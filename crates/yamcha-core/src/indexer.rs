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
            -- 색인해 둔 시점의 파일 신원. 다음에 열 때 바뀌지 않은 편을
            -- 내용을 읽지 않고 가려내려고 둔다. 비어 있으면(첫 실행·업그레이드
            -- 직후) 전체를 다시 읽게 되는데, 그건 안전한 쪽이다.
            CREATE TABLE IF NOT EXISTS note_state(
                path TEXT PRIMARY KEY,
                mtime INTEGER NOT NULL,
                size INTEGER NOT NULL
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
        tx.execute("DELETE FROM note_state WHERE path = ?1", params![rel_path])?;
        tx.commit()?;
        Ok(())
    }

    pub fn clear(&mut self) -> Result<(), CoreError> {
        self.conn.execute_batch(
            "DELETE FROM notes; DELETE FROM links; DELETE FROM tags; DELETE FROM note_state;",
        )?;
        Ok(())
    }

    /// 색인해 둔 시점의 파일 신원을 기록한다 (경로 → 수정시각·크기).
    ///
    /// `upsert`와 짝이다. 색인에 넣었으면 넣은 시점의 신원도 남겨야 다음에 열 때
    /// 건너뛸 수 있다. 빠뜨리면 그 편은 매번 다시 읽힌다 — 느릴 뿐 틀리지는 않는다.
    pub fn set_note_state(&mut self, rel_path: &str, mtime: i64, size: i64) -> Result<(), CoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO note_state(path, mtime, size) VALUES (?1, ?2, ?3)",
            params![rel_path, mtime, size],
        )?;
        Ok(())
    }

    /// 파일 신원을 **한 트랜잭션으로 몰아서** 기록한다.
    ///
    /// 전체 재색인은 편마다 이걸 부르는데, 한 건씩 쓰면 SQLite가 매번 커밋한다
    /// (실측: 2,000편 첫 색인이 11.9초 → 21.7초로 늘었다). 묶으면 그 값이 사라진다.
    pub fn set_note_states(&mut self, states: &[(String, i64, i64)]) -> Result<(), CoreError> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO note_state(path, mtime, size) VALUES (?1, ?2, ?3)",
            )?;
            for (path, mtime, size) in states {
                stmt.execute(params![path, mtime, size])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 색인이 기억하는 파일 신원 전부 (경로 → (수정시각, 크기))
    pub fn note_states(&self) -> Result<std::collections::HashMap<String, (i64, i64)>, CoreError> {
        let mut stmt = self.conn.prepare("SELECT path, mtime, size FROM note_state")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        })?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let (path, state) = row?;
            out.insert(path, state);
        }
        Ok(out)
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

    /// vault가 이미 아는 고유명사 사전 (자동 태그 제안의 유일한 후보 출처).
    ///
    /// 사용자가 "이건 이름이다"라고 이미 표시해 둔 것만 모은다 — 기존 태그,
    /// 다른 노트의 제목, 책의 저자·출판사. 추측은 하지 않는다.
    ///
    /// 데일리노트 제목은 날짜라서 뺀다. 한 글자 제목도 뺀다(너무 광범위하다).
    pub fn proper_noun_dict(&self) -> Result<Vec<crate::autotag::DictEntry>, CoreError> {
        use crate::autotag::{DictEntry, DictSource};

        let mut out: Vec<DictEntry> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        // ① 이미 쓰는 태그 — 사용자가 태그로 삼겠다고 이미 정한 이름이다
        for t in self.all_tags()? {
            if seen.insert(t.tag.clone()) {
                out.push(DictEntry::new(t.tag, DictSource::Tag));
            }
        }

        // ② 노트 제목과 책 메타 (+ 그 노트의 분야를 범주로 물려준다)
        let mut stmt = self
            .conn
            .prepare("SELECT type, title, frontmatter FROM notes")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;

        for row in rows {
            let (note_type, title, fm_json) = row?;
            if note_type == "daily" {
                continue; // 제목이 날짜다
            }
            let fm: serde_json::Value =
                serde_json::from_str(&fm_json).unwrap_or(serde_json::Value::Null);
            let field = |k: &str| {
                fm.get(k)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            let categories: Vec<String> = field("genre").into_iter().collect();

            let title = title.trim();
            if title.chars().count() >= 2 && seen.insert(title.to_string()) {
                out.push(
                    DictEntry::new(title, DictSource::NoteTitle)
                        .with_categories(categories.clone()),
                );
            }
            // 저자는 "A, B"처럼 여럿일 수 있다
            if let Some(authors) = field("author") {
                for a in authors.split(',').map(str::trim).filter(|s| s.len() > 1) {
                    if seen.insert(a.to_string()) {
                        out.push(
                            DictEntry::new(a, DictSource::Author)
                                .with_categories(categories.clone()),
                        );
                    }
                }
            }
            if let Some(pubr) = field("publisher") {
                if pubr.chars().count() >= 2 && seen.insert(pubr.clone()) {
                    out.push(DictEntry::new(pubr, DictSource::Publisher));
                }
            }
        }

        Ok(out)
    }

    /// 태그가 하나도 없는 노트들 (자동 태그 일괄 정리 화면용)
    pub fn untagged_notes(&self) -> Result<Vec<NoteRef>, CoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT n.path, n.type, n.title, n.date
             FROM notes n LEFT JOIN tags t ON n.path = t.path
             WHERE t.path IS NULL ORDER BY n.date DESC",
        )?;
        let rows = stmt.query_map([], Self::note_ref_row)?;
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
    fn proper_noun_dict_collects_names_and_categories() {
        use crate::autotag::DictSource;
        let (_d, v, mut idx) = setup();
        let book = v
            .create_note(
                "book",
                "클린 코드",
                json!({"author": "로버트 마틴", "publisher": "인사이트", "genre": "컴퓨터/IT"}),
            )
            .unwrap();
        let free = v.create_note("free", "메모", json!({})).unwrap();
        v.save_note(&free, json!({"tags": ["독서"]}), "본문").unwrap();
        // 데일리는 제목이 날짜라 사전에 들어가면 안 된다
        let daily = v.open_daily("2026-08-01").unwrap();

        for rel in [&book, &free, &daily] {
            idx.upsert(&v.parse_full(rel).unwrap()).unwrap();
        }

        let dict = idx.proper_noun_dict().unwrap();
        let find = |n: &str| dict.iter().find(|e| e.name == n);

        // 책 제목은 자기 분야를 범주로 물려받는다
        let title = find("클린 코드").expect("책 제목이 사전에 있어야 한다");
        assert_eq!(title.source, DictSource::NoteTitle);
        assert_eq!(title.categories, vec!["컴퓨터/IT".to_string()]);

        assert_eq!(find("로버트 마틴").unwrap().source, DictSource::Author);
        assert_eq!(find("인사이트").unwrap().source, DictSource::Publisher);
        assert_eq!(find("독서").unwrap().source, DictSource::Tag);
        // 날짜 제목은 없다
        assert!(find("2026-08-01").is_none());
    }

    /// vault → 색인 → 사전 → 제안까지 실제 흐름 그대로 확인한다.
    /// 단위 테스트의 손으로 만든 사전이 아니라, 진짜 노트에서 뽑은 사전으로 돈다.
    #[test]
    fn autotag_end_to_end_suggests_only_known_names() {
        let (_d, v, mut idx) = setup();
        // 서재에 책 한 권 — 제목·저자·출판사·분야가 전부 사전 재료가 된다
        let book = v
            .create_note(
                "book",
                "클린 코드",
                json!({"author": "로버트 마틴", "publisher": "인사이트", "genre": "컴퓨터/IT"}),
            )
            .unwrap();
        // 태그를 하나 쓰고 있는 노트
        let memo = v.create_note("free", "메모", json!({})).unwrap();
        v.save_note(&memo, json!({"tags": ["독서"]}), "본문").unwrap();

        for rel in [&book, &memo] {
            idx.upsert(&v.parse_full(rel).unwrap()).unwrap();
        }
        let dict = idx.proper_noun_dict().unwrap();

        // 일지에 그 책 이야기를 적었다 — 필러 부사도 잔뜩 섞어 둔다
        let input = crate::autotag::TagInput {
            title: String::new(),
            body: "오늘 로버트 마틴의 클린 코드를 읽었다. 실제로 사실은 정말 좋았고 \
                   독서를 계속해야겠다고 생각했다. Rust로 예제도 따라 쳤다."
                .into(),
            note_type: "daily".into(),
            genre: None,
            current_tags: vec![],
        };
        let r = crate::autotag::suggest_tags(&input, &dict, 10);
        let names: Vec<&str> = r.iter().map(|s| s.tag.as_str()).collect();

        // 사전에 있는 고유명사는 잡는다
        assert!(names.contains(&"클린 코드"), "책 제목: {names:?}");
        assert!(names.contains(&"로버트 마틴"), "저자: {names:?}");
        assert!(names.contains(&"독서"), "기존 태그: {names:?}");
        assert!(names.contains(&"Rust"), "영문 고유명사: {names:?}");
        // 책 제목을 따라 분야가 범주로 붙는다
        let cat = r.iter().find(|s| s.tag == "컴퓨터/IT").expect("범주");
        assert!(cat.category);
        // 필러 부사는 아무리 나와도 제안되지 않는다
        for junk in ["실제로", "사실은", "사실", "정말", "생각"] {
            assert!(!names.contains(&junk), "{junk}가 샜다: {names:?}");
        }
    }

    #[test]
    fn untagged_notes_excludes_tagged() {
        let (_d, v, mut idx) = setup();
        let tagged = v.create_note("free", "태그있음", json!({})).unwrap();
        v.save_note(&tagged, json!({"tags": ["독서"]}), "본문").unwrap();
        let bare = v.create_note("free", "태그없음", json!({})).unwrap();
        v.save_note(&bare, json!({}), "그냥 본문").unwrap();

        for rel in [&tagged, &bare] {
            idx.upsert(&v.parse_full(rel).unwrap()).unwrap();
        }

        let untagged = idx.untagged_notes().unwrap();
        let paths: Vec<_> = untagged.iter().map(|r| r.rel_path.as_str()).collect();
        assert!(paths.contains(&bare.as_str()));
        assert!(!paths.contains(&tagged.as_str()));
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
