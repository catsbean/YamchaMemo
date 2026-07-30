//! tantivy 전문검색. 한국어 부분 문자열 검색을 위해 1~2그램 토크나이저 사용.
//! 추후 형태소(lindera) 등으로 토크나이저만 교체 가능하도록 필드 구성을 단순하게 유지.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, Occur, Query, QueryParser, TermQuery};
use tantivy::schema::{
    IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, STORED, STRING,
};
use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer};
use tantivy::{doc, Index, IndexReader, IndexWriter, TantivyDocument, Term};

use crate::error::CoreError;
use crate::vault::ParsedNote;

/// 첨부 문서를 노트와 구별하는 타입 id. 스키마를 늘리지 않으려고
/// 기존 `type` 필드를 재활용한다 (필터·일괄 삭제가 이 한 값으로 다 된다).
pub const FILE_TYPE: &str = "_file";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SearchHit {
    pub rel_path: String,
    pub note_type: String,
    pub title: String,
    pub date: String,
    /// 매치 주변 본문 발췌
    pub snippet: String,
}

/// 검색 대상. 노트와 첨부 문서를 **따로** 묻는다.
///
/// 같이 묻지 않는 이유: 첨부 검색은 노트 검색보다 훨씬 비싸다(거대한 본문의 발췌 생성).
/// 화면은 노트 결과를 먼저 그리고 첨부 결과를 뒤에 붙인다 — 첫 응답이 첨부 때문에
/// 늦어지지 않는다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, specta::Type)]
pub enum SearchScope {
    /// 노트만 (첨부가 색인돼 있어도 제외) — 기존 동작
    #[default]
    Notes,
    /// 첨부 문서만
    Files,
}

/// 검색 결과를 좁히는 조건. 모두 비어 있으면 필터 없음(기존 동작).
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct SearchFilter {
    /// 노트 타입 id 목록 (비면 전체)
    pub types: Vec<String>,
    /// 최근 N일 이내만 (0이면 기간 제한 없음)
    pub days: u32,
    /// 이 태그 중 하나라도 가진 노트만 (비면 전체)
    pub tags: Vec<String>,
    /// 노트를 볼지 첨부를 볼지
    pub scope: SearchScope,
}

impl SearchFilter {
    /// 후필터가 실제로 걸리는지. 걸리면 색인에서 넉넉히 받아 와야 한다.
    /// (scope는 후필터가 아니라 색인 쿼리로 표현하므로 여기 없다)
    fn is_active(&self) -> bool {
        match self.scope {
            SearchScope::Notes => {
                !self.types.is_empty() || self.days > 0 || !self.tags.is_empty()
            }
            // 첨부에는 타입·태그가 없다 — 기간만 후필터로 남는다
            SearchScope::Files => self.days > 0,
        }
    }

    /// `days`를 기준 날짜 문자열로 (없으면 None)
    fn since_date(&self) -> Option<String> {
        if self.days == 0 {
            return None;
        }
        let d = chrono::Local::now().date_naive() - chrono::Duration::days(self.days as i64 - 1);
        Some(d.format("%Y-%m-%d").to_string())
    }
}

pub struct SearchEngine {
    index: Index,
    reader: IndexReader,
    writer: IndexWriter,
    f_path: tantivy::schema::Field,
    f_title: tantivy::schema::Field,
    f_body: tantivy::schema::Field,
    f_tags: tantivy::schema::Field,
    f_type: tantivy::schema::Field,
    f_date: tantivy::schema::Field,
}

impl From<tantivy::TantivyError> for CoreError {
    fn from(e: tantivy::TantivyError) -> Self {
        CoreError::Invalid(format!("검색 인덱스 오류: {e}"))
    }
}

impl From<tantivy::directory::error::OpenDirectoryError> for CoreError {
    fn from(e: tantivy::directory::error::OpenDirectoryError) -> Self {
        CoreError::Invalid(format!("검색 인덱스 디렉토리 오류: {e}"))
    }
}

fn bigram_text() -> TextOptions {
    TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer("bigram")
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    )
}

impl SearchEngine {
    /// 인덱스 열기. 스키마 변경이나 크래시로 남은 잠금 등으로 실패하면
    /// 디렉토리를 비우고 재생성한다 (전체 재색인은 set_vault가 수행).
    pub fn open(dir: &Path) -> Result<SearchEngine, CoreError> {
        match Self::try_open(dir) {
            Ok(s) => Ok(s),
            Err(_) => {
                let _ = std::fs::remove_dir_all(dir);
                Self::try_open(dir)
            }
        }
    }

    fn try_open(dir: &Path) -> Result<SearchEngine, CoreError> {
        std::fs::create_dir_all(dir)?;

        let mut b = Schema::builder();
        let f_path = b.add_text_field("path", STRING | STORED);
        let f_title = b.add_text_field("title", bigram_text().set_stored());
        let f_body = b.add_text_field("body", bigram_text().set_stored());
        // 태그는 검색뿐 아니라 결과 필터에도 쓰므로 저장까지 한다
        // (스키마가 바뀌면 open()이 인덱스를 지우고 다시 만들고, set_vault가 재색인한다)
        let f_tags = b.add_text_field("tags", bigram_text().set_stored());
        let f_type = b.add_text_field("type", STRING | STORED);
        let f_date = b.add_text_field("date", STRING | STORED);
        let schema = b.build();

        let index = Index::open_or_create(MmapDirectory::open(dir)?, schema)?;
        index.tokenizers().register(
            "bigram",
            TextAnalyzer::builder(NgramTokenizer::new(1, 2, false).map_err(|e| {
                CoreError::Invalid(format!("토크나이저 오류: {e}"))
            })?)
            .filter(LowerCaser)
            .build(),
        );
        let writer = index.writer(30_000_000)?;
        let reader = index.reader()?;
        Ok(SearchEngine {
            index,
            reader,
            writer,
            f_path,
            f_title,
            f_body,
            f_tags,
            f_type,
            f_date,
        })
    }

    pub fn upsert(&mut self, note: &ParsedNote) -> Result<(), CoreError> {
        self.writer
            .delete_term(Term::from_field_text(self.f_path, &note.rel_path));
        self.writer.add_document(doc!(
            self.f_path => note.rel_path.clone(),
            self.f_title => note.title.clone(),
            self.f_body => note.body.clone(),
            self.f_tags => note.tags.join(" "),
            self.f_type => note.note_type.clone(),
            self.f_date => note.date.clone(),
        ))?;
        Ok(())
    }

    pub fn remove(&mut self, rel_path: &str) -> Result<(), CoreError> {
        self.writer
            .delete_term(Term::from_field_text(self.f_path, rel_path));
        Ok(())
    }

    pub fn clear(&mut self) -> Result<(), CoreError> {
        self.writer.delete_all_documents()?;
        Ok(())
    }

    /// 변경사항 반영 (배치 후 한 번 호출)
    pub fn commit(&mut self) -> Result<(), CoreError> {
        self.writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, CoreError> {
        self.search_filtered(query, &SearchFilter::default(), limit)
    }

    /// 필터를 건 검색. tantivy에는 넉넉히 물어보고 결과를 걸러 상위 `limit`만 돌려준다.
    /// (필터 조건이 색인 쿼리로 표현되기엔 종류가 잡다해서, 후필터가 단순하고 정확하다.)
    pub fn search_filtered(
        &self,
        query: &str,
        filter: &SearchFilter,
        limit: usize,
    ) -> Result<Vec<SearchHit>, CoreError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(vec![]);
        }
        let mut parser = QueryParser::for_index(
            &self.index,
            vec![self.f_title, self.f_body, self.f_tags],
        );
        parser.set_conjunction_by_default();
        parser.set_field_boost(self.f_title, 3.0);
        parser.set_field_boost(self.f_tags, 2.0);
        let (q, _errors) = parser.parse_query_lenient(query);

        // scope는 색인 쿼리로 표현한다. 후필터로 하면 걸러질 문서의 본문까지
        // 압축 해제하게 되고, 본문이 수만~20만 자인 첨부에서는 그 비용이 검색 시간을
        // 지배한다 (실측: 후필터 62ms → 쿼리 절)
        let file_term: Box<dyn Query> = Box::new(TermQuery::new(
            Term::from_field_text(self.f_type, FILE_TYPE),
            IndexRecordOption::Basic,
        ));
        let q: Box<dyn Query> = match filter.scope {
            SearchScope::Notes => Box::new(BooleanQuery::new(vec![
                (Occur::Must, q),
                (Occur::MustNot, file_term),
            ])),
            SearchScope::Files => Box::new(BooleanQuery::new(vec![
                (Occur::Must, q),
                (Occur::Must, file_term),
            ])),
        };

        let active = filter.is_active();
        let fetch = if active { (limit * 4).max(200) } else { limit };
        let since = filter.since_date();
        let note_filters = filter.scope == SearchScope::Notes;

        let searcher = self.reader.searcher();
        let top = searcher.search(&q, &TopDocs::with_limit(fetch))?;
        let mut out = Vec::with_capacity(top.len().min(limit));
        for (_score, addr) in top {
            let doc: TantivyDocument = searcher.doc(addr)?;
            let get = |f| {
                doc.get_first(f)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let note_type = get(self.f_type);
            if note_filters && !filter.types.is_empty() && !filter.types.contains(&note_type) {
                continue;
            }
            let date = get(self.f_date);
            if let Some(since) = &since {
                // 날짜는 YYYY-MM-DD 고정 폭이라 문자열 비교로 충분하다
                if date.as_str() < since.as_str() {
                    continue;
                }
            }
            if note_filters && !filter.tags.is_empty() {
                let tags = get(self.f_tags);
                let has = filter
                    .tags
                    .iter()
                    .any(|t| tags.split_whitespace().any(|x| x == t));
                if !has {
                    continue;
                }
            }
            let body = get(self.f_body);
            out.push(SearchHit {
                rel_path: get(self.f_path),
                note_type,
                title: get(self.f_title),
                date,
                snippet: excerpt(&body, query),
            });
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }
}

/// 쿼리 토큰이 처음 등장하는 위치 주변의 본문 발췌.
///
/// 첨부 문서 본문은 20만 자까지 갈 수 있어서 **본문을 복사하지 않는다**.
/// 바이트 단위로 훑어 위치만 찾고, 그 주변만 잘라 낸다 (실측: 62ms → 6ms).
fn excerpt(body: &str, query: &str) -> String {
    const RADIUS: usize = 50;
    const NO_MATCH_LEN: usize = 100;

    let body = body.trim();
    if body.is_empty() {
        return String::new();
    }

    let found = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .find_map(|t| find_ci(body, t).map(|p| (p, t.len())));

    let (start, end) = match found {
        Some((pos, len)) => (
            back_chars(body, pos, RADIUS),
            fwd_chars(body, pos + len, RADIUS),
        ),
        None => (0, fwd_chars(body, 0, NO_MATCH_LEN)),
    };
    let mut s = body[start..end].replace('\n', " ");
    if start > 0 {
        s.insert(0, '…');
    }
    if end < body.len() {
        s.push('…');
    }
    s
}

/// ASCII 대소문자만 무시하는 부분 문자열 검색 (바이트 오프셋).
/// 한글은 대소문자가 없으므로 이 정도로 충분하다.
/// UTF-8은 자기동기적이라 이어지는 바이트가 선두 바이트와 같을 수 없어
/// 경계가 아닌 곳에서 매치가 시작될 수 없다 — 그래도 한 번 더 확인한다.
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || n.len() > h.len() {
        return None;
    }
    let first = n[0].to_ascii_lowercase();
    for i in 0..=(h.len() - n.len()) {
        if h[i].to_ascii_lowercase() != first {
            continue;
        }
        if h[i..i + n.len()]
            .iter()
            .zip(n)
            .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase())
            && hay.is_char_boundary(i)
        {
            return Some(i);
        }
    }
    None
}

/// `from`에서 문자 `n`개 뒤로 간 바이트 위치
fn back_chars(s: &str, from: usize, n: usize) -> usize {
    let mut bytes = 0;
    for c in s[..from].chars().rev().take(n) {
        bytes += c.len_utf8();
    }
    from - bytes
}

/// `from`에서 문자 `n`개 앞으로 간 바이트 위치
fn fwd_chars(s: &str, from: usize, n: usize) -> usize {
    let mut bytes = 0;
    for c in s[from..].chars().take(n) {
        bytes += c.len_utf8();
    }
    from + bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(rel: &str, title: &str, body: &str, tags: &[&str]) -> ParsedNote {
        ParsedNote {
            rel_path: rel.into(),
            note_type: "free".into(),
            title: title.into(),
            stem: title.into(),
            date: "2026-07-18".into(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            links: vec![],
            body: body.into(),
            frontmatter_json: "{}".into(),
        }
    }

    // ---- 규모 벤치 (기본 제외, 수동 실행) ----
    // cargo test -p yamcha-core search_scale_bench -- --ignored --nocapture
    //
    // 첨부 문서를 색인에 넣으면 검색이 느려지는지 재는 것이 목적이다.
    // 노트만 있는 인덱스와 노트+첨부 인덱스를 같은 쿼리로 비교한다.

    /// 결정적 난수 (매 실행 같은 코퍼스)
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self, n: usize) -> usize {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
            (self.0 >> 33) as usize % n
        }
    }

    const WORDS: &[&str] = &[
        "독서", "기록", "오늘", "생각", "코드", "설계", "검색", "문서", "회의", "계획",
        "정리", "메모", "일정", "공고", "면적", "청약", "신청", "자료", "보고", "요약",
        "학습", "연습", "구현", "확인", "측정", "개선", "문제", "해결", "방법", "결과",
        "프로젝트", "인덱스", "토크나이저", "마크다운", "템플릿", "백링크", "첨부파일", "소나기",
    ];

    fn gen_text(rng: &mut Lcg, chars: usize) -> String {
        let mut s = String::with_capacity(chars * 3);
        while s.chars().count() < chars {
            for _ in 0..10 {
                s.push_str(WORDS[rng.next(WORDS.len())]);
                s.push(' ');
            }
            s.push('\n');
        }
        s
    }

    fn file_doc(rel: &str, title: &str, body: String, date: &str) -> ParsedNote {
        ParsedNote {
            rel_path: rel.into(),
            note_type: "_file".into(),
            title: title.into(),
            stem: title.into(),
            date: date.into(),
            tags: vec![],
            links: vec![],
            body,
            frontmatter_json: "{}".into(),
        }
    }

    const NOTES: usize = 2_000;
    const NOTE_CHARS: usize = 1_200;
    const FILES: usize = 150;
    const FILE_CHARS: usize = 30_000; // 실측 평균 31,326자
    const BIG_FILES: usize = 5;
    const BIG_CHARS: usize = 200_000; // 상한까지 찬 문서

    fn build(with_files: bool) -> (tempfile::TempDir, SearchEngine, u128) {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SearchEngine::open(dir.path()).unwrap();
        let mut rng = Lcg(42);
        let t = std::time::Instant::now();
        for i in 0..NOTES {
            let body = gen_text(&mut rng, NOTE_CHARS);
            let mut n = note(
                &format!("Free/노트{i}.md"),
                &format!("노트 {i} {}", WORDS[i % WORDS.len()]),
                &body,
                &["일상"],
            );
            n.date = format!("2026-{:02}-{:02}", (i % 12) + 1, (i % 28) + 1);
            s.upsert(&n).unwrap();
        }
        if with_files {
            for i in 0..FILES {
                let body = gen_text(&mut rng, FILE_CHARS);
                s.upsert(&file_doc(
                    &format!("_attachments/2026-07/문서{i}.pdf"),
                    &format!("문서{i}.pdf"),
                    body,
                    "2026-07-01",
                ))
                .unwrap();
            }
            for i in 0..BIG_FILES {
                let body = gen_text(&mut rng, BIG_CHARS);
                s.upsert(&file_doc(
                    &format!("_attachments/2026-07/큰문서{i}.hwp"),
                    &format!("큰문서{i}.hwp"),
                    body,
                    "2026-07-02",
                ))
                .unwrap();
            }
        }
        s.commit().unwrap();
        (dir, s, t.elapsed().as_millis())
    }

    fn dir_size(p: &std::path::Path) -> u64 {
        std::fs::read_dir(p)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| e.metadata().ok())
                    .map(|m| m.len())
                    .sum()
            })
            .unwrap_or(0)
    }

    fn time_query(s: &SearchEngine, q: &str, f: &SearchFilter, runs: usize) -> (u128, usize) {
        // 첫 회는 캐시 워밍
        let hits = s.search_filtered(q, f, 50).unwrap().len();
        let t = std::time::Instant::now();
        for _ in 0..runs {
            let _ = s.search_filtered(q, f, 50).unwrap();
        }
        (t.elapsed().as_micros() / runs as u128, hits)
    }

    #[test]
    #[ignore]
    fn search_scale_bench() {
        let queries = ["독서", "클린 코드", "소나기 이야기", "토크나이저"];

        for with_files in [false, true] {
            let (dir, s, index_ms) = build(with_files);
            let docs = if with_files {
                NOTES + FILES + BIG_FILES
            } else {
                NOTES
            };
            println!(
                "\n=== {} — 문서 {docs}개, 색인 {index_ms}ms, 인덱스 {:.1}MB ===",
                if with_files { "노트+첨부" } else { "노트만" },
                dir_size(dir.path()) as f64 / 1_048_576.0
            );
            for q in queries {
                let (us, hits) = time_query(&s, q, &SearchFilter::default(), 20);
                println!("  전체   {q:<12} {us:>7}µs  {hits}건");
            }
            if with_files {
                let only_files = SearchFilter {
                    scope: SearchScope::Files,
                    ..Default::default()
                };
                for q in queries {
                    let (us, hits) = time_query(&s, q, &only_files, 20);
                    println!("  첨부만 {q:<12} {us:>7}µs  {hits}건");
                }
                // 노트 검색이 첨부 때문에 느려지지 않는지가 이 벤치의 핵심 질문이다
                // (첫 페인트는 노트 결과만 기다린다)
            }
        }
    }

    #[test]
    fn filters_narrow_results() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SearchEngine::open(dir.path()).unwrap();
        let mut daily = note("Daily/2026/07/2026-07-18.md", "일기", "오늘 독서 기록", &["일상"]);
        daily.note_type = "daily".into();
        daily.date = "2026-07-18".into();
        let mut old_free = note("Free/옛날.md", "옛 메모", "독서 이야기", &["책"]);
        old_free.date = "2020-01-01".into();
        s.upsert(&daily).unwrap();
        s.upsert(&old_free).unwrap();
        s.commit().unwrap();

        // 필터 없음: 둘 다
        assert_eq!(s.search("독서", 10).unwrap().len(), 2);

        // 타입 필터
        let only_daily = SearchFilter {
            types: vec!["daily".into()],
            ..Default::default()
        };
        let hits = s.search_filtered("독서", &only_daily, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_type, "daily");

        // 태그 필터
        let only_book_tag = SearchFilter {
            tags: vec!["책".into()],
            ..Default::default()
        };
        let hits = s.search_filtered("독서", &only_book_tag, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "Free/옛날.md");

        // 기간 필터: 최근 1년 안엔 2020년 노트가 안 잡힌다
        let recent = SearchFilter {
            days: 365,
            ..Default::default()
        };
        assert!(s
            .search_filtered("독서", &recent, 10)
            .unwrap()
            .iter()
            .all(|h| h.rel_path != "Free/옛날.md"));
    }

    #[test]
    fn korean_substring_search() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SearchEngine::open(dir.path()).unwrap();
        s.upsert(&note("Free/a.md", "클린 코드", "좋은 코드에 대한 책", &["독서"]))
            .unwrap();
        s.upsert(&note("Free/b.md", "함께 자라기", "애자일 이야기", &[]))
            .unwrap();
        s.commit().unwrap();

        // 제목 부분 문자열
        let hits = s.search("클린", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "Free/a.md");

        // 본문 검색 + 매치 주변 발췌
        let hits = s.search("애자일", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "Free/b.md");
        assert!(hits[0].snippet.contains("애자일"));

        // 태그 검색
        let hits = s.search("독서", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn scope_separates_notes_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SearchEngine::open(dir.path()).unwrap();
        s.upsert(&note("Free/메모.md", "독서 메모", "책 이야기", &["독서"]))
            .unwrap();
        s.upsert(&file_doc(
            "_attachments/2026-07/독서목록.pdf",
            "독서목록.pdf",
            "책 이야기가 담긴 문서".into(),
            "2026-07-01",
        ))
        .unwrap();
        s.commit().unwrap();

        // 기본(Notes) — 첨부는 안 나온다. 첨부를 색인해도 기존 동작이 그대로다.
        let hits = s.search("독서", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "Free/메모.md");

        // Files — 첨부만 나온다
        let files = SearchFilter {
            scope: SearchScope::Files,
            ..Default::default()
        };
        let hits = s.search_filtered("독서", &files, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "_attachments/2026-07/독서목록.pdf");
        assert_eq!(hits[0].note_type, FILE_TYPE);

        // 첨부 검색에는 노트용 타입·태그 필터가 끼어들지 않는다
        // (화면의 타입 칩이 걸려 있어도 첨부 결과가 사라지면 안 된다)
        let files_with_note_filters = SearchFilter {
            types: vec!["daily".into()],
            tags: vec!["없는태그".into()],
            scope: SearchScope::Files,
            ..Default::default()
        };
        let hits = s
            .search_filtered("독서", &files_with_note_filters, 10)
            .unwrap();
        assert_eq!(hits.len(), 1);

        // 기간 필터는 첨부에도 걸린다
        let old_only = SearchFilter {
            days: 1,
            scope: SearchScope::Files,
            ..Default::default()
        };
        assert!(s.search_filtered("독서", &old_only, 10).unwrap().is_empty());
    }

    #[test]
    fn excerpt_finds_match_in_long_body() {
        // 첨부 문서만큼 긴 본문에서도 매치 주변을 뽑아낸다
        let mut body = "가나다라마 ".repeat(20_000); // 12만 자
        body.push_str("찾을말 이 뒤에 있다");
        let s = excerpt(&body, "찾을말");
        assert!(s.contains("찾을말"));
        assert!(s.starts_with('…'));
        assert!(s.chars().count() < 130, "발췌가 너무 길다: {}", s.chars().count());

        // 매치가 없으면 앞부분
        let s = excerpt(&body, "없는말");
        assert!(s.starts_with("가나다라마"));
        assert!(s.ends_with('…'));

        // ASCII 대소문자 무시
        assert!(excerpt("Hello World", "world").contains("World"));
        // 여러 토큰 중 하나만 있어도 그 자리를 잡는다
        assert!(excerpt("앞부분 그리고 목표어 뒷부분", "없는말 목표어").contains("목표어"));
    }

    #[test]
    fn upsert_replaces_and_remove_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SearchEngine::open(dir.path()).unwrap();
        s.upsert(&note("Free/a.md", "원래 제목", "본문", &[])).unwrap();
        s.commit().unwrap();
        s.upsert(&note("Free/a.md", "바뀐 제목", "본문", &[])).unwrap();
        s.commit().unwrap();

        assert!(s.search("원래", 10).unwrap().is_empty());
        assert_eq!(s.search("바뀐", 10).unwrap().len(), 1);

        s.remove("Free/a.md").unwrap();
        s.commit().unwrap();
        assert!(s.search("바뀐", 10).unwrap().is_empty());
    }
}
