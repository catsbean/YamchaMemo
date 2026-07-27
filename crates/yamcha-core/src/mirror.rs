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

/// 미러 대상 파일 목록 (rel 경로): 타입 폴더의 모든 파일 + _attachments + _types.json
pub fn file_list(vault: &Vault) -> Result<Vec<String>, CoreError> {
    let mut out = Vec::new();
    let mut dirs: Vec<PathBuf> = vault
        .types()
        .iter()
        .map(|t| vault.root().join(&t.folder))
        .collect();
    dirs.push(vault.root().join("_attachments"));

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
        walk(vault.root(), &dir, &mut out);
    }
    if vault.root().join("_types.json").exists() {
        out.push("_types.json".to_string());
    }
    Ok(out)
}

fn mtime(path: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// vault → target_root 전체 동기화 (vault 우선, 미러가 더 새로우면 충돌 보고)
pub fn sync_to(vault: &Vault, target_root: &Path) -> Result<MirrorReport, CoreError> {
    let mut report = MirrorReport {
        target: target_root.to_string_lossy().to_string(),
        ..Default::default()
    };
    fs::create_dir_all(target_root)?;

    for rel in file_list(vault)? {
        let src = vault.root().join(&rel);
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

fn sync_file(src: &Path, dst: &Path) -> Result<SyncOutcome, CoreError> {
    if !dst.exists() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
        return Ok(SyncOutcome::Copied);
    }
    // 내용이 같으면 스킵 (개인 규모 파일이라 직접 비교)
    let src_bytes = fs::read(src)?;
    let dst_bytes = fs::read(dst)?;
    if src_bytes == dst_bytes {
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
        let r1 = sync_to(&v, mdir.path()).unwrap();
        assert!(r1.copied >= 1);
        assert!(r1.conflicts.is_empty());
        assert!(mdir.path().join(&rel).exists());

        // 변화 없으면 스킵
        let r2 = sync_to(&v, mdir.path()).unwrap();
        assert_eq!(r2.copied, 0);
        assert!(r2.skipped >= 1);

        // vault 수정 → 다시 복사
        v.save_note(&rel, json!({}), "고친 내용").unwrap();
        let r3 = sync_to(&v, mdir.path()).unwrap();
        assert!(r3.copied >= 1);
        let mirrored = fs::read_to_string(mdir.path().join(&rel)).unwrap();
        assert!(mirrored.contains("고친 내용"));

        // 미러 쪽을 직접(더 나중에) 수정 → 충돌로 보고, 덮지 않음
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(mdir.path().join(&rel), "미러에서 몰래 수정").unwrap();
        let r4 = sync_to(&v, mdir.path()).unwrap();
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

    #[test]
    fn attachments_and_types_included() {
        let vdir = tempfile::tempdir().unwrap();
        let mdir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(vdir.path()).unwrap();
        v.add_custom_type("회의록", vec![], "").unwrap();
        v.save_pasted_image(b"img", "png").unwrap();

        sync_to(&v, mdir.path()).unwrap();
        assert!(mdir.path().join("_types.json").exists());
        // _attachments 내 파일 복사 확인
        let list = file_list(&v).unwrap();
        assert!(list.iter().any(|p| p.starts_with("_attachments/")));
    }
}
