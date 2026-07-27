//! tantivy 전문검색. 한국어 부분 문자열 검색을 위해 1~2그램 토크나이저 사용.
//! 추후 형태소(lindera) 등으로 토크나이저만 교체 가능하도록 필드 구성을 단순하게 유지.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::QueryParser;
use tantivy::schema::{
    IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, STORED, STRING,
};
use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer};
use tantivy::{doc, Index, IndexReader, IndexWriter, TantivyDocument, Term};

use crate::error::CoreError;
use crate::vault::ParsedNote;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SearchHit {
    pub rel_path: String,
    pub note_type: String,
    pub title: String,
    pub date: String,
    /// 매치 주변 본문 발췌
    pub snippet: String,
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
}

impl SearchFilter {
    fn is_active(&self) -> bool {
        !self.types.is_empty() || self.days > 0 || !self.tags.is_empty()
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

        let active = filter.is_active();
        let fetch = if active { (limit * 4).max(200) } else { limit };
        let since = filter.since_date();

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
            if !filter.types.is_empty() && !filter.types.contains(&note_type) {
                continue;
            }
            let date = get(self.f_date);
            if let Some(since) = &since {
                // 날짜는 YYYY-MM-DD 고정 폭이라 문자열 비교로 충분하다
                if date.as_str() < since.as_str() {
                    continue;
                }
            }
            if !filter.tags.is_empty() {
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

/// 쿼리 토큰이 처음 등장하는 위치 주변의 본문 발췌 (문자 단위, 한글 안전)
fn excerpt(body: &str, query: &str) -> String {
    const RADIUS: usize = 50;
    const NO_MATCH_LEN: usize = 100;

    let body = body.trim();
    let hay: Vec<char> = body.chars().collect();
    if hay.is_empty() {
        return String::new();
    }
    // 1:1 소문자 매핑 (한글은 그대로, ASCII는 소문자)
    let hay_lower: Vec<char> = hay
        .iter()
        .map(|c| c.to_lowercase().next().unwrap_or(*c))
        .collect();

    let mut found: Option<(usize, usize)> = None;
    for token in query.split_whitespace() {
        let needle: Vec<char> = token
            .chars()
            .map(|c| c.to_lowercase().next().unwrap_or(c))
            .collect();
        if needle.is_empty() || needle.len() > hay_lower.len() {
            continue;
        }
        if let Some(p) = hay_lower
            .windows(needle.len())
            .position(|w| w == needle.as_slice())
        {
            found = Some((p, needle.len()));
            break;
        }
    }

    let (start, end) = match found {
        Some((p, len)) => (p.saturating_sub(RADIUS), (p + len + RADIUS).min(hay.len())),
        None => (0, NO_MATCH_LEN.min(hay.len())),
    };
    let mut s: String = hay[start..end].iter().collect::<String>().replace('\n', " ");
    if start > 0 {
        s = format!("…{s}");
    }
    if end < hay.len() {
        s.push('…');
    }
    s
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
