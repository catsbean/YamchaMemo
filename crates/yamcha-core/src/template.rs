//! 타입별 본문 템플릿과 독서기록 콜아웃 엔트리 블록.

use chrono::Datelike;

use crate::schema::{Builtin, DailyKind, EntryKind};

/// 내장 타입의 초기 본문 템플릿
pub fn builtin_body_template(b: Builtin) -> &'static str {
    match b {
        // 책 = 소개 + 기록(독서기록 콜아웃 누적) 두 섹션
        Builtin::Book => "## 소개\n\n## 기록\n\n",
        // 글쓰기 본문 = 원고 그 자체
        Builtin::Writing => "",
        Builtin::Daily => "## 할 일\n\n- [ ] \n\n## 기록\n\n",
        // 정보노트 = 어디서 얻은 정보를 정리해 두는 곳.
        // 출처는 frontmatter에 있으니 본문은 "무엇을 알았나 / 원문 / 내 생각" 세 칸.
        Builtin::Info => "## 요약\n\n## 내용\n\n## 메모\n\n",
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
///
/// `{{date}}` `{{title}}` `{{time}}` 은 언제나,
/// 날짜에서 나오는 값(`{{weekday}}` `{{yesterday}}` `{{tomorrow}}` `{{month}}`
/// `{{year}}` `{{week}}`)은 `date`가 `YYYY-MM-DD`일 때만 치환한다.
/// 모르는 자리표시자는 건드리지 않고 원문으로 남긴다 — 사용자가 오타를 알아채야 한다.
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
        if s.contains("{{tomorrow}}") {
            let t = d + chrono::Duration::days(1);
            s = s.replace("{{tomorrow}}", &t.format("%Y-%m-%d").to_string());
        }
        if s.contains("{{month}}") {
            s = s.replace("{{month}}", &d.format("%Y-%m").to_string());
        }
        if s.contains("{{year}}") {
            s = s.replace("{{year}}", &d.format("%Y").to_string());
        }
        if s.contains("{{week}}") {
            // ISO 주차 — 주간 회고를 적어 두기 좋다
            s = s.replace("{{week}}", &format!("{}주", d.iso_week().week()));
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

/// 빈 체크박스 자리표시자(`- [ ]`)인지 — 기본 데일리 템플릿이 넣어두는 빈 줄이라
/// 실제 할 일을 추가할 때는 걷어낸다.
fn is_empty_checkbox(line: &str) -> bool {
    let t = line.trim();
    matches!(t, "- [ ]" | "* [ ]" | "- [x]" | "* [x]")
}

/// 본문의 특정 `## 섹션` 끝에 블록을 덧붙인다.
///
/// 섹션이 없으면 본문 맨 뒤에 섹션째 새로 만들어 붙인다 — 데일리 템플릿은 사용자가
/// 자유롭게 고칠 수 있어서 `## 할 일`/`## 기록`이 없을 수 있기 때문이다.
///
/// `tight=true`(목록용)면 기존 내용 바로 다음 줄에 붙이고 빈 체크박스 자리표시자를
/// 걷어낸다. `false`(콜아웃용)면 빈 줄로 띄운다.
pub fn append_to_section(body: &str, section: &str, block: &str, tight: bool) -> String {
    let block = block.trim_end();
    if block.is_empty() {
        return body.to_string();
    }
    let lines: Vec<&str> = body.lines().collect();

    let Some(start) = lines.iter().position(|l| l.trim() == section) else {
        // 섹션 없음 → 맨 뒤에 새로 만든다
        let mut s = body.trim_end().to_string();
        if !s.is_empty() {
            s.push_str("\n\n");
        }
        s.push_str(section);
        s.push_str("\n\n");
        s.push_str(block);
        s.push('\n');
        return s;
    };

    // 다음 `## ` 헤더 직전까지가 이 섹션
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, l)| l.trim_start().starts_with("## "))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());

    let mut section_lines: Vec<&str> = lines[start + 1..end].to_vec();
    if tight {
        section_lines.retain(|l| !is_empty_checkbox(l));
    }
    let section_body = section_lines.join("\n");
    let section_body = section_body.trim();

    let mut s = lines[..=start].join("\n");
    s.push_str("\n\n");
    if !section_body.is_empty() {
        s.push_str(section_body);
        s.push_str(if tight { "\n" } else { "\n\n" });
    }
    s.push_str(block);
    s.push('\n');

    let tail = lines[end..].join("\n");
    let tail = tail.trim();
    if !tail.is_empty() {
        s.push('\n');
        s.push_str(tail);
        s.push('\n');
    }
    s
}

/// 임의 이름으로 콜아웃 블록을 만든다 (커스텀 종류·종류 변경에서 함께 쓴다).
pub fn callout_block(label: &str, meta: &str, text: &str) -> String {
    let mut block = if meta.trim().is_empty() {
        format!("> [!{label}]\n")
    } else {
        format!("> [!{label}] {}\n", meta.trim())
    };
    let text = text.trim();
    if text.is_empty() {
        block.push_str("> \n");
    } else {
        for line in text.lines() {
            block.push_str(&format!("> {line}\n"));
        }
    }
    block
}

/// index번째 콜아웃의 **종류 이름만** 바꾼다 (날짜·본문은 유지). 범위 밖이면 None.
pub fn replace_entry_kind(records: &str, index: usize, new_label: &str) -> Option<String> {
    let ranges = entry_line_ranges(records);
    let &(start, _) = ranges.get(index)?;
    let mut lines: Vec<String> = records.lines().map(|s| s.to_string()).collect();
    let header = lines.get(start)?.clone();
    let m = header.find("[!")?;
    let close = header[m..].find(']')? + m;
    lines[start] = format!("{}[!{}]{}", &header[..m], new_label, &header[close + 1..]);
    Some(lines.join("\n"))
}

/// 데일리 빠른 입력 블록. 할 일은 체크박스 줄(여러 줄이면 각각), 나머지는 시각이 붙은 콜아웃.
pub fn daily_entry_block(kind: DailyKind, time: &str, text: &str) -> String {
    let text = text.trim();
    match kind {
        DailyKind::Todo => text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| {
                // 사용자가 이미 "- [ ] "를 붙여 적었으면 중복하지 않는다
                let l = l
                    .strip_prefix("- [ ]")
                    .or_else(|| l.strip_prefix("* [ ]"))
                    .unwrap_or(l)
                    .trim();
                format!("- [ ] {l}")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => {
            let mut block = format!("> [!{}] {time}\n", kind.label());
            if text.is_empty() {
                block.push_str("> \n");
            } else {
                for line in text.lines() {
                    block.push_str(&format!("> {line}\n"));
                }
            }
            block
        }
    }
}

/// 본문에서 `## 섹션` 아래 내용만 떼어낸다 (헤더 줄 제외). 섹션이 없으면 None.
pub fn section_text(body: &str, section: &str) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let start = lines.iter().position(|l| l.trim() == section)?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, l)| l.trim_start().starts_with("## "))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());
    Some(lines[start + 1..end].join("\n").trim().to_string())
}

/// `## 섹션` 아래 내용을 통째로 새 내용으로 교체한다. 섹션이 없으면 None.
pub fn replace_section_text(body: &str, section: &str, new_text: &str) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let start = lines.iter().position(|l| l.trim() == section)?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, l)| l.trim_start().starts_with("## "))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());

    let mut s = lines[..=start].join("\n");
    s.push_str("\n\n");
    let new_text = new_text.trim();
    if !new_text.is_empty() {
        s.push_str(new_text);
        s.push('\n');
    }
    let tail = lines[end..].join("\n");
    let tail = tail.trim();
    if !tail.is_empty() {
        s.push('\n');
        s.push_str(tail);
        s.push('\n');
    }
    Some(s)
}

/// 기록 섹션에서 각 콜아웃 엔트리가 차지하는 줄 범위 `[start, end)`를 순서대로 돌려준다.
/// `parse_entries`와 같은 순서·개수라서 인덱스로 짝지을 수 있다.
/// (수정·삭제할 때 원문을 재조립하지 않고 해당 줄만 갈아끼우기 위해 쓴다)
pub fn entry_line_ranges(records: &str) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    let mut count = 0usize;

    for (i, line) in records.lines().enumerate() {
        count = i + 1;
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix('>') {
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            if let Some(header) = rest.trim_start().strip_prefix("[!") {
                if header.contains(']') {
                    if let Some(s) = start.take() {
                        out.push((s, i));
                    }
                    start = Some(i);
                    continue;
                }
            }
            // 콜아웃 본문 줄 — 진행 중인 엔트리에 속한다 (밖이면 그냥 인용문이라 무시)
        } else {
            // 빈 줄이나 인용이 아닌 줄에서 콜아웃이 끝난다
            if let Some(s) = start.take() {
                out.push((s, i));
            }
        }
    }
    if let Some(s) = start {
        out.push((s, count));
    }
    out
}

/// 기록 섹션의 index번째 콜아웃 **본문만** 새 내용으로 바꾼다 (종류·날짜 헤더는 그대로).
/// 인덱스가 범위를 벗어나면 None.
pub fn replace_entry_text(records: &str, index: usize, new_text: &str) -> Option<String> {
    let ranges = entry_line_ranges(records);
    let &(start, end) = ranges.get(index)?;
    let lines: Vec<&str> = records.lines().collect();

    let mut out: Vec<String> = lines[..=start].iter().map(|s| s.to_string()).collect();
    let text = new_text.trim();
    if text.is_empty() {
        out.push("> ".into());
    } else {
        for l in text.lines() {
            out.push(format!("> {l}"));
        }
    }
    out.extend(lines[end..].iter().map(|s| s.to_string()));
    Some(out.join("\n"))
}

/// 기록 섹션에서 index번째 콜아웃을 통째로 지운다. 인덱스가 범위를 벗어나면 None.
pub fn remove_entry(records: &str, index: usize) -> Option<String> {
    let ranges = entry_line_ranges(records);
    let &(start, end) = ranges.get(index)?;
    let lines: Vec<&str> = records.lines().collect();
    let mut out: Vec<&str> = Vec::new();
    out.extend_from_slice(&lines[..start]);
    out.extend_from_slice(&lines[end..]);
    // 지우고 남은 연속 빈 줄을 하나로 정리
    let joined = out.join("\n");
    let mut cleaned = String::new();
    let mut blank = false;
    for line in joined.lines() {
        if line.trim().is_empty() {
            if blank {
                continue;
            }
            blank = true;
        } else {
            blank = false;
        }
        cleaned.push_str(line);
        cleaned.push('\n');
    }
    Some(cleaned.trim().to_string())
}

/// 보기 화면에 그릴 기록 블록 — 콜아웃이거나, 콜아웃이 아닌 원문 덩어리다.
/// (외부 편집기에서 콜아웃 없이 써 넣은 내용을 숨기지 않으려고 함께 돌려준다)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordBlock {
    /// index는 `parse_entries` 기준 — 수정·삭제에 그대로 쓴다
    Callout { index: usize, entry: ParsedEntry },
    Raw(String),
}

/// 기록 섹션을 문서 순서대로 콜아웃/원문 블록으로 쪼갠다.
pub fn parse_record_blocks(records: &str) -> Vec<RecordBlock> {
    let entries = parse_entries(records);
    let ranges = entry_line_ranges(records);
    let lines: Vec<&str> = records.lines().collect();
    let mut out = Vec::new();
    let mut cursor = 0usize;

    let push_raw = |from: usize, to: usize, out: &mut Vec<RecordBlock>| {
        if from >= to || from >= lines.len() {
            return;
        }
        let chunk = lines[from..to.min(lines.len())].join("\n");
        let chunk = chunk.trim();
        if !chunk.is_empty() {
            out.push(RecordBlock::Raw(chunk.to_string()));
        }
    };

    for (i, &(s, e)) in ranges.iter().enumerate() {
        push_raw(cursor, s, &mut out);
        if let Some(entry) = entries.get(i) {
            out.push(RecordBlock::Callout {
                index: i,
                entry: entry.clone(),
            });
        }
        cursor = e;
    }
    push_raw(cursor, lines.len(), &mut out);
    out
}

/// 본문을 `## 섹션` 단위로 나눈다 → (섹션 헤더, 내용). 첫 헤더 앞의 내용은 이름이 빈 문자열.
/// 내용이 비어 있는 섹션도 그대로 돌려준다 (호출 쪽에서 판단).
pub fn sections(body: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut name = String::new();
    let mut buf: Vec<&str> = Vec::new();

    for line in body.lines() {
        if line.trim_start().starts_with("## ") {
            if !name.is_empty() || !buf.join("\n").trim().is_empty() {
                out.push((name.clone(), buf.join("\n").trim().to_string()));
            }
            name = line.trim().to_string();
            buf.clear();
        } else {
            buf.push(line);
        }
    }
    if !name.is_empty() || !buf.join("\n").trim().is_empty() {
        out.push((name, buf.join("\n").trim().to_string()));
    }
    out
}

/// 할 일 섹션에서 뽑아낸 체크박스 항목 하나
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTodo {
    /// 섹션 안에서의 줄 번호 (수정·삭제 시 그 줄만 갈아끼우려고 들고 있는다)
    pub line: usize,
    pub done: bool,
    pub text: String,
}

/// 체크박스 줄(`- [ ] 내용` / `- [x] 내용`)에서 (완료여부, 내용)을 뽑는다.
/// 내용이 없는 자리표시자는 목록에 넣지 않는다.
fn parse_todo_line(line: &str) -> Option<(bool, String)> {
    let t = line.trim_start();
    let rest = t
        .strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .or_else(|| t.strip_prefix("+ "))?;
    let rest = rest.trim_start();
    let (done, body) = if let Some(b) = rest.strip_prefix("[ ]") {
        (false, b)
    } else if let Some(b) = rest.strip_prefix("[x]").or_else(|| rest.strip_prefix("[X]")) {
        (true, b)
    } else {
        return None;
    };
    let text = body.trim();
    if text.is_empty() {
        None
    } else {
        Some((done, text.to_string()))
    }
}

/// 할 일 목록을 문서에 적힌 순서대로 뽑는다 (완료·미완료 모두).
pub fn parse_todos(section: &str) -> Vec<ParsedTodo> {
    section
        .lines()
        .enumerate()
        .filter_map(|(i, line)| {
            parse_todo_line(line).map(|(done, text)| ParsedTodo {
                line: i,
                done,
                text,
            })
        })
        .collect()
}

/// index번째 할 일 줄을 새 줄로 갈아끼운다 (들여쓰기는 유지). 범위 밖이면 None.
fn replace_todo_line(section: &str, index: usize, make: impl Fn(&str) -> String) -> Option<String> {
    let todos = parse_todos(section);
    let target = todos.get(index)?.line;
    let mut lines: Vec<String> = section.lines().map(|s| s.to_string()).collect();
    let indent: String = lines[target]
        .chars()
        .take_while(|c| c.is_whitespace())
        .collect();
    lines[target] = make(&indent);
    Some(lines.join("\n"))
}

/// index번째 할 일의 완료 여부를 바꾼다.
pub fn set_todo_done(section: &str, index: usize, done: bool) -> Option<String> {
    let text = parse_todos(section).get(index)?.text.clone();
    let mark = if done { "[x]" } else { "[ ]" };
    replace_todo_line(section, index, |indent| format!("{indent}- {mark} {text}"))
}

/// index번째 할 일의 내용을 바꾼다 (완료 여부는 유지).
pub fn replace_todo_text(section: &str, index: usize, new_text: &str) -> Option<String> {
    let done = parse_todos(section).get(index)?.done;
    let mark = if done { "[x]" } else { "[ ]" };
    let text = new_text.trim().replace('\n', " ");
    replace_todo_line(section, index, |indent| format!("{indent}- {mark} {text}"))
}

/// index번째 할 일 줄을 지운다.
pub fn remove_todo(section: &str, index: usize) -> Option<String> {
    let todos = parse_todos(section);
    let target = todos.get(index)?.line;
    let lines: Vec<&str> = section.lines().collect();
    let mut out: Vec<&str> = Vec::new();
    out.extend_from_slice(&lines[..target]);
    out.extend_from_slice(&lines[target + 1..]);
    Some(out.join("\n"))
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

    /// 기본 데일리 템플릿 (사용자가 안 고쳤을 때)
    const DAILY: &str = "## 할 일\n\n- [ ] \n\n## 기록\n\n";

    #[test]
    fn todo_goes_under_todo_section_replacing_placeholder() {
        let block = daily_entry_block(DailyKind::Todo, "14:32", "우유 사기");
        assert_eq!(block, "- [ ] 우유 사기");
        let body = append_to_section(DAILY, "## 할 일", &block, true);
        assert_eq!(body, "## 할 일\n\n- [ ] 우유 사기\n\n## 기록\n");
        // 두 번째 할 일은 목록에 바로 이어 붙는다 (빈 줄 없이)
        let block2 = daily_entry_block(DailyKind::Todo, "14:40", "설거지");
        let body2 = append_to_section(&body, "## 할 일", &block2, true);
        assert!(
            body2.contains("- [ ] 우유 사기\n- [ ] 설거지"),
            "got: {body2}"
        );
        // 기록 섹션은 그대로 남는다
        assert!(body2.contains("## 기록"));
    }

    const RECORDS: &str =
        "> [!발췌] 2026-07-18\n> 첫 인용\n> 둘째 줄\n\n> [!생각] 2026-07-19\n> 내 생각\n";

    #[test]
    fn replace_kind_keeps_date_and_body() {
        let records = "> [!발췌] 2026-07-18\n> 인용\n\n> [!생각]\n> 생각\n";
        let out = replace_entry_kind(records, 0, "질문").unwrap();
        assert!(out.contains("> [!질문] 2026-07-18"), "got: {out}");
        assert!(out.contains("> 인용"), "got: {out}");
        // 옆 항목은 그대로
        assert!(out.contains("> [!생각]"), "got: {out}");
        // 날짜 없는 콜아웃도 처리
        let out = replace_entry_kind(records, 1, "느낌").unwrap();
        assert!(out.contains("> [!느낌]"), "got: {out}");
        assert!(replace_entry_kind(records, 9, "x").is_none());
    }

    #[test]
    fn callout_block_handles_custom_label_and_empty_meta() {
        assert_eq!(callout_block("인용", "14:00", "본문"), "> [!인용] 14:00\n> 본문\n");
        assert_eq!(callout_block("메모", "", "한 줄"), "> [!메모]\n> 한 줄\n");
        assert_eq!(callout_block("메모", "", ""), "> [!메모]\n> \n");
    }

    #[test]
    fn record_blocks_keep_non_callout_text_in_order() {
        // 외부 편집기에서 평문·일반 인용문을 섞어 넣은 상황
        let records =
            "옵시디언 평문\n\n> [!발췌] 2026-07-18\n> 인용\n\n> 그냥 인용문\n\n> [!생각]\n> 생각\n";
        let blocks = parse_record_blocks(records);
        assert_eq!(blocks.len(), 4, "블록: {blocks:?}");
        assert_eq!(blocks[0], RecordBlock::Raw("옵시디언 평문".into()));
        match &blocks[1] {
            RecordBlock::Callout { index, entry } => {
                assert_eq!(*index, 0);
                assert_eq!(entry.kind_label, "발췌");
            }
            b => panic!("콜아웃이어야 함: {b:?}"),
        }
        assert_eq!(blocks[2], RecordBlock::Raw("> 그냥 인용문".into()));
        match &blocks[3] {
            // 인덱스는 parse_entries 기준이라 수정·삭제에 그대로 쓸 수 있다
            RecordBlock::Callout { index, entry } => {
                assert_eq!(*index, 1);
                assert_eq!(entry.kind_label, "생각");
            }
            b => panic!("콜아웃이어야 함: {b:?}"),
        }
    }

    #[test]
    fn record_blocks_all_callouts_has_no_raw() {
        let blocks = parse_record_blocks("> [!발췌] 2026-07-18\n> 인용\n");
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], RecordBlock::Callout { index: 0, .. }));
        assert!(parse_record_blocks("").is_empty());
    }

    #[test]
    fn sections_splits_by_h2() {
        let body = "머리말\n\n## 할 일\n\n- [ ] 하나\n\n## 메모\n\n외부에서 추가한 섹션\n";
        let ss = sections(body);
        assert_eq!(ss.len(), 3);
        assert_eq!(ss[0], ("".to_string(), "머리말".to_string()));
        assert_eq!(ss[1].0, "## 할 일");
        assert_eq!(ss[2], ("## 메모".to_string(), "외부에서 추가한 섹션".to_string()));
    }

    const TODOS: &str = "- [ ] 우유 사기\n- [x] 끝낸 일\n  - [ ] 하위 할 일\n- [ ]\n";

    #[test]
    fn parse_todos_keeps_document_order_and_state() {
        let ts = parse_todos(TODOS);
        // 내용 없는 자리표시자(`- [ ]`)는 제외
        assert_eq!(ts.len(), 3);
        assert_eq!(ts[0], ParsedTodo { line: 0, done: false, text: "우유 사기".into() });
        assert_eq!(ts[1], ParsedTodo { line: 1, done: true, text: "끝낸 일".into() });
        assert_eq!(ts[2].text, "하위 할 일");
    }

    #[test]
    fn todo_toggle_update_delete() {
        // 완료 표시
        let out = set_todo_done(TODOS, 0, true).unwrap();
        assert!(out.contains("- [x] 우유 사기"), "got: {out}");
        // 되돌리기
        let back = set_todo_done(&out, 0, false).unwrap();
        assert!(back.contains("- [ ] 우유 사기"), "got: {back}");

        // 내용 수정 — 완료 여부는 유지
        let out = replace_todo_text(TODOS, 1, "고친 내용").unwrap();
        assert!(out.contains("- [x] 고친 내용"), "got: {out}");
        assert!(!out.contains("끝낸 일"));

        // 들여쓰기 유지
        let out = replace_todo_text(TODOS, 2, "고친 하위").unwrap();
        assert!(out.contains("  - [ ] 고친 하위"), "got: {out}");

        // 삭제 — 그 줄만 사라진다
        let out = remove_todo(TODOS, 0).unwrap();
        assert!(!out.contains("우유 사기"), "got: {out}");
        assert!(out.contains("- [x] 끝낸 일"), "got: {out}");
        assert_eq!(parse_todos(&out).len(), 2);
    }

    #[test]
    fn todo_ops_reject_out_of_range() {
        assert!(set_todo_done(TODOS, 9, true).is_none());
        assert!(replace_todo_text(TODOS, 9, "x").is_none());
        assert!(remove_todo(TODOS, 9).is_none());
    }

    #[test]
    fn entry_ranges_align_with_parse_entries() {
        let es = parse_entries(RECORDS);
        let rs = entry_line_ranges(RECORDS);
        assert_eq!(es.len(), 2);
        assert_eq!(rs.len(), es.len(), "파싱 결과와 줄 범위 개수가 같아야 인덱스로 짝지을 수 있다");
        assert_eq!(rs[0], (0, 3));
        assert_eq!(rs[1].0, 4);
    }

    #[test]
    fn replace_entry_keeps_header_and_siblings() {
        let out = replace_entry_text(RECORDS, 0, "고친 인용\n두 줄로").unwrap();
        // 종류·날짜 헤더는 그대로
        assert!(out.contains("> [!발췌] 2026-07-18"), "got: {out}");
        assert!(out.contains("> 고친 인용\n> 두 줄로"), "got: {out}");
        // 옛 본문은 사라지고 옆 엔트리는 남는다
        assert!(!out.contains("첫 인용"), "got: {out}");
        assert!(out.contains("> [!생각] 2026-07-19"), "got: {out}");
        assert!(out.contains("> 내 생각"), "got: {out}");
        // 파싱해도 여전히 2건
        assert_eq!(parse_entries(&out).len(), 2);
        assert_eq!(parse_entries(&out)[0].text, "고친 인용\n두 줄로");
    }

    #[test]
    fn remove_entry_drops_only_that_callout() {
        let out = remove_entry(RECORDS, 0).unwrap();
        assert!(!out.contains("발췌"), "got: {out}");
        assert!(!out.contains("첫 인용"), "got: {out}");
        assert!(out.contains("> [!생각] 2026-07-19"), "got: {out}");
        let left = parse_entries(&out);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].kind_label, "생각");

        // 마지막 하나까지 지우면 빈 문자열
        let empty = remove_entry(&out, 0).unwrap();
        assert!(parse_entries(&empty).is_empty(), "got: {empty}");
    }

    #[test]
    fn entry_ops_reject_out_of_range() {
        assert!(replace_entry_text(RECORDS, 9, "x").is_none());
        assert!(remove_entry(RECORDS, 9).is_none());
    }

    #[test]
    fn section_text_and_replace_roundtrip() {
        let body = "## 할 일\n\n- [ ] 남은 일\n\n## 기록\n\n> [!기록] 09:00\n> 아침\n";
        assert_eq!(section_text(body, "## 기록").unwrap(), "> [!기록] 09:00\n> 아침");
        assert_eq!(section_text(body, "## 할 일").unwrap(), "- [ ] 남은 일");
        assert!(section_text(body, "## 없는섹션").is_none());

        let out = replace_section_text(body, "## 기록", "> [!느낌] 10:00\n> 바뀜").unwrap();
        // 기록만 바뀌고 할 일 섹션은 그대로
        assert!(out.contains("- [ ] 남은 일"), "got: {out}");
        assert!(out.contains("> [!느낌] 10:00"), "got: {out}");
        assert!(!out.contains("아침"), "got: {out}");
    }

    #[test]
    fn multiline_todo_becomes_multiple_checkboxes() {
        let block = daily_entry_block(DailyKind::Todo, "09:00", "우유 사기\n- [ ] 설거지\n\n빨래");
        assert_eq!(block, "- [ ] 우유 사기\n- [ ] 설거지\n- [ ] 빨래");
    }

    #[test]
    fn log_and_feeling_are_callouts_in_record_section() {
        let block = daily_entry_block(DailyKind::Log, "14:32", "회의함");
        assert_eq!(block, "> [!기록] 14:32\n> 회의함\n");
        let body = append_to_section(DAILY, "## 기록", &block, false);
        assert!(body.contains("## 기록\n\n> [!기록] 14:32\n> 회의함"), "got: {body}");
        // 할 일 섹션의 자리표시자는 콜아웃 추가로 사라지지 않는다
        assert!(body.contains("- [ ]"));

        // 두 번째 콜아웃은 빈 줄로 분리된다
        let block2 = daily_entry_block(DailyKind::Feeling, "20:10", "후련하다");
        let body2 = append_to_section(&body, "## 기록", &block2, false);
        assert!(
            body2.contains("> 회의함\n\n> [!느낌] 20:10\n> 후련하다"),
            "got: {body2}"
        );
    }

    #[test]
    fn missing_section_is_created_at_end() {
        // 사용자가 템플릿에서 `## 할 일`을 지운 경우
        let body = "## 오늘\n\n아무거나\n";
        let block = daily_entry_block(DailyKind::Todo, "10:00", "새 할 일");
        let out = append_to_section(body, "## 할 일", &block, true);
        assert_eq!(out, "## 오늘\n\n아무거나\n\n## 할 일\n\n- [ ] 새 할 일\n");
    }

    #[test]
    fn append_to_empty_body_creates_section() {
        let block = daily_entry_block(DailyKind::Log, "08:00", "기상");
        let out = append_to_section("", "## 기록", &block, false);
        assert_eq!(out, "## 기록\n\n> [!기록] 08:00\n> 기상\n");
    }

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

    #[test]
    fn template_placeholders_all() {
        let out = render_template(
            "{{date}} {{weekday}} {{yesterday}} {{tomorrow}} {{month}} {{year}} {{week}} {{title}}",
            "2026-07-30",
            "제목",
        );
        assert!(out.starts_with("2026-07-30 목 2026-07-29 2026-07-31 2026-07 2026 "));
        assert!(out.contains("주 제목"), "주차와 제목: {out}");
    }

    #[test]
    fn template_keeps_unknown_and_bad_date() {
        // 모르는 자리표시자는 그대로 남긴다 (오타를 알아채도록)
        let out = render_template("{{nope}} {{date}}", "2026-07-30", "t");
        assert_eq!(out, "{{nope}} 2026-07-30");
        // 날짜 꼴이 아니면 날짜 파생 값은 손대지 않는다
        let out = render_template("{{weekday}} {{tomorrow}}", "무제", "t");
        assert_eq!(out, "{{weekday}} {{tomorrow}}");
    }

}
