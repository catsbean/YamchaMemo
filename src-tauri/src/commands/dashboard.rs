//! 화면이 모아 보여 주는 것들 — 독서기록 엔트리·미완 할 일·일지 요약.

use super::*;

/// 책 한 권의 기록 콜아웃 한 건 (어느 책의 것인지까지 붙여 평탄화한 형태)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct ReadingEntry {
    pub book_rel: String,
    pub book_title: String,
    pub book_author: String,
    /// 책의 분야 (장르별 보기·필터용)
    pub genre: String,
    /// 책에 달린 태그
    pub tags: Vec<String>,
    /// 표지 rel 경로 (없으면 빈 문자열)
    pub cover: String,
    pub kind_label: String,
    pub date: String,
    pub text: String,
}

/// 책 노트 한 편에서 기록 엔트리를 평탄화한다.
/// 독서기록 목록과 회고가 같은 모양을 보도록 한 곳에 둔다.
fn entries_of_book(n: &NoteSummary, body: &str) -> Vec<ReadingEntry> {
    let fm = |k: &str| {
        n.frontmatter
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let (_, records) = yamcha_core::template::split_book_body(body);
    yamcha_core::template::parse_entries(&records)
        .into_iter()
        .map(|e| ReadingEntry {
            book_rel: n.rel_path.clone(),
            book_title: n.title.clone(),
            book_author: fm("author"),
            genre: fm("genre"),
            tags: n.tags.clone(),
            cover: fm("cover"),
            kind_label: e.kind_label,
            date: e.date,
            text: e.text,
        })
        .collect()
}

/// 전체 책의 기록을 엔트리 단위로 펼쳐 반환한다 (정렬·필터는 화면에서).
#[tauri::command]
#[specta::specta]
pub fn list_entries(state: State<'_, AppState>) -> Result<Vec<ReadingEntry>, String> {
    with_ctx(&state, |c| {
        let mut out = Vec::new();
        for n in c.vault.list_notes()? {
            if n.note_type != "book" {
                continue;
            }
            let Ok(note) = c.vault.read_note(&n.rel_path) else {
                continue;
            };
            out.extend(entries_of_book(&n, &note.body));
        }
        Ok(out)
    })
}

/// 어느 노트에 있는 미완 할 일 한 줄
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct TodoItem {
    pub rel_path: String,
    pub note_type: String,
    pub note_title: String,
    pub date: String,
    pub text: String,
}

/// vault 전체의 미완 할 일 (내용이 있는 `- [ ]`만). 최근 노트가 앞에 온다.
#[tauri::command]
#[specta::specta]
pub fn list_open_todos(state: State<'_, AppState>, limit: u32) -> Result<Vec<TodoItem>, String> {
    with_ctx(&state, |c| {
        let limit = limit.clamp(1, 500) as usize;
        let mut out: Vec<TodoItem> = Vec::new();
        // list_notes는 날짜 내림차순이라 순회 순서가 곧 최신순이다
        for n in c.vault.list_notes()? {
            let Ok(note) = c.vault.read_note(&n.rel_path) else {
                continue;
            };
            for text in yamcha_core::parse::open_todo_texts(&note.body) {
                out.push(TodoItem {
                    rel_path: n.rel_path.clone(),
                    note_type: n.note_type.clone(),
                    note_title: n.title.clone(),
                    date: n.date.clone(),
                    text,
                });
            }
        }
        // 데일리노트를 먼저 (하루 운영에 바로 쓰이는 목록이라)
        out.sort_by_key(|t| u8::from(t.note_type != "daily"));
        out.truncate(limit);
        Ok(out)
    })
}

/// 그 날짜에 기록이 추가된 책 하나
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct DigestBookEntry {
    pub book_rel: String,
    pub book_title: String,
    pub count: u32,
}

/// 데일리노트 하단 요약 바에 뿌릴 값들 (템플릿과 무관하게 항상 계산한다)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct DailyDigest {
    /// vault 전체의 미완 할 일
    pub open_todos_total: u32,
    /// 그 날짜 데일리노트 안의 미완 할 일
    pub open_todos_today: u32,
    /// 읽는 중인 책 제목 (최대 3권)
    pub reading_titles: Vec<String>,
    /// 읽는 중인 책의 rel 경로 (1권일 때 바로 열기용)
    pub reading_rels: Vec<String>,
    pub reading_count: u32,
    pub finished_total: u32,
    pub finished_this_year: u32,
    /// 그 날짜에 기록을 남긴 책들
    pub today_entries: Vec<DigestBookEntry>,
    pub today_entry_count: u32,
}

/// 데일리노트 요약. `date`는 `YYYY-MM-DD`.
#[tauri::command]
#[specta::specta]
pub fn daily_digest(state: State<'_, AppState>, date: String) -> Result<DailyDigest, String> {
    with_ctx(&state, |c| {
        let mut d = DailyDigest::default();
        let year = date.get(..4).unwrap_or("").to_string();

        for n in c.vault.list_notes()? {
            let Ok(note) = c.vault.read_note(&n.rel_path) else {
                continue;
            };
            let open = yamcha_core::parse::count_open_todos(&note.body);
            d.open_todos_total += open;
            if n.note_type == "daily" && n.date == date {
                d.open_todos_today += open;
            }
            if n.note_type != "book" {
                continue;
            }

            let fm = |k: &str| n.frontmatter.get(k).and_then(|v| v.as_str()).unwrap_or("");
            match fm("status") {
                "reading" => {
                    d.reading_count += 1;
                    if d.reading_titles.len() < 3 {
                        d.reading_titles.push(n.title.clone());
                        d.reading_rels.push(n.rel_path.clone());
                    }
                }
                "finished" => {
                    d.finished_total += 1;
                    // 완독일이 없으면 노트 날짜로 대신 본다
                    let when = if fm("finished").is_empty() {
                        n.date.as_str()
                    } else {
                        fm("finished")
                    };
                    if !year.is_empty() && when.starts_with(&year) {
                        d.finished_this_year += 1;
                    }
                }
                _ => {}
            }

            // 그 날짜에 남긴 기록
            let (_, records) = yamcha_core::template::split_book_body(&note.body);
            let count = yamcha_core::template::parse_entries(&records)
                .iter()
                .filter(|e| e.date == date)
                .count() as u32;
            if count > 0 {
                d.today_entry_count += count;
                d.today_entries.push(DigestBookEntry {
                    book_rel: n.rel_path.clone(),
                    book_title: n.title.clone(),
                    count,
                });
            }
        }

        d.today_entries.sort_by_key(|e| std::cmp::Reverse(e.count));
        Ok(d)
    })
}

/// 회고 화면이 날짜 섹션 하나를 그리는 데 필요한 전부.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct ReviewDay {
    pub date: String,
    pub rel_path: String,
    /// 소속 일지의 태그 — 회고의 태그 필터가 본문 인라인 `#태그`와 **함께** 본다
    pub tags: Vec<String>,
    pub blocks: Vec<NoteBlock>,
    pub todos: Vec<NoteTodo>,
}

/// 회고 기간 하나를 통째로.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct ReviewRange {
    /// 최신 날짜가 앞 (화면 기본 정렬과 같게)
    pub days: Vec<ReviewDay>,
    /// 기간 안의 독서기록만. `with_reading`이 false면 빈 목록
    pub reading: Vec<ReadingEntry>,
}

/// 일지가 가리키는 날짜.
///
/// 파일 이름이 곧 날짜라는 것이 일지의 규칙이고 화면도 그렇게 읽는다.
/// frontmatter는 외부 편집기에서 어긋날 수 있으니 이름이 날짜꼴이 아닐 때만 믿는다.
fn day_date(rel_path: &str, fm_date: &str) -> String {
    let stem = rel_path
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim_end_matches(".md");
    if is_ymd(stem) {
        stem.to_string()
    } else if is_ymd(fm_date) {
        fm_date.to_string()
    } else {
        String::new()
    }
}

/// `YYYY-MM-DD` 꼴인가. 고정폭이라 기간 비교를 문자열 그대로 할 수 있다.
fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| b[i].is_ascii_digit())
}

/// 회고 기간 전체를 한 번에 읽는다. `from`·`to`는 `YYYY-MM-DD`(양끝 포함).
///
/// 날짜마다 `note_blocks`·`note_todos`를 부르면 한 달에 62번이 오간다 —
/// 기간을 사용자가 직접 정할 수 있게 되면서 그 수가 수백까지 늘 수 있어 한 번으로 묶었다.
///
/// **필터는 일부러 여기서 걸지 않는다.** 종류 칩 하나를 껐다 켤 때마다 파일을
/// 다시 읽을 이유가 없다 — 백엔드는 기간을 주고, 좁히는 일은 화면이 한다.
#[tauri::command]
#[specta::specta]
pub fn review_range(
    state: State<'_, AppState>,
    from: String,
    to: String,
    with_reading: bool,
) -> Result<ReviewRange, String> {
    with_ctx(&state, |c| {
        let mut days: Vec<ReviewDay> = Vec::new();
        for n in c.vault.list_notes_of_type(Builtin::Daily.id())? {
            let date = day_date(&n.rel_path, &n.date);
            if date.is_empty() || date < from || date > to {
                continue;
            }
            // 한 편을 못 읽었다고 기간 전체를 실패시키지 않는다
            let Ok(note) = c.vault.read_note(&n.rel_path) else {
                continue;
            };
            days.push(ReviewDay {
                date,
                rel_path: n.rel_path.clone(),
                tags: n.tags.clone(),
                blocks: blocks_of_body(&note.body),
                todos: todos_of_body(&note.body),
            });
        }
        days.sort_by(|a, b| b.date.cmp(&a.date));

        let mut reading: Vec<ReadingEntry> = Vec::new();
        if with_reading {
            for n in c.vault.list_notes_of_type(Builtin::Book.id())? {
                let Ok(note) = c.vault.read_note(&n.rel_path) else {
                    continue;
                };
                // 기간 밖은 여기서 버린다 — 안 그러면 vault 전체 기록이 화면까지 건너온다
                reading.extend(
                    entries_of_book(&n, &note.body)
                        .into_iter()
                        .filter(|e| e.date >= from && e.date <= to),
                );
            }
        }
        Ok(ReviewRange { days, reading })
    })
}

#[cfg(test)]
mod review_range_tests {
    use super::*;

    #[test]
    fn 파일_이름이_날짜면_그걸_믿는다() {
        assert_eq!(
            day_date("Daily/2026/07/2026-07-30.md", "2026-01-01"),
            "2026-07-30"
        );
    }

    #[test]
    fn 이름이_날짜꼴이_아니면_frontmatter를_본다() {
        assert_eq!(day_date("Daily/메모.md", "2026-07-30"), "2026-07-30");
        assert_eq!(day_date("Daily/메모.md", ""), "");
    }

    #[test]
    fn 날짜꼴은_고정폭만_받는다() {
        assert!(is_ymd("2026-07-30"));
        assert!(!is_ymd("2026-7-30"));
        assert!(!is_ymd("2026-07-30a"));
        assert!(!is_ymd("무제"));
        assert!(!is_ymd("20260730--"));
    }
}
