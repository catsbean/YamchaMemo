//! 첨부 문서를 검색 색인에 넣고 빼는 일.
//!
//! 설계의 핵심은 **끄면 인덱스가 원래 크기로 돌아온다**는 것이다.
//! 첨부는 노트와 같은 필드에 `type = "_file"`로 들어가므로
//! 끌 때는 그 term 하나로 일괄 삭제하면 된다 (스키마를 늘리지 않은 값).
//!
//! 추출은 비싸다(PDF 최악 14.7초). 그래서 추출 결과를 SQLite에 캐시하고,
//! 껐다 켤 때는 **재추출 없이** 캐시에서 색인만 다시 채운다.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::extract::{self, Status};
use crate::indexer::Indexer;
use crate::search::{SearchEngine, FILE_TYPE};
use crate::vault::{ParsedNote, Vault};

/// 첨부 색인 상태 — 화면에 "문서 48개 · 스캔본 12개 · 암호 10개"를 알리는 재료
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct FileIndexStatus {
    /// 색인에 들어간 문서 수 (텍스트가 있는 것)
    pub indexed: u32,
    /// 텍스트가 없는 문서 — 스캔본으로 보이는 것
    pub empty: u32,
    /// 암호가 걸려 못 읽은 문서
    pub encrypted: u32,
    /// 파서가 실패한 문서
    pub failed: u32,
    /// 크기 상한을 넘은 문서
    pub too_big: u32,
}

impl FileIndexStatus {
    /// 사용자에게 알릴 것이 있는지 (안 잡히는 문서가 하나라도 있는지)
    pub fn has_gaps(&self) -> bool {
        self.empty + self.encrypted + self.failed + self.too_big > 0
    }
}

/// 진행 상황 알림 — 백그라운드 작업이 한 파일마다 부른다
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FileIndexProgress {
    pub done: u32,
    pub total: u32,
    /// 지금 읽는 파일 이름 (경로가 아니라 이름만 — 화면에 그대로 쓴다)
    pub current: String,
}

/// vault의 첨부 파일 목록 (rel 경로). 표지 이미지처럼 텍스트가 없는 것은 빼고,
/// 다룰 수 있는 확장자만 돌려준다.
pub fn list_attachments(vault: &Vault) -> Vec<String> {
    let root = vault.root().join("_attachments");
    let mut out = Vec::new();
    walk(&root, vault.root(), &mut out);
    out.sort();
    out
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // 책 표지는 이미지뿐이라 훑을 것이 없다
            if path.file_name().map(|n| n == "covers").unwrap_or(false) {
                continue;
            }
            walk(&path, root, out);
            continue;
        }
        let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_lowercase()) else {
            continue;
        };
        if !extract::is_supported(&ext) {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// 파일의 mtime(유닉스초)과 크기 — 캐시 유효성 판단에 쓴다
fn stamp(abs: &Path) -> (i64, i64) {
    let Ok(m) = std::fs::metadata(abs) else {
        return (0, 0);
    };
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    (mtime, m.len() as i64)
}

/// 파일 수정일을 `YYYY-MM-DD`로 (검색 결과의 날짜 칸)
fn file_date(abs: &Path) -> String {
    let (mtime, _) = stamp(abs);
    chrono::DateTime::from_timestamp(mtime, 0)
        .map(|dt| {
            dt.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

fn file_name(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

/// 추출한 텍스트를 검색 색인에 넣는다.
/// 첨부를 노트와 같은 필드에 담아 스키마를 늘리지 않는다 —
/// 제목 자리에 파일 이름을 넣으므로 **파일명 검색이 공짜로 딸려 온다**.
fn index_doc(
    search: &mut SearchEngine,
    rel: &str,
    text: &str,
    date: &str,
) -> Result<(), CoreError> {
    let doc = ParsedNote {
        rel_path: rel.to_string(),
        note_type: FILE_TYPE.to_string(),
        title: file_name(rel),
        stem: file_name(rel),
        date: date.to_string(),
        tags: vec![],
        links: vec![],
        body: text.to_string(),
        frontmatter_json: "{}".into(),
    };
    search.upsert(&doc)
}

/// 인덱스에 접근하는 방법. 호출자가 잠금을 쥐는 방식을 결정한다.
///
/// 이런 모양이 된 이유 — 추출은 파일 하나에 15초까지 걸린다(실측 PDF).
/// 그동안 앱 전체 상태 잠금을 쥐고 있으면 다른 모든 커맨드가 멈춘다.
/// 그래서 **추출은 잠금 밖에서, 색인 쓰기만 잠금 안에서** 하도록
/// 잠금 구간을 호출자에게 맡긴다.
pub trait IndexAccess {
    fn with<R>(
        &self,
        f: impl FnOnce(&mut Indexer, &mut SearchEngine) -> Result<R, CoreError>,
    ) -> Result<R, CoreError>;
}

/// 넘긴 첨부들을 추출·색인한다. 캐시에 있는 것은 다시 뽑지 않는다.
///
/// **목록의 일부만 넘겨도 안전하다** — 여기서 캐시를 정리(prune)하지 않기 때문이다.
/// 파일 하나가 바뀐 경우(watcher)에도 같은 경로를 쓴다. 사라진 파일 정리는
/// 전체 색인을 할 때 호출자가 `Indexer::prune_docs`로 따로 한다.
///
/// `cancel`이 서면 다음 파일로 넘어가지 않는다 — 토글을 다시 끄면 기다리지 않고 끝나야 한다.
/// `progress`는 파일 하나마다 불린다.
pub fn build<A: IndexAccess>(
    root: &Path,
    rels: &[String],
    access: &A,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(FileIndexProgress),
) -> Result<FileIndexStatus, CoreError> {
    let total = rels.len() as u32;
    let mut done = 0u32;
    for rel in rels {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        done += 1;
        progress(FileIndexProgress {
            done,
            total,
            current: file_name(rel),
        });

        let abs: PathBuf = root.join(rel);
        let (mtime, size) = stamp(&abs);
        let ext = abs
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let date = file_date(&abs);

        // 파일이 그대로면 캐시를 쓴다 (실패·암호도 기억하고 있으므로 다시 붙들지 않는다)
        let cached = access.with(|i, _| i.cached_doc(rel, mtime, size))?;
        match cached {
            Some(c) => {
                if c.status == "ok" && !c.text.is_empty() {
                    access.with(|_, s| index_doc(s, rel, &c.text, &date))?;
                }
            }
            None => {
                // ★ 잠금 밖 — 여기가 오래 걸리는 자리다
                let r = extract::extract(&abs);
                let status = r.status.as_str().to_string();
                access.with(|i, s| {
                    i.put_doc(rel, mtime, size, &ext, &r.text, &status)?;
                    if r.status == Status::Ok && !r.text.is_empty() {
                        index_doc(s, rel, &r.text, &date)?;
                    }
                    Ok(())
                })?;
            }
        }
    }
    access.with(|i, s| {
        s.commit()?;
        status_of(i)
    })
}

/// 캐시에 있는 것만으로 색인을 다시 채운다 (**재추출 없음**).
/// 첨부 검색을 껐다 켜는 경우 — 추출은 이미 끝나 있으니 즉시 끝난다.
pub fn rebuild_from_cache(
    vault: &Vault,
    indexer: &mut Indexer,
    search: &mut SearchEngine,
) -> Result<FileIndexStatus, CoreError> {
    let root = vault.root().to_path_buf();
    for d in indexer.all_docs()? {
        if d.status != "ok" || d.text.is_empty() {
            continue;
        }
        let abs = root.join(&d.rel_path);
        // 파일이 사라졌으면 색인에 넣지 않는다
        if !abs.exists() {
            continue;
        }
        index_doc(search, &d.rel_path, &d.text, &file_date(&abs))?;
    }
    search.commit()?;
    status_of(indexer)
}

/// 색인에서 첨부를 전부 뺀다. 추출 캐시는 남긴다 — 다시 켤 때 즉시 복구하려고.
pub fn drop_all(search: &mut SearchEngine) -> Result<(), CoreError> {
    search.remove_by_type(FILE_TYPE)?;
    search.commit()
}

/// 첨부 하나만 갱신 (watcher가 부른다). 파일이 없어지면 색인·캐시에서 뺀다.
pub fn refresh_one(
    vault: &Vault,
    indexer: &mut Indexer,
    search: &mut SearchEngine,
    rel: &str,
) -> Result<(), CoreError> {
    let abs = vault.root().join(rel);
    if !abs.exists() {
        indexer.remove_doc(rel)?;
        search.remove(rel)?;
        return search.commit();
    }
    let ext = abs
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !extract::is_supported(&ext) {
        return Ok(());
    }
    let (mtime, size) = stamp(&abs);
    if indexer.cached_doc(rel, mtime, size)?.is_some() {
        return Ok(()); // 내용이 그대로다
    }
    let r = extract::extract(&abs);
    indexer.put_doc(rel, mtime, size, &ext, &r.text, r.status.as_str())?;
    if r.status == Status::Ok && !r.text.is_empty() {
        index_doc(search, rel, &r.text, &file_date(&abs))?;
    } else {
        search.remove(rel)?;
    }
    search.commit()
}

/// 캐시의 상태별 개수를 모아 현황으로
pub fn status_of(indexer: &Indexer) -> Result<FileIndexStatus, CoreError> {
    let mut s = FileIndexStatus::default();
    for (status, n) in indexer.doc_status_counts()? {
        match status.as_str() {
            "ok" => s.indexed = n,
            "empty" => s.empty = n,
            "encrypted" => s.encrypted = n,
            "too_big" => s.too_big = n,
            _ => s.failed += n,
        }
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    // zip fixture를 만드는 테스트에서만 쓴다 (docs를 끄면 그 테스트가 빠진다)
    #[cfg(feature = "docs")]
    use std::io::Write;

    /// 테스트용 접근자 — 잠금 대신 RefCell 하나로 둘을 함께 빌려준다
    struct Local {
        indexer: std::cell::RefCell<Indexer>,
        search: std::cell::RefCell<SearchEngine>,
    }

    impl IndexAccess for Local {
        fn with<R>(
            &self,
            f: impl FnOnce(&mut Indexer, &mut SearchEngine) -> Result<R, CoreError>,
        ) -> Result<R, CoreError> {
            f(&mut self.indexer.borrow_mut(), &mut self.search.borrow_mut())
        }
    }

    /// 빌려온 인덱스로 build를 돌리는 테스트 편의 함수
    fn run_build(
        v: &Vault,
        i: &mut Indexer,
        s: &mut SearchEngine,
        cancel: Arc<AtomicBool>,
    ) -> FileIndexStatus {
        struct Borrowed<'a> {
            indexer: std::cell::RefCell<&'a mut Indexer>,
            search: std::cell::RefCell<&'a mut SearchEngine>,
        }
        impl IndexAccess for Borrowed<'_> {
            fn with<R>(
                &self,
                f: impl FnOnce(&mut Indexer, &mut SearchEngine) -> Result<R, CoreError>,
            ) -> Result<R, CoreError> {
                f(&mut self.indexer.borrow_mut(), &mut self.search.borrow_mut())
            }
        }
        let root = v.root().to_path_buf();
        let rels = list_attachments(v);
        let b = Borrowed {
            indexer: std::cell::RefCell::new(i),
            search: std::cell::RefCell::new(s),
        };
        build(&root, &rels, &b, cancel, |_| {}).unwrap()
    }

    fn vault_with_attachments() -> (tempfile::TempDir, Vault, Indexer, SearchEngine) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        let idx = Indexer::open(&dir.path().join(".yamcha/index.db")).unwrap();
        let s = SearchEngine::open(&dir.path().join(".yamcha/search")).unwrap();

        let att = dir.path().join("_attachments").join("2026-07");
        std::fs::create_dir_all(&att).unwrap();
        std::fs::write(att.join("메모.txt"), "여름 소나기 이야기 전용면적 84").unwrap();
        std::fs::write(att.join("일정.csv"), "날짜,내용\n2026-07-30,청약 접수").unwrap();
        // 표지 폴더는 훑지 않는다
        let covers = dir.path().join("_attachments").join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        std::fs::write(covers.join("책.jpg"), b"jpeg").unwrap();
        // 다루지 않는 확장자
        std::fs::write(att.join("그림.png"), b"png").unwrap();

        (dir, v, idx, s)
    }

    #[test]
    fn lists_only_supported_attachments() {
        let (_d, v, _i, _s) = vault_with_attachments();
        let list = list_attachments(&v);
        assert_eq!(
            list,
            vec![
                "_attachments/2026-07/메모.txt".to_string(),
                "_attachments/2026-07/일정.csv".to_string(),
            ]
        );
    }

    #[test]
    #[cfg(feature = "docs")]
    fn build_indexes_attachments_and_drop_removes_them() {
        let (_d, v, i, s) = vault_with_attachments();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut seen: Vec<String> = Vec::new();
        let root = v.root().to_path_buf();
        let rels = list_attachments(&v);
        let local = Local {
            indexer: std::cell::RefCell::new(i),
            search: std::cell::RefCell::new(s),
        };
        let st = build(&root, &rels, &local, cancel, |p| seen.push(p.current)).unwrap();
        let mut i = local.indexer.into_inner();
        let mut s = local.search.into_inner();

        assert_eq!(st.indexed, 2);
        assert!(!st.has_gaps());
        // 진행 알림이 파일마다 온다
        assert_eq!(seen.len(), 2);

        // 노트 검색(기본)에는 첨부가 안 나온다
        assert!(s.search("소나기", 10).unwrap().is_empty());

        // 첨부 검색에는 나온다
        let files = crate::search::SearchFilter {
            scope: crate::search::SearchScope::Files,
            ..Default::default()
        };
        let hits = s.search_filtered("소나기", &files, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "_attachments/2026-07/메모.txt");
        // 제목 자리에 파일 이름이 들어가므로 파일명 검색도 된다
        assert_eq!(hits[0].title, "메모.txt");
        let by_name = s.search_filtered("일정", &files, 10).unwrap();
        assert_eq!(by_name.len(), 1);

        // 끄면 색인에서 사라진다
        drop_all(&mut s).unwrap();
        assert!(s.search_filtered("소나기", &files, 10).unwrap().is_empty());
        // 노트는 그대로 (첨부만 빠졌다)
        assert_eq!(i.all_docs().unwrap().len(), 2, "추출 캐시는 남아 있어야 한다");

        // 다시 켜면 재추출 없이 즉시 복구된다
        let st = rebuild_from_cache(&v, &mut i, &mut s).unwrap();
        assert_eq!(st.indexed, 2);
        assert_eq!(s.search_filtered("소나기", &files, 10).unwrap().len(), 1);
    }

    /// watcher는 바뀐 파일 하나만 넘긴다. 그때 나머지 캐시가 날아가면 안 된다.
    /// (예전엔 build 안에서 prune을 해서 이 경로가 나머지를 다 지웠다)
    #[test]
    #[cfg(feature = "docs")]
    fn partial_build_keeps_other_cache_entries() {
        let (_d, v, mut i, mut s) = vault_with_attachments();
        run_build(&v, &mut i, &mut s, Arc::new(AtomicBool::new(false)));
        assert_eq!(i.all_docs().unwrap().len(), 2);

        // 파일 하나만 넘겨 다시 돌린다
        struct Borrowed<'a> {
            indexer: std::cell::RefCell<&'a mut Indexer>,
            search: std::cell::RefCell<&'a mut SearchEngine>,
        }
        impl IndexAccess for Borrowed<'_> {
            fn with<R>(
                &self,
                f: impl FnOnce(&mut Indexer, &mut SearchEngine) -> Result<R, CoreError>,
            ) -> Result<R, CoreError> {
                f(&mut self.indexer.borrow_mut(), &mut self.search.borrow_mut())
            }
        }
        let root = v.root().to_path_buf();
        let one = vec!["_attachments/2026-07/메모.txt".to_string()];
        let b = Borrowed {
            indexer: std::cell::RefCell::new(&mut i),
            search: std::cell::RefCell::new(&mut s),
        };
        build(&root, &one, &b, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        drop(b);

        assert_eq!(
            i.all_docs().unwrap().len(),
            2,
            "일부만 넘겼는데 나머지 캐시가 사라졌다"
        );
    }

    #[test]
    fn cancel_stops_early() {
        let (_d, v, i, s) = vault_with_attachments();
        let cancel = Arc::new(AtomicBool::new(true)); // 시작부터 취소 상태
        let root = v.root().to_path_buf();
        let rels = list_attachments(&v);
        let local = Local {
            indexer: std::cell::RefCell::new(i),
            search: std::cell::RefCell::new(s),
        };
        let st = build(&root, &rels, &local, cancel, |_| {}).unwrap();
        let i = local.indexer.into_inner();
        assert_eq!(st.indexed, 0);
        assert!(i.all_docs().unwrap().is_empty());
    }

    #[test]
    #[cfg(feature = "docs")]
    fn refresh_one_follows_the_file() {
        let (d, v, mut i, mut s) = vault_with_attachments();
        let cancel = Arc::new(AtomicBool::new(false));
        run_build(&v, &mut i, &mut s, cancel);

        let files = crate::search::SearchFilter {
            scope: crate::search::SearchScope::Files,
            ..Default::default()
        };
        let rel = "_attachments/2026-07/메모.txt";
        let abs = d.path().join(rel);

        // 내용이 바뀌면 새 내용으로 찾힌다
        std::fs::write(&abs, "내용이 완전히 바뀌었다 토크나이저").unwrap();
        // mtime 해상도가 초 단위라 크기까지 달라지도록 썼다
        refresh_one(&v, &mut i, &mut s, rel).unwrap();
        assert_eq!(s.search_filtered("토크나이저", &files, 10).unwrap().len(), 1);
        assert!(s.search_filtered("소나기", &files, 10).unwrap().is_empty());

        // 파일이 사라지면 색인·캐시에서 빠진다
        std::fs::remove_file(&abs).unwrap();
        refresh_one(&v, &mut i, &mut s, rel).unwrap();
        assert!(s.search_filtered("토크나이저", &files, 10).unwrap().is_empty());
        assert!(i.all_docs().unwrap().iter().all(|d| d.rel_path != rel));
    }

    /// 실제 vault로 끝까지 확인한다 (fixture가 아닌 진짜 문서·진짜 인덱스).
    /// 앱이 같은 vault를 열고 있으면 tantivy 쓰기 잠금이 겹치므로 앱을 먼저 닫아야 한다.
    ///
    /// YAMCHA_VAULT=<vault경로> YAMCHA_FIND=<찾을말> \
    ///   cargo test -p yamcha-core real_vault_end_to_end -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_vault_end_to_end() {
        let path = std::env::var("YAMCHA_VAULT").expect("YAMCHA_VAULT에 vault 경로를 넣어 주세요");
        let needle = std::env::var("YAMCHA_FIND").unwrap_or_else(|_| "소나기".to_string());
        let root = std::path::PathBuf::from(&path);
        let v = Vault::open(&root).unwrap();
        let mut i = Indexer::open(&root.join(".yamcha/index.db")).unwrap();
        let mut s = SearchEngine::open(&root.join(".yamcha/search")).unwrap();

        let rels = list_attachments(&v);
        println!("첨부 {}개", rels.len());
        let t = std::time::Instant::now();
        let st = run_build(&v, &mut i, &mut s, Arc::new(AtomicBool::new(false)));
        println!(
            "색인 {}ms — 성공 {} · 스캔본 {} · 암호 {} · 실패 {} · 초과 {}",
            t.elapsed().as_millis(),
            st.indexed,
            st.empty,
            st.encrypted,
            st.failed,
            st.too_big
        );

        let files = crate::search::SearchFilter {
            scope: crate::search::SearchScope::Files,
            ..Default::default()
        };
        let t = std::time::Instant::now();
        let hits = s.search_filtered(&needle, &files, 50).unwrap();
        println!("\"{needle}\" 첨부 검색 {}µs — {}건", t.elapsed().as_micros(), hits.len());
        for h in hits.iter().take(3) {
            println!("  {} ({})", h.title, h.date);
        }
        assert!(!hits.is_empty(), "첨부에서 \"{needle}\"을 못 찾았다");

        // 노트 검색에는 첨부가 섞이지 않는다
        let notes = s.search(&needle, 50).unwrap();
        assert!(
            notes.iter().all(|h| h.note_type != FILE_TYPE),
            "노트 검색에 첨부가 섞였다"
        );

        // 인덱스 크기 — "끄면 원래 크기로 돌아온다"가 실제로 그런지 본다
        let index_dir = root.join(".yamcha/search");
        let size_mb = |p: &std::path::Path| -> f64 {
            fn walk(p: &std::path::Path) -> u64 {
                std::fs::read_dir(p)
                    .map(|rd| {
                        rd.flatten()
                            .map(|e| {
                                let path = e.path();
                                if path.is_dir() {
                                    walk(&path)
                                } else {
                                    e.metadata().map(|m| m.len()).unwrap_or(0)
                                }
                            })
                            .sum()
                    })
                    .unwrap_or(0)
            }
            walk(p) as f64 / 1_048_576.0
        };
        println!("첨부 켠 인덱스 {:.1}MB", size_mb(&index_dir));

        // 끄면 사라지고, 다시 켜면 재추출 없이 돌아온다
        let t = std::time::Instant::now();
        drop_all(&mut s).unwrap();
        println!("끄기 {}ms → 인덱스 {:.1}MB", t.elapsed().as_millis(), size_mb(&index_dir));
        assert!(s.search_filtered(&needle, &files, 50).unwrap().is_empty());

        let t = std::time::Instant::now();
        rebuild_from_cache(&v, &mut i, &mut s).unwrap();
        println!("재추출 없이 복구 {}ms", t.elapsed().as_millis());
        assert!(!s.search_filtered(&needle, &files, 50).unwrap().is_empty());
    }

    #[test]
    #[cfg(feature = "docs")]
    fn gaps_are_reported_for_unreadable_documents() {
        let (d, v, mut i, mut s) = vault_with_attachments();
        // 깨진 hwp — 읽히지 않는다
        let att = d.path().join("_attachments").join("2026-07");
        std::fs::write(att.join("깨진.hwp"), "OLE가 아니다").unwrap();
        // 본문 XML이 없는 docx
        let f = std::fs::File::create(att.join("빈.docx")).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        z.start_file("docProps/app.xml", opts).unwrap();
        z.write_all(b"<x/>").unwrap();
        z.finish().unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let st = run_build(&v, &mut i, &mut s, cancel);
        assert_eq!(st.indexed, 2);
        assert_eq!(st.failed, 2, "읽지 못한 문서를 현황에 알려야 한다");
        assert!(st.has_gaps());
    }
}
