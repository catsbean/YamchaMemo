use std::fs;
use std::path::Path;

/// 카카오 API 키를 컴파일 타임 env로 넘긴다.
/// 우선순위: 환경변수 YAMCHA_KAKAO_KEY → src-tauri/.env 파일.
/// 어느 쪽에도 없으면 넘기지 않는다(키 없이도 빌드되며, 앱은 교보 폴백으로 동작).
fn export_kakao_key() {
    println!("cargo:rerun-if-env-changed=YAMCHA_KAKAO_KEY");
    println!("cargo:rerun-if-changed=.env");

    let from_env = std::env::var("YAMCHA_KAKAO_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let key = from_env.or_else(|| read_dotenv_key(Path::new(".env"), "YAMCHA_KAKAO_KEY"));

    if let Some(key) = key {
        println!("cargo:rustc-env=YAMCHA_KAKAO_KEY={}", key.trim());
    }
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
