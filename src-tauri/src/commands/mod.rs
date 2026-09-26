use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use tauri::{Emitter, Manager, State};
use yamcha_core::schema::{builtin_defs, Builtin, EntryKind};
use yamcha_core::{
    Backlink, FieldDef, FileIndexStatus, Indexer, NoteContent, NoteRef, NoteSummary, SearchEngine,
    SearchHit,
    TagCount,
    TypeDef, Vault,
};

pub mod net;
pub mod scrap;
pub mod notes;
pub mod find;
pub mod dashboard;
pub mod maintenance;
pub mod files;
pub mod books;
pub mod kyobo;
pub mod update;

// 형제 모듈이 서로 부르는 것들. 각 모듈이 `use super::*`로 여기를 보므로,
// 여기서 한 번 모아 두면 모듈끼리의 경로를 일일이 적지 않아도 된다.
pub(crate) use books::KyoboHit;
pub(crate) use files::{file_index_active, refresh_attachments, FILE_INDEX_ON};
pub(crate) use kyobo::{kyobo_hit_to_doc, kyobo_meta, kyobo_search, KyoboMeta};
pub(crate) use net::{
    effective_key, html_unescape, http_client, net_err, quick_http_client, BROWSER_UA,
};
pub(crate) use notes::{blocks_of_body, todos_of_body, NoteBlock, NoteTodo};

/// vault + 인덱스 + 검색엔진 묶음
pub struct Ctx {
    pub vault: Vault,
    pub indexer: Indexer,
    pub search: SearchEngine,
    /// 할 일 모아 보기용 편별 캐시 (`dashboard::list_todos`가 채우고 읽는다).
    /// vault를 바꾸면 Ctx째로 새로 만들어지므로 저절로 비워진다.
    pub todo_cache: dashboard::TodoCache,
}

pub struct AppState(pub Mutex<Option<Ctx>>);

/// 파일 감시 핸들 (set_vault 시 교체)
pub struct WatcherState(pub Mutex<Option<crate::watcher::WatcherHandle>>);

/// 상태 잠금을 잡고 일한다 — 모든 커맨드가 여기를 지난다.
///
/// 커맨드는 메인 스레드가 아니라 비동기 런타임의 **작업 스레드**에서 돈다(`#[tauri::command(async)]`,
/// `command_thread_tests`). 그 스레드를 쥔 채 잠금을 기다리면, 제목 바꾸기(최대 20초)처럼
/// 오래 쥐는 일이 도는 동안 노트를 열며 부른 커맨드 몇 개가 작업 스레드를 다 차지해
/// 잠금과 무관한 커맨드까지 멈췄다(실제 앱에서 7초). `block_in_place`로 런타임에 "이 스레드는
/// 막힌다"고 알려, 기다리는 동안 다른 일은 딴 스레드로 옮겨 가게 한다.
fn with_ctx<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Ctx) -> Result<T, yamcha_core::CoreError>,
) -> Result<T, String> {
    blocking(|| {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let ctx = guard.as_mut().ok_or("vault가 설정되지 않았습니다")?;
        f(ctx).map_err(|e| e.to_string())
    })
}

/// 막힐 수 있는 일(상태 잠금 기다리기·그 안의 일)을 런타임에 알리고 돈다.
///
/// 작업 스레드면 `block_in_place`로 감싸고, 그 밖(`spawn_blocking` 스레드·시험)이면 그냥 돈다 —
/// `block_in_place`는 스레드 하나짜리 런타임에서 부르면 멈추므로 어디서 도는지 먼저 본다.
pub(crate) fn blocking<R>(f: impl FnOnce() -> R) -> R {
    match tokio::runtime::Handle::try_current() {
        Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(f)
        }
        _ => f(),
    }
}

/// 쓰기 커맨드용: 감시 억제 마킹 후 실행
fn with_ctx_write<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Ctx) -> Result<T, yamcha_core::CoreError>,
) -> Result<T, String> {
    crate::watcher::mark_self_write();
    let r = with_ctx(state, f);
    crate::watcher::mark_self_write();
    r
}

/// 노트 변경 후 인덱스 갱신 (파일이 없으면 인덱스에서 제거)
///
/// `_index.md`처럼 노트가 아닌 `.md`는 파싱하지 않고 색인에서 뺀다 — 감시가 이 파일의
/// 바깥 변경(동기화 등)을 넘겨주면 파싱돼 들어가고, 안의 `[[링크]]`가 죄다 백링크가 됐다.
pub(crate) fn refresh_note(ctx: &mut Ctx, rel: &str) -> Result<(), yamcha_core::CoreError> {
    refresh_notes(ctx, std::iter::once(rel))
}

/// 여러 편을 한 번에 색인에 반영한다 — **검색 색인 커밋은 끝에 한 번만.**
///
/// 커밋은 디스크 동기화를 거쳐 편마다 하기엔 비싸다. 제목 바꾸기처럼 한 번에 여러 편이
/// 바뀌는 자리(링크를 고쳐 쓴 노트들)에서 편마다 커밋하면 그 값이 편수만큼 쌓인다.
pub(crate) fn refresh_notes<'a>(
    ctx: &mut Ctx,
    rels: impl IntoIterator<Item = &'a str>,
) -> Result<(), yamcha_core::CoreError> {
    let rels: Vec<&str> = rels.into_iter().collect();
    with_index_retry(ctx, |ctx, force| {
        let mut dirty = force;
        let mut states = Vec::new();
        for rel in &rels {
            dirty |= index_one(ctx, rel, &mut states)?;
        }
        // 신원은 한 번에 몰아서 쓴다 — 편마다 쓰면 그때마다 SQLite 트랜잭션이 돈다
        ctx.indexer.set_note_states(&states)?;
        if dirty {
            ctx.search.commit()?;
        }
        Ok(())
    })
}

/// 색인 갱신을 몇 번 다시 해 본다.
///
/// Windows에서는 백신·검색 색인기가 갓 쓴 파일을 잠깐 쥐면 검색 색인 커밋이 "액세스가
/// 거부되었습니다(os error 5)"로 드물게 실패한다 — 불변식 시험에서 수백 번에 한 번 났고,
/// 그때 제목 바꾸기는 파일을 옮겨 놓고 실패를 돌려줬다. vault가 자기 파일에 쓰는
/// `retry_while_locked`와 같은 처방이다: 실패하면 검색 쪽을 마지막 커밋으로 되돌리고 처음부터
/// 다시 한다. 갱신은 몇 번을 해도 결과가 같다(upsert·지우기).
///
/// 다시 할 때(`force`)는 커밋을 거르지 않는다 — SQLite 쪽은 이미 반영돼 "지울 게 없다"고
/// 답하지만, 검색 쪽은 방금 되돌려졌기 때문이다.
fn with_index_retry(
    ctx: &mut Ctx,
    mut update: impl FnMut(&mut Ctx, bool) -> Result<(), yamcha_core::CoreError>,
) -> Result<(), yamcha_core::CoreError> {
    // 커밋 자체가 잠깐 막힌 것은 `SearchEngine::commit`이 이미 기다려 준다(~1초). 여기까지
    // 온 것은 그보다 오래 막혔거나 다른 까닭이다 — 두 번만 더 해 보고, 상태 잠금을 오래 쥐지 않는다.
    const BACKOFF_MS: [u64; 2] = [100, 400];
    crate::watcher::mark_self_write();
    let mut last = match update(ctx, false) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    for ms in BACKOFF_MS {
        ctx.search.rollback()?;
        std::thread::sleep(Duration::from_millis(ms));
        match update(ctx, true) {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// 한 편을 색인에 반영한다 (커밋은 부르는 쪽이) → 검색 색인을 건드렸나.
fn index_one(
    ctx: &mut Ctx,
    rel: &str,
    states: &mut Vec<(String, i64, i64)>,
) -> Result<bool, yamcha_core::CoreError> {
    // 노트가 아니면 읽어 볼 것도 없다. 예전 버전이 색인에 넣어 둔 것만 걷어낸다.
    if !Vault::is_note_file(rel) {
        return unindex_one(ctx, rel);
    }
    match ctx.vault.parse_full(rel) {
        Ok(parsed) => {
            ctx.indexer.upsert(&parsed)?;
            ctx.search.upsert(&parsed)?;
            // 방금 색인한 시점의 파일 신원도 남긴다 — 안 남기면 다음에 앱을 켤 때
            // 이 편을 또 읽는다. list_note_files와 같은 잣대(나노초)여야 한다 — 밀리초로
            // 남겼더니 신원이 안 맞아 저장한 편마다 다음 시작에 또 읽혔다.
            if let Ok(meta) = std::fs::metadata(ctx.vault.root().join(rel)) {
                let (mtime, size) = yamcha_core::file_identity(&meta);
                states.push((rel.to_string(), mtime, size));
            }
            Ok(true)
        }
        // 못 읽었다 = 지워졌거나 지금 쓰이는 중이다 — 색인에서 뺀다
        Err(_) => unindex_one(ctx, rel),
    }
}

/// 색인·검색에서 이 경로를 뺀다 (커밋은 부르는 쪽이) → **애초에 색인에 있었나**.
///
/// 없었으면 부르는 쪽이 커밋을 거른다. 검색 색인 커밋은 디스크 동기화를 거쳐 값이 비싸다.
/// `_index.md`는 노트를 만들거나 지울 때마다 다시 쓰이고 그때마다 감시를 거쳐 여기로 오는데,
/// 지울 것도 없이 커밋만 하면 그 값을 늘 치른다 — 그동안 상태 잠금을 쥐어 앱이 기다린다.
/// 검색 쪽 지우기는 늘 걸어 둔다: 값이 거의 없고, 되돌린 뒤 다시 할 때 빠지면 안 된다.
fn unindex_one(ctx: &mut Ctx, rel: &str) -> Result<bool, yamcha_core::CoreError> {
    let had = ctx.indexer.remove(rel)?;
    ctx.search.remove(rel)?;
    Ok(had)
}

/// 제목 바꾸기·옮기기 뒤 색인을 따라잡는다 — 옛 경로를 빼고, 새 경로와 링크를 고쳐 쓴
/// 노트만 다시 읽는다. 검색 색인 커밋은 한 번.
///
/// 예전에는 vault 전체를 다시 색인했다 — 2,000편에 13초(release 실측), 그동안 상태 잠금을
/// 쥐어 앱이 통째로 멈췄다. 무엇을 건드렸는지는 바꾼 쪽(`Relocation`)이 알려 준다.
///
/// **실패를 돌려주지 않는다.** 이 자리에 왔을 때 파일은 이미 새 자리에 있다. 색인(파생물)을
/// 못 따라잡았다고 실패를 돌려주면 화면은 "안 됐다"고 믿고 옛 경로를 쥔 채 남는다 — 불변식
/// 시험이 찾은 상태다. 끝내 못 따라잡으면 건드린 편의 신원을 틀어 두어 다음 시작의 증분
/// 색인이 다시 읽게(옛 경로는 지우게) 하고 넘어간다.
pub(crate) fn catch_up_relocation(ctx: &mut Ctx, old_rel: &str, moved: &yamcha_core::Relocation) {
    let touched: Vec<&str> = std::iter::once(moved.rel.as_str())
        .chain(moved.rewritten.iter().map(String::as_str))
        .collect();
    let caught_up = with_index_retry(ctx, |ctx, force| {
        let mut states = Vec::new();
        let mut dirty = force;
        if moved.rel != old_rel {
            dirty |= unindex_one(ctx, old_rel)?;
        }
        for rel in &touched {
            dirty |= index_one(ctx, rel, &mut states)?;
        }
        // 신원은 한 번에 몰아서 쓴다 — 편마다 쓰면 그때마다 SQLite 트랜잭션이 돈다
        ctx.indexer.set_note_states(&states)?;
        if dirty {
            ctx.search.commit()?;
        }
        Ok(())
    });
    if let Err(e) = caught_up {
        eprintln!("색인 따라잡기 실패 — 다음 시작에 다시 읽는다: {e}");
        let stale: Vec<(String, i64, i64)> = std::iter::once(old_rel)
            .chain(touched.iter().copied())
            .map(|r| (r.to_string(), -1, -1))
            .collect();
        let _ = ctx.indexer.set_note_states(&stale);
    }
}

#[tauri::command(async)]
#[specta::specta]
pub fn core_version() -> String {
    yamcha_core::version()
}

/// 경로를 폴더 이름으로 쓸 수 있는 짧은 값으로 (사람이 알아볼 힌트 + 충돌 없는 지문).
///
/// FNV-1a를 직접 쓴다. `DefaultHasher`는 릴리스마다 결과가 달라도 된다고 문서에
/// 못박혀 있어서, 앱을 새로 빌드할 때마다 색인 폴더가 갈릴 수 있다.
fn vault_key(vault_root: &Path) -> String {
    let raw = vault_root.to_string_lossy();
    // Windows는 대소문자를 가리지 않으므로 같은 폴더가 두 벌로 갈리지 않게 맞춘다
    let normalized = if cfg!(windows) {
        raw.to_lowercase()
    } else {
        raw.to_string()
    };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in normalized.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // 힌트도 소문자로 맞춘다 — 지문이 같은데 힌트만 달라 폴더가 갈리면
    // 같은 vault를 열 때마다 색인을 처음부터 다시 만든다
    let hint: String = vault_root
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .take(24)
        .collect();
    if hint.is_empty() {
        format!("vault-{hash:016x}")
    } else {
        format!("{hint}-{hash:016x}")
    }
}

/// 색인을 둘 곳 — **vault 밖**이다.
///
/// vault는 클라우드 동기화 폴더에 두라고 권하는 자리다(README). 그런데 색인은
/// SQLite와 tantivy로, 동기화 에이전트가 실시간으로 건드리면 깨지기 쉬운 파일이다.
/// 게다가 파일에서 언제든 다시 만들 수 있는 파생 데이터라 기기 사이로 옮길 이유가 없다.
/// vault마다 폴더를 나눠 여러 vault를 오가도 섞이지 않게 한다.
fn index_dir_for(app: &tauri::AppHandle, vault_root: &Path) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 폴더를 찾지 못했습니다: {e}"))?;
    Ok(base.join("index").join(vault_key(vault_root)))
}

/// 예전 버전이 vault 안에 만들어 둔 색인을 치운다.
///
/// 순수 파생 데이터라 지워도 바로 뒤 `reindex_all`이 새 자리에 다시 만든다. 그냥 두면
/// 클라우드 동기화가 계속 그 파일들을 실어 나른다. **휴지통과 히스토리는 사용자 데이터라
/// 절대 건드리지 않는다** — 지우는 대상을 index.db 계열과 search 폴더로 못박는다.
fn remove_legacy_index(vault_root: &Path) {
    let dot = vault_root.join(".yamcha");
    let _ = std::fs::remove_dir_all(dot.join("search"));
    // SQLite는 -wal·-shm 형제 파일을 남긴다
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(dot.join(format!("index.db{suffix}")));
    }
}

/// vault를 여는 동안의 진행 알림 (`vault-open-progress` 이벤트). 시작 화면이 문구로 보여 준다.
#[derive(serde::Serialize, Clone)]
pub struct OpenProgress {
    /// `index`(바뀐 노트 색인) · `hydrate`(내려받지 않은 노트를 받아 따라잡는 중) · `done`
    pub phase: &'static str,
    pub done: usize,
    pub total: usize,
}

fn emit_open_progress(app: &tauri::AppHandle, phase: &'static str, done: usize, total: usize) {
    let _ = app.emit("vault-open-progress", OpenProgress { phase, done, total });
}

/// vault 폴더를 열고 (없으면 폴더 구조 생성) 바뀐 노트를 재색인한다.
///
/// 비동기 커맨드다. 동기 커맨드는 메인 스레드에서 돌아서, 색인이 오래 걸리면(클라우드
/// 드라이브가 느릴 때) 창 전체가 "불러오는 중"에 얼어붙고 진행 이벤트도 못 나간다.
/// 실제 일은 `spawn_blocking`으로 보내고, 진행은 `vault-open-progress`로 알린다.
#[tauri::command]
#[specta::specta]
pub async fn set_vault(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_vault(&app, &path))
        .await
        .map_err(|e| e.to_string())?
}

fn open_vault(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    // 로컬 이미지(표지 등)를 asset:// 프로토콜로 표시할 수 있게 vault를 스코프에 허용
    let _ = app
        .asset_protocol_scope()
        .allow_directory(std::path::Path::new(path), true);
    // 락을 먼저 잡아 동시 호출을 직렬화하고, 기존 Ctx를 놓아
    // tantivy IndexWriter 잠금(LockBusy)을 해제한 뒤 새로 연다.
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.vault.root() == std::path::Path::new(path) {
            return Ok(()); // 같은 vault 중복 호출 무시
        }
    }
    *guard = None;
    let vault = Vault::open(path).map_err(|e| e.to_string())?;
    let index_dir = index_dir_for(app, vault.root())?;
    std::fs::create_dir_all(&index_dir).map_err(|e| e.to_string())?;
    let mut indexer = Indexer::open(&index_dir.join("index.db")).map_err(|e| e.to_string())?;
    let mut search = SearchEngine::open(&index_dir.join("search")).map_err(|e| e.to_string())?;
    remove_legacy_index(vault.root());
    // 바뀐 노트만 다시 읽는다 — 켤 때마다 전체를 읽으면 2,000편에 11.9초다.
    // 진행은 25편마다 한 번 알린다 (편마다 보내면 이벤트가 색인보다 비싸진다).
    let mut progress = |done: usize, total: usize| {
        if done == total || done.is_multiple_of(25) {
            emit_open_progress(app, "index", done, total);
        }
    };
    yamcha_core::reindex_changed_with(&vault, &mut indexer, &mut search, &mut progress)
        .map_err(|e| e.to_string())?;
    // 없어진 노트의 스냅샷을 걷는다. 앱 밖(옵시디언·탐색기)에서 지운 파일은
    // delete_note를 거치지 않아 스냅샷만 남는다 — 놔두면 계속 쌓인다.
    // 같은 목록에서 아직 내려받지 않은 노트도 추려 둔다 — 열린 뒤 따로 따라잡는다.
    let mut offline: Vec<String> = Vec::new();
    if let Ok(files) = vault.list_note_files() {
        offline = files.iter().filter(|f| f.offline).map(|f| f.rel_path.clone()).collect();
        let live: Vec<String> = files.into_iter().map(|f| f.rel_path).collect();
        let _ = yamcha_core::history::prune_orphans(&vault, &live);
    }
    // 강제 종료로 남은 `.md.tmp`도 함께 (하루 지난 것만 — 갓 만들어진 건 쓰는 중일 수 있다)
    let _ = vault.sweep_stale_tmp(Duration::from_secs(24 * 60 * 60));
    let root = vault.root().to_path_buf();
    *guard = Some(Ctx {
        vault,
        indexer,
        search,
        todo_cache: dashboard::TodoCache::default(),
    });
    drop(guard);
    crate::watcher::mark_self_write();
    // 파일 감시 시작 (기존 감시는 교체)
    let watcher_state = app.state::<WatcherState>();
    let handle = crate::watcher::start(app.clone(), root.clone());
    if let Ok(mut w) = watcher_state.0.lock() {
        *w = handle;
    }
    if offline.is_empty() {
        emit_open_progress(app, "done", 0, 0);
    } else {
        spawn_hydrate(app.clone(), root, offline);
    }
    Ok(())
}

/// 아직 내려받지 않은 클라우드 노트를 뒤에서 하나씩 받아 색인에 넣는다.
///
/// 시작 경로는 이 파일들을 열지 않았다(열면 다운로드가 끝날 때까지 멈춘다). 여기서는
/// 별도 스레드가 대신 기다린다 — 읽기 자체가 다운로드를 일으키고, 그동안 앱은 멀쩡히 돈다.
/// 받은 편은 `refresh_note`로 색인하고 `vault-hydrated`로 알려 목록의 임시 요약을 갈아 끼운다.
/// 감시(watcher)에만 맡기지 않는 이유: 내려받기는 내용이 바뀌는 게 아니라 속성만 바뀌어
/// 파일 변경 알림이 온다는 보장이 없다.
fn spawn_hydrate(app: tauri::AppHandle, root: PathBuf, rels: Vec<String>) {
    std::thread::spawn(move || {
        let total = rels.len();
        let mut batch: Vec<String> = Vec::new();
        for (i, rel) in rels.iter().enumerate() {
            emit_open_progress(&app, "hydrate", i, total);
            if std::fs::read(root.join(rel)).is_err() {
                continue; // 못 받았다(오프라인 등) — 다음 시작에 다시 "바뀐 것"으로 잡힌다
            }
            let state = app.state::<AppState>();
            let Ok(mut guard) = state.0.lock() else { break };
            let Some(ctx) = guard.as_mut() else { break };
            if ctx.vault.root() != root {
                break; // 그 사이 다른 vault로 옮겼다
            }
            if refresh_note(ctx, rel).is_ok() {
                batch.push(rel.clone());
            }
            drop(guard);
            if batch.len() >= 10 {
                let _ = app.emit("vault-hydrated", std::mem::take(&mut batch));
            }
        }
        if !batch.is_empty() {
            let _ = app.emit("vault-hydrated", batch);
        }
        emit_open_progress(&app, "done", total, total);
    });
}

/// 첫 실행 화면에 제안할 저장 위치 (클라우드 동기화 폴더 등)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct StorageDir {
    pub label: String,
    pub path: String,
}

/// 존재하는 클라우드 동기화 폴더를 감지해 제안 목록으로 반환한다.
/// 마지막 항목은 항상 문서 폴더. 없는 경로는 건너뛴다.
#[tauri::command(async)]
#[specta::specta]
pub fn detect_storage_dirs() -> Vec<StorageDir> {
    let mut out: Vec<StorageDir> = Vec::new();
    let mut push_if_exists = |label: &str, path: std::path::PathBuf| {
        if path.is_dir() && !out.iter().any(|d| d.path == path.to_string_lossy()) {
            out.push(StorageDir {
                label: label.to_string(),
                path: path.to_string_lossy().to_string(),
            });
        }
    };

    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        if let Ok(od) = std::env::var("OneDrive") {
            push_if_exists("☁️ OneDrive — 자동 백업(권장)", std::path::PathBuf::from(od));
        }
        if !home.is_empty() {
            push_if_exists(
                "☁️ OneDrive — 자동 백업(권장)",
                std::path::Path::new(&home).join("OneDrive"),
            );
            push_if_exists(
                "☁️ iCloud Drive",
                std::path::Path::new(&home).join("iCloudDrive"),
            );
            push_if_exists(
                "☁️ Google Drive",
                std::path::Path::new(&home).join("Google Drive"),
            );
            push_if_exists("☁️ Dropbox", std::path::Path::new(&home).join("Dropbox"));
        }
        push_if_exists("☁️ Google Drive", std::path::PathBuf::from("G:\\My Drive"));
        if !home.is_empty() {
            push_if_exists(
                "📁 문서 폴더",
                std::path::Path::new(&home).join("Documents"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            let h = std::path::Path::new(&home);
            push_if_exists("☁️ iCloud Drive — 자동 백업(권장)", h.join("Library/Mobile Documents/com~apple~CloudDocs"));
            // Google Drive: ~/Library/CloudStorage/GoogleDrive-* (글롭)
            if let Ok(entries) = std::fs::read_dir(h.join("Library/CloudStorage")) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with("GoogleDrive-") {
                        push_if_exists("☁️ Google Drive", e.path());
                    }
                }
            }
            push_if_exists("☁️ Dropbox", h.join("Dropbox"));
            push_if_exists("📁 문서 폴더", h.join("Documents"));
        }
    }

    out
}

#[tauri::command(async)]
#[specta::specta]
pub fn get_vault_path(state: State<'_, AppState>) -> Option<String> {
    state
        .0
        .lock()
        .ok()?
        .as_ref()
        .map(|c| c.vault.root().to_string_lossy().to_string())
}

/// 타입 정의 목록 (내장 + 사용자 정의). vault가 없으면 내장만.
#[tauri::command(async)]
#[specta::specta]
pub fn get_schemas(state: State<'_, AppState>) -> Vec<TypeDef> {
    state
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.vault.types().to_vec()))
        .unwrap_or_else(builtin_defs)
}

/// 사용자 정의 분류 추가
#[tauri::command(async)]
#[specta::specta]
pub fn add_custom_type(
    state: State<'_, AppState>,
    label: String,
    id: String,
    fields: Vec<FieldDef>,
    template: String,
) -> Result<TypeDef, String> {
    with_ctx_write(&state, |c| {
        c.vault.add_custom_type(&label, &id, fields, &template)
    })
}

/// 사용자 정의 분류의 본문 템플릿 수정 (생성 후에도 언제든 변경 가능)
#[tauri::command(async)]
#[specta::specta]
pub fn update_custom_type_template(
    state: State<'_, AppState>,
    id: String,
    template: String,
) -> Result<TypeDef, String> {
    with_ctx_write(&state, |c| {
        c.vault.update_custom_type_template(&id, &template)
    })
}

/// 목록 줄에 값을 내보일 칸 고르기 — 켠 칸만 이름으로 넘긴다 (나머지는 꺼진다)
#[tauri::command(async)]
#[specta::specta]
pub fn update_custom_type_list_fields(
    state: State<'_, AppState>,
    id: String,
    names: Vec<String>,
) -> Result<TypeDef, String> {
    with_ctx_write(&state, |c| c.vault.set_list_fields(&id, &names))
}

/// 사용자 정의 분류 제거 — 내부 노트는 자유노트로 이동
#[tauri::command(async)]
#[specta::specta]
pub fn remove_custom_type(state: State<'_, AppState>, id: String) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        c.vault.remove_custom_type(&id)?;
        yamcha_core::reindex_all(&c.vault, &mut c.indexer, &mut c.search)?;
        Ok(())
    })
}

/// 내보내기 파일 쓰기 — 사용자가 저장 대화상자에서 고른 경로에 그대로 쓴다.
/// (vault 밖이어도 된다. 사용자가 직접 고른 자리이므로)
#[tauri::command(async)]
#[specta::specta]
#[allow(clippy::disallowed_methods)] // vault 밖, 사용자가 고른 자리 — 끊기면 다시 내보내면 된다
pub fn write_export(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))
}

/// 템플릿 미리보기 — 오늘 날짜로 자리표시자를 채워 돌려준다.
/// 화면에서 직접 치환하지 않고 이 명령을 쓰는 이유는, 실제로 노트를 만들 때와
/// 똑같은 함수를 거쳐야 미리보기가 거짓말을 하지 않기 때문이다.
#[tauri::command(async)]
#[specta::specta]
pub fn preview_template(content: String, title: String) -> Result<String, String> {
    let today = yamcha_core::Vault::today();
    let t = if title.trim().is_empty() { "제목".to_string() } else { title };
    Ok(yamcha_core::template::render_template(&content, &today, &t))
}

/// 전체 재색인 (인덱스 손상 대비 수동 명령)
#[tauri::command(async)]
#[specta::specta]
pub fn reindex(state: State<'_, AppState>) -> Result<u32, String> {
    with_ctx(&state, |c| {
        let n = yamcha_core::reindex_all(&c.vault, &mut c.indexer, &mut c.search)?;
        // 재색인은 색인을 비우고 노트만 다시 넣는다. 첨부 검색이 켜져 있으면
        // 캐시에서 첨부도 다시 채운다 (재추출 없음).
        if FILE_INDEX_ON.load(Ordering::Relaxed) {
            yamcha_core::file_index::rebuild_from_cache(&c.vault, &mut c.indexer, &mut c.search)?;
        }
        Ok(n as u32)
    })
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // 시험은 옛 색인 파일을 흉내 내려고 맨 쓰기를 쓴다
mod index_location_tests {
    use super::*;

    #[test]
    fn 같은_vault는_늘_같은_폴더_다른_vault는_다른_폴더() {
        let a = Path::new("E:/Projects/YamchaMemo/testvault");
        let b = Path::new("E:/Projects/YamchaMemo/다른창고");
        assert_eq!(vault_key(a), vault_key(a), "같은 경로가 두 값을 냈다");
        assert_ne!(vault_key(a), vault_key(b));
        // 사람이 알아볼 힌트가 앞에 붙는다
        assert!(vault_key(a).starts_with("testvault-"), "{}", vault_key(a));
    }

    /// Windows에서 대소문자만 다른 경로는 같은 폴더다 — 두 벌로 갈리면
    /// 같은 vault를 열 때마다 색인을 처음부터 다시 만든다.
    #[test]
    #[cfg(windows)]
    fn 윈도우에서는_대소문자를_가리지_않는다() {
        assert_eq!(
            vault_key(Path::new("E:/Projects/Vault")),
            vault_key(Path::new("e:/projects/vault"))
        );
    }

    /// 옛 색인을 치울 때 **사용자 데이터는 건드리지 않는다**.
    #[test]
    fn 옛_색인만_치우고_휴지통과_히스토리는_남긴다() {
        let d = tempfile::tempdir().unwrap();
        let dot = d.path().join(".yamcha");
        std::fs::create_dir_all(dot.join("search")).unwrap();
        std::fs::create_dir_all(dot.join("trash")).unwrap();
        std::fs::create_dir_all(dot.join("history").join("Free__메모.md")).unwrap();
        std::fs::write(dot.join("search").join("meta.json"), "{}").unwrap();
        std::fs::write(dot.join("index.db"), "sqlite").unwrap();
        std::fs::write(dot.join("index.db-wal"), "wal").unwrap();
        std::fs::write(dot.join("trash").join("20260101-000000_지운것.md"), "본문").unwrap();
        std::fs::write(
            dot.join("history").join("Free__메모.md").join("20260101-000000-000.md"),
            "예전 판",
        )
        .unwrap();

        remove_legacy_index(d.path());

        assert!(!dot.join("search").exists(), "search가 남았다");
        assert!(!dot.join("index.db").exists(), "index.db가 남았다");
        assert!(!dot.join("index.db-wal").exists(), "wal이 남았다");
        // 여기부터가 진짜 확인하고 싶은 것
        assert!(
            dot.join("trash").join("20260101-000000_지운것.md").exists(),
            "휴지통을 지웠다"
        );
        assert!(
            dot.join("history").join("Free__메모.md").join("20260101-000000-000.md").exists(),
            "히스토리를 지웠다"
        );
    }
}

#[cfg(test)]
mod refresh_note_tests {
    use super::*;

    fn ctx(vault_root: &Path, index_root: &Path) -> Ctx {
        Ctx {
            vault: Vault::open(vault_root).unwrap(),
            indexer: Indexer::open(&index_root.join("index.db")).unwrap(),
            search: SearchEngine::open(&index_root.join("search")).unwrap(),
            todo_cache: dashboard::TodoCache::default(),
        }
    }

    /// 노트는 색인에 들어가고 앱이 만든 목록 파일은 들어가지 않는다 — `_index.md`가
    /// 들어가면 그 안의 `[[링크]]`가 그 분류의 모든 노트에 백링크로 떠올랐다.
    /// 색인에 없는 것을 또 빼라고 해도 조용히 아무 일도 하지 않는다(검색 색인 커밋 없음).
    #[test]
    fn 노트가_아닌_md는_색인에_들어가지_않는다() {
        let vault_dir = tempfile::tempdir().unwrap();
        let index_dir = tempfile::tempdir().unwrap();
        let mut c = ctx(vault_dir.path(), index_dir.path());

        let rel = c
            .vault
            .create_note("free", "메모", serde_json::Value::Null)
            .unwrap();
        refresh_note(&mut c, &rel).unwrap();
        c.vault.flush_index_files().unwrap();
        refresh_note(&mut c, "Free/_index.md").unwrap();

        let states = c.indexer.note_states().unwrap();
        assert!(states.contains_key(&rel), "노트가 색인에 없다: {states:?}");
        assert!(
            !states.contains_key("Free/_index.md"),
            "목록 파일이 색인에 들어갔다: {states:?}"
        );

        // 두 번째 호출도 오류 없이 지나간다 (지울 게 없다)
        refresh_note(&mut c, "Free/_index.md").unwrap();

        // 노트가 사라지면 색인에서도 빠진다
        std::fs::remove_file(vault_dir.path().join(&rel)).unwrap();
        refresh_note(&mut c, &rel).unwrap();
        assert!(!c.indexer.note_states().unwrap().contains_key(&rel));
    }

    /// 검색 색인 커밋이 끝내 실패해도 제목 바꾸기는 **성공을 돌려준다** — 파일은 이미 새
    /// 자리에 있다. 실패를 돌려주면 화면이 옛 경로를 쥔 채 남는다(불변식 시험이 찾은 상태).
    /// 못 따라잡은 편은 다음 시작의 증분 색인이 바로잡는다.
    #[test]
    #[cfg(windows)]
    fn 색인_커밋이_실패해도_제목_바꾸기는_성공한다() {
        let vault_dir = tempfile::tempdir().unwrap();
        let index_dir = tempfile::tempdir().unwrap();
        let mut c = ctx(vault_dir.path(), index_dir.path());
        let rel = notes::create_note_in(&mut c, "free", "메모", serde_json::Value::Null).unwrap();

        // 커밋이 meta.json을 갈아 끼우지 못하게 막는다 — Windows는 읽기 전용 파일을 덮어쓰지
        // 않고 "액세스가 거부되었습니다(os error 5)"를 돌려준다. 실제로 난 오류와 같다.
        let meta = index_dir.path().join("search").join("meta.json");
        let set_readonly = |on: bool| {
            let mut p = std::fs::metadata(&meta).unwrap().permissions();
            p.set_readonly(on);
            std::fs::set_permissions(&meta, p).unwrap();
        };
        set_readonly(true);
        let renamed = notes::rename_note_in(&mut c, &rel, "새 이름");
        let states = c.indexer.note_states().unwrap();
        set_readonly(false);

        let new_rel = renamed.expect("파일은 옮겨졌는데 실패를 돌려줬다");
        assert_eq!(new_rel, "Free/새 이름.md");
        assert!(vault_dir.path().join(&new_rel).is_file());
        // 실패 경로를 정말 탔는가 — 다음 시작에 다시 읽히도록 신원이 틀어져 있어야 한다
        assert_eq!(states.get(&new_rel), Some(&(-1, -1)), "커밋이 실패하지 않았다: {states:?}");
        assert_eq!(states.get(&rel), Some(&(-1, -1)), "옛 경로가 다음 시작에 지워지지 않는다");

        // 다음 시작: 증분 색인이 바로잡는다
        yamcha_core::reindex_changed(&c.vault, &mut c.indexer, &mut c.search).unwrap();
        let states = c.indexer.note_states().unwrap();
        assert!(states.contains_key(&new_rel) && !states.contains_key(&rel), "{states:?}");
        assert_eq!(
            c.search.note_paths().unwrap(),
            [new_rel].into_iter().collect(),
            "검색이 바로잡히지 않았다"
        );
    }
}

/// 커맨드는 **메인 스레드에서 돌지 않는다** — 소스를 훑어 확인한다.
///
/// Tauri의 동기 커맨드는 메인 스레드에서 돈다. 모든 커맨드가 상태 잠금 하나를 거치는데,
/// 제목 바꾸기(최대 20초)처럼 오래 쥐는 일이 도는 동안 동기 커맨드 하나(예: 노트를 열자
/// 백링크 패널이 부른 것)가 그 잠금을 기다리면 **메인 스레드가 묶여** 창이 얼고 진행 알림도
/// 화면에 닿지 않는다.
/// 그래서 모두 `async fn`이거나 `#[tauri::command(async)]`(스레드 풀에서 돈다)여야 한다.
#[cfg(test)]
mod command_thread_tests {
    #[test]
    fn 모든_커맨드는_메인_스레드_밖에서_돈다() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        let mut offenders = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            let lines: Vec<&str> = src.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if !line.trim_start().starts_with("#[tauri::command") {
                    continue;
                }
                let async_attr = line.contains("(async)");
                let Some(sig) = lines[i + 1..].iter().find(|l| l.trim_start().starts_with("pub ")) else {
                    continue;
                };
                if !async_attr && !sig.contains("async fn") {
                    let file = path.file_name().unwrap().to_string_lossy().to_string();
                    offenders.push(format!("{file}: {}", sig.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "메인 스레드에서 도는 동기 커맨드 — `#[tauri::command(async)]`를 달아라:\n{}",
            offenders.join("\n")
        );
    }
}

#[cfg(test)]
mod blocking_tests {
    use super::blocking;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// 어디서 불러도 멈추지 않는다 — 런타임 밖, 작업 스레드, `spawn_blocking` 스레드,
    /// 스레드 하나짜리 런타임(`block_in_place`를 그냥 부르면 여기서 멈춘다).
    #[test]
    fn 어디서_불러도_돈다() {
        assert_eq!(blocking(|| 1), 1);
        let mt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .build()
            .unwrap();
        assert_eq!(
            mt.block_on(async { tokio::spawn(async { blocking(|| 2) }).await.unwrap() }),
            2
        );
        assert_eq!(
            mt.block_on(async { tokio::task::spawn_blocking(|| blocking(|| 3)).await.unwrap() }),
            3
        );
        let ct = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert_eq!(ct.block_on(async { blocking(|| 4) }), 4);
    }

    /// 작업 스레드보다 많은 커맨드가 잠금을 기다려도 다른 일은 곧바로 돈다 — 고친 까닭.
    /// (그냥 기다리면 작업 스레드가 다 묶여, 잠금이 풀릴 때까지 무엇도 돌지 못했다.)
    #[test]
    fn 작업_스레드가_모두_잠금을_기다려도_다른_일은_돈다() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .build()
            .unwrap();
        let lock = Arc::new(Mutex::new(()));
        let held = lock.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _g = held.lock().unwrap();
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(800));
        });
        rx.recv().unwrap();

        let waited = rt.block_on(async {
            for _ in 0..4 {
                let l = lock.clone();
                tokio::spawn(async move { blocking(|| drop(l.lock().unwrap())) });
            }
            std::thread::sleep(Duration::from_millis(100)); // 넷이 작업 스레드를 잡을 틈
            let start = Instant::now();
            tokio::spawn(async {}).await.unwrap();
            start.elapsed()
        });
        holder.join().unwrap();
        assert!(
            waited < Duration::from_millis(400),
            "잠금과 무관한 일이 {waited:?} 기다렸다 — 작업 스레드가 잠금에 묶였다"
        );
    }
}
