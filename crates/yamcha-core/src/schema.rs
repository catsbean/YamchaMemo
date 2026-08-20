//! 노트 타입 정의: 내장 4종 + 사용자 정의 타입.
//! 모든 타입은 `TypeDef`로 표현되며, frontmatter `type` 값(id)과 폴더가 1:1 대응한다.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// 동작이 특별한 내장 타입 4종.
/// 책(Book) 파일 하나가 도서 정보(frontmatter) + `## 소개` + `## 기록`(독서기록)을 모두 담는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Builtin {
    Book,
    Writing,
    Daily,
    Free,
}

impl Builtin {
    pub const ALL: [Builtin; 4] = [
        Builtin::Book,
        Builtin::Writing,
        Builtin::Daily,
        Builtin::Free,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Builtin::Book => "book",
            Builtin::Writing => "writing",
            Builtin::Daily => "daily",
            Builtin::Free => "free",
        }
    }

    pub fn from_id(id: &str) -> Option<Builtin> {
        Builtin::ALL.iter().copied().find(|b| b.id() == id)
    }

    pub fn folder(self) -> &'static str {
        match self {
            Builtin::Book => "Books",
            Builtin::Writing => "Writing",
            Builtin::Daily => "Daily",
            Builtin::Free => "Free",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Builtin::Book => "도서리스트",
            Builtin::Writing => "글쓰기",
            Builtin::Daily => "데일리노트",
            Builtin::Free => "자유노트",
        }
    }
}

/// GUI 폼 위젯 종류
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    Text,
    Date,
    Select,
    Tags,
    Number,
    Url,
    /// 로컬 이미지 경로 또는 URL (표지 등 — GUI에서 파일 선택 지원)
    Image,
    /// `[[제목]]` 형태의 위키링크 문자열
    WikiLink,
}

/// frontmatter 필드 하나의 정의 (GUI 폼 렌더링용)
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FieldDef {
    pub name: String,
    pub label: String,
    pub kind: FieldKind,
    pub required: bool,
    /// Select일 때 선택지 (value)
    pub options: Vec<String>,
    /// Select일 때 선택지 한글 라벨 (options와 같은 길이)
    pub option_labels: Vec<String>,
    /// 목록 화면의 각 줄에 이 칸의 값을 뱃지로 보여줄지.
    /// 나중에 생긴 칸이라 예전 `_types.json`에는 없다 — 없으면 끔이다.
    #[serde(default)]
    pub in_list: bool,
}

impl FieldDef {
    pub fn new(name: &str, label: &str, kind: FieldKind, required: bool) -> Self {
        FieldDef {
            name: name.into(),
            label: label.into(),
            kind,
            required,
            options: vec![],
            option_labels: vec![],
            in_list: false,
        }
    }

    fn select(name: &str, label: &str, required: bool, options: &[(&str, &str)]) -> Self {
        FieldDef {
            name: name.into(),
            label: label.into(),
            kind: FieldKind::Select,
            required,
            options: options.iter().map(|(v, _)| v.to_string()).collect(),
            option_labels: options.iter().map(|(_, l)| l.to_string()).collect(),
            in_list: false,
        }
    }
}

/// 타입 하나의 전체 정의 (내장 + 사용자 정의 공통)
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TypeDef {
    /// frontmatter `type` 값
    pub id: String,
    pub label: String,
    /// vault 내 폴더 이름
    pub folder: String,
    pub fields: Vec<FieldDef>,
    /// 새 노트 본문 템플릿 ({{date}}, {{title}} 치환)
    pub template: String,
    pub builtin: bool,
}

/// 도서 상태
pub const BOOK_STATUSES: [(&str, &str); 4] = [
    ("wishlist", "읽고 싶은 책"),
    ("reading", "읽는 중"),
    ("finished", "완독"),
    ("paused", "중단"),
];

/// 글쓰기(원고) 상태
pub const WRITING_STATUSES: [(&str, &str); 4] = [
    ("idea", "구상"),
    ("draft", "초고"),
    ("revise", "퇴고"),
    ("done", "완성"),
];

/// 독서기록 엔트리 구분 (콜아웃 이름으로 사용)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Excerpt,
    Thought,
    Summary,
    Question,
}

impl EntryKind {
    pub const ALL: [EntryKind; 4] = [
        EntryKind::Excerpt,
        EntryKind::Thought,
        EntryKind::Summary,
        EntryKind::Question,
    ];

    /// 콜아웃 태그로 쓰이는 한글 라벨
    pub fn label(self) -> &'static str {
        match self {
            EntryKind::Excerpt => "발췌",
            EntryKind::Thought => "생각",
            EntryKind::Summary => "요약",
            EntryKind::Question => "질문",
        }
    }
}

/// 데일리노트 빠른 입력 구분. 종류마다 들어가는 섹션과 형식이 다르다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DailyKind {
    /// 체크박스 항목으로 `## 할 일`에 추가
    Todo,
    /// 콜아웃으로 `## 기록`에 추가
    Log,
    /// 콜아웃으로 `## 기록`에 추가
    Feeling,
}

impl DailyKind {
    pub const ALL: [DailyKind; 3] = [DailyKind::Todo, DailyKind::Log, DailyKind::Feeling];

    /// 버튼·콜아웃 태그에 쓰이는 한글 라벨
    pub fn label(self) -> &'static str {
        match self {
            DailyKind::Todo => "할 일",
            DailyKind::Log => "기록",
            DailyKind::Feeling => "느낌",
        }
    }

    /// 이 종류가 들어갈 본문 섹션 헤더 (없으면 새로 만들어 붙인다)
    pub fn section(self) -> &'static str {
        match self {
            DailyKind::Todo => "## 할 일",
            DailyKind::Log | DailyKind::Feeling => "## 기록",
        }
    }
}

fn common_fields() -> Vec<FieldDef> {
    vec![
        FieldDef::new("date", "날짜", FieldKind::Date, true),
        FieldDef::new("tags", "태그", FieldKind::Tags, true),
    ]
}

/// 별칭 칸의 정의. `[[프로헥사디온 칼슘]]`을 '비비풀'로도 부르는 사람이
/// `[[비비풀]]`이라 써도 같은 글에 닿게 한다. 태그와 같은 위젯(쉼표 구분)을 쓴다.
///
/// **일지에는 붙이지 않는다** — 날짜가 곧 이름이라 다른 이름으로 부를 일이 없다.
pub fn aliases_field() -> FieldDef {
    FieldDef::new("aliases", "별칭", FieldKind::Tags, false)
}

fn builtin_fields(b: Builtin) -> Vec<FieldDef> {
    let mut f = common_fields();
    if !matches!(b, Builtin::Daily) {
        f.push(aliases_field());
    }
    match b {
        Builtin::Book => {
            f.push(FieldDef::new("title", "제목", FieldKind::Text, true));
            f.push(FieldDef::new("author", "저자", FieldKind::Text, true));
            f.push(FieldDef::new("genre", "분야", FieldKind::Text, false));
            f.push(FieldDef::select("status", "상태", true, &BOOK_STATUSES));
            f.push(FieldDef::new("isbn", "ISBN", FieldKind::Text, false));
            f.push(FieldDef::new("publisher", "출판사", FieldKind::Text, false));
            f.push(FieldDef::new("cover", "표지", FieldKind::Image, false));
            f.push(FieldDef::new("rating", "평점", FieldKind::Number, false));
            f.push(FieldDef::new("started", "읽기 시작", FieldKind::Date, false));
            f.push(FieldDef::new("finished", "완독일", FieldKind::Date, false));
        }
        Builtin::Writing => {
            f.push(FieldDef::new("title", "제목", FieldKind::Text, true));
            f.push(FieldDef::select("status", "상태", true, &WRITING_STATUSES));
            f.push(FieldDef::new("category", "분야", FieldKind::Text, false));
            f.push(FieldDef::new("series", "시리즈", FieldKind::Text, false));
            f.push(FieldDef::new("episode", "회차", FieldKind::Number, false));
            f.push(FieldDef::new("goal", "목표 글자수", FieldKind::Number, false));
            f.push(FieldDef::new("started", "시작일", FieldKind::Date, false));
            f.push(FieldDef::new("finished", "완성일", FieldKind::Date, false));
        }
        Builtin::Daily => {}
        Builtin::Free => {
            f.push(FieldDef::new("title", "제목", FieldKind::Text, false));
        }
    }
    f
}

/// 내장 타입 정의 목록
pub fn builtin_defs() -> Vec<TypeDef> {
    Builtin::ALL
        .iter()
        .map(|&b| TypeDef {
            id: b.id().to_string(),
            label: b.label().to_string(),
            folder: b.folder().to_string(),
            fields: builtin_fields(b),
            template: crate::template::builtin_body_template(b).to_string(),
            builtin: true,
        })
        .collect()
}

/// frontmatter 검증·보정: 필수 공통 필드(date/type/tags)가 없으면 기본값 주입.
/// 알 수 없는 필드는 그대로 보존한다.
pub fn normalize_frontmatter(fm: &mut Map<String, Value>, type_id: &str, today: &str) {
    if !fm.get("date").map(|v| v.is_string()).unwrap_or(false) {
        fm.insert("date".into(), json!(today));
    }
    fm.insert("type".into(), json!(type_id));
    if !fm.get("tags").map(|v| v.is_array()).unwrap_or(false) {
        fm.insert("tags".into(), json!([]));
    }
    // book: status 기본값
    if type_id == Builtin::Book.id() {
        let valid = fm
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| BOOK_STATUSES.iter().any(|(v, _)| *v == s))
            .unwrap_or(false);
        if !valid {
            fm.insert("status".into(), json!("wishlist"));
        }
    }
    // writing: status 기본값
    if type_id == Builtin::Writing.id() {
        let valid = fm
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| WRITING_STATUSES.iter().any(|(v, _)| *v == s))
            .unwrap_or(false);
        if !valid {
            fm.insert("status".into(), json!("idea"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_roundtrip() {
        for b in Builtin::ALL {
            assert_eq!(Builtin::from_id(b.id()), Some(b));
        }
        let defs = builtin_defs();
        assert_eq!(defs.len(), 4);
        assert!(defs.iter().all(|d| d.builtin));
    }

    /// 별칭은 일지 빼고 어디에나 있어야 한다 (일지는 날짜가 곧 이름이다)
    #[test]
    fn 별칭_칸은_일지만_빼고_있다() {
        for d in builtin_defs() {
            let has = d.fields.iter().any(|f| f.name == "aliases");
            assert_eq!(has, d.id != "daily", "{}의 별칭 칸이 잘못됐다", d.id);
        }
    }

    /// 별칭이 없는 노트에 `aliases: []`를 심지 않는다 — frontmatter가 지저분해진다
    #[test]
    fn normalize_does_not_add_empty_aliases() {
        let mut fm = Map::new();
        normalize_frontmatter(&mut fm, "free", "2026-08-11");
        assert!(!fm.contains_key("aliases"));
    }

    #[test]
    fn normalize_injects_required() {
        let mut fm = Map::new();
        normalize_frontmatter(&mut fm, "book", "2026-07-18");
        assert_eq!(fm["date"], json!("2026-07-18"));
        assert_eq!(fm["type"], json!("book"));
        assert_eq!(fm["tags"], json!([]));
        assert_eq!(fm["status"], json!("wishlist"));
    }

    #[test]
    fn normalize_preserves_unknown_fields() {
        let mut fm = Map::new();
        fm.insert("custom".into(), json!("keep me"));
        fm.insert("status".into(), json!("reading"));
        normalize_frontmatter(&mut fm, "book", "2026-07-18");
        assert_eq!(fm["custom"], json!("keep me"));
        assert_eq!(fm["status"], json!("reading"));
    }

    #[test]
    fn custom_type_normalize() {
        let mut fm = Map::new();
        normalize_frontmatter(&mut fm, "회의록", "2026-07-18");
        assert_eq!(fm["type"], json!("회의록"));
        assert_eq!(fm["tags"], json!([]));
    }
}
