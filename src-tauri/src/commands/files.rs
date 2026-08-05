//! 첨부 문서 검색 (검색창 `📄 파일 속` 토글).

use super::*;

/// 첨부 색인 취소 플래그. 토글을 끄면 진행 중인 추출이 즉시 멈춘다.
static FILE_INDEX_CANCEL: AtomicBool = AtomicBool::new(false);

/// 지금 색인이 돌고 있는지 (같은 작업이 두 번 돌지 않게)
static FILE_INDEX_RUNNING: AtomicBool = AtomicBool::new(false);

/// 첨부가 색인에 들어가 있는지. watcher가 첨부 변경을 따라갈지 판단하는 데 쓴다.
pub(crate) static FILE_INDEX_ON: AtomicBool = AtomicBool::new(false);

/// 첨부 검색이 켜져 있는지 (watcher용)
pub(crate) fn file_index_active() -> bool {
    FILE_INDEX_ON.load(Ordering::Relaxed) || FILE_INDEX_RUNNING.load(Ordering::Relaxed)
}

/// 첨부 색인 현황 (색인된 수 · 스캔본 · 암호 · 실패)
#[tauri::command]
#[specta::specta]
pub fn file_index_status(state: State<'_, AppState>) -> Result<FileIndexStatus, String> {
    with_ctx(&state, |c| yamcha_core::file_index::status_of(&c.indexer))
}

/// 코어에 인덱스를 빌려주는 방식 — **파일 하나 쓸 때만** 잠금을 쥔다.
/// 추출은 잠금 밖에서 일어나므로 15초짜리 PDF를 읽는 동안에도 앱이 멈추지 않는다.
struct StateAccess<'a>(&'a tauri::State<'a, AppState>);

impl yamcha_core::file_index::IndexAccess for StateAccess<'_> {
    fn with<R>(
        &self,
        f: impl FnOnce(&mut Indexer, &mut SearchEngine) -> Result<R, yamcha_core::CoreError>,
    ) -> Result<R, yamcha_core::CoreError> {
        let mut guard = self
            .0
             .0
            .lock()
            .map_err(|e| yamcha_core::CoreError::Invalid(e.to_string()))?;
        let ctx = guard
            .as_mut()
            .ok_or_else(|| yamcha_core::CoreError::Invalid("vault가 설정되지 않았습니다".into()))?;
        f(&mut ctx.indexer, &mut ctx.search)
    }
}

/// 첨부 색인 시작. **바로 돌려주고 백그라운드에서 추출한다** —
/// PDF 한 건이 15초까지 걸려서(실측) 커맨드가 기다리면 앱이 멈춘 것처럼 보인다.
///
/// 진행 상황은 `file-index-progress`, 끝나면 `file-index-done` 이벤트로 알린다.
/// 이미 추출해 둔 문서는 캐시에서 즉시 채우므로 두 번째부터는 사실상 즉시 끝난다.
#[tauri::command]
#[specta::specta]
pub fn build_file_index(app: tauri::AppHandle) -> Result<(), String> {
    if FILE_INDEX_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(()); // 이미 돌고 있다
    }
    FILE_INDEX_CANCEL.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        // 첨부 목록은 짧게 잠금을 쥐고 뜬다
        let listed = {
            match state.0.lock() {
                Ok(guard) => guard
                    .as_ref()
                    .map(|c| {
                        (
                            c.vault.root().to_path_buf(),
                            yamcha_core::file_index::list_attachments(&c.vault),
                        )
                    })
                    .ok_or("vault가 설정되지 않았습니다".to_string()),
                Err(e) => Err(e.to_string()),
            }
        };

        let result = match listed {
            Ok((root, rels)) => {
                let cancel = std::sync::Arc::new(AtomicBool::new(false));
                let access = StateAccess(&state);
                // vault에서 사라진 첨부의 캐시 정리는 **전체 색인일 때만** 한다.
                // (build 안에서 하면 파일 하나만 넘기는 watcher 경로가 나머지를 다 지운다)
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(ctx) = guard.as_mut() {
                        let _ = ctx.indexer.prune_docs(&rels);
                    }
                }
                let progress_app = app.clone();
                let cancel_for_loop = cancel.clone();
                yamcha_core::file_index::build(
                    &root,
                    &rels,
                    &access,
                    cancel_for_loop,
                    |p| {
                        // 토글이 꺼졌으면 다음 파일로 넘어가지 않는다
                        if FILE_INDEX_CANCEL.load(Ordering::Relaxed) {
                            cancel.store(true, Ordering::Relaxed);
                        }
                        let _ = progress_app.emit("file-index-progress", p);
                    },
                )
                .map_err(|e| e.to_string())
            }
            Err(e) => Err(e),
        };

        FILE_INDEX_RUNNING.store(false, Ordering::SeqCst);
        match result {
            Ok(status) => {
                FILE_INDEX_ON.store(true, Ordering::SeqCst);
                let _ = app.emit("file-index-done", status);
            }
            Err(e) => {
                let _ = app.emit("file-index-error", e);
            }
        }
    });
    Ok(())
}

/// 바뀐 첨부만 다시 읽는다 (watcher가 부른다).
/// `file_index::build`와 같은 경로를 쓴다 — 추출은 잠금 밖, 색인 쓰기만 잠금 안.
/// 사라진 파일은 추출할 것이 없으니 색인·캐시에서 뺀다.
pub(crate) fn refresh_attachments(app: &tauri::AppHandle, rels: &[String]) {
    let state = app.state::<AppState>();
    let Some(root) = state
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.vault.root().to_path_buf()))
    else {
        return;
    };

    let (gone, present): (Vec<String>, Vec<String>) = rels
        .iter()
        .cloned()
        .partition(|rel| !root.join(rel).exists());

    // 사라진 파일 — 추출할 것이 없으니 잠금을 짧게 쥐고 지운다
    if !gone.is_empty() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(ctx) = guard.as_mut() {
                for rel in &gone {
                    let _ = yamcha_core::file_index::refresh_one(
                        &ctx.vault,
                        &mut ctx.indexer,
                        &mut ctx.search,
                        rel,
                    );
                }
            }
        }
    }
    if !present.is_empty() {
        let access = StateAccess(&state);
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let _ = yamcha_core::file_index::build(&root, &present, &access, cancel, |_| {});
    }
}

/// 첨부를 색인에서 뺀다 (토글 끄기). 추출 캐시는 남겨 다시 켤 때 즉시 복구한다.
#[tauri::command]
#[specta::specta]
pub fn drop_file_index(state: State<'_, AppState>) -> Result<(), String> {
    FILE_INDEX_CANCEL.store(true, Ordering::SeqCst);
    FILE_INDEX_ON.store(false, Ordering::SeqCst);
    with_ctx(&state, |c| {
        yamcha_core::file_index::drop_all(&mut c.search)
    })
}

/// 추출 캐시를 비우고 처음부터 다시 읽는다 (설정의 "문서 다시 읽기").
/// 깨졌던 파일이 고쳐졌거나 추출기가 개선됐을 때 쓴다.
#[tauri::command]
#[specta::specta]
pub fn reset_file_index(state: State<'_, AppState>) -> Result<(), String> {
    FILE_INDEX_ON.store(false, Ordering::SeqCst);
    with_ctx(&state, |c| {
        yamcha_core::file_index::drop_all(&mut c.search)?;
        c.indexer.clear_docs()
    })
}
