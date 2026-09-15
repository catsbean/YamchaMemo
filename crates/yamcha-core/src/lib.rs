//! YamchaMemo 코어 라이브러리.
//!
//! 파일 IO·스키마·템플릿·인덱싱·검색·미러링 로직이 모두 여기에 위치한다.
//! 이 크레이트는 `tauri`에 의존하지 않는다 (모바일 확장 시 그대로 재사용).

pub mod audit;
pub mod autotag;
pub mod enrich;
pub mod error;
pub mod extract;
pub mod file_index;
pub mod history;
pub mod index_file;
pub mod indexer;
pub mod korean;
#[cfg(test)]
mod lock_bench;
pub mod mirror;
pub mod parse;
pub mod schema;
pub mod search;
pub mod template;
pub mod vault;

pub use audit::{IssueKind, NoteIssue};
pub use autotag::{suggest_tags, DictEntry, DictSource, TagInput, TagSuggestion};
pub use enrich::suggest_genre;
pub use error::CoreError;
pub use history::{HistoryItem, HistoryPolicy};
pub use file_index::{FileIndexProgress, FileIndexStatus};
pub use indexer::{Backlink, Indexer, NoteRef, TagCount};
pub use schema::{Builtin, EntryKind, FieldDef, FieldKind, TypeDef};
pub use search::{SearchEngine, SearchFilter, SearchHit, SearchScope, FILE_TYPE};
pub use vault::{
    fingerprint, CalloutDef, NoteContent, NoteSummary, ParsedNote, SaveResult, TrashItem, Vault,
};

/// 증분 색인 결과
#[derive(Debug, Clone, Copy, Default)]
pub struct ReindexReport {
    /// 다시 읽어 색인한 편수
    pub indexed: usize,
    /// 색인에서 지운 편수 (앱이 꺼져 있는 동안 사라진 파일)
    pub removed: usize,
    /// 바뀌지 않아 건너뛴 편수
    pub skipped: usize,
    /// 전체를 다시 읽었는가 (첫 실행이거나 검색 색인이 새로 만들어졌을 때)
    pub full: bool,
    /// 아직 이 기기에 내려받지 않은 클라우드 파일이라 열지 않은 편수.
    /// 색인에 남은 옛 내용은 그대로 두고, 내려받힌 뒤 따로 따라잡는다.
    pub offline: usize,
}

/// 색인 진행 알림 — (처리한 편수, 전체 편수). 시작 화면이 "몇 편 중 몇 편"을 보여 주는 데 쓴다.
pub type ReindexProgress<'a> = &'a mut dyn FnMut(usize, usize);

/// vault 전체를 다시 인덱싱한다 (SQLite + tantivy).
pub fn reindex_all(
    vault: &Vault,
    indexer: &mut Indexer,
    search: &mut SearchEngine,
) -> Result<usize, CoreError> {
    reindex_all_with(vault, indexer, search, &mut |_, _| {})
}

/// `reindex_all` + 진행 알림.
///
/// 내려받지 않은 클라우드 파일은 **열지 않는다** — 열면 다운로드가 끝날 때까지 여기서
/// 멈추고, 그게 앱 시작 화면이 얼어붙는 원인이었다(iCloud 동기화 직후 실측 20초+).
/// 그 편들은 색인에 없는 채로 두고 내려받힌 뒤 `refresh_note`로 따라잡는다.
pub fn reindex_all_with(
    vault: &Vault,
    indexer: &mut Indexer,
    search: &mut SearchEngine,
    progress: ReindexProgress<'_>,
) -> Result<usize, CoreError> {
    indexer.clear()?;
    search.clear()?;
    let files = vault.list_note_files()?;
    let total = files.len();
    let mut states = Vec::new();
    for (i, file) in files.iter().enumerate() {
        progress(i, total);
        if file.offline {
            continue;
        }
        if let Ok(parsed) = vault.parse_full(&file.rel_path) {
            indexer.upsert(&parsed)?;
            search.upsert(&parsed)?;
            states.push((file.rel_path.clone(), file.mtime, file.size));
        }
    }
    progress(total, total);
    // 신원은 한 번에 몰아서 쓴다 (편마다 쓰면 그때마다 커밋한다)
    indexer.set_note_states(&states)?;
    search.commit()?;
    Ok(states.len())
}

/// **바뀐 노트만** 다시 인덱싱한다 — 앱을 켤 때 쓴다.
///
/// 예전에는 켤 때마다 vault 전체를 다시 읽었다(실측: 2,000편에 11.9초). 색인은
/// 파일에서 만들어지는 파생물이고 파일은 대부분 그대로인데, 매번 처음부터 만들
/// 이유가 없다. 색인이 기억하는 (수정시각, 크기)와 지금 디스크의 값을 견줘
/// 달라진 것만 읽는다 — 내용은 달라진 편만 연다.
///
/// 검색 색인이 손상돼 새로 만들어졌다면 **반드시 전체를 다시 읽는다**. 그때는
/// 안이 비어 있어서, 파일이 안 바뀌었다고 건너뛰면 그 노트들이 검색에서 사라진다.
pub fn reindex_changed(
    vault: &Vault,
    indexer: &mut Indexer,
    search: &mut SearchEngine,
) -> Result<ReindexReport, CoreError> {
    reindex_changed_with(vault, indexer, search, &mut |_, _| {})
}

/// `reindex_changed` + 진행 알림. 내려받지 않은 클라우드 파일은 열지 않는다(`reindex_all_with` 참고).
pub fn reindex_changed_with(
    vault: &Vault,
    indexer: &mut Indexer,
    search: &mut SearchEngine,
    progress: ReindexProgress<'_>,
) -> Result<ReindexReport, CoreError> {
    if search.was_rebuilt() {
        let files = vault.list_note_files()?;
        let offline = files.iter().filter(|f| f.offline).count();
        let indexed = reindex_all_with(vault, indexer, search, progress)?;
        return Ok(ReindexReport { indexed, full: true, offline, ..Default::default() });
    }

    let files = vault.list_note_files()?;
    reindex_files(vault, &files, indexer, search, progress)
}

/// 증분 색인의 몸통 — 목록을 받아 처리한다. 목록을 따로 받는 건 시험에서 "내려받지 않은
/// 파일"을 흉내 내기 위해서다 (자리표시자는 클라우드 드라이브 안에서만 만들 수 있다).
fn reindex_files(
    vault: &Vault,
    files: &[crate::vault::NoteFile],
    indexer: &mut Indexer,
    search: &mut SearchEngine,
    progress: ReindexProgress<'_>,
) -> Result<ReindexReport, CoreError> {
    let mut known = indexer.note_states()?;
    let total = files.len();
    let mut report = ReindexReport::default();
    let mut states = Vec::new();

    for (i, file) in files.iter().enumerate() {
        progress(i, total);
        // 색인이 기억하는 신원과 같으면 열지 않는다
        if known.remove(&file.rel_path) == Some((file.mtime, file.size)) {
            report.skipped += 1;
            continue;
        }
        // 바뀌었지만 아직 내려받지 않았다 — 색인의 옛 내용을 그대로 두고 신원도 갱신하지
        // 않는다. 그래야 내려받힌 뒤(또는 다음 시작에) 다시 "바뀐 것"으로 잡힌다.
        if file.offline {
            report.offline += 1;
            continue;
        }
        if let Ok(parsed) = vault.parse_full(&file.rel_path) {
            indexer.upsert(&parsed)?;
            search.upsert(&parsed)?;
            states.push((file.rel_path.clone(), file.mtime, file.size));
            report.indexed += 1;
        }
    }
    progress(total, total);
    indexer.set_note_states(&states)?;

    // 남은 것 = 색인에는 있는데 디스크에 없다 (앱이 꺼진 사이에 지워졌다)
    for rel in known.keys() {
        indexer.remove(rel)?;
        search.remove(rel)?;
        report.removed += 1;
    }

    search.commit()?;
    Ok(report)
}

pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn version_is_nonempty() {
        assert!(!super::version().is_empty());
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        idx: tempfile::TempDir,
        vault: Vault,
    }

    fn setup() -> (Fixture, Indexer, SearchEngine) {
        let dir = tempfile::tempdir().unwrap();
        let idx = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let indexer = Indexer::open(&idx.path().join("index.db")).unwrap();
        let search = SearchEngine::open(&idx.path().join("search")).unwrap();
        (Fixture { _dir: dir, idx, vault }, indexer, search)
    }

    /// 아직 내려받지 않은 클라우드 파일은 열지 않는다 — 열면 다운로드가 끝날 때까지 멈추고,
    /// 그게 시작 화면이 얼어붙던 원인이다. 색인의 옛 내용과 신원은 그대로 둬서
    /// 내려받힌 뒤 다시 "바뀐 것"으로 잡히게 한다.
    #[test]
    fn 내려받지_않은_노트는_열지_않고_신원도_남기지_않는다() {
        let (f, mut i, mut s) = setup();
        let rel = f.vault.create_note("free", "구름 노트", json!({})).unwrap();
        f.vault.save_note(&rel, json!({}), "옛 본문 자차카타").unwrap();
        reindex_changed(&f.vault, &mut i, &mut s).unwrap();

        // 앱 밖(다른 기기)에서 고쳐졌고, 이 기기엔 자리표시자만 왔다고 치자
        std::thread::sleep(std::time::Duration::from_millis(15));
        f.vault.save_note(&rel, json!({}), "새 본문 파하가나").unwrap();
        let mut files = f.vault.list_note_files().unwrap();
        files.iter_mut().for_each(|x| x.offline = true);

        let r = reindex_files(&f.vault, &files, &mut i, &mut s, &mut |_, _| {}).unwrap();
        assert_eq!(r.offline, 1, "내려받지 않은 파일을 건너뛰지 않았다");
        assert_eq!(r.indexed, 0, "내려받지 않은 파일을 읽었다");
        assert_eq!(s.search("자차카타", 10).unwrap().len(), 1, "옛 내용을 지웠다");
        assert!(s.search("파하가나", 10).unwrap().is_empty());

        // 내려받힌 뒤 다시 돌면 이제야 읽는다 — 신원을 안 남겨 뒀기 때문
        let r = reindex_changed(&f.vault, &mut i, &mut s).unwrap();
        assert_eq!(r.indexed, 1, "내려받힌 뒤에도 옛 신원 때문에 건너뛰었다");
        assert_eq!(s.search("파하가나", 10).unwrap().len(), 1);
    }

    /// 진행 알림은 0/N부터 N/N까지 온다 — 시작 화면이 "몇 편 중 몇 편"을 보여 주는 근거
    #[test]
    fn 진행_알림은_처음과_끝을_모두_알린다() {
        let (f, mut i, mut s) = setup();
        for n in 0..3 {
            f.vault.create_note("free", &format!("노트 {n}"), json!({})).unwrap();
        }
        let mut seen = Vec::new();
        reindex_changed_with(&f.vault, &mut i, &mut s, &mut |d, t| seen.push((d, t))).unwrap();
        assert_eq!(seen.first(), Some(&(0, 3)));
        assert_eq!(seen.last(), Some(&(3, 3)));
        assert_eq!(seen.len(), 4);
    }

    /// 파일 신원이 그대로면 열지 않는다 — 이게 증분의 전부다
    #[test]
    fn 바뀌지_않은_노트는_건너뛴다() {
        let (f, mut i, mut s) = setup();
        for n in 0..3 {
            f.vault.create_note("free", &format!("노트 {n}"), json!({})).unwrap();
        }

        let first = reindex_changed(&f.vault, &mut i, &mut s).unwrap();
        assert_eq!(first.indexed, 3);
        assert_eq!(first.skipped, 0);

        // 아무것도 안 건드리고 다시 — 전부 건너뛴다
        let second = reindex_changed(&f.vault, &mut i, &mut s).unwrap();
        assert_eq!(second.indexed, 0, "안 바뀐 노트를 다시 읽었다");
        assert_eq!(second.skipped, 3);
        assert!(!second.full);
    }

    /// 내용이 바뀌면 반드시 다시 읽어야 한다 (검색 결과가 낡으면 안 된다)
    #[test]
    fn 바뀐_노트는_다시_읽고_검색에_반영된다() {
        let (f, mut i, mut s) = setup();
        let rel = f.vault.create_note("free", "고칠 노트", json!({})).unwrap();
        reindex_changed(&f.vault, &mut i, &mut s).unwrap();
        assert!(s.search("가나다라마", 10).unwrap().is_empty());

        // mtime 해상도(밀리초) 밖으로 벌린 뒤 고친다
        std::thread::sleep(std::time::Duration::from_millis(15));
        f.vault.save_note(&rel, json!({}), "가나다라마 새 본문").unwrap();

        let r = reindex_changed(&f.vault, &mut i, &mut s).unwrap();
        assert_eq!(r.indexed, 1, "바뀐 노트를 건너뛰었다");
        assert_eq!(s.search("가나다라마", 10).unwrap().len(), 1, "검색에 안 걸린다");
    }

    /// 앱이 꺼져 있는 동안 지워진 파일은 색인에서도 빠져야 한다
    #[test]
    fn 사라진_노트는_색인에서_지운다() {
        let (f, mut i, mut s) = setup();
        let rel = f.vault.create_note("free", "사라질 노트", json!({})).unwrap();
        f.vault.save_note(&rel, json!({}), "바다바다바다").unwrap();
        reindex_changed(&f.vault, &mut i, &mut s).unwrap();
        assert_eq!(s.search("바다바다바다", 10).unwrap().len(), 1);

        // 앱 밖에서 지운 상황
        std::fs::remove_file(f.vault.root().join(&rel)).unwrap();

        let r = reindex_changed(&f.vault, &mut i, &mut s).unwrap();
        assert_eq!(r.removed, 1, "지워진 노트가 색인에 남았다");
        assert!(s.search("바다바다바다", 10).unwrap().is_empty(), "검색에 유령이 남았다");
    }

    /// **검색 색인이 손상돼 새로 만들어졌으면 전체를 다시 읽어야 한다.**
    /// SQLite는 멀쩡하니 "안 바뀌었다"고 건너뛰면 그 노트들은 검색에서 영영 사라진다.
    /// 증분 색인에서 제일 위험한 자리다.
    #[test]
    fn 검색_색인이_날아가면_전체를_다시_읽는다() {
        let (f, mut i, mut s) = setup();
        let rel = f.vault.create_note("free", "지켜야 할 노트", json!({})).unwrap();
        f.vault.save_note(&rel, json!({}), "마바사마바사").unwrap();
        reindex_changed(&f.vault, &mut i, &mut s).unwrap();
        assert_eq!(s.search("마바사마바사", 10).unwrap().len(), 1);

        // 검색 색인만 망가뜨린다 (SQLite는 그대로 — note_state가 살아 있다)
        drop(s);
        let search_dir = f.idx.path().join("search");
        std::fs::remove_dir_all(&search_dir).unwrap();
        std::fs::create_dir_all(&search_dir).unwrap();
        std::fs::write(search_dir.join("meta.json"), "망가진 내용").unwrap();

        let mut s2 = SearchEngine::open(&search_dir).unwrap();
        assert!(s2.was_rebuilt(), "새로 만들었는데 표시가 없다");

        let r = reindex_changed(&f.vault, &mut i, &mut s2).unwrap();
        assert!(r.full, "전체를 다시 읽지 않았다");
        assert_eq!(
            s2.search("마바사마바사", 10).unwrap().len(),
            1,
            "손상 복구 뒤 노트가 검색에서 사라졌다"
        );
    }
}
