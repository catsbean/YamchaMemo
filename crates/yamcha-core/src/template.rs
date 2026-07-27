//! 타입별 본문 템플릿과 독서기록 콜아웃 엔트리 블록.

use chrono::Datelike;

use crate::schema::{Builtin, EntryKind};

/// 내장 타입의 초기 본문 템플릿
pub fn builtin_body_template(b: Builtin) -> &'static str {
    match b {
        // 책 = 소개 + 기록(독서기록 콜아웃 누적) 두 섹션
        Builtin::Book => "## 소개\n\n## 기록\n\n",
        // 글쓰기 본문 = 원고 그 자체
        Builtin::Writing => "",
        Builtin::Daily => "## 할 일\n\n- [ ] \n\n## 기록\n\n",
        Builtin::Info => "",
        Builtin::Free => "",
    }
}

/// 책 본문을 (소개, 기록) 두 섹션으로 분리한다.
/// `## 기록` 헤더 기준으로 나누고, 소개는 `## 소개` 헤더를 제거한 내용.
pub fn split_book_body(body: &str) -> (String, String) {
    let mut intro_lines: Vec<&str> = Vec::new();
    let mut record_lines: Vec<&str> = Vec::new();
    let mut in_records = false;
    for line in body.lines() {
        if !in_records && line.trim() == "## 기록" {
            in_records = true;
            continue;
        }
        if in_records {
            record_lines.push(line);
        } else {
            intro_lines.push(line);
        }
    }
    let intro_raw = intro_lines.join("\n");
    let intro = intro_raw
        .trim_start()
        .strip_prefix("## 소개")
        .unwrap_or(intro_raw.trim_start())
        .trim()
        .to_string();
    let records = record_lines.join("\n").trim().to_string();
    (intro, records)
}

/// (소개, 기록)을 책 본문으로 재조립한다.
pub fn compose_book_body(intro: &str, records: &str) -> String {
    let intro = intro.trim();
    let records = records.trim();
    let mut s = String::from("## 소개\n\n");
    if !intro.is_empty() {
        s.push_str(intro);
        s.push_str("\n\n");
    }
    s.push_str("## 기록\n\n");
    if !records.is_empty() {
        s.push_str(records);
        s.push('\n');
    }
    s
}

const WEEKDAYS: [&str; 7] = ["월", "화", "수", "목", "금", "토", "일"];

/// 템플릿 플레이스홀더 치환.
/// `{{date}}` `{{title}}` `{{weekday}}` `{{yesterday}}` `{{time}}`
/// — 날짜 파생 값은 `date`가 `YYYY-MM-DD`일 때만 치환되고, 아니면 원문을 남긴다.
pub fn render_template(template: &str, date: &str, title: &str) -> String {
    let mut s = template.replace("{{date}}", date).replace("{{title}}", title);
    if s.contains("{{time}}") {
        s = s.replace("{{time}}", &chrono::Local::now().format("%H:%M").to_string());
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        if s.contains("{{weekday}}") {
            let idx = d.weekday().num_days_from_monday() as usize;
            s = s.replace("{{weekday}}", WEEKDAYS[idx]);
        }
        if s.contains("{{yesterday}}") {
            let y = d - chrono::Duration::days(1);
            s = s.replace("{{yesterday}}", &y.format("%Y-%m-%d").to_string());
        }
    }
    s
}

/// 독서기록 엔트리를 콜아웃 블록으로 생성:
/// ```markdown
/// > [!발췌] 2026-07-18
/// > 인용문 첫 줄
/// > 둘째 줄
/// ```
pub fn reading_entry_block(existing_body: &str, date: &str, kind: EntryKind, text: &str) -> String {
    // 빈 줄로 분리해야 이전 콜아웃과 합쳐지지 않는다
    let sep = if existing_body.trim().is_empty() {
        ""
    } else {
        "\n\n"
    };
    let mut block = format!("{sep}> [!{}] {date}\n", kind.label());
    let text = text.trim();
    if text.is_empty() {
        block.push_str("> \n");
    } else {
        for line in text.lines() {
            block.push_str(&format!("> {line}\n"));
        }
    }
    block.push('\n');
    block
}

/// 기록 섹션에서 뽑아낸 콜아웃 엔트리 하나
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEntry {
    /// 콜아웃 이름 그대로 (발췌/생각/요약/질문 — 외부에서 넣은 다른 이름도 그대로 둔다)
    pub kind_label: String,
    /// 헤더에 적힌 날짜 (없으면 빈 문자열)
    pub date: String,
    /// `> ` 접두어를 걷어낸 본문
    pub text: String,
}

/// 기록 섹션(`## 기록` 이하)을 콜아웃 단위로 분해한다.
/// `> [!종류] 날짜` 줄로 시작하고, 이어지는 `>` 줄들이 본문이다.
/// 콜아웃 헤더가 아닌 일반 인용문은 무시한다.
pub fn parse_entries(records: &str) -> Vec<ParsedEntry> {
    let mut out: Vec<ParsedEntry> = Vec::new();
    let mut cur: Option<ParsedEntry> = None;
    let mut lines: Vec<String> = Vec::new();

    fn flush(cur: &mut Option<ParsedEntry>, lines: &mut Vec<String>, out: &mut Vec<ParsedEntry>) {
        if let Some(mut e) = cur.take() {
            e.text = lines.join("\n").trim().to_string();
            out.push(e);
        }
        lines.clear();
    }

    for line in records.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix('>') {
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            // 콜아웃 헤더인가: [!이름] 뒤에 날짜(선택)
            if let Some(header) = rest.trim_start().strip_prefix("[!") {
                if let Some((name, after)) = header.split_once(']') {
                    flush(&mut cur, &mut lines, &mut out);
                    cur = Some(ParsedEntry {
                        kind_label: name.trim().to_string(),
                        date: after.trim().to_string(),
                        text: String::new(),
                    });
                    continue;
                }
            }
            if cur.is_some() {
                lines.push(rest.to_string());
            }
        } else if trimmed.is_empty() {
            // 빈 줄은 콜아웃의 끝
            flush(&mut cur, &mut lines, &mut out);
        } else {
            // 인용이 아닌 본문 줄 — 콜아웃 밖이다
            flush(&mut cur, &mut lines, &mut out);
        }
    }
    flush(&mut cur, &mut lines, &mut out);
    out
}

/// 독서기록 파일명(stem): `독서기록_{책제목}_{저자}`
pub fn reading_file_stem(book_title: &str, author: &str) -> String {
    if author.trim().is_empty() {
        format!("독서기록_{book_title}")
    } else {
        format!("독서기록_{book_title}_{author}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_block_is_callout() {
        let first = reading_entry_block("", "2026-07-18", EntryKind::Excerpt, "인용문\n둘째 줄");
        assert_eq!(first, "> [!발췌] 2026-07-18\n> 인용문\n> 둘째 줄\n\n");
        let next = reading_entry_block("이미 내용", "2026-07-19", EntryKind::Thought, "생각");
        assert!(next.starts_with("\n\n> [!생각] 2026-07-19\n> 생각\n"));
    }

    #[test]
    fn render_placeholders() {
        assert_eq!(
            render_template("# {{title}}\n{{date}}", "2026-07-18", "제목"),
            "# 제목\n2026-07-18"
        );
    }

    #[test]
    fn render_date_derived_placeholders() {
        // 2026-07-18은 토요일
        assert_eq!(
            render_template("{{date}}({{weekday}}) 어제={{yesterday}}", "2026-07-18", ""),
            "2026-07-18(토) 어제=2026-07-17"
        );
        // 월 경계
        assert_eq!(render_template("{{yesterday}}", "2026-08-01", ""), "2026-07-31");
        // 날짜를 알 수 없으면 원문 유지 (깨진 텍스트를 만들지 않는다)
        assert_eq!(render_template("{{weekday}}", "언젠가", ""), "{{weekday}}");
    }

    #[test]
    fn reading_stem() {
        assert_eq!(
            reading_file_stem("클린 코드", "로버트 마틴"),
            "독서기록_클린 코드_로버트 마틴"
        );
        assert_eq!(reading_file_stem("무저자", ""), "독서기록_무저자");
    }

    #[test]
    fn parse_entries_basic() {
        let records = "> [!발췌] 2026-07-18\n> 첫 줄\n> 둘째 줄\n\n> [!생각] 2026-07-19\n> 생각한 것\n";
        let es = parse_entries(records);
        assert_eq!(es.len(), 2);
        assert_eq!(es[0].kind_label, "발췌");
        assert_eq!(es[0].date, "2026-07-18");
        assert_eq!(es[0].text, "첫 줄\n둘째 줄");
        assert_eq!(es[1].kind_label, "생각");
        assert_eq!(es[1].text, "생각한 것");
    }

    #[test]
    fn parse_entries_tolerates_외부_편집() {
        // 날짜 없는 콜아웃, 앱이 모르는 이름, 빈 콜아웃, 일반 인용문
        let records = "> [!메모]\n> 옵시디언에서 넣은 것\n\n> [!발췌]\n\n> 그냥 인용문\n";
        let es = parse_entries(records);
        assert_eq!(es.len(), 2);
        assert_eq!(es[0].kind_label, "메모");
        assert_eq!(es[0].date, "");
        assert_eq!(es[0].text, "옵시디언에서 넣은 것");
        assert_eq!(es[1].kind_label, "발췌");
        assert_eq!(es[1].text, "");
    }

    #[test]
    fn parse_entries_ignores_non_callout() {
        assert!(parse_entries("그냥 본문\n\n> 인용만 있음\n").is_empty());
        assert!(parse_entries("").is_empty());
    }

    /// 실제로 append_reading_entry가 만든 형태를 그대로 되읽을 수 있어야 한다
    #[test]
    fn parse_entries_roundtrips_with_reading_entry_block() {
        let mut body = String::new();
        body.push_str(&reading_entry_block(&body, "2026-07-18", EntryKind::Excerpt, "인용문"));
        body.push_str(&reading_entry_block(&body, "2026-07-19", EntryKind::Question, "왜?\n정말?"));
        let es = parse_entries(&body);
        assert_eq!(es.len(), 2);
        assert_eq!(es[0].text, "인용문");
        assert_eq!(es[1].kind_label, "질문");
        assert_eq!(es[1].text, "왜?\n정말?");
    }

    #[test]
    fn book_body_split_compose() {
        let body = "## 소개\n\n좋은 책이다.\n\n## 기록\n\n> [!발췌] 2026-07-19\n> 인용\n";
        let (intro, records) = split_book_body(body);
        assert_eq!(intro, "좋은 책이다.");
        assert!(records.starts_with("> [!발췌]"));

        let recomposed = compose_book_body(&intro, &records);
        assert!(recomposed.contains("## 소개\n\n좋은 책이다."));
        assert!(recomposed.contains("## 기록\n\n> [!발췌]"));

        // 기록 섹션이 없는 옛 책도 안전하게 분리
        let (intro2, records2) = split_book_body("## 소개\n\n소개만 있음\n");
        assert_eq!(intro2, "소개만 있음");
        assert_eq!(records2, "");
    }
}
