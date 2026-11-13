//! 편집 스냅샷: 저장 직전의 파일 내용을 `.yamcha/history/`에 남겨 되돌릴 수 있게 한다.
//!
//! 휴지통이 "파일 삭제"를 막아 준다면, 여기는 **문단을 날리고 자동 저장된 사고**를 막는다.
//! 자동 저장이 3초마다 도는 앱이므로 무작정 다 뜨면 안 된다 — 그래서 규칙이 셋이다:
//! 1. 직전 스냅샷과 내용이 같으면 뜨지 않는다.
//! 2. 직전 스냅샷 이후 `min_interval_secs`가 지나지 않았으면 뜨지 않는다.
//! 3. **단, 지금 저장하려는 내용이 눈에 띄게 짧아졌으면 간격을 무시하고 뜬다.** 대량 삭제는
//!    한 번 놓치면 복구할 길이 없기 때문이다.

use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, Local, NaiveDateTime};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::vault::Vault;

/// 스냅샷 보관 정책
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub struct HistoryPolicy {
    /// 노트 하나당 보관 개수 (초과 시 오래된 것부터 삭제)
    pub max_per_note: u32,
    /// 직전 스냅샷 이후 이 시간이 지나야 새로 뜬다 (초)
    pub min_interval_secs: u64,
}

impl Default for HistoryPolicy {
    fn default() -> Self {
        HistoryPolicy {
            max_per_note: 20,
            min_interval_secs: 300,
        }
    }
}

/// 스냅샷 한 건
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HistoryItem {
    /// 파일명 스탬프 (복원 시 키)
    pub stamp: String,
    /// 읽기 좋은 시각 "YYYY-MM-DD HH:MM"
    pub saved_at: String,
    /// 그 시점 본문 글자 수 (공백 제외)
    pub char_count: u32,
}

const STAMP_FMT: &str = "%Y%m%d-%H%M%S-%3f";

/// 이 노트의 스냅샷들이 모여 있는 폴더
fn note_dir(vault: &Vault, rel: &str) -> PathBuf {
    let flat = rel.replace(['/', '\\'], "__");
    vault.root().join(".yamcha").join("history").join(flat)
}

/// 스탬프는 `YYYYMMDD-HHMMSS-mmm` — 뒤 밀리초는 같은 초에 두 번 뜰 때의 정렬용이라
/// 시각 계산에는 앞 15자만 쓴다(chrono의 `%3f`는 파싱 지원이 들쭉날쭉하다).
fn parse_stamp(stamp: &str) -> Option<DateTime<Local>> {
    let head = stamp.get(..15)?;
    NaiveDateTime::parse_from_str(head, "%Y%m%d-%H%M%S")
        .ok()?
        .and_local_timezone(Local)
        .single()
}

/// 공백을 뺀 글자 수 (본문 분량 비교용)
fn dense_len(s: &str) -> usize {
    s.chars().filter(|c| !c.is_whitespace()).count()
}

/// 스탬프 목록 (오래된 것 → 최신)
fn stamps(vault: &Vault, rel: &str) -> Vec<String> {
    let dir = note_dir(vault, rel);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".md").map(|s| s.to_string())
        })
        .collect();
    out.sort();
    out
}

/// 저장 직전 스냅샷. `incoming`은 이제 곧 쓰일 새 내용(모르면 None).
/// 실제로 스냅샷을 떴으면 `true`.
pub fn snapshot(
    vault: &Vault,
    rel: &str,
    incoming: Option<&str>,
    policy: HistoryPolicy,
) -> Result<bool, CoreError> {
    if policy.max_per_note == 0 {
        return Ok(false);
    }
    let abs = vault.abs(rel)?;
    if !abs.exists() {
        return Ok(false); // 새 파일 — 보존할 이전 상태가 없다
    }
    let current = fs::read_to_string(&abs)?;

    let existing = stamps(vault, rel);
    if let Some(last) = existing.last() {
        let dir = note_dir(vault, rel);
        let last_content = fs::read_to_string(dir.join(format!("{last}.md"))).unwrap_or_default();
        // 규칙 1: 이미 같은 내용을 갖고 있다
        if last_content == current {
            return Ok(false);
        }
        // 규칙 2·3: 간격이 안 됐으면 건너뛰되, 내용이 크게 줄어드는 저장은 예외
        let too_soon = parse_stamp(last)
            .map(|t| {
                (Local::now() - t).num_seconds() < policy.min_interval_secs as i64
            })
            .unwrap_or(false);
        if too_soon && !is_big_shrink(&current, incoming) {
            return Ok(false);
        }
    }

    let dir = note_dir(vault, rel);
    fs::create_dir_all(&dir)?;
    let stamp = Local::now().format(STAMP_FMT).to_string();
    let path = dir.join(format!("{stamp}.md"));
    if path.exists() {
        return Ok(false); // 같은 밀리초 — 사실상 같은 저장
    }
    // 되살릴 때 기대는 사본이다 — 쓰다 끊긴 반쪽짜리가 복원 지점으로 뜨면 안 된다
    vault.atomic_write_bytes(&path, current.as_bytes())?;

    // 개수 제한
    let mut all = stamps(vault, rel);
    while all.len() > policy.max_per_note as usize {
        let oldest = all.remove(0);
        let _ = fs::remove_file(dir.join(format!("{oldest}.md")));
    }
    Ok(true)
}

/// 지금 쓰려는 내용이 현재 내용보다 20% 이상 짧은가 (대량 삭제 감지)
fn is_big_shrink(current: &str, incoming: Option<&str>) -> bool {
    let Some(next) = incoming else {
        return false;
    };
    let cur = dense_len(current);
    if cur < 50 {
        return false; // 원래 짧은 노트는 비율이 요동쳐서 의미가 없다
    }
    dense_len(next) * 5 < cur * 4
}

/// 스냅샷 목록 (최신 우선)
pub fn list(vault: &Vault, rel: &str) -> Result<Vec<HistoryItem>, CoreError> {
    let dir = note_dir(vault, rel);
    let mut out = Vec::new();
    for stamp in stamps(vault, rel) {
        let content = fs::read_to_string(dir.join(format!("{stamp}.md"))).unwrap_or_default();
        let (_, body) = crate::parse::split_frontmatter(&content);
        out.push(HistoryItem {
            saved_at: parse_stamp(&stamp)
                .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| stamp.clone()),
            char_count: dense_len(body) as u32,
            stamp,
        });
    }
    out.reverse();
    Ok(out)
}

/// 스냅샷 원문 (frontmatter 포함)
pub fn read(vault: &Vault, rel: &str, stamp: &str) -> Result<String, CoreError> {
    let path = note_dir(vault, rel).join(format!("{stamp}.md"));
    if !path.exists() {
        return Err(CoreError::NotFound(format!("{rel} @ {stamp}")));
    }
    Ok(fs::read_to_string(&path)?)
}

/// 해당 스냅샷으로 되돌린다. 되돌리기 직전의 상태도 스냅샷으로 남긴다.
pub fn restore(
    vault: &Vault,
    rel: &str,
    stamp: &str,
    policy: HistoryPolicy,
) -> Result<(), CoreError> {
    let content = read(vault, rel, stamp)?;
    // 되돌리기 자체가 되돌릴 수 있어야 하므로 간격 규칙을 무시하고 현재 상태를 남긴다
    snapshot(
        vault,
        rel,
        None,
        HistoryPolicy {
            min_interval_secs: 0,
            ..policy
        },
    )?;
    vault.write_raw(rel, &content)
}

/// 노트 하나의 스냅샷 전부 삭제 (노트를 지웠을 때 등).
///
/// 노트를 지우면 파일 자체는 휴지통에 통째로 남으므로 되돌릴 길은 그대로 있다.
/// 여기서 지우는 건 중간 스냅샷이고, 안 지우면 **지운 글의 본문이 최대 20벌**
/// `.yamcha/history/`에 계속 남는다.
pub fn clear_note(vault: &Vault, rel: &str) -> Result<(), CoreError> {
    let dir = note_dir(vault, rel);
    if dir.is_dir() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// 노트가 자리를 옮기면 스냅샷도 따라간다 (제목 변경·분류 이동).
///
/// 스냅샷 폴더 이름은 rel 경로에서 나오므로, 안 옮기면 옛 이름 폴더는 고아로 남고
/// 새 이름은 이력이 없는 상태에서 다시 시작한다 — 이름 한 번 바꿨다고 되돌릴 지점이
/// 사라지면 안전장치라고 할 수 없다.
pub fn move_note(vault: &Vault, from: &str, to: &str) -> Result<(), CoreError> {
    if from == to {
        return Ok(());
    }
    move_dir(note_dir(vault, from), note_dir(vault, to))
}

/// 스냅샷 폴더를 옮긴다. 갈 자리에 이미 기록이 있으면 하나씩 합친다.
fn move_dir(src: PathBuf, dst: PathBuf) -> Result<(), CoreError> {
    if !src.is_dir() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    // 대소문자만 바꾼 이름이면(Windows) 두 경로가 **같은 폴더**다 — 합치기로 가면 스냅샷마다
    // "이미 있다"며 건너뛴 뒤 폴더를 지워 기록이 통째로 사라진다. 그냥 이름만 바꾼다.
    let same_dir = matches!(
        (fs::canonicalize(&src), fs::canonicalize(&dst)),
        (Ok(a), Ok(b)) if a == b
    );
    if !dst.exists() || same_dir {
        crate::vault::retry_while_locked(|| fs::rename(&src, &dst))?;
        return Ok(());
    }
    // 옮겨갈 자리에 이미 이력이 있다(같은 이름을 예전에 썼다). 예전엔 여기서 그냥 돌아섰다 —
    // 남은 옛 경로의 기록은 다음 시작에 주인 없는 기록으로 지워져, 바꾼 노트의 기록이 통째로
    // 사라졌다. 스냅샷을 하나씩 합친다(이름은 시각이라 겹치면 같은 판이다 — 있는 쪽을 둔다).
    for entry in fs::read_dir(&src)? {
        let entry = entry?;
        let into = dst.join(entry.file_name());
        if into.exists() {
            continue;
        }
        let snap = entry.path();
        crate::vault::retry_while_locked(|| fs::rename(&snap, &into))?;
    }
    let _ = fs::remove_dir_all(&src);
    Ok(())
}

// ── 휴지통 ──
// 노트를 휴지통으로 보내면 그 편집 기록도 함께 휴지통에 머문다. 예전엔 그 자리에서 지웠다 —
// 지운 글의 본문이 20벌씩 vault에 남지 않게 하려는 것이었는데, 휴지통에서 글을 되살려도
// 기록은 영영 돌아오지 않았다(목록의 [되돌리기]가 생기며 드러났다). 이제 기록은 휴지통 파일과
// **같이 살고 같이 죽는다** — 되살리면 따라 돌아오고, 휴지통을 비우면 함께 지워진다.

/// 휴지통 속 노트의 편집 기록이 머무는 곳 — `.yamcha/trash/.history/<휴지통 파일 이름>/`.
/// 휴지통 목록·비우기는 `.md` 파일만 보므로 이 폴더를 노트로 착각하지 않는다.
fn trash_stash_dir(vault: &Vault, trash_file: &str) -> PathBuf {
    vault.root().join(".yamcha").join("trash").join(".history").join(trash_file)
}

/// 휴지통 파일 이름으로 쓸 수 없는 것(경로를 벗어나는 것)을 막는다
fn check_trash_file(trash_file: &str) -> Result<(), CoreError> {
    if trash_file.is_empty()
        || trash_file.contains('/')
        || trash_file.contains('\\')
        || trash_file.contains("..")
    {
        return Err(CoreError::Invalid(format!("잘못된 휴지통 파일 이름: {trash_file}")));
    }
    Ok(())
}

/// 노트를 휴지통으로 보낼 때 — 그 편집 기록을 휴지통으로 옮긴다.
pub fn stash_for_trash(vault: &Vault, rel: &str, trash_file: &str) -> Result<(), CoreError> {
    check_trash_file(trash_file)?;
    move_dir(note_dir(vault, rel), trash_stash_dir(vault, trash_file))
}

/// 휴지통에서 되살릴 때 — 기록을 되살린 자리로 돌려놓는다(이름이 바뀌었으면 새 이름으로).
pub fn unstash_from_trash(vault: &Vault, trash_file: &str, rel: &str) -> Result<(), CoreError> {
    check_trash_file(trash_file)?;
    move_dir(trash_stash_dir(vault, trash_file), note_dir(vault, rel))
}

/// 휴지통 항목을 영구히 지울 때 — 기록도 함께.
pub fn drop_trash_stash(vault: &Vault, trash_file: &str) -> Result<(), CoreError> {
    check_trash_file(trash_file)?;
    let dir = trash_stash_dir(vault, trash_file);
    if dir.is_dir() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// 주인(휴지통 파일)이 없어진 기록을 걷는다 → 걷은 수. 휴지통 파일을 앱 밖에서 지웠을 때 남는다.
pub fn prune_trash_stash(vault: &Vault) -> Result<u32, CoreError> {
    let root = vault.root().join(".yamcha").join("trash").join(".history");
    if !root.is_dir() {
        return Ok(0);
    }
    let trash = vault.root().join(".yamcha").join("trash");
    let mut removed = 0;
    for entry in fs::read_dir(&root)?.flatten() {
        if entry.path().is_dir()
            && !trash.join(entry.file_name()).is_file()
            && fs::remove_dir_all(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

/// vault에 더 이상 없는 노트의 스냅샷 폴더를 지운다 → 지운 폴더 수.
///
/// 앱 밖(옵시디언·탐색기)에서 지운 파일은 `delete_note`를 거치지 않아 스냅샷만 남는다.
/// 예전 버전이 쌓아 둔 것도 여기서 함께 걷힌다. vault를 열 때 한 번 돈다.
pub fn prune_orphans(vault: &Vault, live: &[String]) -> Result<u32, CoreError> {
    prune_orphans_older_than(vault, live, ORPHAN_KEEP)
}

/// 주인 없는 기록이라도 마지막 스냅샷이 이보다 새것이면 남긴다.
///
/// "목록에 없다"가 "지워졌다"는 뜻이 아닐 수 있다 — 클라우드 동기화가 막 시작돼 한 폴더가 아직
/// 안 보이거나, 연결이 끊긴 드라이브라 잠깐 못 읽으면 그 폴더의 모든 노트가 목록에서 빠진다. 예전엔
/// 그 순간 그 노트들의 편집 기록을 통째로 지웠다. 휴지통처럼 한동안 두었다가 걷는다.
pub const ORPHAN_KEEP: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// `prune_orphans`의 몸통 (시험이 기간을 줄 수 있게 뗐다)
pub fn prune_orphans_older_than(
    vault: &Vault,
    live: &[String],
    keep: std::time::Duration,
) -> Result<u32, CoreError> {
    let root = vault.root().join(".yamcha").join("history");
    if !root.is_dir() {
        return Ok(0);
    }
    // 목록이 통째로 비었으면 vault를 못 읽은 것이다 — 아무것도 지우지 않는다
    if live.is_empty() {
        return Ok(0);
    }
    let alive: std::collections::HashSet<String> =
        live.iter().map(|rel| rel.replace(['/', '\\'], "__")).collect();
    let now = std::time::SystemTime::now();
    let mut removed = 0u32;
    for entry in fs::read_dir(&root)?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if alive.contains(&name) {
            continue;
        }
        // 가장 새 스냅샷의 시각 — 못 읽으면 새것으로 본다(지우지 않는 쪽)
        let newest = fs::read_dir(&path)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.metadata().and_then(|m| m.modified()).ok())
            .max();
        let old_enough = newest
            .map(|t| now.duration_since(t).map(|age| age >= keep).unwrap_or(false))
            .unwrap_or(true); // 빈 폴더
        if old_enough && fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// vault의 모든 스냅샷 삭제 → 지운 파일 수
pub fn purge_all(vault: &Vault) -> Result<u32, CoreError> {
    let root = vault.root().join(".yamcha").join("history");
    if !root.is_dir() {
        return Ok(0);
    }
    let mut removed = 0u32;
    for entry in fs::read_dir(&root)?.flatten() {
        if entry.path().is_dir() {
            removed += fs::read_dir(entry.path())
                .map(|it| it.flatten().count() as u32)
                .unwrap_or(0);
        }
    }
    fs::remove_dir_all(&root)?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, Vault, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        // 기본 정책(5분 간격)이 테스트마다 끼어들지 않게 스냅샷을 꺼 두고 시작한다
        v.set_history_policy(HistoryPolicy {
            max_per_note: 0,
            min_interval_secs: 0,
        });
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        (dir, v, rel)
    }

    const EAGER: HistoryPolicy = HistoryPolicy {
        max_per_note: 20,
        min_interval_secs: 0,
    };

    #[test]
    fn 새_파일은_뜰_이전_상태가_없다() {
        let (_d, v, _) = setup();
        assert!(!snapshot(&v, "Free/없는파일.md", None, EAGER).unwrap());
    }

    #[test]
    fn 같은_내용은_다시_뜨지_않는다() {
        let (_d, v, rel) = setup();
        assert!(snapshot(&v, &rel, None, EAGER).unwrap());
        assert!(!snapshot(&v, &rel, None, EAGER).unwrap());
        assert_eq!(list(&v, &rel).unwrap().len(), 1);
    }

    /// 파일 원문 (snapshot이 비교하는 단위는 frontmatter를 포함한 파일 전체다)
    fn full(body: &str) -> String {
        format!("---\ndate: 2026-07-01\ntype: free\ntags: []\n---\n\n{body}")
    }

    /// 스냅샷 규칙만 보려고 디스크 상태를 직접 바꾼다 (write_raw는 스냅샷을 뜨지 않는다)
    fn put(v: &Vault, rel: &str, body: &str) {
        v.write_raw(rel, &full(body)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
    }

    #[test]
    fn 간격_안에서는_건너뛴다() {
        let (_d, v, rel) = setup();
        let slow = HistoryPolicy {
            max_per_note: 20,
            min_interval_secs: 3600,
        };
        assert!(snapshot(&v, &rel, None, slow).unwrap());
        put(&v, &rel, "내용이 바뀌었다");
        // 내용은 달라졌지만 1시간이 안 지났으므로 뜨지 않는다
        assert!(!snapshot(&v, &rel, None, slow).unwrap());
    }

    #[test]
    fn 대량_삭제는_간격을_무시하고_뜬다() {
        let (_d, v, rel) = setup();
        let slow = HistoryPolicy {
            max_per_note: 20,
            min_interval_secs: 3600,
        };
        let long_body = "가나다라마바사아자차카타파하".repeat(10); // 140자
        put(&v, &rel, &long_body);
        assert!(snapshot(&v, &rel, None, slow).unwrap());

        put(&v, &rel, &format!("{long_body} 조금 더"));
        // 비슷한 길이로 저장하려는 참: 간격 규칙에 걸려 건너뛴다
        let similar = full(&format!("{long_body} 더 더"));
        assert!(!snapshot(&v, &rel, Some(&similar), slow).unwrap());
        // 통째로 지우려는 참: 간격을 무시하고 직전 상태를 보존한다
        assert!(snapshot(&v, &rel, Some(&full("한 줄만 남긴다")), slow).unwrap());
    }

    #[test]
    fn 보관_개수를_넘으면_오래된_것부터_지운다() {
        let (_d, v, rel) = setup();
        let policy = HistoryPolicy {
            max_per_note: 3,
            min_interval_secs: 0,
        };
        for i in 0..6 {
            put(&v, &rel, &format!("버전 {i}"));
            snapshot(&v, &rel, None, policy).unwrap();
        }
        let items = list(&v, &rel).unwrap();
        assert_eq!(items.len(), 3);
        // 최신이 위
        assert!(items[0].saved_at >= items[1].saved_at);
    }

    /// 실제 경로: save_note가 알아서 직전 상태를 남긴다
    #[test]
    fn save_note가_이전_상태를_남긴다() {
        let (_d, mut v, rel) = setup();
        v.set_history_policy(EAGER);
        v.save_note(&rel, json!({}), "처음 내용").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        v.save_note(&rel, json!({}), "바꾼 내용").unwrap();

        let items = list(&v, &rel).unwrap();
        assert!(items.len() >= 2, "스냅샷이 {}개뿐", items.len());
        let newest = read(&v, &rel, &items[0].stamp).unwrap();
        assert!(newest.contains("처음 내용"), "직전 상태가 아님: {newest}");
    }

    #[test]
    fn 되돌리면_그때_내용이_돌아오고_현재도_보존된다() {
        let (_d, v, rel) = setup();
        v.save_note(&rel, json!({}), "처음 쓴 소중한 문단").unwrap();
        snapshot(&v, &rel, None, EAGER).unwrap();
        let stamp = list(&v, &rel).unwrap()[0].stamp.clone();

        v.save_note(&rel, json!({}), "실수로 다 지움").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        restore(&v, &rel, &stamp, EAGER).unwrap();

        assert!(v.read_note(&rel).unwrap().body.contains("처음 쓴 소중한 문단"));
        // 되돌리기 직전 상태("실수로 다 지움")도 스냅샷에 남아 있다
        let all: Vec<String> = list(&v, &rel)
            .unwrap()
            .iter()
            .map(|i| read(&v, &rel, &i.stamp).unwrap())
            .collect();
        assert!(all.iter().any(|c| c.contains("실수로 다 지움")));
    }

    #[test]
    fn 전체_비우기() {
        let (_d, v, rel) = setup();
        v.save_note(&rel, json!({}), "무언가").unwrap();
        snapshot(&v, &rel, None, EAGER).unwrap();
        assert!(purge_all(&v).unwrap() >= 1);
        assert!(list(&v, &rel).unwrap().is_empty());
    }

    /// **지운 글의 본문이 vault 안에 남으면 안 된다.**
    /// 파일 자체는 휴지통에 있으니 되돌릴 길은 그대로다.
    /// 스냅샷 둘을 뜬 노트 하나 → 그 스탬프들
    fn with_two_snapshots(v: &mut Vault, rel: &str) -> Vec<String> {
        v.set_history_policy(EAGER);
        put(v, rel, "첫 판");
        snapshot(v, rel, None, EAGER).unwrap();
        put(v, rel, "둘째 판");
        snapshot(v, rel, None, EAGER).unwrap();
        let stamps: Vec<String> = list(v, rel).unwrap().into_iter().map(|h| h.stamp).collect();
        assert_eq!(stamps.len(), 2);
        stamps
    }

    /// 지운 글의 기록은 노트 자리에서 빠져 휴지통으로 간다 — 지운 글이 기록 목록에 남지 않고,
    /// 되살리면 그대로 돌아온다. (예전엔 지울 때 기록을 지워서, 되살려도 기록은 영영 없었다)
    #[test]
    fn 지운_글의_기록은_휴지통을_따라갔다가_되살리면_돌아온다() {
        let (_d, mut v, rel) = setup();
        let before = with_two_snapshots(&mut v, &rel);

        let file = v.trash_note(&rel).unwrap();
        assert!(list(&v, &rel).unwrap().is_empty(), "지운 글의 기록이 노트 자리에 남았다");
        assert!(!note_dir(&v, &rel).exists());
        assert!(trash_stash_dir(&v, &file).is_dir(), "기록이 휴지통에 없다");
        // 휴지통 목록에는 노트만 보인다 (기록 폴더를 항목으로 세지 않는다)
        assert_eq!(v.list_trash().unwrap().len(), 1);

        let back = v.restore_trash(&file).unwrap().rel;
        assert_eq!(back, rel);
        let after: Vec<String> = list(&v, &back).unwrap().into_iter().map(|h| h.stamp).collect();
        assert_eq!(after, before, "되살렸는데 기록이 돌아오지 않았다");
        assert!(!trash_stash_dir(&v, &file).exists());
    }

    /// 지운 사이 같은 이름의 글을 새로 만들어 `(2)`로 되살아나면, 기록은 되살아난 쪽을 따라간다
    #[test]
    fn 이름이_바뀌어_되살아나면_기록도_그_이름으로() {
        let (_d, mut v, rel) = setup();
        let before = with_two_snapshots(&mut v, &rel);
        let file = v.trash_note(&rel).unwrap();
        let newer = v.create_note("free", "메모", json!({})).unwrap();
        assert_eq!(newer, rel);
        let back = v.restore_trash(&file).unwrap().rel;
        assert_ne!(back, rel);
        let after: Vec<String> = list(&v, &back).unwrap().into_iter().map(|h| h.stamp).collect();
        assert_eq!(after, before);
        assert!(list(&v, &newer).unwrap().is_empty(), "새 글이 남의 기록을 물려받았다");
    }

    /// 휴지통을 비우면 기록도 함께 지워진다 — 지운 글의 본문이 vault에 계속 남지 않는다
    #[test]
    fn 휴지통을_비우면_기록도_함께_지워진다() {
        let (_d, mut v, rel) = setup();
        with_two_snapshots(&mut v, &rel);
        let file = v.trash_note(&rel).unwrap();
        // 오래된 항목으로 꾸민다 (파일과 기록 폴더의 이름을 함께)
        let trash = v.root().join(".yamcha/trash");
        let old = format!("20200101-000000_{}", file.split_once('_').unwrap().1);
        fs::rename(trash.join(&file), trash.join(&old)).unwrap();
        fs::rename(trash_stash_dir(&v, &file), trash_stash_dir(&v, &old)).unwrap();

        assert_eq!(v.purge_trash(7).unwrap(), 1);
        assert!(!trash_stash_dir(&v, &old).exists(), "비운 휴지통의 기록이 남았다");
    }

    /// 휴지통 파일을 앱 밖에서 지워 주인이 없어진 기록도 비울 때 걷힌다
    #[test]
    fn 주인_없는_휴지통_기록은_비울_때_걷힌다() {
        let (_d, mut v, rel) = setup();
        with_two_snapshots(&mut v, &rel);
        let file = v.trash_note(&rel).unwrap();
        fs::remove_file(v.root().join(".yamcha/trash").join(&file)).unwrap();
        assert_eq!(v.purge_trash(7).unwrap(), 0);
        assert!(!trash_stash_dir(&v, &file).exists());
    }

    #[test]
    fn 휴지통_파일_이름으로_경로를_벗어날_수_없다() {
        let (_d, v, rel) = setup();
        for bad in ["", "../밖", "a/b.md", "a\\b.md"] {
            assert!(stash_for_trash(&v, &rel, bad).is_err(), "{bad}");
            assert!(unstash_from_trash(&v, bad, &rel).is_err(), "{bad}");
            assert!(drop_trash_stash(&v, bad).is_err(), "{bad}");
        }
    }

    /// 제목을 바꿨다고 되돌릴 지점이 사라지면 안전장치가 아니다
    #[test]
    fn 제목을_바꾸면_스냅샷이_따라온다() {
        let (_d, mut v, rel) = setup();
        v.set_history_policy(EAGER);
        put(&v, &rel, "옛 제목 시절의 내용");
        snapshot(&v, &rel, None, EAGER).unwrap();

        let new_rel = v.rename_note(&rel, "새 제목").unwrap().rel;
        assert_ne!(new_rel, rel, "이름이 안 바뀌었다");
        assert!(
            !list(&v, &new_rel).unwrap().is_empty(),
            "이름을 바꾸자 이력이 사라졌다"
        );
        assert!(!note_dir(&v, &rel).exists(), "옛 이름 폴더가 고아로 남았다");
    }

    /// 앱 밖에서 지운 파일은 delete_note를 거치지 않는다 — 그 스냅샷은 켤 때 걷는다
    #[test]
    fn 없어진_노트의_스냅샷은_걷어낸다() {
        let (_d, v, rel) = setup();
        snapshot(&v, &rel, None, EAGER).unwrap();
        let other = v.create_note("free", "살아 있는 노트", json!({})).unwrap();
        snapshot(&v, &other, None, EAGER).unwrap();

        // 탐색기에서 지운 상황
        std::fs::remove_file(v.abs(&rel).unwrap()).unwrap();

        let live: Vec<String> = v
            .list_note_files()
            .unwrap()
            .into_iter()
            .map(|f| f.rel_path)
            .collect();
        // 갓 생긴 고아는 남긴다 — 잠깐 못 읽은 것일 수 있다
        assert_eq!(prune_orphans(&v, &live).unwrap(), 0);
        assert!(!list(&v, &rel).unwrap().is_empty(), "갓 생긴 고아를 지웠다");
        // 한동안 지나면 걷는다
        assert_eq!(prune_orphans_older_than(&v, &live, std::time::Duration::ZERO).unwrap(), 1);
        assert!(list(&v, &rel).unwrap().is_empty(), "고아 스냅샷이 남았다");
        assert!(
            !list(&v, &other).unwrap().is_empty(),
            "살아 있는 노트의 이력까지 지웠다"
        );
    }

    /// 한 폴더를 잠깐 못 읽었다고(동기화 전·끊긴 드라이브) 그 노트들의 기록을 지우지 않는다.
    /// 목록이 통째로 비면 아예 손대지 않는다.
    #[test]
    fn 잠깐_안_보이는_노트의_기록은_지우지_않는다() {
        let (_d, v, rel) = setup();
        snapshot(&v, &rel, None, EAGER).unwrap();
        // 목록에서 빠졌다(파일은 그대로)
        assert_eq!(prune_orphans(&v, &["Free/다른 노트.md".to_string()]).unwrap(), 0);
        assert!(!list(&v, &rel).unwrap().is_empty());
        // 목록이 비었다 — 기간이 지났어도 지우지 않는다
        assert_eq!(prune_orphans_older_than(&v, &[], std::time::Duration::ZERO).unwrap(), 0);
        assert!(!list(&v, &rel).unwrap().is_empty());
    }
}
