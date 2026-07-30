//! YamchaMemo 코어 라이브러리.
//!
//! 파일 IO·스키마·템플릿·인덱싱·검색·미러링 로직이 모두 여기에 위치한다.
//! 이 크레이트는 `tauri`에 의존하지 않는다 (모바일 확장 시 그대로 재사용).

pub mod audit;
pub mod enrich;
pub mod error;
pub mod extract;
pub mod history;
pub mod index_file;
pub mod indexer;
pub mod korean;
pub mod mirror;
pub mod parse;
pub mod schema;
pub mod search;
pub mod template;
pub mod vault;

pub use audit::{IssueKind, NoteIssue};
pub use enrich::suggest_genre;
pub use error::CoreError;
pub use history::{HistoryItem, HistoryPolicy};
pub use indexer::{Backlink, Indexer, NoteRef, TagCount};
pub use schema::{Builtin, EntryKind, FieldDef, FieldKind, TypeDef};
pub use search::{SearchEngine, SearchFilter, SearchHit, SearchScope, FILE_TYPE};
pub use vault::{CalloutDef, NoteContent, NoteSummary, ParsedNote, TrashItem, Vault};

/// vault 전체를 다시 인덱싱한다 (SQLite + tantivy).
pub fn reindex_all(
    vault: &Vault,
    indexer: &mut Indexer,
    search: &mut SearchEngine,
) -> Result<usize, CoreError> {
    indexer.clear()?;
    search.clear()?;
    let notes = vault.list_notes()?;
    let mut count = 0;
    for summary in &notes {
        if let Ok(parsed) = vault.parse_full(&summary.rel_path) {
            indexer.upsert(&parsed)?;
            search.upsert(&parsed)?;
            count += 1;
        }
    }
    search.commit()?;
    Ok(count)
}

pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_nonempty() {
        assert!(!super::version().is_empty());
    }
}
