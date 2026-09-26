//! vault 파일 감시: 외부(다른 앱)에서 파일이 바뀌면 인덱스를 갱신하고
//! 프론트에 "vault-external-change" 이벤트를 보낸다.
//! 앱 자신의 쓰기는 전역 타임스탬프로 억제한다.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify_debouncer_full::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use tauri::{AppHandle, Emitter, Manager};
use yamcha_core::Vault;

use crate::commands::{AppState, Ctx};

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

/// 바뀐 `.md`를 색인에 반영하고, 그중 프론트에 알릴 것(남이 고친 노트)을 돌려준다.
///
/// 감시 콜백에서 떼어 둔 것은 시험이 감시와 **같은 길**로 바깥 변경을 흘려보내게
/// 하려는 것이다 (`invariants` 시험).
pub(crate) fn apply_md_changes(ctx: &mut Ctx, rels: &[String]) -> Vec<String> {
    let mut external = Vec::new();
    for rel in rels.iter().filter(|r| r.ends_with(".md")) {
        if notify_as_external(&ctx.vault, rel) {
            external.push(rel.clone());
        }
    }
    // 다시 읽을 것만 모아 **한 번에**(검색 색인 커밋 한 번) 반영한다
    let stale = needs_reindex(ctx, rels);
    let _ = crate::commands::refresh_notes(ctx, stale.iter().map(String::as_str));
    external
}

/// 바뀐 `.md` 중 색인에 다시 넣어야 하는 것 — 색인이 **지금 모습 그대로**(수정시각·크기)
/// 이미 알고 있는 파일은 뺀다.
///
/// 앱이 쓴 파일은 쓰는 그 자리에서 색인까지 마친다. 감시는 그 쓰기도 똑같이 알려 오는데,
/// 제목 바꾸기가 600편의 링크를 고쳐 쓰자 감시가 600편을 한 편씩(편마다 검색 색인 커밋) 다시
/// 읽느라 상태 잠금을 1분 넘게 쥐었다 — 진행 창이 닫힌 뒤에 앱이 통째로 멈췄다(실제 앱에서
/// 잰 값). 사라진 파일과 노트가 아닌 `.md`(`_index.md`)는 신원이 없으니 늘 남는다 — 색인에서
/// 빼는 길이다(예전 버전이 넣어 둔 `_index.md`도 여기서 걷힌다).
fn needs_reindex(ctx: &Ctx, rels: &[String]) -> Vec<String> {
    let known = ctx.indexer.note_states().unwrap_or_default();
    rels.iter()
        .filter(|r| r.ends_with(".md"))
        .filter(|rel| {
            let now = std::fs::metadata(ctx.vault.root().join(rel))
                .ok()
                .map(|m| yamcha_core::file_identity(&m));
            // 수정시각을 못 읽은 것(0)은 늘 바뀐 것으로 본다
            !matches!((now, known.get(rel.as_str())), (Some(now), Some(k)) if now == *k && now.0 != 0)
        })
        .cloned()
        .collect()
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
                    external = apply_md_changes(ctx, &rels);
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
#[allow(clippy::disallowed_methods)] // 시험은 남이 고친 노트를 흉내 내려고 맨 쓰기를 쓴다
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

    /// 앱이 방금 쓰고 색인한 파일은 감시가 다시 읽지 않는다 — 제목 바꾸기가 600편을 고쳐
    /// 쓰자 감시가 600편을 한 편씩 다시 읽느라 앱이 1분 넘게 멈췄다. 남이 고친 파일·사라진
    /// 파일·노트가 아닌 `.md`는 다시 본다.
    #[test]
    fn 앱이_쓰고_색인한_파일은_다시_읽지_않는다() {
        use crate::commands::{dashboard, notes};
        let vault_dir = tempfile::tempdir().unwrap();
        let index_dir = tempfile::tempdir().unwrap();
        let mut c = Ctx {
            vault: Vault::open(vault_dir.path()).unwrap(),
            indexer: yamcha_core::Indexer::open(&index_dir.path().join("index.db")).unwrap(),
            search: yamcha_core::SearchEngine::open(&index_dir.path().join("search")).unwrap(),
            todo_cache: dashboard::TodoCache::default(),
        };
        let null = serde_json::Value::Null;
        let mine = notes::create_note_in(&mut c, "free", "내가 쓴 글", null.clone()).unwrap();
        let theirs = notes::create_note_in(&mut c, "free", "남이 고친 글", null.clone()).unwrap();
        let gone = notes::create_note_in(&mut c, "free", "사라진 글", null).unwrap();
        c.vault.flush_index_files().unwrap();
        std::fs::write(vault_dir.path().join(&theirs), "---\ntype: free\n---\n\n남이 고쳤다").unwrap();
        std::fs::remove_file(vault_dir.path().join(&gone)).unwrap();

        let rels = vec![mine, theirs.clone(), "Free/_index.md".to_string(), gone.clone()];
        assert_eq!(
            needs_reindex(&c, &rels),
            vec![theirs, "Free/_index.md".to_string(), gone],
            "앱이 방금 쓴 글까지 다시 읽거나, 다시 읽을 것을 빠뜨렸다"
        );
    }
}
