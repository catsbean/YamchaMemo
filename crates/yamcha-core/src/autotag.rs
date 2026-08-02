//! 자동 태그 추천: 본문에서 **고유명사**를 찾아 태그로 제안한다.
//!
//! **제안만 한다.** 파일을 조용히 고치지 않는다 — [`audit`](crate::audit)의 "자동 수정
//! 없음" 원칙과 같은 태도다. 실제로 붙이는 것은 항상 화면에서 사용자가 칩을 누른
//! 뒤 `update_frontmatter`로 한다.
//!
//! ## 왜 사전 대조인가
//!
//! 한국어에는 대문자가 없어서 "김상욱"과 "김치찌개"를 문자열만 보고 가를 수 없다.
//! 고유명사 판별은 형태소 분석기(NNP 태그) 없이는 규칙으로 풀리지 않는다.
//!
//! 대신 이 앱에는 **vault 자체가 고유명사 사전**이라는 이점이 있다 — 노트 제목,
//! 책의 저자·출판사, 기존 태그는 전부 사용자가 이미 "이건 이름이다"라고 표시해 둔
//! 것이다. 그래서 추측하지 않고 **대조**만 한다. 사전에 없는 말은 제안하지 않는다.
//!
//! 일반 명사 키워드 추출(빈도·위치 기반)은 일부러 하지 않는다. 그 방식은 "실제로"
//! 같은 부사가 새고, 막으려면 불용어 목록을 끝없이 늘려야 한다.
//!
//! ## 못 하는 것
//!
//! vault에 없는, 처음 보는 이름은 못 잡는다. 일지에 "어제 김상욱 교수 강연"이라고
//! 썼는데 그 이름이 vault 어디에도 없으면 사전에 없으니 제안하지 못한다.
//! 이 구멍이 실제로 자주 느껴지면 그때 형태소 분석기를 검토한다.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::korean;

/// 사전 항목이 어디서 왔는지 — 제안 근거 문구에 쓴다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DictSource {
    /// 이미 쓰고 있는 태그
    Tag,
    /// 다른 노트의 제목 (책·인물·프로젝트 노트)
    NoteTitle,
    /// 책의 저자
    Author,
    /// 책의 출판사
    Publisher,
}

impl DictSource {
    fn label(self) -> &'static str {
        match self {
            DictSource::Tag => "이미 쓰는 태그",
            DictSource::NoteTitle => "노트 제목",
            DictSource::Author => "저자",
            DictSource::Publisher => "출판사",
        }
    }
}

/// vault에서 모은 고유명사 사전의 한 항목
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DictEntry {
    pub name: String,
    /// 이 이름이 속한 범주 (책 분야 등) — 이름과 함께 제안한다
    pub categories: Vec<String>,
    pub source: DictSource,
}

impl DictEntry {
    pub fn new(name: impl Into<String>, source: DictSource) -> Self {
        DictEntry {
            name: name.into(),
            categories: vec![],
            source,
        }
    }

    pub fn with_categories(mut self, categories: Vec<String>) -> Self {
        self.categories = categories;
        self
    }
}

/// 추천에 필요한 노트 정보. 저장된 파일이 아니라 **지금 편집 중인 내용**을 받아야
/// 타이핑 중인 초안이 제안에 반영된다.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct TagInput {
    pub title: String,
    pub body: String,
    pub note_type: String,
    /// book의 분야(genre) — 있으면 범주 태그 후보가 된다
    pub genre: Option<String>,
    /// 이미 달린 태그 — 후보에서 제외한다
    pub current_tags: Vec<String>,
}

/// 태그 후보 하나
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TagSuggestion {
    pub tag: String,
    /// 0.0~1.0. 화면은 이 순서로 보여준다
    pub score: f32,
    /// 화면 툴팁에 보여줄 근거 ("저자" 등)
    pub reason: String,
    /// vault에 이미 있는 태그인가 (화면에서 색을 달리한다)
    pub existing: bool,
    /// 범주 태그인가 (고유명사 칩과 색을 달리한다)
    pub category: bool,
}

/// 영어 문장 첫머리에 흔해서 고유명사로 볼 수 없는 낱말
const EN_FUNCTION_WORDS: &[&str] = &[
    "The", "This", "That", "These", "Those", "There", "Then", "They", "Their", "It", "Its", "If",
    "In", "On", "At", "And", "But", "Or", "So", "As", "For", "From", "To", "Of", "With", "We",
    "You", "He", "She", "His", "Her", "My", "Our", "Your", "A", "An", "Is", "Are", "Was", "Were",
    "Be", "Do", "Does", "Did", "Not", "No", "Yes", "When", "What", "Which", "Who", "How", "Why",
    "Also", "After", "Before", "Because", "By", "Can", "Could", "Should", "Would", "Will",
];

/// 한글 어절 끝에서 뗄 조사 — 긴 것부터 시도한다("에서"가 "에"보다 먼저 걸리도록).
///
/// **바닥글자 "로"는 일부러 뺐다.** "도로·경로·제로·진로·회로"처럼 그 자체가
/// 명사인 2음절 낱말이 particle "로"와 겹쳐서, "도로"가 "도"로 뭉개지는 식의
/// 오탐이 난다. "으로"(2글자)는 이런 충돌이 사실상 없어 남긴다.
const PARTICLES: &[&str] = &[
    "이라도", "이라서", "이지만", "한테서", "에게서", "까지는", "부터는", "이라면",
    "에서", "에게", "한테", "까지", "부터", "이나", "라도", "이라", "이며", "이고",
    "처럼", "같이", "마다", "조차", "마저", "밖에", "뿐", "으로", "은", "는", "이",
    "가", "을", "를", "의", "와", "과", "랑", "도", "만", "나", "며", "고", "라", "에",
];

fn word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\p{L}\p{N}]+").unwrap())
}

fn bold_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\*\*([^*]+)\*\*").unwrap())
}

fn is_ascii_alnum_word(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// 토큰에서 영문·숫자 부분만 떼어 낸다. 한글 조사가 붙어 와도("Rust로") 이름을 찾는다 —
/// 어절 정규식이 한글과 영문을 한 덩어리로 잡기 때문에 여기서 갈라 줘야 한다.
/// "Rust" → Some("Rust"), "Rust로" → Some("Rust"), "클린" → None
fn ascii_word(s: &str) -> Option<&str> {
    if is_ascii_alnum_word(s) {
        return Some(s);
    }
    let end = s.find(|c: char| !c.is_ascii_alphanumeric())?;
    if end == 0 {
        return None;
    }
    Some(&s[..end])
}

/// 영문·숫자는 소문자로, 한글은 그대로 — 대소문자 차이를 흡수한다.
fn normalize_for_compare(s: &str) -> String {
    if is_ascii_alnum_word(s) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// 어절에서 조사를 뗀 표제어. 매칭되는 조사가 없으면 원문 그대로.
/// "책을" → "책", "리팩토링은" → "리팩토링", "책상" → "책상"("상"은 조사가 아니다)
fn strip_particle(word: &str) -> &str {
    let len = word.chars().count();
    for &p in PARTICLES {
        let plen = p.chars().count();
        if len > plen && word.ends_with(p) {
            let cut = word.len() - p.len();
            return &word[..cut];
        }
    }
    word
}

fn normalize_token(word: &str) -> String {
    match ascii_word(word) {
        Some(a) => a.to_lowercase(),
        None => strip_particle(word).to_string(),
    }
}

/// 표제어 하나의 등장 정보
#[derive(Debug, Clone, Copy, Default)]
struct Agg {
    count: u32,
    in_title: bool,
    in_heading: bool,
    in_bold: bool,
}

impl Agg {
    fn structural(self) -> bool {
        self.in_title || self.in_heading || self.in_bold
    }
}

/// 제목·본문에서 표제어별 등장 정보를 모은다 (한 어절짜리 이름을 찾을 때 쓴다).
fn collect_occurrences(input: &TagInput) -> HashMap<String, Agg> {
    let mut map: HashMap<String, Agg> = HashMap::new();

    let mut add = |word: &str, in_title: bool, in_heading: bool, in_bold: bool| {
        let stem = normalize_token(word);
        if stem.is_empty() {
            return;
        }
        let agg = map.entry(stem).or_default();
        agg.count += 1;
        agg.in_title |= in_title;
        agg.in_heading |= in_heading;
        agg.in_bold |= in_bold;
    };

    for m in word_re().find_iter(&input.title) {
        add(m.as_str(), true, false, false);
    }

    for line in input.body.lines() {
        let is_heading = line.trim_start().starts_with('#');
        let bold_ranges: Vec<(usize, usize)> = bold_re()
            .captures_iter(line)
            .filter_map(|cap| cap.get(1))
            .map(|m| (m.start(), m.end()))
            .collect();
        for m in word_re().find_iter(line) {
            let in_bold = bold_ranges
                .iter()
                .any(|&(s, e)| m.start() >= s && m.end() <= e);
            add(m.as_str(), false, is_heading, in_bold);
        }
    }

    map
}

/// 제목 + 헤딩 줄 + 굵게 표시된 구간을 한 덩어리로 (여러 어절짜리 이름의 가중치 판정용)
fn structural_text(input: &TagInput) -> String {
    let mut out = String::from(&input.title);
    for line in input.body.lines() {
        if line.trim_start().starts_with('#') {
            out.push('\n');
            out.push_str(line);
        }
        for cap in bold_re().captures_iter(line) {
            if let Some(m) = cap.get(1) {
                out.push('\n');
                out.push_str(m.as_str());
            }
        }
    }
    out
}

fn last_segment(tag: &str) -> &str {
    tag.rsplit('/').next().unwrap_or(tag)
}

/// 공백을 지우고 소문자로 — 띄어쓰기와 대소문자 차이를 함께 흡수한다.
/// "창조 기사 논쟁" → "창조기사논쟁"
fn despace(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 이 이름에 붙여쓰기 매칭을 허용할지.
///
/// 짧은 이름에 부분 문자열 매칭을 열면 "독서"가 독서실·독서회에 걸린다.
/// 넉넉히 긴 이름만 허용한다 — 여러 어절짜리는 그 자체로 구체적이라 문턱을 낮춘다.
fn allows_despaced(name: &str, needle: &str) -> bool {
    let n = needle.chars().count();
    n >= 4 || (name.contains(' ') && n >= 3)
}

/// 줄 단위로 공백을 지우고 찾는다.
///
/// **줄을 넘어서 이어 붙이지 않는다.** 본문 전체를 한 덩어리로 붙이면
/// 목록의 "- 창조" 다음 줄 "- 기사 논쟁"이 이어져 없던 언급이 생긴다.
fn count_despaced(haystack: &str, needle: &str) -> u32 {
    haystack
        .lines()
        .map(|l| despace(l).matches(needle).count() as u32)
        .sum()
}

fn contains_despaced(haystack: &str, needle: &str) -> bool {
    haystack.lines().any(|l| despace(l).contains(needle))
}

/// 사전의 이름 하나가 이 노트에 나오는지. 나오면 (등장 정보, 근사매칭 여부).
///
/// 세 방법을 순서대로 쓴다:
/// 1. **한 어절 정확 일치** — 조사를 뗀 표제어와 같을 때만. 태그 "책"이 책상·정책에
///    걸리지 않게 하는 것이 이 단계의 목적이다.
/// 2. **붙여쓰기 매칭** — 공백을 지우고 부분 문자열로 찾는다. 책 제목이
///    "창조 기사 논쟁"인데 본문에 "창조기사논쟁"이나 "창조기사 논쟁"으로 적어도
///    같은 이름으로 본다. 짧은 이름에는 열지 않는다([`allows_despaced`]).
/// 3. **자모 근사** — 표기 흔들림(리팩토링↔리팩터링)만.
fn match_name(
    name: &str,
    map: &HashMap<String, Agg>,
    structural: &str,
    body: &str,
    title: &str,
) -> Option<(Agg, bool)> {
    let seg = last_segment(name);
    let chars = seg.chars().count();
    if chars == 0 {
        return None;
    }

    // ① 한 어절이면 조사를 뗀 표제어와 정확히 일치하는지 먼저 본다
    if !seg.contains(' ') {
        let key = normalize_for_compare(seg);
        if let Some(&agg) = map.get(&key) {
            // 한 글자짜리는 본문 등장만으로 너무 광범위하다 — 제목·헤딩·강조만 인정
            if chars == 1 && !agg.structural() {
                return None;
            }
            return Some((agg, false));
        }
    }

    // ② 띄어쓰기를 무시하고 찾는다
    let needle = despace(seg);
    if allows_despaced(seg, &needle) {
        let count = count_despaced(body, &needle);
        let in_title = contains_despaced(title, &needle);
        if count > 0 || in_title {
            return Some((
                Agg {
                    count: count.max(1),
                    in_title,
                    in_heading: contains_despaced(structural, &needle),
                    in_bold: false,
                },
                false,
            ));
        }
    }

    // ③ 표기 흔들림 흡수는 3글자 이상 한 어절 이름에만, 길이가 비슷한 표제어에만 —
    //    비용과 오탐을 함께 묶는다.
    if chars >= 3 && !seg.contains(' ') {
        for (stem, &agg) in map.iter() {
            let len_diff = (stem.chars().count() as isize - chars as isize).abs();
            if len_diff > 2 {
                continue;
            }
            if korean::is_near(seg, stem) {
                return Some((agg, true));
            }
        }
    }
    None
}

fn score_name(agg: Agg, source: DictSource, via_near: bool) -> f32 {
    let freq_bonus = ((agg.count as f32).ln().max(0.0) * 0.08).min(0.20);
    let mut score = 0.60;
    if agg.structural() {
        score += 0.25;
    }
    score += freq_bonus;
    // 이미 태그로 쓰고 있다는 것은 사용자가 그 이름을 태그로 원한다는 증거다
    if source == DictSource::Tag {
        score += 0.05;
    }
    if via_near {
        score -= 0.15;
    }
    score.clamp(0.0, 1.0)
}

fn reason_name(agg: Agg, source: DictSource, via_near: bool) -> String {
    let where_ = if agg.in_title {
        "제목에 나옴"
    } else if agg.in_heading || agg.in_bold {
        "헤딩/강조에 나옴"
    } else {
        "본문에 나옴"
    };
    let mut r = format!("{} · {where_}", source.label());
    if via_near {
        r.push_str(" (비슷한 표기)");
    }
    r
}

/// 본문 내용 + vault 고유명사 사전 → 태그 후보(점수순, 최대 `limit`개).
///
/// `dict`는 [`crate::indexer::Indexer::proper_noun_dict`]의 결과를 그대로 넣으면 된다.
pub fn suggest_tags(input: &TagInput, dict: &[DictEntry], limit: usize) -> Vec<TagSuggestion> {
    let map = collect_occurrences(input);
    let structural = structural_text(input);
    let current: HashSet<&str> = input.current_tags.iter().map(|s| s.as_str()).collect();
    let known_tags: HashSet<&str> = dict
        .iter()
        .filter(|e| e.source == DictSource::Tag)
        .map(|e| e.name.as_str())
        .collect();

    let mut out: Vec<TagSuggestion> = Vec::new();
    // 매칭된 이름이 속한 범주 — 이름 뒤에 함께 제안한다
    let mut categories: HashMap<String, f32> = HashMap::new();

    for entry in dict {
        // 자기 자신(이 노트의 제목)은 태그가 될 수 없다
        if entry.name == input.title || current.contains(entry.name.as_str()) {
            continue;
        }
        let Some((agg, via_near)) = match_name(
            &entry.name,
            &map,
            &structural,
            &input.body,
            &input.title,
        ) else {
            continue;
        };
        out.push(TagSuggestion {
            tag: entry.name.clone(),
            score: score_name(agg, entry.source, via_near),
            reason: reason_name(agg, entry.source, via_near),
            existing: known_tags.contains(entry.name.as_str()),
            category: false,
        });
        for c in &entry.categories {
            let e = categories.entry(c.clone()).or_insert(0.0);
            *e = e.max(0.50);
        }
    }

    // 이 노트가 책이면 자기 분야도 범주 후보다
    if let Some(genre) = input
        .genre
        .as_deref()
        .map(str::trim)
        .filter(|g| !g.is_empty())
    {
        let e = categories.entry(genre.to_string()).or_insert(0.0);
        *e = e.max(0.70);
    }

    // 영문 고유명사 — 대문자로 시작하는 낱말은 한글과 달리 신호가 분명하다
    let in_dict: HashSet<String> = dict
        .iter()
        .map(|e| normalize_for_compare(last_segment(&e.name)))
        .collect();
    let mut seen_ascii: HashSet<String> = HashSet::new();
    for m in word_re().find_iter(&input.body) {
        // 한글 조사가 붙어 와도("Rust로") 영문 부분만 본다
        let Some(w) = ascii_word(m.as_str()) else {
            continue;
        };
        if w.chars().count() < 2 || !w.starts_with(|c: char| c.is_ascii_uppercase()) {
            continue;
        }
        if EN_FUNCTION_WORDS.contains(&w) {
            continue;
        }
        let key = w.to_lowercase();
        if in_dict.contains(&key) || current.contains(w) || !seen_ascii.insert(key) {
            continue;
        }
        out.push(TagSuggestion {
            tag: w.to_string(),
            score: 0.45,
            reason: "영문 고유명사".into(),
            existing: false,
            category: false,
        });
    }

    // 범주는 이름 뒤에 붙인다
    for (name, score) in categories {
        if current.contains(name.as_str()) || out.iter().any(|s| s.tag == name) {
            continue;
        }
        let existing = known_tags.contains(name.as_str());
        out.push(TagSuggestion {
            tag: name,
            score,
            reason: "범주".into(),
            existing,
            category: true,
        });
    }

    // 중복 제거(더 높은 점수 유지) 후 정렬 — 고유명사가 범주보다 먼저 온다
    let mut best: HashMap<String, TagSuggestion> = HashMap::new();
    for s in out {
        best.entry(s.tag.clone())
            .and_modify(|cur| {
                if s.score > cur.score {
                    *cur = s.clone();
                }
            })
            .or_insert(s);
    }
    let mut result: Vec<TagSuggestion> = best.into_values().collect();
    result.sort_by(|a, b| {
        a.category
            .cmp(&b.category)
            .then_with(|| b.score.partial_cmp(&a.score).unwrap())
            .then_with(|| a.tag.cmp(&b.tag))
    });
    result.truncate(limit);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(title: &str, body: &str) -> TagInput {
        TagInput {
            title: title.into(),
            body: body.into(),
            note_type: "free".into(),
            genre: None,
            current_tags: vec![],
        }
    }

    fn tag(name: &str) -> DictEntry {
        DictEntry::new(name, DictSource::Tag)
    }

    fn note_title(name: &str) -> DictEntry {
        DictEntry::new(name, DictSource::NoteTitle)
    }

    #[test]
    fn particle_stripping() {
        assert_eq!(strip_particle("책을"), "책");
        assert_eq!(strip_particle("리팩토링은"), "리팩토링");
        assert_eq!(strip_particle("책상"), "책상"); // "상"은 조사가 아니다
        assert_eq!(strip_particle("독서를"), "독서");
        assert_eq!(strip_particle("집으로"), "집");
        assert_eq!(strip_particle("책상으로"), "책상");
        // 바닥글자 "로"는 빼서 "도로/경로/제로" 같은 낱말을 지킨다
        assert_eq!(strip_particle("도로"), "도로");
        assert_eq!(strip_particle("경로"), "경로");
    }

    #[test]
    fn only_dictionary_names_are_suggested() {
        // 사전에 없는 말은 아무리 반복돼도 제안하지 않는다 —
        // "실제로" 같은 부사가 새던 문제를 원천 차단한다
        let d = vec![tag("독서")];
        let body = "실제로 실제로 실제로 확인했고 사실은 사실은 그렇다";
        let r = suggest_tags(&input("", body), &d, 10);
        assert!(r.is_empty());
    }

    #[test]
    fn existing_tag_matched_from_body() {
        let d = vec![tag("독서")];
        let r = suggest_tags(&input("", "오늘 독서를 했다"), &d, 10);
        assert!(r.iter().any(|s| s.tag == "독서" && s.existing && !s.category));
    }

    #[test]
    fn spacing_variants_all_match_the_same_name() {
        let d = vec![note_title("창조 기사 논쟁")];
        for body in [
            "오늘 창조 기사 논쟁을 읽었다",   // 제목 그대로
            "오늘 창조기사논쟁을 읽었다",     // 다 붙여 씀
            "오늘 창조기사 논쟁을 읽었다",    // 띄어쓰기가 다름
            "오늘 창조 기사논쟁을 읽었다",    // 또 다른 자리
        ] {
            let r = suggest_tags(&input("", body), &d, 10);
            assert!(
                r.iter().any(|s| s.tag == "창조 기사 논쟁"),
                "이 본문에서 못 찾았다: {body}"
            );
        }
    }

    #[test]
    fn despaced_match_does_not_cross_lines() {
        // 목록의 두 줄이 이어 붙어 없던 언급이 생기면 안 된다
        let d = vec![note_title("창조 기사 논쟁")];
        let r = suggest_tags(&input("", "- 창조\n- 기사 논쟁"), &d, 10);
        assert!(!r.iter().any(|s| s.tag == "창조 기사 논쟁"));
    }

    #[test]
    fn despaced_match_respects_punctuation() {
        // 문장이 끊긴 자리는 붙여쓰기로 봐 주지 않는다 (구두점은 지우지 않는다)
        let d = vec![note_title("창조 기사 논쟁")];
        let r = suggest_tags(&input("", "그건 창조. 기사 논쟁과는 다른 얘기"), &d, 10);
        assert!(!r.iter().any(|s| s.tag == "창조 기사 논쟁"));
    }

    #[test]
    fn short_names_do_not_get_despaced_substring_matching() {
        // 붙여쓰기 매칭을 짧은 이름에 열면 "독서"가 독서실에 걸린다
        let d = vec![tag("독서"), tag("일기")];
        let r = suggest_tags(&input("", "독서실에서 일기예보를 봤다"), &d, 10);
        assert!(r.is_empty(), "{:?}", r);
    }

    #[test]
    fn despaced_match_is_case_insensitive_for_ascii() {
        let d = vec![note_title("Clean Code")];
        let r = suggest_tags(&input("", "어제 clean code를 읽었다"), &d, 10);
        assert!(r.iter().any(|s| s.tag == "Clean Code"));
    }

    #[test]
    fn daily_callout_body_is_matched() {
        // 데일리노트 본문은 콜아웃 형식이다 — 인용 표시(`>`)와 시각이 섞여 있어도
        // 이름을 찾아야 한다. 붙여쓰기가 달라도 마찬가지.
        let d = vec![note_title("창조 기사 논쟁").with_categories(vec!["종교/신학".into()])];
        let body = "## 기록\n\n> [!기록] 09:30\n> 창조기사논쟁을 절반쯤 읽었다\n\n## 할 일\n\n- [ ] 나머지 읽기";
        let mut i = input("", body);
        i.note_type = "daily".into();
        let r = suggest_tags(&i, &d, 10);
        assert!(r.iter().any(|s| s.tag == "창조 기사 논쟁"), "{r:?}");
        assert!(r.iter().any(|s| s.tag == "종교/신학" && s.category));
    }

    #[test]
    fn note_title_becomes_proper_noun_suggestion() {
        let d = vec![note_title("클린 코드")];
        let r = suggest_tags(&input("", "어제 클린 코드를 다 읽었다"), &d, 10);
        let hit = r.iter().find(|s| s.tag == "클린 코드").unwrap();
        assert!(hit.reason.contains("노트 제목"));
        assert!(!hit.existing); // 아직 태그로 쓰인 적은 없다
    }

    #[test]
    fn author_and_publisher_are_proper_nouns() {
        let d = vec![
            DictEntry::new("로버트 마틴", DictSource::Author),
            DictEntry::new("인사이트", DictSource::Publisher),
        ];
        let r = suggest_tags(&input("", "로버트 마틴이 인사이트에서 낸 책"), &d, 10);
        assert!(r.iter().any(|s| s.tag == "로버트 마틴"));
        assert!(r.iter().any(|s| s.tag == "인사이트"));
    }

    #[test]
    fn category_rides_along_with_the_name() {
        let d = vec![note_title("클린 코드").with_categories(vec!["컴퓨터/IT".into()])];
        let r = suggest_tags(&input("", "클린 코드 읽는 중"), &d, 10);
        let name = r.iter().find(|s| s.tag == "클린 코드").unwrap();
        let cat = r.iter().find(|s| s.tag == "컴퓨터/IT").unwrap();
        assert!(!name.category);
        assert!(cat.category);
        // 고유명사가 범주보다 앞에 온다
        let ni = r.iter().position(|s| s.tag == "클린 코드").unwrap();
        let ci = r.iter().position(|s| s.tag == "컴퓨터/IT").unwrap();
        assert!(ni < ci);
    }

    #[test]
    fn category_not_suggested_when_name_absent() {
        let d = vec![note_title("클린 코드").with_categories(vec!["컴퓨터/IT".into()])];
        let r = suggest_tags(&input("", "오늘은 산책을 했다"), &d, 10);
        assert!(r.is_empty());
    }

    #[test]
    fn title_occurrence_scores_higher() {
        let d = vec![tag("독서")];
        let t = suggest_tags(&input("독서 기록", "그냥 본문"), &d, 10);
        let b = suggest_tags(&input("", "독서 이야기"), &d, 10);
        let s1 = t.iter().find(|s| s.tag == "독서").unwrap().score;
        let s2 = b.iter().find(|s| s.tag == "독서").unwrap().score;
        assert!(s1 > s2);
    }

    #[test]
    fn short_name_does_not_pollute_substrings() {
        let d = vec![tag("책")];
        let r = suggest_tags(&input("", "책상 위에 정책 문서가 있다"), &d, 10);
        assert!(!r.iter().any(|s| s.tag == "책"));
    }

    #[test]
    fn diary_tag_does_not_match_weather_word() {
        let d = vec![tag("일기")];
        let r = suggest_tags(&input("", "일기예보를 확인했다"), &d, 10);
        assert!(!r.iter().any(|s| s.tag == "일기"));
    }

    #[test]
    fn near_match_absorbs_spelling_variance() {
        let d = vec![tag("리팩터링")];
        let r = suggest_tags(&input("", "리팩토링을 오늘 했다"), &d, 10);
        let hit = r.iter().find(|s| s.tag == "리팩터링").unwrap();
        assert!(hit.reason.contains("비슷한 표기"));
    }

    #[test]
    fn two_char_name_skips_near_match() {
        let d = vec![tag("성공")];
        let r = suggest_tags(&input("", "이건 수공예 작품이다"), &d, 10);
        assert!(!r.iter().any(|s| s.tag == "성공"));
    }

    #[test]
    fn current_tags_excluded() {
        let d = vec![tag("독서")];
        let mut i = input("", "오늘 독서를 했다");
        i.current_tags = vec!["독서".into()];
        let r = suggest_tags(&i, &d, 10);
        assert!(!r.iter().any(|s| s.tag == "독서"));
    }

    #[test]
    fn own_title_is_not_suggested() {
        let d = vec![note_title("클린 코드")];
        let r = suggest_tags(&input("클린 코드", "클린 코드에 대한 감상"), &d, 10);
        assert!(!r.iter().any(|s| s.tag == "클린 코드"));
    }

    #[test]
    fn ascii_proper_noun_detected_by_capitalization() {
        // "Rust로"처럼 한글 조사가 붙어도 영문 이름만 떼어 낸다
        let r = suggest_tags(&input("", "요즘 Rust로 Tauri 앱을 만든다"), &[], 10);
        assert!(r.iter().any(|s| s.tag == "Rust"));
        assert!(r.iter().any(|s| s.tag == "Tauri"));
    }

    #[test]
    fn ascii_dict_name_matches_through_korean_particle() {
        // 사전에 있는 영문 이름도 조사가 붙은 채로 찾아야 한다
        let d = vec![tag("Rust")];
        let r = suggest_tags(&input("", "요즘 Rust를 배운다"), &d, 10);
        let hit = r.iter().find(|s| s.tag == "Rust").unwrap();
        assert!(hit.existing);
    }

    #[test]
    fn ascii_function_words_not_suggested() {
        let r = suggest_tags(&input("", "The quick brown fox. This is it."), &[], 10);
        assert!(!r.iter().any(|s| s.tag == "The" || s.tag == "This"));
    }

    #[test]
    fn book_genre_becomes_category() {
        let mut i = input("", "");
        i.note_type = "book".into();
        i.genre = Some("소설/문학".into());
        let r = suggest_tags(&i, &[], 10);
        let hit = r.iter().find(|s| s.tag == "소설/문학").unwrap();
        assert!(hit.category);
    }

    #[test]
    fn empty_note_yields_empty_result() {
        let r = suggest_tags(&input("", ""), &[tag("독서")], 10);
        assert!(r.is_empty());
    }
}
