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
    #[error("{0}")]
    Invalid(String),
}
