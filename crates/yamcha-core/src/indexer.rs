//! SQLite 인덱스: 노트 메타·링크 그래프·태그.
//! 백링크와 태그 브라우저가 이 인덱스를 조회한다.

use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::vault::{ParsedNote, Vault};

/// 백링크/태그 조회 결과 행
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NoteRef {
    pub rel_path: String,
    pub note_type: String,
    pub title: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

pub struct Indexer {
    conn: Connection,
}

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        CoreError::Invalid(format!("인덱스 DB 오류: {e}"))
    }
}

impl Indexer {
    pub fn open(db_path: &Path) -> Result<Indexer, CoreError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes(
                path TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                stem TEXT NOT NULL,
                date TEXT NOT NULL,
                frontmatter TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS links(
                src TEXT NOT NULL,
                target TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tags(
                path TEXT NOT NULL,
                tag TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);
            CREATE INDEX IF NOT EXISTS idx_links_src ON links(src);
            CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
            CREATE INDEX IF NOT EXISTS idx_tags_path ON tags(path);
            CREATE INDEX IF NOT EXISTS idx_notes_stem ON notes(stem);",
        )?;
        Ok(Indexer { conn })
    }

    pub fn upsert(&mut self, note: &ParsedNote) -> Result<(), CoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM links WHERE src = ?1", params![note.rel_path])?;
        tx.execute("DELETE FROM tags WHERE path = ?1", params![note.rel_path])?;
        tx.execute(
            "INSERT OR REPLACE INTO notes(path, type, title, stem, date, frontmatter)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                note.rel_path,
                note.note_type,
                note.title,
                note.stem,
                note.date,
                note.frontmatter_json
            ],
        )?;
        for target in &note.links {
            tx.execute(
                "INSERT INTO links(src, target) VALUES (?1, ?2)",
                params![note.rel_path, target],
            )?;
        }
        for tag in &note.tags {
            tx.execute(
                "INSERT INTO tags(path, tag) VALUES (?1, ?2)",
                params![note.rel_path, tag],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn remove(&mut self, rel_path: &str) -> Result<(), CoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM notes WHERE path = ?1", params![rel_path])?;
        tx.execute("DELETE FROM links WHERE src = ?1", params![rel_path])?;
        tx.execute("DELETE FROM tags WHERE path = ?1", params![rel_path])?;
        tx.commit()?;
        Ok(())
    }

    pub fn clear(&mut self) -> Result<(), CoreError> {
        self.conn
            .execute_batch("DELETE FROM notes; DELETE FROM links; DELETE FROM tags;")?;
        Ok(())
    }

    /// 어떤 노트를 가리키는 링크들 (타깃 = 해당 노트의 제목 또는 파일명 stem)
    pub fn backlinks(&self, vault: &Vault, rel_path: &str) -> Result<Vec<NoteRef>, CoreError> {
        let parsed = vault.parse_full(rel_path)?;
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT n.path, n.type, n.title, n.date
             FROM links l JOIN notes n ON n.path = l.src
             WHERE (l.target = ?1 OR l.target = ?2) AND l.src != ?3
             ORDER BY n.date DESC",
        )?;
        let rows = stmt.query_map(
            params![parsed.title, parsed.stem, rel_path],
            Self::note_ref_row,
        )?;
        collect_refs(rows)
    }

    pub fn all_tags(&self) -> Result<Vec<TagCount>, CoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT tag, COUNT(*) FROM tags GROUP BY tag ORDER BY COUNT(*) DESC, tag",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TagCount {
                tag: r.get(0)?,
                count: r.get(1)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn notes_by_tag(&self, tag: &str) -> Result<Vec<NoteRef>, CoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT n.path, n.type, n.title, n.date
             FROM tags t JOIN notes n ON n.path = t.path
             WHERE t.tag = ?1 ORDER BY n.date DESC",
        )?;
        let rows = stmt.query_map(params![tag], Self::note_ref_row)?;
        collect_refs(rows)
    }

    fn note_ref_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<NoteRef> {
        Ok(NoteRef {
            rel_path: r.get(0)?,
            note_type: r.get(1)?,
            title: r.get(2)?,
            date: r.get(3)?,
        })
    }
}

fn collect_refs(
    rows: impl Iterator<Item = rusqlite::Result<NoteRef>>,
) -> Result<Vec<NoteRef>, CoreError> {
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, Vault, Indexer) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        let idx = Indexer::open(&dir.path().join(".yamcha/index.db")).unwrap();
        (dir, v, idx)
    }

    #[test]
    fn backlinks_via_body_and_frontmatter() {
        let (_d, v, mut idx) = setup();
        let book = v
            .create_note("book", "클린 코드", json!({"author": "마틴"}))
            .unwrap();
        let free = v.create_note("free", "감상", json!({})).unwrap();
        v.save_note(&free, json!({}), "오늘 [[클린 코드]]를 읽었다 #독서")
            .unwrap();
        let daily = v.open_daily("2026-07-19").unwrap();
        v.save_note(&daily, json!({}), "[[클린 코드]] 완독").unwrap();

        for rel in [&book, &free, &daily] {
            idx.upsert(&v.parse_full(rel).unwrap()).unwrap();
        }

        // 책 노트의 백링크: 본문에서 [[클린 코드]]를 링크한 노트들
        let bl = idx.backlinks(&v, &book).unwrap();
        let paths: Vec<_> = bl.iter().map(|r| r.rel_path.as_str()).collect();
        assert!(paths.contains(&free.as_str()));
        assert!(paths.contains(&daily.as_str()));
    }

    #[test]
    fn tags_from_frontmatter_and_inline() {
        let (_d, v, mut idx) = setup();
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        v.save_note(&rel, json!({"tags": ["프로젝트"]}), "본문에 #인라인 태그")
            .unwrap();
        idx.upsert(&v.parse_full(&rel).unwrap()).unwrap();

        let tags = idx.all_tags().unwrap();
        let names: Vec<_> = tags.iter().map(|t| t.tag.as_str()).collect();
        assert!(names.contains(&"프로젝트"));
        assert!(names.contains(&"인라인"));

        let notes = idx.notes_by_tag("프로젝트").unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].rel_path, rel);
    }

    #[test]
    fn remove_cleans_everything() {
        let (_d, v, mut idx) = setup();
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        v.save_note(&rel, json!({"tags": ["t"]}), "[[어딘가]]").unwrap();
        idx.upsert(&v.parse_full(&rel).unwrap()).unwrap();
        idx.remove(&rel).unwrap();
        assert!(idx.all_tags().unwrap().is_empty());
    }
}
