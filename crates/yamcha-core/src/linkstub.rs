//! 가리키는 글이 없는 `[[링크]]`의 대상을 자유노트에 만들어 둔다.
//!
//! 링크를 먼저 쓰고 글은 나중에 채우는 흐름을 위한 것이다. 조용히 파일을 만드는 일이라
//! 세 가지를 지킨다.
//!
//! 1. **있으면 만들지 않는다.** 화면이 "없다"고 본 것을 믿지 않고 여기서 다시 푼다 —
//!    다른 창이 방금 만든 글과 겹치면 같은 이름이 둘 생긴다.
//! 2. **만든 글에 그 링크가 닿아야 한다.** 제목은 파일명 규칙으로 다듬어지고(`회의: 3월` →
//!    `회의 3월`) 제목 머릿글이 붙는다(`2026-08-11 장보기`). 닿지 않으면 쓴 이름을 별칭으로
//!    심는다 — 안 그러면 같은 링크가 볼 때마다 새 글을 하나씩 더 만든다.
//! 3. **손댄 글은 치우지 않는다.** 뒤처리(`is_untouched_link_stub`)는 여기서 만든 표시가 있고
//!    본문이 만들 때 그대로인 글만 본다.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::schema::Builtin;
use crate::vault::{is_ymd, NoteSummary, Vault};
use crate::{template, CoreError};

/// frontmatter 표시 — 이 글은 링크에서 자동으로 만들어졌다
pub const CREATED_FROM: &str = "created_from";
pub const CREATED_FROM_LINK: &str = "link";

/// 한 번에 만들 수 있는 최대 편수. 링크가 잔뜩 든 글을 붙여 넣었을 때 빈 글이 쏟아지지 않게.
pub const MAX_LINK_STUBS: usize = 20;

/// 자동으로 만든 글 하나
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct CreatedLink {
    /// 링크에 적힌 이름 (`[[이것]]`)
    pub target: String,
    pub rel_path: String,
    pub title: String,
}

/// `[[타깃|표시]]`·`[[타깃#섹션]]`에서 타깃만 (화면의 `linkTargetOf`와 같은 규칙)
fn target_of(raw: &str) -> String {
    let t = raw.trim();
    let t = t.strip_prefix("[[").unwrap_or(t);
    let t = t.strip_suffix("]]").unwrap_or(t);
    let t = t.split('|').next().unwrap_or("");
    let t = t.split('#').next().unwrap_or("");
    t.trim().to_string()
}

/// 이 이름으로는 글을 만들지 않는다.
///
/// - 빈 이름, 파일명으로 쓸 글자가 하나도 안 남는 이름
/// - `/`가 든 것 — 폴더까지 적은 링크다. 오타일 때 엉뚱한 자리에 만들 수 없다
/// - 날짜 모양 — 일지의 자리다 (자유노트에 `2026-11-12`가 생기면 일지와 헷갈린다)
fn skip_reason(target: &str) -> Option<&'static str> {
    if target.is_empty() {
        return Some("빈 이름");
    }
    if target.contains('/') || target.contains('\\') {
        return Some("폴더까지 적은 링크");
    }
    if is_ymd(target) {
        return Some("날짜");
    }
    let stem = Vault::sanitize_note_stem(target);
    if stem.is_empty() || stem == "무제" {
        return Some("파일명으로 쓸 수 없는 이름");
    }
    None
}

fn stem_of(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.strip_suffix(".md").unwrap_or(name)
}

fn aliases_of(n: &NoteSummary) -> Vec<String> {
    n.frontmatter
        .as_object()
        .map(crate::parse::extract_aliases)
        .unwrap_or_default()
}

/// 이 이름이 이미 어떤 글에 닿는가 — 제목·파일명·별칭 (대소문자를 가린다. 화면의
/// `resolveLink`·백링크를 세는 색인과 같은 규칙)
fn reaches(notes: &[NoteSummary], target: &str) -> bool {
    notes
        .iter()
        .any(|n| n.title == target || stem_of(&n.rel_path) == target || aliases_of(n).iter().any(|a| a == target))
}

impl Vault {
    /// 가리키는 글이 없는 링크 대상들을 자유노트에 만든다 → 만든 글들.
    ///
    /// 이미 닿는 글이 있는 이름, 만들지 않기로 한 이름(`skip_reason`)은 조용히 건너뛴다.
    /// 새로 만들 것이 `MAX_LINK_STUBS`를 넘으면 **하나도 만들지 않고** 거절한다.
    pub fn ensure_link_targets(&self, targets: &[String]) -> Result<Vec<CreatedLink>, CoreError> {
        let notes = self.list_notes()?;
        let mut wanted: Vec<String> = Vec::new();
        for raw in targets {
            let t = target_of(raw);
            if skip_reason(&t).is_some() || reaches(&notes, &t) || wanted.contains(&t) {
                continue;
            }
            wanted.push(t);
        }
        if wanted.len() > MAX_LINK_STUBS {
            return Err(CoreError::Invalid(format!(
                "없는 글로 이어진 링크가 {}개입니다. 한 번에 {}개까지만 자동으로 만듭니다.",
                wanted.len(),
                MAX_LINK_STUBS
            )));
        }

        let mut out = Vec::new();
        for target in wanted {
            let rel = self.create_note(
                Builtin::Free.id(),
                &target,
                json!({ CREATED_FROM: CREATED_FROM_LINK }),
            )?;
            let made = self.note_summary(&rel)?;
            // 다듬어진 제목·머릿글 때문에 링크가 안 닿으면 쓴 이름을 별칭으로 심는다
            if made.title != target && stem_of(&rel) != target {
                self.update_frontmatter(&rel, json!({ "aliases": [target] }))?;
            }
            out.push(CreatedLink { target, rel_path: rel, title: made.title });
        }
        Ok(out)
    }

    /// 링크에서 자동으로 만든 뒤 **아무도 손대지 않은** 글인가.
    ///
    /// 표시(`created_from: link`)가 있고, 본문이 비었거나 만들 때의 템플릿 그대로일 때만 참.
    /// 한 글자라도 다르면 손댄 것으로 본다 — 템플릿을 그 뒤에 바꿨거나 `{{time}}`이 들어 있어
    /// 비교가 어긋나는 경우도 "손댔다" 쪽으로 떨어진다(치우지 않는 쪽이 안전하다).
    pub fn is_untouched_link_stub(&self, rel: &str) -> Result<bool, CoreError> {
        let note = self.read_note(rel)?;
        if note.note_type != Builtin::Free.id() {
            return Ok(false);
        }
        let fm = match note.frontmatter.as_object() {
            Some(fm) => fm,
            None => return Ok(false),
        };
        if fm.get(CREATED_FROM).and_then(Value::as_str) != Some(CREATED_FROM_LINK) {
            return Ok(false);
        }
        let body = note.body.trim();
        if body.is_empty() {
            return Ok(true);
        }
        // 만들 때 템플릿에 들어간 제목은 머릿글을 뺀, 링크에 적힌 이름이다.
        // 별칭을 심었으면 그것이 그 이름이고, 아니면 제목이 곧 그 이름이다.
        let aliases = crate::parse::extract_aliases(fm);
        let raw = match aliases.first() {
            Some(a) => Vault::sanitize_note_stem(a),
            None => fm
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| stem_of(rel).to_string()),
        };
        let date = fm.get("date").and_then(Value::as_str).unwrap_or("");
        let fresh = template::render_template(&self.body_template(Builtin::Free), date, &raw);
        Ok(body == fresh.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    fn names(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 없는_이름은_자유노트에_만든다() {
        let (_d, v) = vault();
        let made = v.ensure_link_targets(&names(&["새 글"])).unwrap();
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].rel_path, "Free/새 글.md");
        assert_eq!(made[0].title, "새 글");
        let note = v.read_note(&made[0].rel_path).unwrap();
        assert_eq!(note.note_type, "free");
        assert_eq!(note.frontmatter[CREATED_FROM], CREATED_FROM_LINK);
    }

    #[test]
    fn 이미_있으면_만들지_않는다_제목_파일명_별칭() {
        let (_d, v) = vault();
        v.create_note("free", "카레", json!({})).unwrap();
        v.create_note("writing", "초고", json!({ "aliases": ["비비풀"] })).unwrap();
        let made = v.ensure_link_targets(&names(&["카레", "초고", "비비풀"])).unwrap();
        assert!(made.is_empty(), "있는 글을 또 만들었다: {made:?}");
    }

    #[test]
    fn 두_번_불러도_한_편() {
        let (_d, v) = vault();
        assert_eq!(v.ensure_link_targets(&names(&["장보기"])).unwrap().len(), 1);
        assert!(v.ensure_link_targets(&names(&["장보기"])).unwrap().is_empty());
        let free = v.list_notes_of_type("free").unwrap();
        assert_eq!(free.len(), 1);
    }

    #[test]
    fn 같은_이름이_한_번에_여러_번_와도_한_편() {
        let (_d, v) = vault();
        let made = v
            .ensure_link_targets(&names(&["장보기", "[[장보기|살 것]]", "장보기#채소"]))
            .unwrap();
        assert_eq!(made.len(), 1);
    }

    /// 파일명으로 못 쓰는 글자가 빠져 제목이 달라져도 그 링크로 닿는다 — 안 닿으면
    /// 같은 링크가 볼 때마다 새 글을 만든다.
    #[test]
    fn 제목이_다듬어져도_링크가_닿는다() {
        let (_d, v) = vault();
        let target = "회의: 3월";
        let made = v.ensure_link_targets(&names(&[target])).unwrap();
        assert_eq!(made.len(), 1);
        assert_ne!(made[0].title, target, "이 시험은 제목이 다듬어지는 경우를 본다");
        let notes = v.list_notes().unwrap();
        assert!(reaches(&notes, target), "만든 글에 링크가 닿지 않는다");
        assert!(v.ensure_link_targets(&names(&[target])).unwrap().is_empty(), "또 만들었다");
    }

    /// 제목 머릿글(`2026-11-12 장보기`)이 붙어도 `[[장보기]]`로 닿고, 뒤처리도 알아본다.
    #[test]
    fn 머릿글이_붙어도_링크가_닿는다() {
        let (_d, v) = vault();
        v.write_title_template("free", "{{date}} ").unwrap();
        let made = v.ensure_link_targets(&names(&["장보기"])).unwrap();
        assert_eq!(made[0].title, format!("{} 장보기", Vault::today()));
        assert!(reaches(&v.list_notes().unwrap(), "장보기"));
        assert!(v.ensure_link_targets(&names(&["장보기"])).unwrap().is_empty(), "또 만들었다");
        assert!(v.is_untouched_link_stub(&made[0].rel_path).unwrap());
    }

    #[test]
    fn 만들지_않는_이름들() {
        let (_d, v) = vault();
        let made = v
            .ensure_link_targets(&names(&["", "  ", "Books/없는 책", "2026-11-12", "///", "[[|표시만]]"]))
            .unwrap();
        assert!(made.is_empty(), "{made:?}");
        assert!(v.list_notes().unwrap().is_empty());
    }

    #[test]
    fn 너무_많으면_하나도_만들지_않는다() {
        let (_d, v) = vault();
        let many: Vec<String> = (0..=MAX_LINK_STUBS).map(|i| format!("글 {i}")).collect();
        assert!(v.ensure_link_targets(&many).is_err());
        assert!(v.list_notes().unwrap().is_empty());
        // 문턱까지는 만든다
        assert_eq!(v.ensure_link_targets(&many[..MAX_LINK_STUBS]).unwrap().len(), MAX_LINK_STUBS);
    }

    #[test]
    fn 갓_만든_글은_손대지_않은_것으로_본다() {
        let (_d, v) = vault();
        let made = v.ensure_link_targets(&names(&["새 글", "회의: 3월"])).unwrap();
        for m in &made {
            assert!(v.is_untouched_link_stub(&m.rel_path).unwrap(), "{}", m.rel_path);
        }
    }

    #[test]
    fn 본문에_한_글자라도_쓰면_손댄_글이다() {
        let (_d, v) = vault();
        let rel = v.ensure_link_targets(&names(&["새 글"])).unwrap().remove(0).rel_path;
        let note = v.read_note(&rel).unwrap();
        v.save_note(&rel, note.frontmatter, &format!("{}\n가", note.body)).unwrap();
        assert!(!v.is_untouched_link_stub(&rel).unwrap());
    }

    #[test]
    fn 표시가_없는_빈_글은_건드리지_않는다() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "내가 만든 빈 글", json!({})).unwrap();
        assert!(!v.is_untouched_link_stub(&rel).unwrap());
    }

    #[test]
    fn 다른_분류로_옮긴_글은_건드리지_않는다() {
        let (_d, v) = vault();
        let rel = v.ensure_link_targets(&names(&["새 글"])).unwrap().remove(0).rel_path;
        let moved = v.move_note(&rel, "writing").unwrap().rel;
        assert!(!v.is_untouched_link_stub(&moved).unwrap());
    }
}
