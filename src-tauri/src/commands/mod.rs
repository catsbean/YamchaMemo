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
}

pub struct AppState(pub Mutex<Option<Ctx>>);

/// 파일 감시 핸들 (set_vault 시 교체)
pub struct WatcherState(pub Mutex<Option<crate::watcher::WatcherHandle>>);

fn with_ctx<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Ctx) -> Result<T, yamcha_core::CoreError>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let ctx = guard.as_mut().ok_or("vault가 설정되지 않았습니다")?;
    f(ctx).map_err(|e| e.to_string())
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
pub(crate) fn refresh_note(ctx: &mut Ctx, rel: &str) -> Result<(), yamcha_core::CoreError> {
    crate::watcher::mark_self_write();
    match ctx.vault.parse_full(rel) {
        Ok(parsed) => {
            ctx.indexer.upsert(&parsed)?;
            ctx.search.upsert(&parsed)?;
            // 방금 색인한 시점의 파일 신원도 남긴다 — 안 남기면 다음에 앱을 켤 때
            // 이 편을 또 읽는다 (틀리지는 않지만 증분의 이득이 사라진다)
            if let Ok(meta) = std::fs::metadata(ctx.vault.root().join(rel)) {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                ctx.indexer.set_note_state(rel, mtime, meta.len() as i64)?;
            }
        }
        Err(_) => {
            ctx.indexer.remove(rel)?;
            ctx.search.remove(rel)?;
        }
    }
    ctx.search.commit()
}

#[tauri::command]
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

/// vault 폴더를 열고 (없으면 폴더 구조 생성) 전체 재색인
#[tauri::command]
#[specta::specta]
pub fn set_vault(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    // 로컬 이미지(표지 등)를 asset:// 프로토콜로 표시할 수 있게 vault를 스코프에 허용
    let _ = app
        .asset_protocol_scope()
        .allow_directory(std::path::Path::new(&path), true);
    // 락을 먼저 잡아 동시 호출을 직렬화하고, 기존 Ctx를 놓아
    // tantivy IndexWriter 잠금(LockBusy)을 해제한 뒤 새로 연다.
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.vault.root() == std::path::Path::new(&path) {
            return Ok(()); // 같은 vault 중복 호출 무시
        }
    }
    *guard = None;
    let vault = Vault::open(&path).map_err(|e| e.to_string())?;
    let index_dir = index_dir_for(&app, vault.root())?;
    std::fs::create_dir_all(&index_dir).map_err(|e| e.to_string())?;
    let mut indexer = Indexer::open(&index_dir.join("index.db")).map_err(|e| e.to_string())?;
    let mut search = SearchEngine::open(&index_dir.join("search")).map_err(|e| e.to_string())?;
    remove_legacy_index(vault.root());
    // 바뀐 노트만 다시 읽는다 — 켤 때마다 전체를 읽으면 2,000편에 11.9초다
    yamcha_core::reindex_changed(&vault, &mut indexer, &mut search).map_err(|e| e.to_string())?;
    // 없어진 노트의 스냅샷을 걷는다. 앱 밖(옵시디언·탐색기)에서 지운 파일은
    // delete_note를 거치지 않아 스냅샷만 남는다 — 놔두면 계속 쌓인다.
    if let Ok(files) = vault.list_note_files() {
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
    });
    drop(guard);
    crate::watcher::mark_self_write();
    // 파일 감시 시작 (기존 감시는 교체)
    let watcher_state = app.state::<WatcherState>();
    let handle = crate::watcher::start(app.clone(), root);
    if let Ok(mut w) = watcher_state.0.lock() {
        *w = handle;
    }
    Ok(())
}

/// 첫 실행 화면에 제안할 저장 위치 (클라우드 동기화 폴더 등)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct StorageDir {
    pub label: String,
    pub path: String,
}

/// 존재하는 클라우드 동기화 폴더를 감지해 제안 목록으로 반환한다.
/// 마지막 항목은 항상 문서 폴더. 없는 경로는 건너뛴다.
#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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

/// 사용자 정의 분류 제거 — 내부 노트는 자유노트로 이동
#[tauri::command]
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
#[tauri::command]
#[specta::specta]
pub fn write_export(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))
}

/// 템플릿 미리보기 — 오늘 날짜로 자리표시자를 채워 돌려준다.
/// 화면에서 직접 치환하지 않고 이 명령을 쓰는 이유는, 실제로 노트를 만들 때와
/// 똑같은 함수를 거쳐야 미리보기가 거짓말을 하지 않기 때문이다.
#[tauri::command]
#[specta::specta]
pub fn preview_template(content: String, title: String) -> Result<String, String> {
    let today = yamcha_core::Vault::today();
    let t = if title.trim().is_empty() { "제목".to_string() } else { title };
    Ok(yamcha_core::template::render_template(&content, &today, &t))
}

/// 전체 재색인 (인덱스 손상 대비 수동 명령)
#[tauri::command]
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
