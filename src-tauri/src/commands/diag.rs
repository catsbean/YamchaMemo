//! 로그와 진단 정보 (8-2) — 기록기는 `crate::applog`.

use super::*;

/// 화면이 남기는 로그 한 줄 — 커맨드 실패·렌더 오류·잡히지 않은 예외·업데이트 결과.
/// `level`은 `info`·`warn`·`error`.
#[tauri::command(async)]
#[specta::specta]
pub fn log_client(level: String, message: String) {
    crate::applog::write(crate::applog::Level::parse(&level), &format!("[화면] {message}"));
}

/// 지금 쓰는 로그 파일 — [로그 폴더 열기]가 탐색기에서 이 파일을 짚는다
#[tauri::command(async)]
#[specta::specta]
pub fn log_file_path() -> Option<String> {
    crate::applog::current_file().map(|p| p.to_string_lossy().to_string())
}

/// 진단 정보 — 사용자가 문제를 알려 올 때 붙여 보내는 글.
///
/// 앱·OS·vault 규모(분류별 편수, 첨부 수와 크기)·최근 로그. **노트 본문은 넣지 않는다.** 로그에는
/// vault 안 경로(제목이 들어 있다)가 있을 수 있어, 화면이 복사하기 전에 그대로 보여 준다.
/// 켜 둔 기능(화면 설정)은 화면이 덧붙인다.
#[tauri::command(async)]
#[specta::specta]
pub fn diagnostics(state: State<'_, AppState>) -> String {
    let mut out = String::new();
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    out.push_str(&format!("YamchaMemo 진단 정보 — {now}\n"));
    out.push_str(&format!(
        "앱 {} · {} {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));

    // 분류별 편수는 잠금 안에서(목록은 폴더만 훑는다), 첨부 크기는 잠금 밖에서 잰다
    let snapshot = with_ctx(&state, |c| {
        let files = c.vault.list_note_files()?;
        Ok((c.vault.root().to_path_buf(), files))
    });
    match snapshot {
        Ok((root, files)) => {
            let mut per_type: std::collections::BTreeMap<String, usize> = Default::default();
            for f in &files {
                *per_type.entry(f.note_type.clone()).or_default() += 1;
            }
            let offline = files.iter().filter(|f| f.offline).count();
            let types: Vec<String> = per_type.iter().map(|(t, n)| format!("{t} {n}")).collect();
            out.push_str(&format!("vault: {}\n", crate::applog::mask(&root.to_string_lossy())));
            out.push_str(&format!(
                "노트 {}편 ({}){}\n",
                files.len(),
                types.join(" · "),
                if offline > 0 { format!(" · 내려받기 전 {offline}") } else { String::new() }
            ));
            let (count, bytes) = dir_size(&root.join("_attachments"));
            out.push_str(&format!("첨부 {count}개 · {:.1}MB\n", bytes as f64 / 1_048_576.0));
        }
        Err(e) => out.push_str(&format!("vault: 열리지 않음 ({e})\n")),
    }
    if let Some(dir) = crate::applog::dir() {
        out.push_str(&format!("로그 폴더: {}\n", crate::applog::mask(&dir.to_string_lossy())));
    }
    let recent = crate::applog::recent(200);
    out.push_str(&format!("\n--- 최근 로그 {}줄 ---\n", recent.len()));
    for line in recent {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// 폴더 안 파일 수와 크기 합 (바로가기는 따라가지 않는다)
fn dir_size(dir: &std::path::Path) -> (usize, u64) {
    let mut count = 0;
    let mut bytes = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                count += 1;
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (count, bytes)
}
