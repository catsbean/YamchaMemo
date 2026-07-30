//! 한글 자모 처리. 퍼지 검색과 초성 검색이 이것 위에 선다.
//!
//! 왜 자모인가 — 한국어 오타는 음절이 아니라 자모 단위로 난다.
//! "클린"과 "클닌"은 음절로 보면 2글자 중 1글자가 다르지만(50%),
//! 자모로 보면 ㅋㅡㄹ ㄹㅣㄴ / ㅋㅡㄹ ㄴㅣㄴ으로 6개 중 5개가 같다(83%).
//! 편집거리를 자모에서 재야 "한 글자 잘못 눌렀다"를 제대로 잡는다.
//!
//! 의존성 없이 코드포인트 연산만 쓴다.

/// 초성 19자 (호환 자모 영역 — 사용자가 키보드로 치는 것과 같은 문자)
const CHO: [char; 19] = [
    'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ',
    'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];
/// 중성 21자
const JUNG: [char; 21] = [
    'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ',
    'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
];
/// 종성 27자 (없음은 0번이라 빈 자리)
const JONG: [char; 27] = [
    'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ',
    'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];

const SYLLABLE_BASE: u32 = 0xAC00;
const SYLLABLE_LAST: u32 = 0xD7A3;

/// 한글 음절 하나를 초·중·종성으로. 음절이 아니면 None.
fn split_syllable(c: char) -> Option<(char, char, Option<char>)> {
    let code = c as u32;
    if !(SYLLABLE_BASE..=SYLLABLE_LAST).contains(&code) {
        return None;
    }
    let i = code - SYLLABLE_BASE;
    let cho = CHO[(i / 588) as usize];
    let jung = JUNG[((i % 588) / 28) as usize];
    let jong_idx = (i % 28) as usize;
    let jong = if jong_idx == 0 {
        None
    } else {
        Some(JONG[jong_idx - 1])
    };
    Some((cho, jung, jong))
}

/// 한글은 자모로 풀고, 나머지는 소문자로 통과시킨다.
/// "클린 코드" → "ㅋㅡㄹㄹㅣㄴ ㅋㅗㄷㅡ"
pub fn to_jamo(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        match split_syllable(c) {
            Some((cho, jung, jong)) => {
                out.push(cho);
                out.push(jung);
                if let Some(j) = jong {
                    out.push(j);
                }
            }
            None => out.extend(c.to_lowercase()),
        }
    }
    out
}

/// 초성만 뽑는다. 한글이 아닌 문자는 그대로 둔다(영문 제목도 초성 검색과 섞이게).
/// 공백은 버린다 — 사용자는 "ㅋㄹㅋㄷ"처럼 붙여 치기 때문이다.
/// "클린 코드" → "ㅋㄹㅋㄷ"
pub fn chosung(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_whitespace() {
            continue;
        }
        match split_syllable(c) {
            Some((cho, _, _)) => out.push(cho),
            None => out.extend(c.to_lowercase()),
        }
    }
    out
}

/// 이 문자가 홀로 쓰인 자음(초성 검색에 쓰이는 것)인지
fn is_lone_consonant(c: char) -> bool {
    CHO.contains(&c) || JONG.contains(&c)
}

/// 쿼리가 초성만으로 되어 있는지 ("ㅋㄹㅋㄷ" → true, "클린" → false).
/// 자음 하나짜리는 너무 광범위해서 초성 검색으로 보지 않는다.
pub fn is_chosung_query(s: &str) -> bool {
    let letters: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
    letters.len() >= 2 && letters.iter().all(|c| is_lone_consonant(*c))
}

/// 자모 기준 유사도 0.0~1.0. 1.0이면 같은 말이다.
///
/// 길이 차가 크면 계산하지 않고 0을 준다 — 짧은 쿼리가 긴 제목에 걸리는 것은
/// 부분 문자열 검색이 할 일이고, 여기서 볼 것은 "거의 같은 말"이다.
pub fn similarity(a: &str, b: &str) -> f32 {
    let x: Vec<char> = to_jamo(a).chars().filter(|c| !c.is_whitespace()).collect();
    let y: Vec<char> = to_jamo(b).chars().filter(|c| !c.is_whitespace()).collect();
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let (long, short) = if x.len() >= y.len() {
        (x.len(), y.len())
    } else {
        (y.len(), x.len())
    };
    // 길이가 1.5배 이상 차이 나면 "거의 같은 말"이 아니다
    if long * 2 > short * 3 {
        return 0.0;
    }
    let dist = levenshtein(&x, &y);
    1.0 - dist as f32 / long as f32
}

/// 쿼리가 대상 안에 "거의 그대로" 들어 있는지 (0.0~1.0).
/// 제목이 쿼리보다 길 때 쓴다 — 제목 "클린 코드 다시 읽기"에서 "클닌 코드"를 찾는 경우.
///
/// 고정 크기 창을 옮기는 방식은 쓰지 않는다. 창을 쿼리 길이로 잡으면 오타로 자모가
/// 하나 늘어난 경우를 못 담고, 넉넉히 잡으면 남는 칸이 삽입 1회로 계산돼 점수가
/// 억울하게 깎인다. 대신 편집거리 DP의 첫 줄을 0으로 두어 **대상의 앞뒤를 공짜로
/// 건너뛰게** 한다 (부분 문자열 근사 매칭).
pub fn best_window_similarity(query: &str, target: &str) -> f32 {
    let q: Vec<char> = to_jamo(query)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let t: Vec<char> = to_jamo(target)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if q.is_empty() || t.is_empty() {
        return 0.0;
    }
    let dist = infix_distance(&q, &t);
    1.0 - dist as f32 / q.len() as f32
}

/// 이 쿼리에 허용할 오타 개수. 자모 6개마다 1개, 최소 1개.
///
/// 실수 임계값(예: 유사도 0.7 이상) 대신 예산으로 판정하는 이유 —
/// 오타 하나의 값이 1/자모수라 쿼리 길이에 따라 임계값의 의미가 달라진다.
/// 3음절 쿼리에서 0.7은 오타 2개를 허용하는데, 자모 6개짜리에 2개면
/// 흔한 자모(ㅏ·ㄹ·ㅔ)가 우연히 겹친 남의 제목까지 들어온다.
pub fn error_budget(query: &str) -> usize {
    let n = to_jamo(query).chars().filter(|c| !c.is_whitespace()).count();
    (n / 6).max(1)
}

/// 대상 안에 쿼리가 오타 예산 안에서 들어 있는지
pub fn is_near(query: &str, target: &str) -> bool {
    let q: Vec<char> = to_jamo(query)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let t: Vec<char> = to_jamo(target)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if q.is_empty() || t.is_empty() {
        return false;
    }
    infix_distance(&q, &t) <= error_budget(query)
}

/// 대상의 어디에든 쿼리가 들어갈 수 있다고 보고 재는 편집거리.
/// 첫 줄을 0으로 채워 대상 앞부분을 공짜로 흘리고, 마지막 줄의 최솟값을 취해
/// 대상 뒷부분도 공짜로 흘린다.
fn infix_distance(q: &[char], t: &[char]) -> usize {
    let mut prev = vec![0usize; t.len() + 1];
    let mut cur = vec![0usize; t.len() + 1];
    for (i, cq) in q.iter().enumerate() {
        cur[0] = i + 1;
        for (j, ct) in t.iter().enumerate() {
            let cost = usize::from(cq != ct);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev.iter().copied().min().unwrap_or(q.len())
}

/// 편집거리 (두 줄만 쓰는 표준 DP)
fn levenshtein(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jamo_decomposition() {
        assert_eq!(to_jamo("클린"), "ㅋㅡㄹㄹㅣㄴ");
        assert_eq!(to_jamo("코드"), "ㅋㅗㄷㅡ");
        // 종성 있는 음절
        assert_eq!(to_jamo("값"), "ㄱㅏㅄ");
        // 공백·영문은 그대로 (영문은 소문자로)
        assert_eq!(to_jamo("Rust 책"), "rust ㅊㅐㄱ");
        // 자모가 아닌 문자는 건드리지 않는다
        assert_eq!(to_jamo("2026-07"), "2026-07");
    }

    #[test]
    fn chosung_extraction() {
        assert_eq!(chosung("클린 코드"), "ㅋㄹㅋㄷ");
        assert_eq!(chosung("함께 자라기"), "ㅎㄲㅈㄹㄱ");
        assert_eq!(chosung("여름 소나기"), "ㅇㅅㅇㅌㄹ");
    }

    #[test]
    fn chosung_query_detection() {
        assert!(is_chosung_query("ㅋㄹㅋㄷ"));
        assert!(is_chosung_query("ㅎㄲ ㅈㄹㄱ"));
        // 음절이 섞이면 초성 검색이 아니다
        assert!(!is_chosung_query("클린"));
        assert!(!is_chosung_query("ㅋ린"));
        // 한 글자는 너무 광범위하다
        assert!(!is_chosung_query("ㅋ"));
        // 모음만은 초성이 될 수 없다
        assert!(!is_chosung_query("ㅏㅑ"));
    }

    #[test]
    fn similarity_catches_one_key_typos() {
        // 자모 하나 틀림 — 음절로 보면 50%지만 자모로는 83%
        assert!(similarity("클린", "클닌") > 0.8);
        assert!(similarity("코드", "코두") > 0.7);
        assert!(similarity("소나기", "소나키") > 0.8);
        // 같은 말
        assert!((similarity("클린 코드", "클린 코드") - 1.0).abs() < 1e-6);
        // 아예 다른 말
        assert!(similarity("클린", "자라기") < 0.4);
        // 길이가 많이 다르면 0
        assert_eq!(similarity("클린", "클린 코드 다시 읽기"), 0.0);
    }

    #[test]
    fn window_similarity_ranks_by_closeness() {
        // 순위용 점수. 오타 하나의 값은 1/자모수다
        // — 4음절(10자모) 쿼리면 0.9, 3음절(6자모)이면 0.83.
        assert!(best_window_similarity("클닌 코드", "클린 코드 다시 읽기") > 0.85);
        assert!(best_window_similarity("소나키", "여름 소나기 이야기") > 0.8);
        // 정확히 들어 있으면 1.0
        assert!(
            (best_window_similarity("소나기", "여름 소나기 이야기") - 1.0).abs() < 1e-6
        );
        // 더 닮은 쪽이 더 높다 (순위가 뒤집히지 않는다)
        assert!(
            best_window_similarity("소나키", "여름 소나기")
                > best_window_similarity("소나키", "함께 자라기")
        );
    }

    #[test]
    fn near_match_uses_error_budget() {
        // 예산: 자모 6개마다 1개
        assert_eq!(error_budget("소나기"), 1); // 6자모
        assert_eq!(error_budget("클린 코드"), 1); // 10자모
        assert_eq!(error_budget("여름 소나기 입주자"), 3); // 20자모

        // 오타 하나는 통과
        assert!(is_near("소나키", "여름 소나기 이야기"));
        assert!(is_near("클닌 코드", "클린 코드 다시 읽기"));
        assert!(is_near("토크나이져", "bigram 토크나이저 교체"));
        // 정확히 들어 있으면 당연히 통과
        assert!(is_near("소나기", "여름 소나기 이야기"));

        // 남의 제목은 통과하지 못한다 — 흔한 자모가 겹쳐도
        assert!(!is_near("소나기", "함께 자라기"));
        assert!(!is_near("자라기", "클린 코드 다시 읽기"));
        assert!(!is_near("클린", "자라기"));
    }
}
