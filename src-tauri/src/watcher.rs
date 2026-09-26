//! vault 파일 감시: 외부(다른 앱)에서 파일이 바뀌면 인덱스를 갱신하고
//! 프론트에 "vault-external-change" 이벤트를 보낸다.
//! 앱 자신의 쓰기는 전역 타임스탬프로 억제한다.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify_debouncer_full::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use tauri::{AppHandle, Emitter, Manager};
use yamcha_core::Vault;

use crate::commands::AppState;

static LAST_SELF_WRITE_MS: AtomicU64 = AtomicU64::new(0);
const SUPPRESS_WINDOW_MS: u64 = 2500;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 앱이 vault에 쓰기 직전/직후에 호출 — 잠시 감시 이벤트를 무시한다
pub fn mark_self_write() {
    LAST_SELF_WRITE_MS.store(now_ms(), Ordering::Relaxed);
}

fn suppressed() -> bool {
    now_ms().saturating_sub(LAST_SELF_WRITE_MS.load(Ordering::Relaxed)) < SUPPRESS_WINDOW_MS
}

/// 프론트에 "외부에서 바뀌었다"고 알릴 노트인가 — 목록·색인과 **같은 잣대**를 쓴다.
///
/// 노트가 아닌 `.md`는 알리지 않는다. `_index.md`는 앱이 스스로 만드는 목록 파일인데
/// `fs::write`로 쓰여 자기쓰기 지문이 남지 않아 늘 남의 변경으로 보였다. 한 번 알리면
/// 모든 창이 vault를 통째로 다시 읽는다(목록·점검·할 일) — 노트도 아니고 열린 글과도
/// 무관한 파일 때문에, 새 노트를 만들 때마다 손을 멈춘 5초 뒤에 그 값을 치르고 있었다.
fn notify_as_external(vault: &Vault, rel: &str) -> bool {
    Vault::is_note_file(rel) && !vault.is_self_write(rel)
}

pub type WatcherHandle = notify_debouncer_full::Debouncer<
    notify_debouncer_full::notify::RecommendedWatcher,
    notify_debouncer_full::RecommendedCache,
>;

/// vault 루트 감시 시작. 반환된 핸들을 보관해야 감시가 유지된다.
pub fn start(app: AppHandle, root: PathBuf) -> Option<WatcherHandle> {
    let watch_root = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(1000),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            // 관심 파일만: .yamcha 제외, md/_attachments/_types.json
            let mut rels: Vec<String> = Vec::new();
            for ev in &events {
                for path in &ev.paths {
                    let Ok(rel) = path.strip_prefix(&root) else {
                        continue;
                    };
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if rel_str.starts_with(".yamcha") || rel_str.ends_with(".md.tmp") {
                        continue;
                    }
                    let interesting = rel_str.ends_with(".md")
                        || rel_str.starts_with("_attachments/")
                        || rel_str == "_types.json";
                    if interesting && !rels.contains(&rel_str) {
                        rels.push(rel_str);
                    }
                }
            }
            if rels.is_empty() {
                return;
            }
            // 자기쓰기 억제 여부는 인덱스 갱신 전에 판단한다.
            // (refresh_note가 내부적으로 mark_self_write를 호출해 타임스탬프를 갱신하므로,
            //  갱신 후에 검사하면 항상 억제된 것으로 오인된다.)
            let was_suppressed = suppressed();
            // 바뀐 md 파일 인덱스 갱신 — 자기쓰기여도 인덱스는 항상 최신으로 유지
            let state = app.state::<AppState>();
            // 노트는 **내용으로** 자기 쓰기를 가린다. 시각으로 가리면 창이 파일을
            // 구분하지 못해서, 내가 A를 저장하는 사이에 온 남의 B 저장 알림까지 삼킨다.
            let mut external: Vec<String> = Vec::new();
            if let Ok(mut guard) = state.0.lock() {
                if let Some(ctx) = guard.as_mut() {
                    for rel in rels.iter().filter(|r| r.ends_with(".md")) {
                        if notify_as_external(&ctx.vault, rel) {
                            external.push(rel.clone());
                        }
                        // 노트가 아닌 `.md`도 refresh_note에 넘긴다 — 예전 버전이 색인에
                        // 넣어 둔 `_index.md`를 그쪽에서 걷어낸다.
                        let _ = crate::commands::refresh_note(ctx, rel);
                    }
                }
            }
            // 노트가 아닌 것(첨부·_types.json)은 지문을 남기는 길이 없어 예전대로 시각으로 가린다
            if !was_suppressed {
                external.extend(rels.iter().filter(|r| !r.ends_with(".md")).cloned());
            }
            // 첨부 변경은 **잠금을 놓은 뒤** 처리한다.
            // 추출이 파일 하나에 15초까지 걸리는데(실측 PDF) 그동안 상태 잠금을 쥐면
            // 앱의 모든 커맨드가 멈춘다. 첨부 검색이 꺼져 있으면 아예 하지 않는다.
            if crate::commands::file_index_active() {
                let changed: Vec<String> = rels
                    .iter()
                    .filter(|r| r.starts_with("_attachments/"))
                    .cloned()
                    .collect();
                if !changed.is_empty() {
                    crate::commands::refresh_attachments(&app, &changed);
                }
            }
            // UI 이벤트만 억제: 내가 방금 써 넣은 그 내용이면 프론트에 알리지 않는다.
            if !external.is_empty() {
                let _ = app.emit("vault-external-change", external);
            }
        },
    )
    .ok()?;

    debouncer
        .watch(&watch_root, RecursiveMode::Recursive)
        .ok()?;
    Some(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 앱이 스스로 만든 `_index.md`는 "외부에서 바뀌었다"고 알리지 않는다.
    /// (자기쓰기 지문이 남지 않는 파일이라, 노트인지부터 먼저 걸러야 한다.)
    /// 남이 고친 노트는 그대로 알린다.
    #[test]
    fn 앱이_만든_목록파일은_외부_변경으로_알리지_않는다() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        let rel = v
            .create_note("free", "메모", serde_json::Value::Null)
            .unwrap();
        v.flush_index_files().unwrap();
        assert!(
            dir.path().join("Free").join("_index.md").is_file(),
            "_index.md가 만들어지지 않았다"
        );

        assert!(
            !notify_as_external(&v, "Free/_index.md"),
            "앱이 만든 목록 파일을 남의 변경으로 알렸다"
        );
        assert!(
            !notify_as_external(&v, &rel),
            "방금 내가 저장한 노트를 남의 변경으로 알렸다"
        );

        std::fs::write(
            dir.path().join(&rel),
            "---\ntype: free\n---\n\n남이 고쳤다",
        )
        .unwrap();
        assert!(
            notify_as_external(&v, &rel),
            "남이 고친 노트를 알리지 않았다"
        );
    }
}
