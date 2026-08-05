use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("IO 오류: {0}")]
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
