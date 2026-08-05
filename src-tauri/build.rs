use std::fs;
use std::path::Path;

/// 카카오 API 키를 컴파일 타임 env로 넘긴다.
/// 우선순위: 환경변수 YAMCHA_KAKAO_KEY → src-tauri/.env 파일.
/// 어느 쪽에도 없으면 넘기지 않는다(키 없이도 빌드되며, 앱은 교보 폴백으로 동작).
///
/// **키를 그대로 넘기지 않는다.** 예전에는 평문으로 넘겨서 설치본에 `strings`만
/// 걸면 키가 그대로 나왔다. 아래 XOR은 *잠금이 아니라 속도 방지턱*이다 —
/// 클라이언트가 쓸 수 있는 키는 클라이언트를 뜯으면 반드시 나온다(암호화해도
/// 복호화 키를 같이 실어야 하므로 마찬가지고, 진짜 해법은 프록시 서버뿐이다).
/// 다만 현실의 위협은 작정한 리버싱이 아니라 **배포 파일에서 키 문자열을 긁어가는
/// 자동 수집**이고, 그건 이걸로 막힌다.
fn export_kakao_key() {
    println!("cargo:rerun-if-env-changed=YAMCHA_KAKAO_KEY");
    println!("cargo:rerun-if-changed=.env");

    let from_env = std::env::var("YAMCHA_KAKAO_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let key = from_env.or_else(|| read_dotenv_key(Path::new(".env"), "YAMCHA_KAKAO_KEY"));

    let Some(key) = key else { return };
    let pad = build_pad();
    let obf: String = key
        .trim()
        .bytes()
        .zip(pad.iter().cycle())
        .map(|(b, p)| format!("{:02x}", b ^ p))
        .collect();
    let pad_hex: String = pad.iter().map(|p| format!("{p:02x}")).collect();
    println!("cargo:rustc-env=YAMCHA_KAKAO_OBF={obf}");
    println!("cargo:rustc-env=YAMCHA_KAKAO_PAD={pad_hex}");
}

/// 빌드마다 달라지는 16바이트 패드. 고정 상수로 두면 여러 빌드에 같은 서명이
/// 남아 한 번 풀린 방법이 그대로 재사용된다.
fn build_pad() -> [u8; 16] {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    let mut pad = [0u8; 16];
    let mut x = seed | 1; // 0이면 아래 시프트가 계속 0이다
    for slot in pad.iter_mut() {
        // xorshift64 — 빌드 스크립트에 난수 크레이트를 들이지 않으려고 직접 쓴다
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *slot = (x >> 24) as u8;
    }
    pad
}

/// `.env`에서 `KEY=값` 한 줄을 읽는다. 주석(#)과 따옴표를 처리한다.
fn read_dotenv_key(path: &Path, name: &str) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        if k.trim() != name {
            continue;
        }
        let v = v.trim().trim_matches(['"', '\'']).to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }
    None
}

fn main() {
    export_kakao_key();
    tauri_build::build()
}
