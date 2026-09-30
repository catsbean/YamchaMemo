//! 백업과 복원 (7-5) — 일은 `yamcha_core::backup`이 한다.

use super::*;
use yamcha_core::backup::BackupReport;

/// 백업·복원의 진행 (`backup-progress` 이벤트) — (한 파일, 전체 파일)
#[derive(serde::Serialize, Clone)]
struct BackupProgress {
    done: usize,
    total: usize,
}

/// `backup-progress`를 보내는 알림. 정수 %가 바뀔 때만 보낸다 (`relocate_reporter`와 같은 까닭).
fn backup_reporter(app: &tauri::AppHandle) -> impl FnMut(usize, usize) + '_ {
    let mut last: Option<usize> = None;
    move |done, total| {
        let pct = (done * 100).checked_div(total).unwrap_or(100);
        if last != Some(pct) {
            last = Some(pct);
            let _ = app.emit("backup-progress", BackupProgress { done, total });
        }
    }
}

/// 지금 vault를 zip 하나로 묶는다 → 담은 파일 수 등.
///
/// **상태 잠금은 vault 경로를 읽을 때만 쥔다.** 첨부가 수백 MB면 묶는 데 한참 걸리는데,
/// 그동안 잠금을 쥐면 앱이 통째로 멈춘다. 파일은 읽기만 하므로 잠금이 필요 없다 —
/// 도중에 저장된 편은 그 순간의 모습으로 담긴다.
#[tauri::command]
#[specta::specta]
pub async fn backup_vault(app: tauri::AppHandle, dest: String) -> Result<BackupReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let root = with_ctx(&state, |c| Ok(c.vault.root().to_path_buf()))?;
        let mut report = backup_reporter(&app);
        yamcha_core::backup::create_backup(&root, Path::new(&dest), &mut report)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 백업 zip을 **빈 폴더**(없으면 만든다)로 푼다. 지금 vault는 건드리지 않는다 —
/// 푼 폴더를 열지는 화면이 사용자에게 묻는다.
#[tauri::command]
#[specta::specta]
pub async fn restore_backup(
    app: tauri::AppHandle,
    zip_path: String,
    dest_dir: String,
) -> Result<BackupReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = backup_reporter(&app);
        yamcha_core::backup::restore_backup(Path::new(&zip_path), Path::new(&dest_dir), &mut report)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
