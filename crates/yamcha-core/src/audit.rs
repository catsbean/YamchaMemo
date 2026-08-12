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

/// 점검에서 발견한 문제의 종류. 이 열거 순서가 우선순위다.
///
/// 파일 규격 문제(앞의 일곱)는 **한 파일당 하나만** 보고한다 — 하나를 고치면
/// 다음 것이 드러나는 편이 한꺼번에 늘어놓는 것보다 낫다. 별칭 문제(뒤의 둘)는
/// 파일이 아니라 **vault 전체의 이름 관계**에서 나오므로 그 규칙 밖에 있다.
/// 같은 파일이 규격 문제와 별칭 문제를 함께 낼 수 있다 — 서로 다른 고장이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum IssueKind {
    /// 클라우드 동기화가 만든 충돌 사본 — 같은 글이 둘로 갈라져 있다
    CloudConflictCopy,
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
    /// 같은 이름의 글이 따로 있어 이 별칭으로는 아무도 오지 않는다
    ShadowedAlias,
    /// 두 글 이상이 같은 별칭을 달고 있다 — 누를 때마다 고르게 된다
    DuplicateAlias,
}

impl IssueKind {
    pub fn label(self) -> &'static str {
        match self {
            IssueKind::CloudConflictCopy => "동기화 충돌 사본",
            IssueKind::OutsideTypeFolder => "분류 폴더 밖에 있음",
            IssueKind::ParseError => "frontmatter를 읽을 수 없음",
            IssueKind::NoFrontmatter => "frontmatter 없음",
            IssueKind::MissingDate => "날짜 없음",
            IssueKind::TypeMismatch => "분류가 폴더와 다름",
            IssueKind::UnknownStatus => "알 수 없는 상태값",
            IssueKind::ShadowedAlias => "쓰이지 않는 별칭",
            IssueKind::DuplicateAlias => "겹치는 별칭",
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

/// 클라우드 동기화(iCloud·Dropbox·OneDrive·Syncthing)가 만든 충돌 사본인가 →
/// 그렇다면 "무엇의 사본인지"를 돌려준다.
///
/// 두 기기에서 같은 노트를 고친 뒤 양쪽이 올라오면, 동기화 클라이언트는 하나를 고르지
/// 못하고 **둘 다 남긴다**. 앱에서는 그냥 노트가 하나 더 생긴 것으로 보여서, 어느 쪽이
/// 최신인지 모른 채 한쪽에만 계속 쓰다가 나머지 절반을 잃는다. 조용히 갈라지는 게
/// 문제이므로 점검에서 반드시 보이게 한다.
///
/// iCloud는 표시를 남기지 않고 `이름 2.md`로만 만든다. 그것만으로는 사람이 지은 이름
/// (`회의록 2.md`)과 구별할 수 없으므로, **같은 폴더에 `이름.md`가 함께 있을 때만**
/// 사본으로 본다.
fn conflict_copy_of(abs: &Path) -> Option<String> {
    let name = abs.file_name()?.to_string_lossy().to_string();
    let stem = name.strip_suffix(".md")?;

    // 이름에 표시를 남기는 것들 — 사람이 이렇게 지을 일이 없다
    for mark in [
        ".sync-conflict-",
        "(conflicted copy",
        "충돌이 발생한 사본",
        "-conflict-",
    ] {
        if let Some(at) = stem.find(mark) {
            return Some(format!("{}.md", stem[..at].trim_end()));
        }
    }

    // iCloud: `이름 2` — 원본이 옆에 있을 때만
    let (base, tail) = stem.rsplit_once(' ')?;
    if tail.len() > 2 || !tail.chars().all(|c| c.is_ascii_digit()) || tail == "1" {
        return None;
    }
    let original = format!("{base}.md");
    abs.parent()?
        .join(&original)
        .exists()
        .then_some(original)
}

/// vault 전체를 훑어 규격에서 벗어난 노트를 찾는다. `.yamcha/`·`_attachments/` 등은 제외.
pub fn audit(vault: &Vault) -> Vec<NoteIssue> {
    let mut out = Vec::new();
    walk(vault, vault.root(), &mut out);
    out.extend(alias_issues(vault));
    out.sort_by(|a, b| (a.kind as u8).cmp(&(b.kind as u8)).then(a.rel_path.cmp(&b.rel_path)));
    out
}

/// rel 경로에서 확장자를 뗀 파일명
fn stem_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).trim_end_matches(".md").to_string()
}

/// 별칭이 **적어 뒀는데 작동하지 않는** 두 경우를 찾는다.
///
/// 이 둘은 시간이 지나야 생긴다. A에 '비비풀'을 달아 둔 뒤 몇 달 지나 '비비풀'이라는
/// 제목의 글을 만들면 그 순간 A의 별칭이 죽는데, 편집 화면을 다시 열지 않는 한
/// 알 길이 없다. 그래서 주기적으로 훑는 점검이 이걸 맡는다.
///
/// 파일을 다시 읽지 않고 `list_notes`의 요약을 쓴다 — 그 목록은 (수정시각, 크기)로
/// 캐시되어 있어서, 점검을 눌러도 vault를 두 번 읽지 않는다.
fn alias_issues(vault: &Vault) -> Vec<NoteIssue> {
    let Ok(notes) = vault.list_notes() else {
        return Vec::new();
    };

    // 이름(제목·파일명) → 그 이름을 가진 글들. 별칭은 이들에게 진다.
    let mut owners: std::collections::HashMap<String, Vec<String>> = Default::default();
    // 별칭 → 그 별칭을 단 글들
    let mut claims: std::collections::HashMap<String, Vec<String>> = Default::default();
    // 글 → 그 글이 단 별칭들 (보고 순서를 파일 순서로 유지하려고 따로 둔다)
    let mut mine: Vec<(String, String, Vec<String>)> = Vec::new();

    for n in &notes {
        let stem = stem_of(&n.rel_path);
        for name in [n.title.clone(), stem.clone()] {
            if name.is_empty() {
                continue;
            }
            let e = owners.entry(name).or_default();
            if !e.contains(&n.rel_path) {
                e.push(n.rel_path.clone());
            }
        }
        let aliases = n
            .frontmatter
            .as_object()
            .map(parse::extract_aliases)
            .unwrap_or_default();
        if aliases.is_empty() {
            continue;
        }
        for a in &aliases {
            claims.entry(a.clone()).or_default().push(n.rel_path.clone());
        }
        let display = if n.title.is_empty() { stem } else { n.title.clone() };
        mine.push((n.rel_path.clone(), display, aliases));
    }

    let mut out = Vec::new();
    for (rel, _display, aliases) in &mine {
        // ① 가려진 별칭 — 같은 이름의 **다른** 글이 있다.
        //    자기 제목과 같은 별칭은 치지 않는다. 쓸모는 없지만 링크는 제목으로 닿는다.
        let shadowed: Vec<&String> = aliases
            .iter()
            .filter(|a| owners.get(*a).is_some_and(|v| v.iter().any(|r| r != rel)))
            .collect();
        if !shadowed.is_empty() {
            let names = shadowed
                .iter()
                .map(|a| format!("'{a}'"))
                .collect::<Vec<_>>()
                .join(", ");
            out.push(NoteIssue {
                rel_path: rel.clone(),
                kind: IssueKind::ShadowedAlias,
                label: IssueKind::ShadowedAlias.label().to_string(),
                detail: format!(
                    "{names}은(는) 이미 다른 글의 이름이라, 이 별칭으로 링크해도 그 글로 갑니다."
                ),
                suggestion: "이 글에서 그 별칭을 빼냅니다 (다른 별칭은 그대로 둡니다).".into(),
                fixable: true,
            });
        }

        // ② 겹치는 별칭 — 다른 글도 같은 별칭을 달았다.
        //    어느 쪽이 그 이름을 가져야 하는지는 앱이 정할 수 없으므로 알리기만 한다.
        let mut shared: Vec<String> = Vec::new();
        for a in aliases {
            let Some(holders) = claims.get(a) else { continue };
            if holders.len() < 2 {
                continue;
            }
            let others = holders
                .iter()
                .filter(|r| *r != rel)
                .map(|r| {
                    mine.iter()
                        .find(|(m, _, _)| m == r)
                        .map(|(_, d, _)| d.clone())
                        .unwrap_or_else(|| stem_of(r))
                })
                .collect::<Vec<_>>()
                .join(", ");
            shared.push(format!("'{a}' (함께 쓰는 글: {others})"));
        }
        if !shared.is_empty() {
            out.push(NoteIssue {
                rel_path: rel.clone(),
                kind: IssueKind::DuplicateAlias,
                label: IssueKind::DuplicateAlias.label().to_string(),
                detail: format!(
                    "{} — 이 별칭으로 링크하면 누를 때마다 어느 글인지 묻게 됩니다.",
                    shared.join(" / ")
                ),
                suggestion: "어느 글이 그 이름을 가질지 정하고, 나머지 글에서 별칭을 빼주세요."
                    .into(),
                fixable: false,
            });
        }
    }
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

    // 0) 동기화 충돌 사본인가 (읽기 전에 판정 가능).
    //    **자동으로 고치지 않는다** — 어느 쪽에 사용자의 마지막 수정이 들어 있는지
    //    파일만 봐서는 알 수 없다. 지우는 것은 사람이 내용을 확인한 뒤에 할 일이다.
    if let Some(original) = conflict_copy_of(abs) {
        return make(
            IssueKind::CloudConflictCopy,
            format!(
                "같은 폴더에 '{original}'이 함께 있습니다. \
                 두 기기에서 같은 글을 고쳐 클라우드가 사본을 남긴 것일 수 있습니다."
            ),
            "두 파일을 열어 비교하고, 필요한 내용을 하나로 합친 뒤 나머지를 지우세요.",
            false,
        );
    }

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
    if kind == IssueKind::DuplicateAlias {
        // 두 글이 같은 별칭을 달았을 때 어느 쪽이 그 이름을 가져야 하는지는
        // 앱이 알 수 없다. 한쪽을 임의로 지우면 사용자가 의도한 쪽이 지워질 수 있다.
        return Err(CoreError::Invalid(
            "겹치는 별칭은 자동으로 정리할 수 없습니다. 어느 글이 그 이름을 가질지 정한 뒤 나머지에서 빼주세요."
                .into(),
        ));
    }
    if kind == IssueKind::CloudConflictCopy {
        // 어느 쪽에 마지막 수정이 들어 있는지 파일만 봐서는 알 수 없다.
        // 잘못 고르면 사용자가 쓴 글이 사라진다 — 사람이 보고 정해야 한다.
        return Err(CoreError::Invalid(
            "동기화 충돌 사본은 자동으로 합칠 수 없습니다. 두 파일을 열어 확인한 뒤 하나로 정리해주세요."
                .into(),
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
        IssueKind::ShadowedAlias => {
            // **지금 다시 계산해서** 뺀다. 점검 목록을 띄워 둔 사이에 가리던 글이
            // 사라졌을 수 있는데, 그때 화면에 적힌 대로 지우면 멀쩡한 별칭을 잃는다.
            let kept = live_aliases(vault, &rel)?;
            if kept.is_empty() {
                fm.remove("aliases");
            } else {
                fm.insert("aliases".into(), json!(kept));
            }
        }
        IssueKind::ParseError | IssueKind::CloudConflictCopy | IssueKind::DuplicateAlias => {
            unreachable!("위에서 이미 걸렀다")
        }
    }

    vault.save_note(&rel, Value::Object(fm), &note.body)?;
    Ok(rel)
}

/// 이 글의 별칭 중 **아직 살아 있는 것**만 (같은 이름의 다른 글에 가리지 않은 것).
fn live_aliases(vault: &Vault, rel: &str) -> Result<Vec<String>, CoreError> {
    let notes = vault.list_notes()?;
    let mine = vault.parse_full(rel)?;
    Ok(mine
        .aliases
        .into_iter()
        .filter(|a| {
            !notes
                .iter()
                .any(|n| n.rel_path != rel && (n.title == *a || stem_of(&n.rel_path) == *a))
        })
        .collect())
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

    /// 별칭이 멀쩡하면 아무 말도 하지 않는다 (자기 제목과 같은 별칭도 고장은 아니다)
    #[test]
    fn 멀쩡한_별칭은_점검에_안_뜬다() {
        let (_d, v) = setup();
        v.create_note("free", "프로헥사디온 칼슘", json!({"aliases": ["비비풀"]}))
            .unwrap();
        // 자기 제목을 별칭으로 또 적어 둔 경우 — 쓸모는 없지만 링크는 제목으로 닿는다
        v.create_note("free", "메모", json!({"aliases": ["메모"]})).unwrap();
        assert!(audit(&v).is_empty(), "{:?}", audit(&v));
    }

    /// **가려진 별칭** — 나중에 같은 이름의 글이 생기면 별칭이 조용히 죽는다.
    /// 그 노트를 다시 열어 보지 않는 한 알 길이 없어서 점검이 맡는다.
    #[test]
    fn 가려진_별칭을_찾아_뺀다() {
        let (_d, v) = setup();
        let aliased = v
            .create_note("free", "프로헥사디온 칼슘", json!({"aliases": ["비비풀", "BB"]}))
            .unwrap();
        // 몇 달 뒤 '비비풀'이라는 제목의 글이 생겼다
        v.create_note("writing", "비비풀", json!({})).unwrap();

        let issues = audit(&v);
        let i = issues
            .iter()
            .find(|i| i.kind == IssueKind::ShadowedAlias)
            .expect("가려진 별칭을 못 찾았다");
        assert_eq!(i.rel_path, aliased);
        assert!(i.detail.contains("'비비풀'"), "{}", i.detail);
        assert!(!i.detail.contains("'BB'"), "멀쩡한 별칭까지 걸었다: {}", i.detail);
        assert!(i.fixable);

        fix(&v, &aliased, IssueKind::ShadowedAlias).unwrap();
        // 죽은 것만 빠지고 멀쩡한 별칭은 남는다
        assert_eq!(v.parse_full(&aliased).unwrap().aliases, vec!["BB"]);
        assert!(!audit(&v).iter().any(|i| i.kind == IssueKind::ShadowedAlias));
    }

    /// 별칭이 전부 죽었으면 `aliases` 키 자체를 지운다 (빈 배열을 남기지 않는다)
    #[test]
    fn 별칭이_전부_죽으면_키를_지운다() {
        let (_d, v) = setup();
        let aliased = v.create_note("free", "가나다", json!({"aliases": ["비비풀"]})).unwrap();
        v.create_note("writing", "비비풀", json!({})).unwrap();

        fix(&v, &aliased, IssueKind::ShadowedAlias).unwrap();
        let fm = v.read_note(&aliased).unwrap().frontmatter;
        assert!(fm.get("aliases").is_none(), "빈 aliases가 남았다: {fm:?}");
    }

    /// **겹치는 글**은 앱이 정할 수 없다 — 알리기만 하고 고치지 않는다
    #[test]
    fn 겹치는_별칭은_알리되_고치지_않는다() {
        let (_d, v) = setup();
        let a = v.create_note("free", "가나다", json!({"aliases": ["BB"]})).unwrap();
        let b = v.create_note("writing", "라마바", json!({"aliases": ["BB"]})).unwrap();

        let issues = audit(&v);
        let dup: Vec<&NoteIssue> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::DuplicateAlias)
            .collect();
        // 양쪽 모두에 뜬다 — 어느 쪽을 열어 고치든 되도록
        assert_eq!(dup.len(), 2, "{issues:?}");
        assert!(dup.iter().any(|i| i.rel_path == a));
        assert!(dup.iter().any(|i| i.rel_path == b));
        // 상대가 누구인지 알려 준다
        assert!(dup.iter().any(|i| i.detail.contains("라마바")), "{dup:?}");
        assert!(dup.iter().all(|i| !i.fixable));

        assert!(fix(&v, &a, IssueKind::DuplicateAlias).is_err(), "임의로 고쳤다");
    }

    /// 두 기기에서 같은 글을 고치면 클라우드가 사본을 남긴다. 앱에서는 노트가 하나
    /// 더 생긴 것처럼만 보여서, 어느 쪽이 최신인지 모른 채 절반을 잃는다.
    #[test]
    fn 동기화_충돌_사본을_찾아낸다() {
        let (d, v) = setup();
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        let original = v.abs(&rel).unwrap();
        let raw = fs::read_to_string(&original).unwrap();
        // iCloud가 남기는 모양: 원본 옆에 `이름 2.md`
        fs::write(original.with_file_name("메모 2.md"), &raw).unwrap();
        // 이름에 표시를 남기는 것들(Syncthing 등)은 원본이 없어도 알아본다
        fs::write(
            d.path().join("Free").join("딴글.sync-conflict-20260806-노트북.md"),
            &raw,
        )
        .unwrap();

        let issues = audit(&v);
        let found: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::CloudConflictCopy)
            .map(|i| i.rel_path.as_str())
            .collect();
        assert_eq!(found.len(), 2, "{issues:?}");
        // 사람이 확인해야 하는 일이므로 [고치기]를 내놓지 않는다
        assert!(issues
            .iter()
            .filter(|i| i.kind == IssueKind::CloudConflictCopy)
            .all(|i| !i.fixable));
    }

    /// 사람이 지은 이름과 앱이 붙인 접미사를 사본으로 오인하면 안 된다
    #[test]
    fn 사람이_지은_이름은_사본으로_보지_않는다() {
        let (_d, v) = setup();
        // 원본이 없는 `회의록 2` — 그냥 두 번째 회의록일 수 있다
        v.create_note("free", "회의록 2", json!({})).unwrap();
        // 이름이 겹쳐 앱이 붙인 접미사 `(2)`
        v.create_note("free", "메모", json!({})).unwrap();
        let dup = v.create_note("free", "메모", json!({})).unwrap();
        assert!(dup.contains("(2)"), "{dup}");

        assert!(
            audit(&v)
                .iter()
                .all(|i| i.kind != IssueKind::CloudConflictCopy),
            "{:?}",
            audit(&v)
        );
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
