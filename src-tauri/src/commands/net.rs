//! 바깥 세상과 말하는 데 필요한 것들 — HTTP 클라이언트·UA·오류 문구·카카오 키.

use super::*;

/// 빌드 시 주입된 카카오 키 (build.rs가 환경변수 또는 src-tauri/.env에서 읽어 넘긴다).
/// 소스에는 키를 두지 않는다 — 주입이 없으면 빈 문자열이고, 앱은 교보 폴백으로 동작한다.
///
/// 키는 XOR로 흩어진 채 들어와 여기서 되맞춘다. 이건 잠금이 아니라 속도 방지턱이다
/// (build.rs의 설명 참조) — 배포 파일에 `strings`를 걸어 키를 긁어가는 자동 수집만
/// 막는다. 되맞춘 값은 한 번만 만들어 두고 재사용한다.
pub(crate) fn default_kakao_key() -> &'static str {
    static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        let (Some(obf), Some(pad)) = (
            option_env!("YAMCHA_KAKAO_OBF"),
            option_env!("YAMCHA_KAKAO_PAD"),
        ) else {
            return String::new();
        };
        let pad = unhex(pad);
        if pad.is_empty() {
            return String::new();
        }
        let bytes: Vec<u8> = unhex(obf)
            .iter()
            .zip(pad.iter().cycle())
            .map(|(b, p)| b ^ p)
            .collect();
        String::from_utf8(bytes).unwrap_or_default()
    })
}

/// 16진 문자열 → 바이트. 짝이 안 맞거나 16진이 아니면 빈 벡터(키 없음으로 동작).
pub(crate) fn unhex(s: &str) -> Vec<u8> {
    if !s.len().is_multiple_of(2) {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in s.as_bytes().chunks(2) {
        let Ok(text) = std::str::from_utf8(pair) else {
            return Vec::new();
        };
        match u8::from_str_radix(text, 16) {
            Ok(b) => out.push(b),
            Err(_) => return Vec::new(),
        }
    }
    out
}

/// 사용자 키가 비어 있으면 빌드 주입 키를 쓴다. 둘 다 없으면 빈 문자열.
pub(crate) fn effective_key(user: &str) -> &str {
    if user.trim().is_empty() {
        default_kakao_key()
    } else {
        user.trim()
    }
}

/// 브라우저처럼 보이는 UA. UA가 없으면 교보는 500, 위키백과는 403으로 거부한다 —
/// 두 곳 다 겪어서 확인했다.
pub(crate) const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// 타임아웃을 건 일반 HTTP 클라이언트 (15초 전체 / 5초 연결).
pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default()
}

/// reqwest 오류를 한국어 완결문으로 변환한다 (영어 원문 노출 방지).
pub(crate) fn net_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "요청 시간이 초과됐습니다. 잠시 후 다시 시도해주세요.".into()
    } else if e.is_connect() {
        "인터넷 연결을 확인해주세요.".into()
    } else {
        "네트워크 오류가 발생했습니다.".into()
    }
}

/// 붙여넣기용 짧은 타임아웃 클라이언트. `http_client()`(15초)는 붙여넣는 순간에는 느리다 —
/// 실패해도 원본 URL이 그대로 남으므로 길게 기다릴 이유가 없다.
pub(crate) fn quick_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default()
}

/// 최소한의 HTML 엔티티 언이스케이프 (og:description/og:image 값에 흔한 것만)
pub(crate) fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[cfg(test)]
mod kakao_key_tests {
    use super::{default_kakao_key, unhex};

    #[test]
    fn unhex_rejects_garbage() {
        assert_eq!(unhex("00ff10"), vec![0x00, 0xff, 0x10]);
        assert!(unhex("abc").is_empty(), "홀수 길이");
        assert!(unhex("zz").is_empty(), "16진이 아님");
    }

    /// **되맞추기가 깨지면 책 검색이 조용히 폴백으로만 돈다.**
    /// XOR로 흩어 넣은 키가 원래 값으로 돌아오는지 여기서 지킨다.
    #[test]
    fn 주입된_키를_원래대로_되맞춘다() {
        // 키 없이도 빌드된다 (CI). 그때는 빈 문자열이 정답이다.
        if option_env!("YAMCHA_KAKAO_OBF").is_none() {
            assert!(default_kakao_key().is_empty());
            return;
        }
        let decoded = default_kakao_key();
        assert!(!decoded.is_empty(), "주입된 키를 되맞추지 못했다");
        assert!(
            decoded.chars().all(|c| c.is_ascii_alphanumeric()),
            "되맞춘 값이 깨졌다 (패드가 어긋났을 때 나오는 모양)"
        );
        // .env로 빌드했다면 그 값과 정확히 같아야 한다
        if let Ok(env) = std::fs::read_to_string(".env") {
            if let Some(expected) = env.lines().find_map(|l| {
                l.trim().strip_prefix("YAMCHA_KAKAO_KEY=").map(str::trim)
            }) {
                if !expected.is_empty() {
                    assert_eq!(decoded, expected, "되맞춘 키가 .env와 다르다");
                }
            }
        }
    }

}

#[cfg(test)]
mod key_tests {
    use super::*;

    #[test]
    fn 사용자키가_빌드주입키보다_우선한다() {
        assert_eq!(effective_key("  내키  "), "내키");
    }

    #[test]
    fn 빈_사용자키는_빌드주입키로_떨어진다() {
        assert_eq!(effective_key("   "), default_kakao_key());
    }

    /// 빌드 타임 주입이 실제로 걸렸는지 눈으로 확인하는 진단용.
    /// `cargo test -p yamcha-app --lib 주입_확인 -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn 주입_확인() {
        let k = default_kakao_key();
        eprintln!(
            "YAMCHA_KAKAO_KEY 주입: {} (길이 {})",
            if k.is_empty() { "없음" } else { "있음" },
            k.len()
        );
    }
}
