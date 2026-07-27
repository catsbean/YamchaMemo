//! vault 무결성 점검: 외부 편집기(옵시디언 등)에서 만들어지거나 고쳐진 파일이
//! 이 앱의 규격에서 벗어났을 때 **조용히 사라지지 않도록** 찾아내고, 사용자가
//! 누르면 고쳐 준다.
//!
//! 원칙 세 가지:
//! 1. **폴더가 타입의 진실원본**이다. frontmatter `type`은 파생 값이며 불일치는 보고만 한다.
//! 2. **소실 금지.** `Vault::list_notes`가 읽지 못해 버리는 파일도 여기서는 반드시 보인다.
//! 3. **자동 수정 없음.** `fix`는 사용자가 항목별로 눌러야 실행된다.

use std::fs;
use std::path::Path;

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::CoreError;
use crate::parse;
use crate::schema::{Builtin, BOOK_STATUSES, WRITING_STATUSES};
use crate::vault::Vault;

/// 점검에서 발견한 문제의 종류. 한 파일당 하나만 보고하며, 이 열거 순서가 우선순위다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum IssueKind {
    /// 타입 폴더 밖(루트 등)에 있는 노트 — 목록에 아예 안 잡힌다
    OutsideTypeFolder,
    /// frontmatter YAML 문법 오류 — 자동으로 고칠 수 없다
    ParseError,
    /// `---` 블록 자체가 없음
    NoFrontmatter,
    /// date 누락 또는 YYYY-MM-DD 형식 아님
    MissingDate,
    /// frontmatter의 type이 폴더와 다름
    TypeMismatch,
    /// book/writing의 status 값이 정의 밖
    UnknownStatus,
}

impl IssueKind {
    pub fn label(self) -> &'static str {
        match self {
            IssueKind::OutsideTypeFolder => "분류 폴더 밖에 있음",
            IssueKind::ParseError => "frontmatter를 읽을 수 없음",
            IssueKind::NoFrontmatter => "frontmatter 없음",
            IssueKind::MissingDate => "날짜 없음",
            IssueKind::TypeMismatch => "분류가 폴더와 다름",
            IssueKind::UnknownStatus => "알 수 없는 상태값",
        }
    }
}

/// 점검 항목 한 건
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NoteIssue {
    pub rel_path: String,
    pub kind: IssueKind,
    pub label: String,
    /// 무엇이 문제인지 (파일별 구체 정보)
    pub detail: String,
    /// [고치기]를 누르면 무엇을 할지
    pub suggestion: String,
    pub fixable: bool,
}

/// `YYYY-MM-DD` 형식인지 (값의 실제 유효성까지는 보지 않는다)
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| if i == 4 || i == 7 { true } else { c.is_ascii_digit() })
}

/// 파일 수정 시각의 날짜 (읽을 수 없으면 오늘)
fn mtime_date(abs: &Path) -> String {
    fs::metadata(abs)
        .and_then(|m| m.modified())
        .map(|t| DateTime::<Local>::from(t).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| Vault::today())
}

/// 스캔에서 건너뛸 디렉토리 이름
fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('_')
}

/// vault 전체를 훑어 규격에서 벗어난 노트를 찾는다. `.yamcha/`·`_attachments/` 등은 제외.
pub fn audit(vault: &Vault) -> Vec<NoteIssue> {
    let mut out = Vec::new();
    walk(vault, vault.root(), &mut out);
    out.sort_by(|a, b| (a.kind as u8).cmp(&(b.kind as u8)).then(a.rel_path.cmp(&b.rel_path)));
    out
}

fn walk(vault: &Vault, dir: &Path, out: &mut Vec<NoteIssue>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !is_skipped_dir(&name) {
                walk(vault, &path, out);
            }
        } else if name.ends_with(".md") && !name.starts_with('_') {
            if let Some(issue) = inspect(vault, &path) {
                out.push(issue);
            }
        }
    }
}

/// 파일 하나를 검사해 가장 우선순위 높은 문제 1건을 돌려준다. 문제 없으면 None.
fn inspect(vault: &Vault, abs: &Path) -> Option<NoteIssue> {
    let rel = abs.strip_prefix(vault.root()).ok()?.to_string_lossy().replace('\\', "/");

    let make = |kind: IssueKind, detail: String, suggestion: &str, fixable: bool| {
        Some(NoteIssue {
            rel_path: rel.clone(),
            kind,
            label: kind.label().to_string(),
            detail,
            suggestion: suggestion.to_string(),
            fixable,
        })
    };

    // 1) 타입 폴더 밖인가 (읽기 전에 판정 가능)
    let type_id = match vault.type_of_rel(&rel) {
        Ok(t) => t,
        Err(_) => {
            let where_ = match rel.rsplit_once('/') {
                Some((dir, _)) => format!("{dir}/ 폴더"),
                None => "vault 최상위".to_string(),
            };
            return make(
                IssueKind::OutsideTypeFolder,
                format!("{where_}에 있어서 목록에 나타나지 않습니다."),
                "자유노트(Free)로 옮기고 기본 정보를 채웁니다.",
                true,
            );
        }
    };

    let content = fs::read_to_string(abs).ok()?;
    let (fm_str, _body) = parse::split_frontmatter(&content);

    // 2) frontmatter 없음
    let Some(yaml) = fm_str else {
        return make(
            IssueKind::NoFrontmatter,
            "--- 로 감싼 frontmatter가 없어 날짜·태그·분류를 알 수 없습니다.".into(),
            "파일 수정 시각을 날짜로, 폴더를 분류로 채워 넣습니다.",
            true,
        );
    };

    // 3) YAML 파싱 실패 — 고칠 수 없다
    let fm = match parse::parse_frontmatter(yaml) {
        Ok(fm) => fm,
        Err(e) => {
            return make(
                IssueKind::ParseError,
                format!("{e} — 이 파일은 목록에서 빠져 있습니다."),
                "원문을 직접 열어 고쳐야 합니다.",
                false,
            );
        }
    };

    // 4) 날짜
    let date_ok = fm.get("date").and_then(|v| v.as_str()).map(is_iso_date).unwrap_or(false);
    if !date_ok {
        let cur = fm.get("date").map(|v| v.to_string()).unwrap_or_else(|| "없음".into());
        return make(
            IssueKind::MissingDate,
            format!("date가 YYYY-MM-DD 형식이 아닙니다 (현재: {cur})."),
            "파일 수정 시각의 날짜로 채웁니다.",
            true,
        );
    }

    // 5) type 불일치 — 폴더가 진실원본
    let fm_type = fm.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if fm_type != type_id {
        let cur = if fm_type.is_empty() { "없음" } else { fm_type };
        return make(
            IssueKind::TypeMismatch,
            format!("폴더는 '{type_id}'인데 frontmatter의 type은 '{cur}'입니다."),
            "폴더에 맞춰 type을 고칩니다 (파일은 옮기지 않습니다).",
            true,
        );
    }

    // 6) status 값
    let (statuses, default) = if type_id == Builtin::Book.id() {
        (&BOOK_STATUSES[..], "wishlist")
    } else if type_id == Builtin::Writing.id() {
        (&WRITING_STATUSES[..], "idea")
    } else {
        return None;
    };
    let status = fm.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if !statuses.iter().any(|(v, _)| *v == status) {
        let cur = if status.is_empty() { "없음" } else { status };
        return make(
            IssueKind::UnknownStatus,
            format!("status가 '{cur}'라서 어느 칸에도 분류되지 않습니다."),
            &format!("'{default}'로 되돌립니다."),
            true,
        );
    }

    None
}

/// 점검 항목 한 건을 고친다. 성공하면 (바뀌었을 수 있는) rel 경로를 돌려준다.
/// 파일을 만지기 전에 항상 스냅샷을 남긴다.
pub fn fix(vault: &Vault, rel: &str, kind: IssueKind) -> Result<String, CoreError> {
    if kind == IssueKind::ParseError {
        return Err(CoreError::Invalid(
            "frontmatter 문법 오류는 자동으로 고칠 수 없습니다. 원문을 직접 수정해주세요.".into(),
        ));
    }
    vault.snapshot_before_change(rel)?;

    // 폴더 밖 파일은 먼저 Free/로 옮긴다
    let rel = if kind == IssueKind::OutsideTypeFolder {
        move_to_free(vault, rel)?
    } else {
        rel.to_string()
    };

    let abs = vault.abs(&rel)?;
    let note = vault.read_note(&rel)?;
    let mut fm = note.frontmatter.as_object().cloned().unwrap_or_default();

    match kind {
        IssueKind::NoFrontmatter | IssueKind::MissingDate | IssueKind::OutsideTypeFolder => {
            // 이미 쓸 만한 날짜가 있으면 건드리지 않는다 (폴더 밖 파일도 date는 멀쩡할 수 있다)
            let ok = fm.get("date").and_then(|v| v.as_str()).map(is_iso_date).unwrap_or(false);
            if !ok {
                fm.insert("date".into(), json!(mtime_date(&abs)));
            }
        }
        IssueKind::UnknownStatus => {
            let t = vault.type_of_rel(&rel)?;
            let default = if t == Builtin::Book.id() { "wishlist" } else { "idea" };
            fm.insert("status".into(), json!(default));
        }
        // TypeMismatch는 save_note의 정규화가 폴더 기준으로 type을 다시 써 준다
        IssueKind::TypeMismatch => {}
        IssueKind::ParseError => unreachable!("위에서 이미 걸렀다"),
    }

    vault.save_note(&rel, Value::Object(fm), &note.body)?;
    Ok(rel)
}

/// 타입 폴더 밖의 파일을 `Free/`로 옮기고 새 rel을 돌려준다.
fn move_to_free(vault: &Vault, rel: &str) -> Result<String, CoreError> {
    let src = vault.abs(rel)?;
    if !src.exists() {
        return Err(CoreError::NotFound(rel.to_string()));
    }
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "무제".into());
    let dir = vault.root().join(Builtin::Free.folder());
    fs::create_dir_all(&dir)?;
    let dest = vault.unique_path(&dir, &stem);
    fs::rename(&src, &dest)?;
    Ok(vault.rel_of(&dest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    /// 규격에 맞는 vault는 점검 항목이 0건
    #[test]
    fn clean_vault_has_no_issues() {
        let (_d, v) = setup();
        v.create_note("free", "메모", json!({})).unwrap();
        v.create_note("book", "클린 코드", json!({"author": "마틴"})).unwrap();
        assert!(audit(&v).is_empty(), "{:?}", audit(&v));
    }

    #[test]
    fn outside_type_folder_is_found_and_moved() {
        let (d, v) = setup();
        fs::write(d.path().join("떠돌이.md"), "---\ndate: 2026-07-01\ntype: free\ntags: []\n---\n\n본문 유지").unwrap();

        let issues = audit(&v);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, IssueKind::OutsideTypeFolder);

        let new_rel = fix(&v, &issues[0].rel_path, IssueKind::OutsideTypeFolder).unwrap();
        assert!(new_rel.starts_with("Free/"), "{new_rel}");
        assert!(v.read_note(&new_rel).unwrap().body.contains("본문 유지"));
        assert!(audit(&v).is_empty());
    }

    #[test]
    fn missing_frontmatter_is_filled_from_mtime() {
        let (d, v) = setup();
        fs::write(d.path().join("Free").join("맨몸.md"), "그냥 본문만 있다").unwrap();

        let issues = audit(&v);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, IssueKind::NoFrontmatter);

        fix(&v, &issues[0].rel_path, IssueKind::NoFrontmatter).unwrap();
        let note = v.read_note("Free/맨몸.md").unwrap();
        assert!(note.body.contains("그냥 본문만 있다"));
        assert!(is_iso_date(note.frontmatter["date"].as_str().unwrap()));
        assert_eq!(note.frontmatter["type"], json!("free"));
        assert!(audit(&v).is_empty());
    }

    #[test]
    fn broken_yaml_is_reported_but_not_fixable() {
        let (d, v) = setup();
        fs::write(
            d.path().join("Free").join("깨짐.md"),
            "---\ndate: 2026-07-01\ntags: [닫히지 않음\n---\n\n본문",
        )
        .unwrap();

        let issues = audit(&v);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, IssueKind::ParseError);
        assert!(!issues[0].fixable);
        assert!(fix(&v, &issues[0].rel_path, IssueKind::ParseError).is_err());

        // 원문 편집 통로로는 고칠 수 있다
        let raw = v.read_raw("Free/깨짐.md").unwrap();
        v.write_raw("Free/깨짐.md", &raw.replace("[닫히지 않음", "[닫힘]")).unwrap();
        // YAML은 살아났고, 남은 건 type 누락 — 이제는 자동으로 고칠 수 있다
        let rest = audit(&v);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].kind, IssueKind::TypeMismatch);
        fix(&v, "Free/깨짐.md", IssueKind::TypeMismatch).unwrap();
        assert!(audit(&v).is_empty());
        assert!(v.read_note("Free/깨짐.md").unwrap().body.contains("본문"));
    }

    #[test]
    fn missing_date_is_filled() {
        let (d, v) = setup();
        fs::write(
            d.path().join("Free").join("날짜없음.md"),
            "---\ntype: free\ntags: []\n---\n\n본문",
        )
        .unwrap();

        let issues = audit(&v);
        assert_eq!(issues[0].kind, IssueKind::MissingDate);
        fix(&v, "Free/날짜없음.md", IssueKind::MissingDate).unwrap();
        assert!(audit(&v).is_empty());
    }

    #[test]
    fn type_mismatch_follows_folder() {
        let (d, v) = setup();
        fs::write(
            d.path().join("Free").join("혼동.md"),
            "---\ndate: 2026-07-01\ntype: book\ntags: []\n---\n\n본문",
        )
        .unwrap();

        let issues = audit(&v);
        assert_eq!(issues[0].kind, IssueKind::TypeMismatch);
        fix(&v, "Free/혼동.md", IssueKind::TypeMismatch).unwrap();
        assert_eq!(
            v.read_note("Free/혼동.md").unwrap().frontmatter["type"],
            json!("free")
        );
        assert!(audit(&v).is_empty());
    }

    #[test]
    fn unknown_status_falls_back_to_default() {
        let (d, v) = setup();
        fs::write(
            d.path().join("Books").join("이상한상태.md"),
            "---\ndate: 2026-07-01\ntype: book\ntags: []\ntitle: 이상한상태\nstatus: 읽는중\n---\n\n## 소개\n\n## 기록\n",
        )
        .unwrap();

        let issues = audit(&v);
        assert_eq!(issues[0].kind, IssueKind::UnknownStatus);
        fix(&v, "Books/이상한상태.md", IssueKind::UnknownStatus).unwrap();
        assert_eq!(
            v.read_note("Books/이상한상태.md").unwrap().frontmatter["status"],
            json!("wishlist")
        );
        assert!(audit(&v).is_empty());
    }

    /// 첨부·휴지통·템플릿 폴더는 점검 대상이 아니다
    #[test]
    fn hidden_and_attachment_dirs_are_skipped() {
        let (d, v) = setup();
        fs::create_dir_all(d.path().join("_attachments")).unwrap();
        fs::write(d.path().join("_attachments").join("메모.md"), "본문만").unwrap();
        fs::write(d.path().join(".yamcha").join("trash").join("20260101-000000_지운것.md"), "본문만").unwrap();
        assert!(audit(&v).is_empty());
    }
}
