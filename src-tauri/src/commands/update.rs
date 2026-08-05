//! 새 버전 확인.

use super::*;

/// 버전 확인 결과 — 자동 설치는 하지 않고 안내만 한다.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct ReleaseCheck {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    pub url: String,
}

/// "x.y.z" 꼴 버전을 비교용 튜플로. 못 읽은 조각은 0으로 본다.
fn parse_semver(s: &str) -> (u32, u32, u32) {
    let mut it = s.trim().trim_start_matches('v').split('.');
    let a = it.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let b = it.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let c = it.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (a, b, c)
}

/// GitHub 릴리스에서 최신 버전을 확인한다. 자동 설치는 하지 않고,
/// 새 버전이 있으면 안내 문구와 릴리스 페이지 링크만 돌려준다.
#[tauri::command]
#[specta::specta]
pub async fn check_latest_release() -> Result<ReleaseCheck, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let resp = http_client()
        .get("https://api.github.com/repos/catsbean/YamchaMemo/releases/latest")
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| net_err(&e))?;
    if !resp.status().is_success() {
        return Err("최신 버전 정보를 가져오지 못했습니다.".into());
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| net_err(&e))?;
    let latest = json["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let url = json["html_url"]
        .as_str()
        .unwrap_or("https://github.com/catsbean/YamchaMemo/releases")
        .to_string();
    let newer = parse_semver(&latest) > parse_semver(&current);
    Ok(ReleaseCheck { current, latest, newer, url })
}

#[cfg(test)]
mod version_tests {
    use super::parse_semver;

    #[test]
    fn semver_compares_numerically_not_lexically() {
        assert!(parse_semver("0.10.0") > parse_semver("0.9.0"));
        assert_eq!(parse_semver("v0.5.4"), parse_semver("0.5.4"));
        assert!(parse_semver("0.5.4") == parse_semver("0.5.4"));
        assert_eq!(parse_semver("bad"), (0, 0, 0));
    }
}
