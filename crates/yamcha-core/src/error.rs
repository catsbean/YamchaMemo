use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    /// 화면에는 **한국어 문장**만 보인다(`io_message`). 원문(`os error 32` 등)은 앱이 로그에 남긴다 —
    /// 원문을 그대로 띄우면 "IO 오류: 다른 프로세스가 파일을 사용 중이기 때문에…(os error 32)"처럼
    /// 무엇을 하면 되는지 알 수 없다.
    #[error("{}", io_message(.0))]
    Io(#[from] std::io::Error),
    #[error("frontmatter 오류: {0}")]
    Frontmatter(String),
    #[error("vault가 설정되지 않았습니다")]
    NoVault,
    #[error("노트를 찾을 수 없습니다: {0}")]
    NotFound(String),
    /// 다른 프로세스가 이 자원(검색 색인 등)을 쓰고 있다.
    /// **손상과 반드시 구별해야 한다** — 손상으로 오인하면 남이 쓰는 색인을 지운다.
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    Invalid(String),
}

/// 흔한 파일 오류를 "무엇이 일어났고 무엇을 하면 되는지" 한 문장으로.
pub fn io_message(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    // Windows 오류 번호가 종류보다 구체적이다 — 먼저 본다. 같은 번호가 macOS에선 전혀 다른 뜻이라
    // (32 = EPIPE 등) Windows에서만.
    #[cfg(windows)]
    if let Some(code) = e.raw_os_error() {
        match code {
            // ERROR_SHARING_VIOLATION · ERROR_LOCK_VIOLATION
            32 | 33 => {
                return "다른 프로그램(동기화·백신 등)이 이 파일을 쓰고 있습니다. 잠시 뒤 다시 해 보세요."
                    .into()
            }
            // ERROR_HANDLE_DISK_FULL · ERROR_DISK_FULL
            39 | 112 => return "디스크 공간이 부족합니다. 공간을 비운 뒤 다시 해 보세요.".into(),
            // ERROR_CLOUD_FILE_* (OneDrive·iCloud의 "필요할 때 내려받기")
            358..=404 => {
                return "클라우드 동기화 프로그램(OneDrive·iCloud 등)이 이 파일을 아직 내려받지 못했습니다. \
                        동기화 프로그램이 켜져 있고 인터넷에 연결돼 있는지 확인하세요."
                    .into()
            }
            _ => {}
        }
    }
    match e.kind() {
        K::NotFound => "파일이나 폴더를 찾을 수 없습니다. 앱 밖에서 옮기거나 지웠을 수 있습니다.".into(),
        K::PermissionDenied => {
            "이 파일을 읽거나 쓸 권한이 없습니다. 읽기 전용이거나 다른 프로그램이 잠갔는지 확인하세요.".into()
        }
        K::AlreadyExists => "같은 이름의 파일이 이미 있습니다.".into(),
        K::InvalidData => "파일을 글자로 읽을 수 없습니다. UTF-8이 아닌 파일일 수 있습니다.".into(),
        K::StorageFull => "디스크 공간이 부족합니다. 공간을 비운 뒤 다시 해 보세요.".into(),
        K::TimedOut => "파일을 다루다 시간이 초과됐습니다. 잠시 뒤 다시 해 보세요.".into(),
        _ => "파일을 다루다 문제가 생겼습니다. 설정 › 도움말의 [진단 정보]에 자세한 내용이 남습니다.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn 파일_오류는_한국어_문장으로_보인다() {
        let shown = |e: Error| CoreError::from(e).to_string();
        #[cfg(windows)]
        {
            assert!(shown(Error::from_raw_os_error(32)).contains("다른 프로그램"));
            assert!(shown(Error::from_raw_os_error(112)).contains("디스크 공간"));
            assert!(shown(Error::from_raw_os_error(362)).contains("클라우드"));
        }
        assert!(shown(Error::from(ErrorKind::NotFound)).contains("찾을 수 없습니다"));
        assert!(shown(Error::from(ErrorKind::PermissionDenied)).contains("권한"));
        // 원문(os error …)은 화면에 실리지 않는다
        let other = shown(Error::other("boom (os error 9999)"));
        assert!(!other.contains("os error") && !other.contains("boom"), "{other}");
    }
}
