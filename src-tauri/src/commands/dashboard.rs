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

/// 어느 노트에 있는 할 일 한 줄
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct TodoItem {
    pub rel_path: String,
    pub note_type: String,
    pub note_title: String,
    pub date: String,
    /// 그 노트 안에서의 순서 — `toggle_todo`·`update_todo`·`delete_todo`에 그대로 넘긴다
    pub index: u32,
    pub done: bool,
    pub text: String,
}

/// 할 일 모아 보기의 한 쪽(page).
///
/// **개수는 목록과 따로 준다.** 목록은 `limit`에 걸려 잘릴 수 있는데, 화면의
/// "N건 남음"과 메뉴 배지가 잘린 목록의 길이를 세면 조용히 틀린 수를 보여 준다
/// (실측: 노트 1만 편이면 4만 건 중 1,000건만 남는다). 세는 일은 어차피 전부
/// 훑으면서 하므로 총계는 공짜다.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct TodoPage {
    pub items: Vec<TodoItem>,
    /// vault 전체의 미완 건수 (목록이 잘려도 정확하다)
    pub open_total: u32,
    /// vault 전체의 완료 건수
    pub done_total: u32,
    /// 목록이 `limit`에 걸려 잘렸는가 — 화면이 "더 있음"을 알릴 수 있게
    pub truncated: bool,
}

/// 노트 한 편에서 뽑아 둔 할 일 — 파일이 그대로면 다시 뽑지 않는다.
struct TodoCacheEntry {
    mtime: i64,
    size: i64,
    /// 줄 세우기용 — 할 일이 하나도 없는 편도 캐시에 남으므로 항목에서 꺼내 쓸 수 없다
    date: String,
    title: String,
    items: Vec<TodoItem>,
}

/// 편별 할 일 캐시. `Ctx`가 들고 있으므로 vault를 바꾸면 함께 사라진다.
///
/// **왜 두는가.** `list_todos`는 vault의 노트를 전부 연다. 실측(release, 노트 1만 편)으로
/// 전부 읽으면 2,200ms인데, 파일 신원(mtime·size)만 훑고 바뀐 편만 다시 읽으면 **490ms**다
/// (그중 445ms가 `list_note_files`의 stat이라, 이 값이 사실상 바닥이다).
/// 목록은 노트를 하나 만들거나 지울 때마다 다시 그려지므로 이 차이가 그대로 체감된다.
///
/// **왜 시각이 아니라 (mtime,size)인가.** 스스로 고쳐지는 잣대이기 때문이다. 무효화를
/// 이벤트로 걸면(저장·감시자) 한 군데를 빠뜨리는 순간 목록이 영영 낡은 채로 남는데,
/// 파일 신원을 보면 어떤 경로로 바뀌었든 다음 호출에서 알아챈다.
#[derive(Default)]
pub struct TodoCache(std::collections::HashMap<String, TodoCacheEntry>);

/// vault 전체의 할 일. `done`이 거짓이면 미완만, 참이면 완료만 담는다.
///
/// 미완과 완료를 **한 번에 주지 않는 이유**는 완료가 훨씬 빨리 쌓이기 때문이다.
/// 노트 1만 편·완료 3만 건에서 둘을 합쳐 보내면 6.6MB가 오간다(미완만은 1.6MB).
/// 완료는 사람이 [완료한 할 일 보기]를 켤 때만 필요하다.
///
/// 순서를 매기는 규칙은 `note_todos`와 **같은 함수**(`todos_of_body`)를 쓴다 —
/// 여기서 본 그 줄을 목록에서 바로 체크할 수 있어야 하는데, 규칙이 갈리면
/// index가 어긋나 엉뚱한 줄이 체크된다.
///
/// 비용은 할 일 수가 아니라 **노트 수**에 붙는다(파일을 연다). 실측값과 근거는
/// `TodoCache`의 설명과 아래 `todo_scan_bench`에 있다.
#[tauri::command]
#[specta::specta]
pub fn list_todos(state: State<'_, AppState>, limit: u32, done: bool) -> Result<TodoPage, String> {
    with_ctx(&state, |c| {
        let limit = limit.clamp(1, 5000) as usize;
        // 파일 신원만 훑는다 — 내용은 바뀐 편만 읽는다
        let files = c.vault.list_note_files()?;
        for f in &files {
            let fresh = matches!(
                c.todo_cache.0.get(&f.rel_path),
                Some(e) if e.mtime == f.mtime && e.size == f.size
            );
            if fresh {
                continue;
            }
            // 요약(제목·날짜)도 같은 잣대로 캐시돼 있어 바뀐 편만 실제로 읽는다
            let (Ok(n), Ok(note)) = (
                c.vault.note_summary(&f.rel_path),
                c.vault.read_note(&f.rel_path),
            ) else {
                // 못 읽은 편도 **그 신원으로는 봤다**고 남긴다. 그냥 건너뛰면
                // frontmatter가 깨진 노트(감사 화면이 다루는 바로 그 상태)를
                // 스캔할 때마다 다시 연다 — 캐시를 둔 이유가 없어진다.
                // 파일이 고쳐지면 mtime이 달라져 저절로 다시 읽힌다.
                c.todo_cache.0.insert(
                    f.rel_path.clone(),
                    TodoCacheEntry {
                        mtime: f.mtime,
                        size: f.size,
                        date: String::new(),
                        title: String::new(),
                        items: Vec::new(),
                    },
                );
                continue;
            };
            let items = todos_of_body(&note.body)
                .into_iter()
                .map(|t| TodoItem {
                    rel_path: n.rel_path.clone(),
                    note_type: n.note_type.clone(),
                    note_title: n.title.clone(),
                    date: n.date.clone(),
                    index: t.index,
                    done: t.done,
                    text: t.text,
                })
                .collect();
            c.todo_cache.0.insert(
                f.rel_path.clone(),
                TodoCacheEntry {
                    mtime: f.mtime,
                    size: f.size,
                    date: n.date.clone(),
                    title: n.title.clone(),
                    items,
                },
            );
        }
        // 사라진 편의 자리는 걷어낸다 (안 걷으면 지운 노트의 할 일이 계속 보인다)
        let alive: std::collections::HashSet<&str> =
            files.iter().map(|f| f.rel_path.as_str()).collect();
        c.todo_cache.0.retain(|rel, _| alive.contains(rel.as_str()));

        let mut items: Vec<TodoItem> = Vec::new();
        let (mut open_total, mut done_total) = (0u32, 0u32);
        // 최근 노트가 앞에 오도록 (list_notes와 같은 잣대: 날짜 내림차순, 그다음 제목)
        let mut entries: Vec<&TodoCacheEntry> = c
            .todo_cache
            .0
            .values()
            .filter(|e| !e.items.is_empty())
            .collect();
        entries.sort_by(|a, b| b.date.cmp(&a.date).then(a.title.cmp(&b.title)));
        for e in entries {
            for t in &e.items {
                if t.done {
                    done_total += 1;
                } else {
                    open_total += 1;
                }
                if t.done == done {
                    items.push(t.clone());
                }
            }
        }
        // 데일리노트를 먼저 (하루 운영에 바로 쓰이는 목록이라).
        // **자르기 전에** 세운다 — 뒤에 세우면 무엇이 남을지가 파일 순서에 좌우된다
        items.sort_by_key(|t| t.note_type != "daily");
        let truncated = items.len() > limit;
        items.truncate(limit);
        Ok(TodoPage {
            items,
            open_total,
            done_total,
            truncated,
        })
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

/// 할 일 모아 보기의 실제 비용을 재는 자리.
///
/// `list_todos`는 **노트를 전부 연다**(`read_note`). 그래서 값이 커지는 축은 할 일 수가
/// 아니라 **노트 수**다. 완료가 아무리 쌓여도 파일을 더 읽지는 않는다 — 대신 돌려주는
/// 목록이 길어져 직렬화·IPC·화면 그리기가 늘어난다. 어느 쪽이 실제로 아픈지는 짐작이
/// 아니라 이 수치로 정한다.
///
/// ```text
/// cargo test -p yamcha-app --release --lib todo_scan_bench -- --ignored --nocapture
/// ```
/// **반드시 `--release`로 잰다** — 디버그 수치는 자릿수가 다르다.
///
/// 2026-08-28 실측 (노트 1만 편 · 완료 3만 · 미완 1만):
/// ```text
/// list_notes 첫 호출 / 캐시     1,873ms / 489ms
/// 전체 스캔 (완료 포함)          2,222ms · 4만 건
/// 전체 스캔 (미완만)             2,204ms · 1만 건   ← 완료 3만 건을 더 세도 18ms 차이
/// 직렬화                        완료 포함 6.6MB / 미완만 1.6MB
/// list_note_files만 (stat)      485ms              ← 캐시가 있어도 못 내려가는 바닥
/// 캐시 채우기(첫 호출)           2,635ms
/// 캐시 적중(바뀐 편 없음)         469ms             ← 평소 값
/// 한 편 고친 뒤                  478ms
/// ```
/// 읽어야 할 결론: **비용은 완료 건수가 아니라 노트 수에 붙는다.** 완료를 3만 건 더
/// 세는 값은 18ms인데 파일을 1만 개 여는 값은 2.2초다. 그래서 손볼 자리는 "완료를
/// 덜 담기"가 아니라 "바뀌지 않은 편을 다시 읽지 않기"(`TodoCache`)였다.
#[cfg(test)]
mod todo_scan_bench {
    use serde_json::json;
    use std::time::Instant;
    use yamcha_core::Vault;

    /// 사용자가 물어본 규모: 노트 1만 편
    const NOTES: usize = 10_000;
    /// 편마다 완료 3 + 미완 1 → 완료 3만 건, 미완 1만 건
    const DONE_PER_NOTE: usize = 3;

    fn body_of(i: usize) -> String {
        let mut s = String::from("## 할 일

");
        for k in 0..DONE_PER_NOTE {
            s.push_str(&format!("- [x] 끝낸 일 {i}-{k} 무언가를 처리했다
"));
        }
        s.push_str(&format!("- [ ] 남은 일 {i} 아직 못 한 것
"));
        s.push_str("
## 기록

> [!기록] 09:00
> 오늘 있었던 일을 적었다
");
        s
    }

    /// 화면이 실제로 받는 것과 같은 모양으로 만든다 (커맨드 본체와 같은 루프).
    /// `done`이 None이면 미완·완료를 모두 담는다 (옛 판이 하던 일 — 비교용).
    fn scan(v: &Vault, done: Option<bool>) -> Vec<super::TodoItem> {
        let mut out = Vec::new();
        for n in v.list_notes().unwrap() {
            let Ok(note) = v.read_note(&n.rel_path) else {
                continue;
            };
            for t in crate::commands::notes::todos_of_body(&note.body) {
                if done.is_some_and(|d| d != t.done) {
                    continue;
                }
                out.push(super::TodoItem {
                    rel_path: n.rel_path.clone(),
                    note_type: n.note_type.clone(),
                    note_title: n.title.clone(),
                    date: n.date.clone(),
                    index: t.index,
                    done: t.done,
                    text: t.text,
                });
            }
        }
        out
    }

    #[test]
    #[ignore]
    fn todo_scan_bench() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();

        let t = Instant::now();
        for i in 0..NOTES {
            let rel = v.create_note("free", &format!("노트 {i}"), json!({})).unwrap();
            v.save_note(&rel, json!({}), &body_of(i)).unwrap();
        }
        println!("
=== 할 일 모아 보기 실측 (노트 {NOTES}편 · 완료 {}건 · 미완 {NOTES}건) ===", NOTES * DONE_PER_NOTE);
        println!("(준비) 노트 쓰기: {}ms", t.elapsed().as_millis());

        // ① 목록 훑기만 (요약 캐시 예열 포함)
        let t = Instant::now();
        let notes = v.list_notes().unwrap();
        println!("① list_notes 첫 호출: {}ms, {}편", t.elapsed().as_millis(), notes.len());
        let t = Instant::now();
        let notes = v.list_notes().unwrap();
        println!("①-b list_notes 두 번째(캐시): {}ms, {}편", t.elapsed().as_millis(), notes.len());

        // ② 지금 코드가 하는 일 — 완료까지 전부
        let t = Instant::now();
        let all = scan(&v, None);
        let all_ms = t.elapsed().as_millis();
        println!("② 전체 스캔 (완료 포함): {all_ms}ms, {}건", all.len());

        // ③ 미완만 — 파일은 똑같이 다 읽는다. 줄어드는 건 결과 크기뿐
        let t = Instant::now();
        let open = scan(&v, Some(false));
        println!("③ 전체 스캔 (미완만): {}ms, {}건", t.elapsed().as_millis(), open.len());

        // ④ 화면으로 건너가는 짐 — 직렬화 시간과 크기 (IPC는 이 JSON을 나른다)
        let t = Instant::now();
        let json_all = serde_json::to_string(&all).unwrap();
        println!(
            "④ 완료 포함 직렬화: {}ms, {:.1}MB",
            t.elapsed().as_millis(),
            json_all.len() as f64 / 1_048_576.0
        );
        let t = Instant::now();
        let json_open = serde_json::to_string(&open).unwrap();
        println!(
            "④-b 미완만 직렬화: {}ms, {:.1}MB",
            t.elapsed().as_millis(),
            json_open.len() as f64 / 1_048_576.0
        );

        // ⑤ 바뀐 편만 다시 읽으면 얼마나 줄어드나 —
        //    (mtime,size)로 가리는 캐시를 흉내 낸다. 앱이 실제로 겪는 상황은
        //    "한 편 저장하고 목록을 다시 그리는" 쪽이라 여기가 중요하다.
        let t = Instant::now();
        let files = v.list_note_files().unwrap();
        println!(
            "⑤ list_note_files만 (stat): {}ms, {}개",
            t.elapsed().as_millis(),
            files.len()
        );

        // 실제 커맨드가 쓰는 캐시와 같은 잣대((mtime,size))로 돈다
        let mut cache: std::collections::HashMap<String, (i64, i64, usize)> =
            std::collections::HashMap::new();
        let warm = |v: &Vault, cache: &mut std::collections::HashMap<String, (i64, i64, usize)>| -> (usize, usize) {
            let mut read = 0usize;
            let mut n = 0usize;
            for f in v.list_note_files().unwrap() {
                let hit = matches!(
                    cache.get(&f.rel_path),
                    Some((m, sz, _)) if *m == f.mtime && *sz == f.size
                );
                if !hit {
                    read += 1;
                    let (Ok(_), Ok(note)) = (v.note_summary(&f.rel_path), v.read_note(&f.rel_path))
                    else {
                        continue;
                    };
                    let todos = crate::commands::notes::todos_of_body(&note.body).len();
                    cache.insert(f.rel_path.clone(), (f.mtime, f.size, todos));
                }
                n += cache.get(&f.rel_path).map(|(_, _, t)| *t).unwrap_or(0);
            }
            (read, n)
        };
        let t = Instant::now();
        let (read, n) = warm(&v, &mut cache);
        println!(
            "⑤-b 캐시 채우기(첫 호출): {}ms, 읽은 편 {read}, 할 일 {n}건",
            t.elapsed().as_millis()
        );
        let t = Instant::now();
        let (read, n) = warm(&v, &mut cache);
        println!(
            "⑤-c 캐시 적중(바뀐 편 없음): {}ms, 읽은 편 {read}, 할 일 {n}건",
            t.elapsed().as_millis()
        );
        // 한 편만 고친 뒤 — 자동저장 직후 목록을 다시 그리는 실제 상황
        let one = files[0].rel_path.clone();
        std::thread::sleep(std::time::Duration::from_millis(15));
        v.save_note(&one, json!({}), &body_of(999_999)).unwrap();
        let t = Instant::now();
        let (read, n) = warm(&v, &mut cache);
        println!(
            "⑤-d 한 편 고친 뒤: {}ms, 읽은 편 {read}, 할 일 {n}건",
            t.elapsed().as_millis()
        );

        // ⑥ 지금 프론트가 실제로 받는 양 (limit 1000으로 잘린 것)
        let mut capped = all.clone();
        capped.sort_by_key(|t| (t.done, t.note_type != "daily"));
        capped.truncate(1000);
        let json_capped = serde_json::to_string(&capped).unwrap();
        println!(
            "⑥ limit 1000으로 자른 뒤: {}건, {:.2}MB — {}건이 잘려 나간다",
            capped.len(),
            json_capped.len() as f64 / 1_048_576.0,
            all.len() - capped.len(),
        );
    }
}
