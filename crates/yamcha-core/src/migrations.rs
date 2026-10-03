//! vault 형식의 판과 이전 장치 (8-4) — `docs/VAULT-FORMAT.md`가 판마다의 형식을 적는다.
//!
//! **1.0의 약속**: 이 판에서 쓴 노트는 다음 판에서도 그대로 열린다. 형식이 바뀌면 vault를 열 때
//! 이전(migration)이 판 차례대로 돌고 판 표시(`.yamcha/format.json`)를 올린다.
//!
//! 예전엔 형식이 바뀔 때마다 그때그때 맞췄다 — 옛 독서기록을 책으로 합치는 일(`migrate_readings`)이
//! vault를 열 때마다 돌았고, 무엇이 언제 바뀌었는지 판으로 남지 않았다. 이제 판 0(표시 없음)→1이
//! 그 일을 맡는다.
//!
//! - 표시가 없거나 낮으면 → 그 판부터 차례대로 이전하고 판을 올린다. 파일을 고치는 이전은 고치기 전에
//!   `.yamcha/migrate-backup/<시각>/`에 사본을 둔다
//! - **더 높으면 → 열지 않는다.** 옛 앱이 새 형식을 모르고 고쳐 망가뜨리지 않게
//! - 이전은 두 번 돌아도 같은 결과여야 한다(판을 쓰다 끊기면 다음에 또 돈다)
//!
//! 판 표시는 vault 안(`.yamcha/`)에 있다 — 클라우드로 이어진 다른 기기도 같은 판을 본다. 백업에 들어간다.

use std::fs;
use std::path::Path;

use chrono::Local;
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::vault::Vault;

/// 이 앱이 쓰는 형식의 판. 형식을 바꾸면 올리고, 아래 `run`에 이전을 더하고, `VAULT-FORMAT.md`에 적는다.
pub const CURRENT_FORMAT: u32 = 1;

const FORMAT_FILE: &str = "format.json";

#[derive(Serialize, Deserialize)]
struct FormatFile {
    version: u32,
    /// 이 vault의 이름표 — 미러 폴더가 "어느 vault의 미러인가"를 기억할 때 쓴다(`vault_id`).
    /// 판을 올리지 않고 덧붙인 칸이라 옛 앱은 모른 척 지나간다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
}

fn read_format(root: &Path) -> Option<FormatFile> {
    fs::read_to_string(format_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<FormatFile>(&s).ok())
}

fn write_format(vault: &Vault, f: &FormatFile) -> Result<(), CoreError> {
    let text = serde_json::to_string_pretty(f).map_err(|e| CoreError::Invalid(e.to_string()))?;
    fs::create_dir_all(vault.root().join(".yamcha"))?;
    vault.atomic_write(&format_path(vault.root()), &text)
}

/// 이 vault의 이름표. 없으면 지금 만들어 `format.json`에 적는다.
///
/// 경로가 아니라 이름표로 알아보는 까닭: vault 폴더를 옮기거나 백업을 새 자리에 풀어도
/// 같은 vault다(백업은 `format.json`을 함께 담는다). 경로로 알아보면 그때마다 제 미러를
/// "남의 미러"라며 거부한다.
pub fn vault_id(vault: &Vault) -> Result<String, CoreError> {
    let mut f = read_format(vault.root()).unwrap_or(FormatFile { version: CURRENT_FORMAT, id: None });
    if let Some(id) = &f.id {
        return Ok(id.clone());
    }
    use std::hash::{Hash, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (nanos, std::process::id(), vault.root()).hash(&mut h);
    let id = format!("{:016x}{:08x}", h.finish(), nanos as u32);
    f.id = Some(id.clone());
    write_format(vault, &f)?;
    Ok(id)
}

fn format_path(root: &Path) -> std::path::PathBuf {
    root.join(".yamcha").join(FORMAT_FILE)
}

/// 이 vault의 판 — 표시가 없으면 0(판 표시가 생기기 전의 vault). 깨진 표시도 0으로 본다 —
/// 이전은 두 번 돌아도 같으므로 다시 도는 쪽이 안전하다.
pub fn format_of(root: &Path) -> u32 {
    read_format(root).map(|f| f.version).unwrap_or(0)
}

/// 열기 전에 — 이 앱보다 새 판이면 열지 않는다 (아무것도 만들거나 고치기 전에 본다)
pub fn check_openable(root: &Path) -> Result<u32, CoreError> {
    let found = format_of(root);
    if found > CURRENT_FORMAT {
        return Err(CoreError::NewerFormat { found, supported: CURRENT_FORMAT });
    }
    Ok(found)
}

/// 이전 결과 — 무엇을 했는지 (앱이 로그에 남긴다)
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MigrationReport {
    pub from: u32,
    pub to: u32,
    /// 옛 독서기록을 책으로 합친 편수 (0→1)
    pub readings_merged: u32,
    /// 고치기 전 사본을 둔 자리 (vault 상대 경로, 고친 게 없으면 None)
    pub backup: Option<String>,
}

/// `found` 판에서 지금 판까지 차례대로 이전하고 판 표시를 쓴다.
pub fn run(vault: &Vault, found: u32) -> Result<MigrationReport, CoreError> {
    let mut report = MigrationReport { from: found, to: found, ..Default::default() };

    // 0 → 1: 옛 `Reading/` 폴더의 독서기록을 책의 `## 기록`으로 합친다 (0.4 이전의 구조)
    if found < 1 {
        if vault.root().join("Reading").is_dir() {
            report.backup = Some(backup_before(vault.root(), &["Reading", "Books", "_types.json"])?);
            report.readings_merged = vault.migrate_readings()?;
        }
        report.to = 1;
    }

    if found != CURRENT_FORMAT {
        // 이름표는 판을 올려도 그대로 둔다
        let id = read_format(vault.root()).and_then(|f| f.id);
        write_format(vault, &FormatFile { version: CURRENT_FORMAT, id })?;
        report.to = CURRENT_FORMAT;
    }
    Ok(report)
}

/// 이전이 고칠 자리의 사본 → 사본 폴더(vault 상대 경로). 없는 자리는 건너뛴다.
#[allow(clippy::disallowed_methods)] // vault 안의 새 사본 폴더로 복사 — 원본은 건드리지 않는다
fn backup_before(root: &Path, rels: &[&str]) -> Result<String, CoreError> {
    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let rel_dir = format!(".yamcha/migrate-backup/{stamp}");
    let dest = root.join(&rel_dir);
    fn copy_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
        if src.is_dir() {
            fs::create_dir_all(dest)?;
            for e in fs::read_dir(src)? {
                let e = e?;
                copy_tree(&e.path(), &dest.join(e.file_name()))?;
            }
        } else if src.is_file() {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(src, dest)?;
        }
        Ok(())
    }
    for rel in rels {
        copy_tree(&root.join(rel), &dest.join(rel))?;
    }
    Ok(rel_dir)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // 옛 vault를 맨 쓰기로 꾸민다
mod tests {
    use super::*;

    #[test]
    fn 새_vault는_지금_판으로_표시된다() {
        let d = tempfile::tempdir().unwrap();
        Vault::open(d.path()).unwrap();
        assert_eq!(format_of(d.path()), CURRENT_FORMAT);
        // 다시 열어도 그대로 — 고칠 게 없으면 사본도 없다
        Vault::open(d.path()).unwrap();
        assert!(!d.path().join(".yamcha/migrate-backup").exists());
    }

    #[test]
    fn 더_새_판이면_아무것도_만들지_않고_열지_않는다() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".yamcha")).unwrap();
        fs::write(format_path(d.path()), r#"{"version": 2}"#).unwrap();
        let err = Vault::open(d.path()).err().expect("열리면 안 된다");
        assert!(matches!(err, CoreError::NewerFormat { found: 2, supported: CURRENT_FORMAT }), "{err}");
        assert!(err.to_string().contains("업데이트"), "{err}");
        // 폴더 구조도 만들지 않았다 (옛 앱이 새 vault에 흔적을 남기지 않게)
        assert!(!d.path().join("Free").exists());
        assert_eq!(format_of(d.path()), 2);
    }

    #[test]
    fn 깨진_판_표시는_0으로_보고_다시_쓴다() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join(".yamcha")).unwrap();
        fs::write(format_path(d.path()), "{깨짐").unwrap();
        Vault::open(d.path()).unwrap();
        assert_eq!(format_of(d.path()), CURRENT_FORMAT);
    }

    /// 판 표시가 없는 옛 vault — 독서기록을 합치기 전에 사본을 두고, 한 번만 돈다
    #[test]
    fn 옛_vault는_사본을_두고_이전한_뒤_다시_돌지_않는다() {
        let d = tempfile::tempdir().unwrap();
        {
            let v = Vault::open(d.path()).unwrap();
            v.create_note("book", "옛 책", serde_json::json!({"author": "저자"})).unwrap();
        }
        // 판 표시가 생기기 전의 vault로 되돌린다
        fs::remove_file(format_path(d.path())).unwrap();
        fs::create_dir_all(d.path().join("Reading")).unwrap();
        let old = "---\ntype: reading\nbook: \"[[옛 책]]\"\n---\n\n> [!발췌] 2026-07-01\n> 옛 기록\n";
        fs::write(d.path().join("Reading/독서기록_옛 책.md"), old).unwrap();
        let book_before = fs::read_to_string(d.path().join("Books/옛 책.md")).unwrap();

        let found = check_openable(d.path()).unwrap();
        let v = Vault::open(d.path()).unwrap();
        assert_eq!(found, 0);
        assert_eq!(format_of(d.path()), CURRENT_FORMAT);
        assert!(v.read_note("Books/옛 책.md").unwrap().body.contains("옛 기록"));

        // 고치기 전 사본: 독서기록과 책이 고치기 전 모습 그대로
        let backups: Vec<_> = fs::read_dir(d.path().join(".yamcha/migrate-backup")).unwrap().flatten().collect();
        assert_eq!(backups.len(), 1);
        let b = backups[0].path();
        assert_eq!(fs::read_to_string(b.join("Reading/독서기록_옛 책.md")).unwrap(), old);
        assert_eq!(fs::read_to_string(b.join("Books/옛 책.md")).unwrap(), book_before);

        // 다시 열어도 같은 결과 — 두 번 합치지 않는다
        let after = fs::read_to_string(d.path().join("Books/옛 책.md")).unwrap();
        Vault::open(d.path()).unwrap();
        assert_eq!(fs::read_to_string(d.path().join("Books/옛 책.md")).unwrap(), after);
        assert_eq!(fs::read_dir(d.path().join(".yamcha/migrate-backup")).unwrap().count(), 1);
    }

    /// 판 0→1을 두 번 돌려도 같다 — 판을 쓰다 끊기면 다음에 또 돈다
    #[test]
    fn 이전은_두_번_돌아도_같다() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::open(d.path()).unwrap();
        v.create_note("free", "메모", serde_json::json!({})).unwrap();
        let first = run(&v, 0).unwrap();
        let second = run(&v, 0).unwrap();
        assert_eq!((first.to, second.to), (CURRENT_FORMAT, CURRENT_FORMAT));
        assert_eq!((first.readings_merged, second.readings_merged), (0, 0));
        assert_eq!(v.list_notes().unwrap().len(), 1);
    }
}
