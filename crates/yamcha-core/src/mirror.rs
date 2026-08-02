//! 단방향 미러링: primary vault → 백업 폴더(클라우드 동기화 폴더 등).
//! vault가 진실원본이며, 미러 쪽이 더 새로우면 덮지 않고 충돌로 보고한다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::vault::Vault;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
pub struct MirrorReport {
    pub target: String,
    pub copied: u32,
    pub skipped: u32,
    /// 미러 쪽이 더 새로워서 덮지 않은 파일 (rel 경로)
    pub conflicts: Vec<String>,
    pub errors: Vec<String>,
}

/// 미러가 쓰는 vault 정보만 뽑아 둔 것.
///
/// 동기화는 vault 전체를 훑는 느린 IO다. `Vault`를 그대로 빌리면 그동안 앱의 상태
/// 잠금을 쥐고 있게 되어 저장·검색이 전부 뒤에 줄을 선다. 필요한 것은 루트 경로와
/// 폴더 이름뿐이니 먼저 복사해 두고 잠금을 놓는다.
#[derive(Debug, Clone)]
pub struct MirrorSource {
    pub root: PathBuf,
    /// 타입 폴더 이름들 (vault 루트 기준)
    pub folders: Vec<String>,
}

impl MirrorSource {
    pub fn of(vault: &Vault) -> MirrorSource {
        MirrorSource {
            root: vault.root().to_path_buf(),
            folders: vault.types().iter().map(|t| t.folder.clone()).collect(),
        }
    }
}

/// 미러 대상 파일 목록 (rel 경로): 타입 폴더의 모든 파일 + _attachments + _types.json
pub fn file_list(src: &MirrorSource) -> Result<Vec<String>, CoreError> {
    let mut out = Vec::new();
    let mut dirs: Vec<PathBuf> = src.folders.iter().map(|f| src.root.join(f)).collect();
    dirs.push(src.root.join("_attachments"));

    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    for dir in dirs {
        walk(&src.root, &dir, &mut out);
    }
    if src.root.join("_types.json").exists() {
        out.push("_types.json".to_string());
    }
    Ok(out)
}

fn mtime(path: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// vault → target_root 전체 동기화 (vault 우선, 미러가 더 새로우면 충돌 보고)
pub fn sync_to(source: &MirrorSource, target_root: &Path) -> Result<MirrorReport, CoreError> {
    let mut report = MirrorReport {
        target: target_root.to_string_lossy().to_string(),
        ..Default::default()
    };
    fs::create_dir_all(target_root)?;

    for rel in file_list(source)? {
        let src = source.root.join(&rel);
        let dst = target_root.join(&rel);
        match sync_file(&src, &dst) {
            Ok(SyncOutcome::Copied) => report.copied += 1,
            Ok(SyncOutcome::Skipped) => report.skipped += 1,
            Ok(SyncOutcome::Conflict) => report.conflicts.push(rel),
            Err(e) => report.errors.push(format!("{rel}: {e}")),
        }
    }
    Ok(report)
}

enum SyncOutcome {
    Copied,
    Skipped,
    Conflict,
}

/// 두 파일의 내용이 같은가.
///
/// 크기가 다르면 한 바이트도 읽지 않는다. 같을 때만 앞에서부터 조각내어 비교하고
/// 다른 곳이 나오는 즉시 멈춘다. 예전에는 양쪽을 통째로 `fs::read` 했는데, 첨부는
/// 300MB까지 허용되므로 파일 하나에 600MB를 올리는 셈이었다.
fn same_content(a: &Path, b: &Path) -> Result<bool, CoreError> {
    use std::io::Read;

    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let mut fa = std::io::BufReader::new(fs::File::open(a)?);
    let mut fb = std::io::BufReader::new(fs::File::open(b)?);
    let (mut buf_a, mut buf_b) = ([0u8; 16 * 1024], [0u8; 16 * 1024]);
    loop {
        let n = fa.read(&mut buf_a)?;
        if n == 0 {
            return Ok(true);
        }
        fb.read_exact(&mut buf_b[..n])?;
        if buf_a[..n] != buf_b[..n] {
            return Ok(false);
        }
    }
}

fn sync_file(src: &Path, dst: &Path) -> Result<SyncOutcome, CoreError> {
    if !dst.exists() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
        return Ok(SyncOutcome::Copied);
    }
    // 내용이 같으면 스킵
    if same_content(src, dst)? {
        return Ok(SyncOutcome::Skipped);
    }
    // 다르면: 미러가 더 새로우면 충돌, 아니면 vault 우선 복사
    let newer_in_mirror = match (mtime(src), mtime(dst)) {
        (Some(s), Some(d)) => d > s,
        _ => false,
    };
    if newer_in_mirror {
        Ok(SyncOutcome::Conflict)
    } else {
        fs::copy(src, dst)?;
        Ok(SyncOutcome::Copied)
    }
}

/// 충돌 해결: push = vault 내용으로 미러 덮어쓰기, pull = 미러 내용을 vault로 가져오기
pub fn resolve(
    vault: &Vault,
    target_root: &Path,
    rel: &str,
    pull: bool,
) -> Result<(), CoreError> {
    let src = vault.root().join(rel);
    let dst = target_root.join(rel);
    if pull {
        if let Some(parent) = src.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&dst, &src)?;
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&src, &dst)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn full_sync_and_conflict_flow() {
        let vdir = tempfile::tempdir().unwrap();
        let mdir = tempfile::tempdir().unwrap();
        let v = Vault::open(vdir.path()).unwrap();
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        v.save_note(&rel, json!({}), "원본 내용").unwrap();

        // 첫 동기화: 복사됨
        let r1 = sync_to(&MirrorSource::of(&v), mdir.path()).unwrap();
        assert!(r1.copied >= 1);
        assert!(r1.conflicts.is_empty());
        assert!(mdir.path().join(&rel).exists());

        // 변화 없으면 스킵
        let r2 = sync_to(&MirrorSource::of(&v), mdir.path()).unwrap();
        assert_eq!(r2.copied, 0);
        assert!(r2.skipped >= 1);

        // vault 수정 → 다시 복사
        v.save_note(&rel, json!({}), "고친 내용").unwrap();
        let r3 = sync_to(&MirrorSource::of(&v), mdir.path()).unwrap();
        assert!(r3.copied >= 1);
        let mirrored = fs::read_to_string(mdir.path().join(&rel)).unwrap();
        assert!(mirrored.contains("고친 내용"));

        // 미러 쪽을 직접(더 나중에) 수정 → 충돌로 보고, 덮지 않음
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(mdir.path().join(&rel), "미러에서 몰래 수정").unwrap();
        let r4 = sync_to(&MirrorSource::of(&v), mdir.path()).unwrap();
        assert!(r4.conflicts.contains(&rel));
        let still = fs::read_to_string(mdir.path().join(&rel)).unwrap();
        assert!(still.contains("몰래"));

        // push 해결 → vault 내용으로 덮음
        resolve(&v, mdir.path(), &rel, false).unwrap();
        let after = fs::read_to_string(mdir.path().join(&rel)).unwrap();
        assert!(after.contains("고친 내용"));

        // pull 해결도 동작
        fs::write(mdir.path().join(&rel), "미러 버전").unwrap();
        resolve(&v, mdir.path(), &rel, true).unwrap();
        let pulled = fs::read_to_string(vdir.path().join(&rel)).unwrap();
        assert!(pulled.contains("미러 버전"));
    }

    /// 내용 비교는 버퍼(16KB)보다 큰 파일에서도 정확해야 한다 —
    /// 조각내어 읽으므로 경계에 걸친 차이를 놓치기 쉬운 자리다.
    #[test]
    fn 큰_파일도_정확히_비교한다() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a.bin");
        let b = d.path().join("b.bin");

        // 버퍼 여러 개를 넘기는 크기
        let big = vec![7u8; 100 * 1024];
        fs::write(&a, &big).unwrap();
        fs::write(&b, &big).unwrap();
        assert!(same_content(&a, &b).unwrap(), "같은 내용을 다르다고 봤다");

        // 마지막 한 바이트만 다르다 (끝까지 읽어야 잡힌다)
        let mut tail = big.clone();
        *tail.last_mut().unwrap() = 8;
        fs::write(&b, &tail).unwrap();
        assert!(!same_content(&a, &b).unwrap(), "끝의 차이를 놓쳤다");

        // 버퍼 경계 바로 뒤가 다르다
        let mut edge = big.clone();
        edge[16 * 1024] = 9;
        fs::write(&b, &edge).unwrap();
        assert!(!same_content(&a, &b).unwrap(), "버퍼 경계의 차이를 놓쳤다");

        // 크기가 다르면 읽지 않고 바로 다르다
        fs::write(&b, vec![7u8; 99 * 1024]).unwrap();
        assert!(!same_content(&a, &b).unwrap());

        // 빈 파일끼리
        fs::write(&a, b"").unwrap();
        fs::write(&b, b"").unwrap();
        assert!(same_content(&a, &b).unwrap());
    }

    #[test]
    fn attachments_and_types_included() {
        let vdir = tempfile::tempdir().unwrap();
        let mdir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(vdir.path()).unwrap();
        v.add_custom_type("회의록", vec![], "").unwrap();
        v.save_pasted_image(b"img", "png").unwrap();

        sync_to(&MirrorSource::of(&v), mdir.path()).unwrap();
        assert!(mdir.path().join("_types.json").exists());
        // _attachments 내 파일 복사 확인
        let list = file_list(&MirrorSource::of(&v)).unwrap();
        assert!(list.iter().any(|p| p.starts_with("_attachments/")));
    }
}
