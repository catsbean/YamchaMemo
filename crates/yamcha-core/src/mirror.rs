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
/// 이름표뿐이니 먼저 복사해 두고 잠금을 놓는다.
#[derive(Debug, Clone)]
pub struct MirrorSource {
    pub root: PathBuf,
    /// vault의 이름표 (`migrations::vault_id`) — 미러 폴더의 표시와 견준다
    pub id: String,
}

impl MirrorSource {
    pub fn of(vault: &Vault) -> Result<MirrorSource, CoreError> {
        Ok(MirrorSource {
            root: vault.root().to_path_buf(),
            id: crate::migrations::vault_id(vault)?,
        })
    }
}

/// 미러 폴더에 두는 표시 — 어느 vault의 미러인가
pub const MARKER: &str = ".yamcha-mirror.json";

#[derive(Serialize, Deserialize)]
struct Marker {
    vault_id: String,
    /// 사람이 읽으라고 적어 두는 vault 경로 (판정에는 쓰지 않는다)
    vault_path: String,
}

/// 미러로 고른 폴더가 어떤 상태인가
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetState {
    /// 없거나 빈 폴더
    Empty,
    /// 이 vault의 미러 (표시가 있다)
    Ours,
    /// 다른 vault의 미러 — 쓰지 않는다
    OtherVault,
    /// 표시 없이 파일이 있다 — 고를 때 한 번 묻는다(예전 판이 만든 미러일 수도 있다)
    NotEmpty,
    /// vault 안이거나 vault를 품은 폴더 — 쓰지 않는다
    Nested,
}

/// 아직 없는 경로도 견줄 수 있게: 있는 데까지 실제 경로로 바꾸고 나머지를 잇는다
fn canonical_lenient(p: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = p;
    loop {
        if let Ok(c) = fs::canonicalize(cur) {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (cur.file_name(), cur.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_os_string());
                cur = parent;
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// 미러로 쓸 폴더를 살핀다. 동기화도 매번 이걸 먼저 거친다.
pub fn check_target(src: &MirrorSource, target: &Path) -> Result<TargetState, CoreError> {
    let root = canonical_lenient(&src.root);
    let t = canonical_lenient(target);
    // vault 안의 폴더면 동기화마다 `Free/Free/Free/…`로 끝없이 자라고 그 사본이 vault의 노트로
    // 잡힌다. vault를 품은 폴더면 미러가 vault 위에 사본을 쏟는다.
    if t.starts_with(&root) || root.starts_with(&t) {
        return Ok(TargetState::Nested);
    }
    if !target.is_dir() {
        return Ok(TargetState::Empty);
    }
    if let Ok(text) = fs::read_to_string(target.join(MARKER)) {
        return Ok(match serde_json::from_str::<Marker>(&text) {
            Ok(m) if m.vault_id == src.id => TargetState::Ours,
            Ok(_) => TargetState::OtherVault,
            Err(_) => TargetState::NotEmpty,
        });
    }
    let has_any = fs::read_dir(target)?.next().is_some();
    Ok(if has_any { TargetState::NotEmpty } else { TargetState::Empty })
}

/// 미러 대상 파일 목록 (rel 경로) — **백업과 같은 규칙**: vault의 파일 전부(분류 폴더 밖의
/// `_callouts.json` 등 포함)와 `.yamcha/`의 템플릿·형식 판. 예전엔 분류 폴더·첨부·
/// `_types.json`만 실어 기록 종류·템플릿이 미러에 없었다.
pub fn file_list(src: &MirrorSource) -> Result<Vec<String>, CoreError> {
    Ok(crate::backup::files_to_back_up(&src.root)?
        .into_iter()
        .map(|(rel, _)| rel)
        .collect())
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
    match check_target(source, target_root)? {
        TargetState::Nested => {
            return Err(CoreError::Invalid(
                "vault 안의 폴더나 vault를 품은 폴더는 미러로 쓸 수 없습니다 — 다른 폴더를 고르세요".into(),
            ))
        }
        TargetState::OtherVault => {
            let other = fs::read_to_string(target_root.join(MARKER))
                .ok()
                .and_then(|t| serde_json::from_str::<Marker>(&t).ok())
                .map(|m| m.vault_path)
                .unwrap_or_default();
            return Err(CoreError::Invalid(format!(
                "이 폴더는 다른 vault({other})의 미러입니다 — 섞이지 않게 복제하지 않았습니다. 다른 폴더를 고르세요"
            )));
        }
        TargetState::Ours => {}
        TargetState::Empty | TargetState::NotEmpty => {
            fs::create_dir_all(target_root)?;
            let marker = Marker {
                vault_id: source.id.clone(),
                vault_path: source.root.to_string_lossy().to_string(),
            };
            let text = serde_json::to_string_pretty(&marker)
                .map_err(|e| CoreError::Invalid(e.to_string()))?;
            #[allow(clippy::disallowed_methods)] // 미러 쪽 표시 파일 — vault 밖이다
            fs::write(target_root.join(MARKER), text)?;
        }
    }

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
        copy_to_mirror(src, dst)?;
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
        copy_to_mirror(src, dst)?;
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
    // 화면이 넘긴 경로다 — vault 밖(`..`·절대 경로)을 가리키면 거절한다 (`abs`가 가린다)
    let src = vault.abs(rel)?;
    let dst = target_root.join(rel);
    if pull {
        // vault의 노트를 덮어쓴다 — 쓰다 끊기면 노트가 반쯤 쓰인 채 남으므로 원자적으로
        vault.atomic_copy(&dst, &src)?;
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        copy_to_mirror(&src, &dst)?;
    }
    Ok(())
}

/// vault → 미러 복사. **원자적 쓰기의 예외다.**
///
/// 미러는 다른 드라이브일 수 있어 vault의 `.yamcha/tmp`를 거쳐서는 갈아 끼울(rename) 수
/// 없고, 임시 파일을 미러 폴더에 만들면 클라우드 동기화가 그 찰나의 파일까지 실어 나른다 —
/// vault가 임시 파일을 노트 폴더 밖으로 뺀 까닭과 같다. 끊겨서 반쯤 쓰인 사본은 다음
/// 동기화가 내용이 다르다고 보고 다시 덮어쓴다.
fn copy_to_mirror(src: &Path, dst: &Path) -> Result<(), CoreError> {
    #[allow(clippy::disallowed_methods)] // 위 설명 — 미러 쪽은 원자적 쓰기의 예외
    fs::copy(src, dst)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // 시험은 바깥 편집·깨진 파일을 흉내 내려고 맨 쓰기를 쓴다
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
        let r1 = sync_to(&MirrorSource::of(&v).unwrap(), mdir.path()).unwrap();
        assert!(r1.copied >= 1);
        assert!(r1.conflicts.is_empty());
        assert!(mdir.path().join(&rel).exists());

        // 변화 없으면 스킵
        let r2 = sync_to(&MirrorSource::of(&v).unwrap(), mdir.path()).unwrap();
        assert_eq!(r2.copied, 0);
        assert!(r2.skipped >= 1);

        // vault 수정 → 다시 복사
        v.save_note(&rel, json!({}), "고친 내용").unwrap();
        let r3 = sync_to(&MirrorSource::of(&v).unwrap(), mdir.path()).unwrap();
        assert!(r3.copied >= 1);
        let mirrored = fs::read_to_string(mdir.path().join(&rel)).unwrap();
        assert!(mirrored.contains("고친 내용"));

        // 미러 쪽을 직접(더 나중에) 수정 → 충돌로 보고, 덮지 않음
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(mdir.path().join(&rel), "미러에서 몰래 수정").unwrap();
        let r4 = sync_to(&MirrorSource::of(&v).unwrap(), mdir.path()).unwrap();
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
        v.add_custom_type("회의록", "회의록", vec![], "").unwrap();
        v.save_pasted_image(b"img", "png").unwrap();

        sync_to(&MirrorSource::of(&v).unwrap(), mdir.path()).unwrap();
        assert!(mdir.path().join("_types.json").exists());
        // _attachments 내 파일 복사 확인
        let list = file_list(&MirrorSource::of(&v).unwrap()).unwrap();
        assert!(list.iter().any(|p| p.starts_with("_attachments/")));
    }

    /// vault 안의 폴더·vault를 품은 폴더는 미러로 받지 않는다 — vault 안이면 동기화마다
    /// `Free/Free/Free/…`로 자라고 그 사본이 노트로 잡혔다.
    #[test]
    fn 중첩된_폴더는_미러로_받지_않는다() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("vault");
        let v = Vault::open(&root).unwrap();
        v.create_note("free", "메모", json!({})).unwrap();
        let src = MirrorSource::of(&v).unwrap();

        let inside = root.join("Free");
        assert_eq!(check_target(&src, &inside).unwrap(), TargetState::Nested);
        assert!(sync_to(&src, &inside).is_err());
        assert!(!root.join("Free/Free").exists(), "vault 안에 사본을 만들었다");
        // 아직 없는 하위 폴더도
        assert_eq!(check_target(&src, &root.join("새 폴더/미러")).unwrap(), TargetState::Nested);
        // vault를 품은 폴더
        assert_eq!(check_target(&src, base.path()).unwrap(), TargetState::Nested);
        // 옆 폴더는 괜찮다
        assert_eq!(check_target(&src, &base.path().join("미러")).unwrap(), TargetState::Empty);
    }

    /// 미러 폴더는 어느 vault의 것인지 기억한다 — 다른 vault가 같은 폴더로 섞여 들지 않는다
    #[test]
    fn 다른_vault의_미러에는_복제하지_않는다() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let mdir = tempfile::tempdir().unwrap();
        let a = Vault::open(a_dir.path()).unwrap();
        let b = Vault::open(b_dir.path()).unwrap();
        a.create_note("free", "A의 노트", json!({})).unwrap();
        b.create_note("free", "B의 노트", json!({})).unwrap();

        let src_a = MirrorSource::of(&a).unwrap();
        sync_to(&src_a, mdir.path()).unwrap();
        assert_eq!(check_target(&src_a, mdir.path()).unwrap(), TargetState::Ours);

        let src_b = MirrorSource::of(&b).unwrap();
        assert_eq!(check_target(&src_b, mdir.path()).unwrap(), TargetState::OtherVault);
        assert!(sync_to(&src_b, mdir.path()).is_err());
        assert!(!mdir.path().join("Free/B의 노트.md").exists(), "다른 vault가 섞였다");

        // 이름표는 그대로 남는다 — 다시 열어도, 폴더를 옮겨도 같은 vault다
        let again = Vault::open(a_dir.path()).unwrap();
        assert_eq!(MirrorSource::of(&again).unwrap().id, src_a.id);
    }

    /// 표시 없이 파일이 든 폴더는 고를 때 물을 수 있게 알려 준다(예전 판의 미러일 수도 있다)
    #[test]
    fn 표시_없는_폴더는_비었는지로_가린다() {
        let vdir = tempfile::tempdir().unwrap();
        let mdir = tempfile::tempdir().unwrap();
        let v = Vault::open(vdir.path()).unwrap();
        let src = MirrorSource::of(&v).unwrap();
        assert_eq!(check_target(&src, mdir.path()).unwrap(), TargetState::Empty);
        fs::write(mdir.path().join("남의 파일.txt"), "x").unwrap();
        assert_eq!(check_target(&src, mdir.path()).unwrap(), TargetState::NotEmpty);
        // 동기화하면 이 vault의 미러로 받아들인다 (예전 판이 만든 미러)
        sync_to(&src, mdir.path()).unwrap();
        assert_eq!(check_target(&src, mdir.path()).unwrap(), TargetState::Ours);
    }

    /// 백업과 같은 것을 복제한다 — 기록 종류·템플릿·형식 판도
    #[test]
    fn 기록_종류와_템플릿도_복제한다() {
        let vdir = tempfile::tempdir().unwrap();
        let mdir = tempfile::tempdir().unwrap();
        let v = Vault::open(vdir.path()).unwrap();
        v.add_callout(crate::vault::CalloutDef {
            label: "아이디어".into(),
            icon: "💡".into(),
            color: "amber".into(),
            scope: "daily".into(),
        })
        .unwrap();
        v.write_body_template_file("free", "## 템플릿\n").unwrap();
        sync_to(&MirrorSource::of(&v).unwrap(), mdir.path()).unwrap();
        assert!(mdir.path().join("_callouts.json").exists());
        assert!(mdir.path().join(".yamcha/templates/free.md").exists());
        assert!(mdir.path().join(".yamcha/format.json").exists());
        // 편집 기록·휴지통은 싣지 않는다
        assert!(!mdir.path().join(".yamcha/history").exists());
    }

    /// 충돌 해결은 화면이 넘긴 경로를 믿지 않는다
    #[test]
    fn 충돌_해결은_vault_밖을_건드리지_않는다() {
        let vdir = tempfile::tempdir().unwrap();
        let mdir = tempfile::tempdir().unwrap();
        let v = Vault::open(vdir.path()).unwrap();
        fs::write(mdir.path().join("x.md"), "미러").unwrap();
        assert!(resolve(&v, mdir.path(), "../x.md", true).is_err());
    }
}
