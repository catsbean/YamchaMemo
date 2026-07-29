//! frontmatter 분리/합성, 위키링크·태그 추출.

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

use crate::error::CoreError;

/// 파일 내용을 (frontmatter YAML 문자열, 본문)으로 분리.
/// frontmatter가 없으면 (None, 전체)를 반환한다.
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(rest) = content.strip_prefix("---") else {
        return (None, content);
    };
    let Some(rest) = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')) else {
        return (None, content);
    };
    // 종료 구분자: 줄 시작의 "---"
    for (idx, line_start) in close_delim_candidates(rest) {
        let _ = line_start;
        let yaml = &rest[..idx];
        let after = &rest[idx..];
        let after = after
            .strip_prefix("---")
            .expect("candidate starts with ---");
        let body = after
            .strip_prefix("\r\n")
            .or_else(|| after.strip_prefix('\n'))
            .unwrap_or(after);
        return (Some(yaml), body);
    }
    (None, content)
}

/// rest 안에서 줄 시작 위치의 "---" 오프셋을 찾는다 (첫 번째 것만 사용).
fn close_delim_candidates(rest: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            out.push((offset, offset));
            break;
        }
        offset += line.len();
    }
    // 파일이 개행 없이 "---"로 끝나는 경우
    if out.is_empty() && rest.ends_with("\n---") {
        out.push((rest.len() - 3, rest.len() - 3));
    }
    out
}

/// YAML frontmatter 문자열 → JSON 오브젝트 (키 순서 보존)
pub fn parse_frontmatter(yaml: &str) -> Result<Map<String, Value>, CoreError> {
    if yaml.trim().is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_yaml_ng::from_str(yaml)
        .map_err(|e| CoreError::Frontmatter(e.to_string()))?;
    match value {
        Value::Object(map) => Ok(map),
        Value::Null => Ok(Map::new()),
        _ => Err(CoreError::Frontmatter(
            "frontmatter는 키-값 맵이어야 합니다".into(),
        )),
    }
}

/// JSON 오브젝트 → YAML 문자열 (끝 개행 포함)
pub fn serialize_frontmatter(fm: &Map<String, Value>) -> Result<String, CoreError> {
    let yaml = serde_yaml_ng::to_string(&Value::Object(fm.clone()))
        .map_err(|e| CoreError::Frontmatter(e.to_string()))?;
    Ok(yaml)
}

/// frontmatter + 본문 → 파일 전체 내용
pub fn compose(fm: &Map<String, Value>, body: &str) -> Result<String, CoreError> {
    let yaml = serialize_frontmatter(fm)?;
    Ok(format!("---\n{yaml}---\n\n{}", body.trim_start_matches('\n')))
}

/// 본문에서 위키링크 타깃 추출: `[[타깃]]`, `[[타깃|표시명]]`, `[[타깃#섹션]]`
pub fn extract_wikilinks(text: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\[\[([^\]\[|#]+)(?:#[^\]\[|]*)?(?:\|[^\]\[]*)?\]\]").unwrap());
    re.captures_iter(text)
        .map(|c| c[1].trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 본문에서 인라인 태그 추출: `#태그` (한글/영문/숫자/슬래시/하이픈/언더스코어)
pub fn extract_inline_tags(text: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"(?:^|\s)#([\p{L}\p{N}/_-]+)").unwrap());
    re.captures_iter(text).map(|c| c[1].to_string()).collect()
}

/// 본문에서 아직 끝내지 않은 할 일 개수.
///
/// **내용이 비어 있는 체크박스는 세지 않는다.** 데일리노트 기본 템플릿이 빈 `- [ ] `를
/// 넣어 두기 때문에, 그걸 세면 아무것도 안 쓴 날에도 "미완 1건"이 되어 버린다.
/// 콜아웃(`>`) 안의 체크박스는 센다.
pub fn count_open_todos(body: &str) -> u32 {
    open_todo_texts(body).len() as u32
}

/// 미완 할 일의 내용만 뽑는다 (규칙은 `count_open_todos`와 동일).
pub fn open_todo_texts(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|line| {
            let t = line.trim_start().trim_start_matches('>').trim_start();
            let rest = t
                .strip_prefix("- ")
                .or_else(|| t.strip_prefix("* "))
                .or_else(|| t.strip_prefix("+ "))?;
            let text = rest.trim_start().strip_prefix("[ ]")?.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn open_todos_skips_empty_checkbox() {
        let body = "## 할 일\n\n- [ ] \n- [ ] 장보기\n- [x] 이미 함\n* [ ] 별표도 인정\n";
        // 템플릿이 넣어 둔 빈 체크박스는 빼고 2건
        assert_eq!(count_open_todos(body), 2);
    }

    #[test]
    fn open_todos_counts_inside_callout_and_indent() {
        let body = "> [!생각] 2026-07-18\n> - [ ] 콜아웃 안의 할 일\n  - [ ] 들여쓴 할 일\n- [X] 대문자 완료\n";
        assert_eq!(count_open_todos(body), 2);
    }

    #[test]
    fn open_todos_ignores_non_tasks() {
        assert_eq!(count_open_todos("- 그냥 목록\n[ ] 리스트 아님\n본문"), 0);
        assert_eq!(count_open_todos(""), 0);
    }

    #[test]
    fn split_basic() {
        let (fm, body) = split_frontmatter("---\ndate: 2026-07-18\ntype: daily\n---\n\n본문");
        assert_eq!(fm, Some("date: 2026-07-18\ntype: daily\n"));
        assert_eq!(body, "\n본문");
    }

    #[test]
    fn split_crlf() {
        let (fm, body) = split_frontmatter("---\r\ndate: 2026-07-18\r\n---\r\n본문");
        assert_eq!(fm, Some("date: 2026-07-18\r\n"));
        assert_eq!(body, "본문");
    }

    #[test]
    fn split_no_frontmatter() {
        let (fm, body) = split_frontmatter("그냥 본문\n---\n구분선");
        assert_eq!(fm, None);
        assert_eq!(body, "그냥 본문\n---\n구분선");
    }

    #[test]
    fn parse_and_compose_roundtrip() {
        let (fm_str, body) =
            split_frontmatter("---\ndate: 2026-07-18\ntype: book\ntags:\n  - 독서\n---\n\n## 소개\n");
        let fm = parse_frontmatter(fm_str.unwrap()).unwrap();
        assert_eq!(fm["type"], json!("book"));
        assert_eq!(fm["tags"], json!(["독서"]));
        let composed = compose(&fm, body).unwrap();
        let (fm2_str, body2) = split_frontmatter(&composed);
        let fm2 = parse_frontmatter(fm2_str.unwrap()).unwrap();
        assert_eq!(fm, fm2);
        assert_eq!(body2.trim(), body.trim());
    }

    #[test]
    fn wikilinks() {
        let links = extract_wikilinks("[[클린 코드]]와 [[함께 자라기|자라기]] 그리고 [[책#챕터1]]");
        assert_eq!(links, vec!["클린 코드", "함께 자라기", "책"]);
    }

    #[test]
    fn inline_tags() {
        let tags = extract_inline_tags("오늘 #독서 그리고 #개발/rust 공부 c#은 태그 아님");
        assert_eq!(tags, vec!["독서", "개발/rust"]);
    }
}
