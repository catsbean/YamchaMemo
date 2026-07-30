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

/// 캐시에서 꺼낸 추출 결과
#[derive(Debug, Clone)]
pub struct CachedDoc {
    pub text: String,
    pub status: String,
    pub chars: u32,
}

/// 색인을 채울 때 쓰는 캐시 한 줄
#[derive(Debug, Clone)]
pub struct DocEntry {
    pub rel_path: String,
    pub ext: String,
    pub text: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

/// 백링크 한 건 — 어떤 노트가, 어느 대목에서 가리키는지.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Backlink {
    #[serde(flatten)]
    pub note: NoteRef,
    /// 링크가 실제로 쓰인 줄들 (콜아웃 `>` 표시는 떼고 다듬은 것)
    pub contexts: Vec<String>,
    /// `[[링크]]` 없이 제목만 언급한 경우 (아직 잇지 않은 언급)
    pub unlinked: bool,
}

/// 본문에서 `needle`이 들어간 줄을 찾아 사람이 읽기 좋게 다듬는다.
/// 링크 문법·콜아웃 표시·머리글 기호를 걷어내고, 너무 길면 앞뒤를 자른다.
fn context_lines(body: &str, needles: &[&str], max: usize) -> Vec<String> {
    let mut out = Vec::new();
    for raw in body.lines() {
        if !needles.iter().any(|n| !n.is_empty() && raw.contains(*n)) {
            continue;
        }
        let mut line = raw.trim();
        // 콜아웃·인용·목록·체크박스 머리 기호 제거
        loop {
            let before = line;
            line = line
                .trim_start_matches('>')
                .trim_start_matches('#')
                .trim_start_matches('-')
                .trim_start_matches('*')
                .trim_start();
            for p in ["[ ]", "[x]", "[X]"] {
                line = line.trim_start_matches(p).trim_start();
            }
            if line == before {
                break;
            }
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 콜아웃 머리줄(`[!기록] 09:30`)만 있는 줄은 문맥이 못 된다
        if line.starts_with("[!") && line.ends_with(']') {
            continue;
        }
        let text: String = if line.chars().count() > 160 {
            line.chars().take(160).collect::<String>() + "…"
        } else {
            line.to_string()
        };
        if !out.contains(&text) {
            out.push(text);
        }
        if out.len() >= max {
            break;
        }
    }
    out
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
            CREATE TABLE IF NOT EXISTS doc_text(
                path TEXT PRIMARY KEY,
                mtime INTEGER NOT NULL,
                size INTEGER NOT NULL,
                ext TEXT NOT NULL,
                chars INTEGER NOT NULL,
                text TEXT NOT NULL,
                status TEXT NOT NULL
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

    /// 백링크 + 문맥. 링크로 이어진 노트가 먼저, 제목만 언급한 노트가 그 뒤.
    ///
    /// 언급(unlinked) 후보는 인덱스에 있는 노트를 훑어 제목 문자열을 찾는다.
    /// 제목이 너무 짧으면(1글자) 아무 데나 걸리므로 건너뛴다.
    pub fn backlinks_detailed(
        &self,
        vault: &Vault,
        rel_path: &str,
    ) -> Result<Vec<Backlink>, CoreError> {
        let parsed = vault.parse_full(rel_path)?;
        let title = parsed.title.clone();
        let stem = parsed.stem.clone();
        let linked = self.backlinks(vault, rel_path)?;
        let linked_paths: Vec<String> = linked.iter().map(|n| n.rel_path.clone()).collect();

        // 링크 문법 그대로 찾는다 — `[[제목]]`, `[[제목|별칭]]`, `[[제목#섹션]]`
        let link_needles = [format!("[[{title}"), format!("[[{stem}")];
        let needles: Vec<&str> = link_needles.iter().map(|s| s.as_str()).collect();

        let mut out: Vec<Backlink> = Vec::new();
        for note in linked {
            let contexts = vault
                .parse_full(&note.rel_path)
                .map(|p| context_lines(&p.body, &needles, 3))
                .unwrap_or_default();
            out.push(Backlink {
                note,
                contexts,
                unlinked: false,
            });
        }

        // 아직 잇지 않은 언급
        if title.chars().count() >= 2 {
            let mut stmt = self
                .conn
                .prepare("SELECT path, type, title, date FROM notes ORDER BY date DESC")?;
            let rows = stmt.query_map([], Self::note_ref_row)?;
            let title_needle = [title.as_str()];
            for r in rows {
                let n = r?;
                if n.rel_path == rel_path || linked_paths.contains(&n.rel_path) {
                    continue;
                }
                let Ok(p) = vault.parse_full(&n.rel_path) else {
                    continue;
                };
                // 링크로 이미 이어져 있으면 언급이 아니다
                if needles.iter().any(|nd| p.body.contains(nd)) {
                    continue;
                }
                let contexts = context_lines(&p.body, &title_needle, 2);
                if contexts.is_empty() {
                    continue;
                }
                out.push(Backlink {
                    note: n,
                    contexts,
                    unlinked: true,
                });
            }
        }
        Ok(out)
    }

    // ---- 첨부 문서 추출 텍스트 캐시 ----
    //
    // 추출은 비싸다 (실측: PDF 한 건 최악 14.7초). 파일이 그대로면 두 번 뽑지 않는다.
    // 실패·암호·스캔본도 **기억한다** — 깨진 파일을 켤 때마다 다시 붙들지 않기 위해서다.
    // 덕분에 첨부 검색을 껐다 켜도 재추출 없이 색인만 다시 채울 수 있다.

    /// 캐시에 있는 추출 결과. 파일의 mtime·size가 그대로일 때만 돌려준다.
    pub fn cached_doc(
        &self,
        rel_path: &str,
        mtime: i64,
        size: i64,
    ) -> Result<Option<CachedDoc>, CoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT text, status, chars FROM doc_text
             WHERE path = ?1 AND mtime = ?2 AND size = ?3",
        )?;
        let mut rows = stmt.query(params![rel_path, mtime, size])?;
        match rows.next()? {
            Some(r) => Ok(Some(CachedDoc {
                text: r.get(0)?,
                status: r.get::<_, String>(1)?,
                chars: r.get::<_, i64>(2)? as u32,
            })),
            None => Ok(None),
        }
    }

    pub fn put_doc(
        &mut self,
        rel_path: &str,
        mtime: i64,
        size: i64,
        ext: &str,
        text: &str,
        status: &str,
    ) -> Result<(), CoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO doc_text(path, mtime, size, ext, chars, text, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                rel_path,
                mtime,
                size,
                ext,
                text.chars().count() as i64,
                text,
                status
            ],
        )?;
        Ok(())
    }

    pub fn remove_doc(&mut self, rel_path: &str) -> Result<(), CoreError> {
        self.conn
            .execute("DELETE FROM doc_text WHERE path = ?1", params![rel_path])?;
        Ok(())
    }

    /// 캐시에 있는 모든 첨부 (색인을 다시 채울 때 쓴다 — 재추출 없이)
    pub fn all_docs(&self) -> Result<Vec<DocEntry>, CoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, ext, text, status FROM doc_text ORDER BY path")?;
        let rows = stmt.query_map([], |r| {
            Ok(DocEntry {
                rel_path: r.get(0)?,
                ext: r.get(1)?,
                text: r.get(2)?,
                status: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 상태별 개수 — "스캔본 12개 · 암호 걸린 문서 10개"를 화면에 알리는 데 쓴다
    pub fn doc_status_counts(&self) -> Result<Vec<(String, u32)>, CoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT status, COUNT(*) FROM doc_text GROUP BY status")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u32)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// vault에서 사라진 첨부의 캐시를 지운다
    pub fn prune_docs(&mut self, existing: &[String]) -> Result<usize, CoreError> {
        let mut stale: Vec<String> = Vec::new();
        {
            let mut stmt = self.conn.prepare("SELECT path FROM doc_text")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for r in rows {
                let p = r?;
                if !existing.contains(&p) {
                    stale.push(p);
                }
            }
        }
        for p in &stale {
            self.conn
                .execute("DELETE FROM doc_text WHERE path = ?1", params![p])?;
        }
        Ok(stale.len())
    }

    /// 추출 캐시 전체 비우기 (설정의 "다시 읽기")
    pub fn clear_docs(&mut self) -> Result<(), CoreError> {
        self.conn.execute_batch("DELETE FROM doc_text;")?;
        Ok(())
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
    fn backlinks_detailed_gives_context_and_unlinked_mentions() {
        let (_d, v, mut idx) = setup();
        let book = v.create_note("book", "클린 코드", json!({})).unwrap();
        // ① 링크로 이어진 노트 — 링크가 쓰인 줄이 문맥으로 나와야 한다
        let linked = v.create_note("free", "감상", json!({})).unwrap();
        v.save_note(
            &linked,
            json!({}),
            "## 기록\n> [!기록] 09:30\n> 오늘 [[클린 코드]]를 읽었다\n\n딴 줄",
        )
        .unwrap();
        // ② 제목만 언급한 노트 — 링크가 없다
        let mention = v.create_note("free", "잡담", json!({})).unwrap();
        v.save_note(&mention, json!({}), "클린 코드 이야기를 들었다")
            .unwrap();
        // ③ 아무 상관 없는 노트
        let other = v.create_note("free", "딴것", json!({})).unwrap();
        v.save_note(&other, json!({}), "관계 없는 내용").unwrap();

        for rel in [&book, &linked, &mention, &other] {
            idx.upsert(&v.parse_full(rel).unwrap()).unwrap();
        }

        let bl = idx.backlinks_detailed(&v, &book).unwrap();

        let l = bl.iter().find(|b| b.note.rel_path == linked).unwrap();
        assert!(!l.unlinked);
        // 콜아웃 표시(`>`)는 떼고 링크가 쓰인 줄만 남는다
        assert_eq!(l.contexts, vec!["오늘 [[클린 코드]]를 읽었다"]);

        let m = bl.iter().find(|b| b.note.rel_path == mention).unwrap();
        assert!(m.unlinked);
        assert_eq!(m.contexts, vec!["클린 코드 이야기를 들었다"]);

        assert!(!bl.iter().any(|b| b.note.rel_path == other));
        // 자기 자신은 들어가지 않는다
        assert!(!bl.iter().any(|b| b.note.rel_path == book));
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
    fn doc_cache_skips_reextraction_and_prunes() {
        let (_d, _v, mut idx) = setup();
        idx.put_doc("_attachments/2026-07/보고서.pdf", 1000, 500, "pdf", "본문 텍스트", "ok")
            .unwrap();
        idx.put_doc("_attachments/2026-07/스캔.pdf", 1000, 900, "pdf", "", "empty")
            .unwrap();
        idx.put_doc("_attachments/2026-07/잠김.xlsx", 1000, 700, "xlsx", "", "encrypted")
            .unwrap();

        // 파일이 그대로면 캐시가 나온다
        let c = idx
            .cached_doc("_attachments/2026-07/보고서.pdf", 1000, 500)
            .unwrap()
            .unwrap();
        assert_eq!(c.text, "본문 텍스트");
        assert_eq!(c.status, "ok");
        assert_eq!(c.chars, 6);

        // mtime이 바뀌면 캐시를 쓰지 않는다 (다시 추출해야 한다)
        assert!(idx
            .cached_doc("_attachments/2026-07/보고서.pdf", 2000, 500)
            .unwrap()
            .is_none());
        // 크기가 바뀌어도 마찬가지
        assert!(idx
            .cached_doc("_attachments/2026-07/보고서.pdf", 1000, 501)
            .unwrap()
            .is_none());

        // 상태별 개수 — 화면에 "스캔본 1개 · 암호 1개"를 알리는 재료
        let counts = idx.doc_status_counts().unwrap();
        assert_eq!(counts.iter().find(|(s, _)| s == "empty").unwrap().1, 1);
        assert_eq!(counts.iter().find(|(s, _)| s == "encrypted").unwrap().1, 1);

        // 색인 재구성용 — 재추출 없이 캐시에서 전부 꺼낸다
        assert_eq!(idx.all_docs().unwrap().len(), 3);

        // vault에서 사라진 파일은 캐시에서도 지운다
        let removed = idx
            .prune_docs(&["_attachments/2026-07/보고서.pdf".to_string()])
            .unwrap();
        assert_eq!(removed, 2);
        assert_eq!(idx.all_docs().unwrap().len(), 1);

        idx.clear_docs().unwrap();
        assert!(idx.all_docs().unwrap().is_empty());
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
