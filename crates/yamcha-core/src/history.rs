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
    fs::write(&path, &current)?;

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
    let src = note_dir(vault, from);
    if !src.is_dir() || from == to {
        return Ok(());
    }
    let dst = note_dir(vault, to);
    if dst.exists() {
        // 옮겨갈 자리에 이미 이력이 있다 (같은 이름을 다시 쓴 경우) — 덮지 않는다
        return Ok(());
    }
    fs::rename(&src, &dst)?;
    Ok(())
}

/// vault에 더 이상 없는 노트의 스냅샷 폴더를 지운다 → 지운 폴더 수.
///
/// 앱 밖(옵시디언·탐색기)에서 지운 파일은 `delete_note`를 거치지 않아 스냅샷만 남는다.
/// 예전 버전이 쌓아 둔 것도 여기서 함께 걷힌다. vault를 열 때 한 번 돈다.
pub fn prune_orphans(vault: &Vault, live: &[String]) -> Result<u32, CoreError> {
    let root = vault.root().join(".yamcha").join("history");
    if !root.is_dir() {
        return Ok(0);
    }
    let alive: std::collections::HashSet<String> =
        live.iter().map(|rel| rel.replace(['/', '\\'], "__")).collect();
    let mut removed = 0u32;
    for entry in fs::read_dir(&root)?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !alive.contains(&name) && fs::remove_dir_all(&path).is_ok() {
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
    #[test]
    fn 노트를_지우면_스냅샷도_지운다() {
        let (_d, mut v, rel) = setup();
        v.set_history_policy(EAGER);
        put(&v, &rel, "지워질 내용");
        snapshot(&v, &rel, None, EAGER).unwrap();
        assert_eq!(list(&v, &rel).unwrap().len(), 1);

        v.delete_note(&rel).unwrap();
        assert!(
            list(&v, &rel).unwrap().is_empty(),
            "지운 글의 스냅샷이 남았다"
        );
        assert!(!note_dir(&v, &rel).exists());
    }

    /// 제목을 바꿨다고 되돌릴 지점이 사라지면 안전장치가 아니다
    #[test]
    fn 제목을_바꾸면_스냅샷이_따라온다() {
        let (_d, mut v, rel) = setup();
        v.set_history_policy(EAGER);
        put(&v, &rel, "옛 제목 시절의 내용");
        snapshot(&v, &rel, None, EAGER).unwrap();

        let new_rel = v.rename_note(&rel, "새 제목").unwrap();
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
        assert_eq!(prune_orphans(&v, &live).unwrap(), 1);
        assert!(list(&v, &rel).unwrap().is_empty(), "고아 스냅샷이 남았다");
        assert!(
            !list(&v, &other).unwrap().is_empty(),
            "살아 있는 노트의 이력까지 지웠다"
        );
    }
}
