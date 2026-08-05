//! 건사하기 — 미러·휴지통·스냅샷·무결성 점검·원문 수리.

use super::*;

/// 미러 폴더들로 동기화 (vault 우선, 미러가 더 새로우면 충돌 보고)
#[tauri::command]
#[specta::specta]
pub fn mirror_sync(
    state: State<'_, AppState>,
    targets: Vec<String>,
) -> Result<Vec<yamcha_core::mirror::MirrorReport>, String> {
    // vault 전체를 훑는 느린 IO다. 필요한 정보만 뽑고 **잠금을 놓은 뒤** 복사한다 —
    // 쥔 채로 돌면 그동안 저장·검색을 포함한 모든 커맨드가 뒤에 줄을 선다.
    let source = with_ctx(&state, |c| {
        Ok(yamcha_core::mirror::MirrorSource::of(&c.vault))
    })?;

    let mut reports = Vec::new();
    for t in &targets {
        reports.push(
            yamcha_core::mirror::sync_to(&source, std::path::Path::new(t))
                .map_err(|e| e.to_string())?,
        );
    }
    Ok(reports)
}

/// 낡은 `_index.md`를 지금 다시 만든다 → 다시 만든 타입 수.
///
/// 저장할 때마다 만들면 vault 전체를 다시 읽게 되어(실측 2,000편에 345ms) 자동저장이
/// 도는 내내 앱이 멈춘다. 그래서 저장은 표시만 하고, 손을 멈췄을 때 프론트가 이걸 부른다.
#[tauri::command]
#[specta::specta]
pub fn flush_index_files(state: State<'_, AppState>) -> Result<u32, String> {
    with_ctx_write(&state, |c| {
        c.vault.flush_index_files().map(|n| n as u32)
    })
}

/// 미러 충돌 해결: pull=true면 미러 내용을 vault로 가져오고 재색인
#[tauri::command]
#[specta::specta]
pub fn mirror_resolve(
    state: State<'_, AppState>,
    target: String,
    rel_path: String,
    pull: bool,
) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        yamcha_core::mirror::resolve(&c.vault, std::path::Path::new(&target), &rel_path, pull)?;
        if pull && rel_path.ends_with(".md") {
            refresh_note(c, &rel_path)?;
        }
        Ok(())
    })
}

/// 휴지통 목록
#[tauri::command]
#[specta::specta]
pub fn list_trash(state: State<'_, AppState>) -> Result<Vec<yamcha_core::TrashItem>, String> {
    with_ctx(&state, |c| c.vault.list_trash())
}

/// 휴지통에서 노트 복구 → 복구된 rel 경로
#[tauri::command]
#[specta::specta]
pub fn restore_trash(state: State<'_, AppState>, file_name: String) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        let rel = c.vault.restore_trash(&file_name)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 휴지통에서 retention_days보다 오래된 항목 영구 삭제 (0이면 안 함) → 삭제 개수
#[tauri::command]
#[specta::specta]
pub fn purge_trash(state: State<'_, AppState>, retention_days: u32) -> Result<u32, String> {
    with_ctx(&state, |c| c.vault.purge_trash(retention_days))
}

/// vault에서 규격에 어긋난 노트를 찾는다 (고치지는 않는다)
#[tauri::command]
#[specta::specta]
pub fn audit_vault(state: State<'_, AppState>) -> Result<Vec<yamcha_core::NoteIssue>, String> {
    with_ctx(&state, |c| Ok(yamcha_core::audit::audit(&c.vault)))
}

/// 점검 항목 한 건 수리 → (바뀌었을 수 있는) rel 경로
#[tauri::command]
#[specta::specta]
pub fn fix_issue(
    state: State<'_, AppState>,
    rel_path: String,
    kind: yamcha_core::IssueKind,
) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        let new_rel = yamcha_core::audit::fix(&c.vault, &rel_path, kind)?;
        if new_rel != rel_path {
            c.indexer.remove(&rel_path)?;
            c.search.remove(&rel_path)?;
        }
        refresh_note(c, &new_rel)?;
        Ok(new_rel)
    })
}

/// 파싱 못 하는 파일의 원문 읽기 (수리 화면 전용)
#[tauri::command]
#[specta::specta]
pub fn read_raw(state: State<'_, AppState>, rel_path: String) -> Result<String, String> {
    with_ctx(&state, |c| c.vault.read_raw(&rel_path))
}

/// 파일 원문 그대로 쓰기 (수리 화면 전용 — 정규화하지 않는다)
#[tauri::command]
#[specta::specta]
pub fn write_raw(
    state: State<'_, AppState>,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        c.vault.snapshot_before_change(&rel_path)?;
        c.vault.write_raw(&rel_path, &content)?;
        let _ = refresh_note(c, &rel_path);
        Ok(())
    })
}

/// 노트의 스냅샷 목록 (최신 우선)
#[tauri::command]
#[specta::specta]
pub fn list_history(
    state: State<'_, AppState>,
    rel_path: String,
) -> Result<Vec<yamcha_core::HistoryItem>, String> {
    with_ctx(&state, |c| yamcha_core::history::list(&c.vault, &rel_path))
}

/// 스냅샷 원문 (미리보기용)
#[tauri::command]
#[specta::specta]
pub fn read_history(
    state: State<'_, AppState>,
    rel_path: String,
    stamp: String,
) -> Result<String, String> {
    with_ctx(&state, |c| {
        yamcha_core::history::read(&c.vault, &rel_path, &stamp)
    })
}

/// 해당 스냅샷으로 되돌린다 (되돌리기 직전 상태도 스냅샷으로 남는다)
#[tauri::command]
#[specta::specta]
pub fn restore_history(
    state: State<'_, AppState>,
    rel_path: String,
    stamp: String,
) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        let policy = c.vault.history_policy();
        yamcha_core::history::restore(&c.vault, &rel_path, &stamp, policy)?;
        refresh_note(c, &rel_path)
    })
}

/// 스냅샷 전부 삭제 → 지운 개수
#[tauri::command]
#[specta::specta]
pub fn purge_history(state: State<'_, AppState>) -> Result<u32, String> {
    with_ctx(&state, |c| yamcha_core::history::purge_all(&c.vault))
}

/// 스냅샷 보관 정책 변경 (설정에서 호출)
#[tauri::command]
#[specta::specta]
pub fn set_history_policy(
    state: State<'_, AppState>,
    max_per_note: u32,
    min_interval_secs: u32,
) -> Result<(), String> {
    with_ctx(&state, |c| {
        c.vault.set_history_policy(yamcha_core::HistoryPolicy {
            max_per_note,
            min_interval_secs: min_interval_secs as u64,
        });
        Ok(())
    })
}
