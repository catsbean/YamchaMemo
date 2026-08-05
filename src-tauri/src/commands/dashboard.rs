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
            let fm = |k: &str| {
                n.frontmatter
                    .get(k)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let (_, records) = yamcha_core::template::split_book_body(&note.body);
            for e in yamcha_core::template::parse_entries(&records) {
                out.push(ReadingEntry {
                    book_rel: n.rel_path.clone(),
                    book_title: n.title.clone(),
                    book_author: fm("author"),
                    genre: fm("genre"),
                    tags: n.tags.clone(),
                    cover: fm("cover"),
                    kind_label: e.kind_label,
                    date: e.date,
                    text: e.text,
                });
            }
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
