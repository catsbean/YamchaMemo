//! 교보문고 경로 (카카오가 못 채우는 소개·분야를 메운다).

use super::*;

/// 교보문고 자동완성 API로 얻은 책 메타 (없으면 빈 문자열)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct KyoboMeta {
    pub intro: String,
    pub genre: String,
    pub cover_url: String,
    pub rating: String,
}

/// 교보는 UA 없는 요청을 500으로 거부한다 — BROWSER_UA를 기본으로 싣는다.
pub(crate) fn kyobo_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default()
}

/// 교보문고에서 ISBN으로 책 메타를 조회한다. 실패해도 빈 값 반환.
/// 자동완성(`autocomplete/shop`) API를 먼저 시도하고, 색인에 없는 책이면(색인이 카탈로그보다
/// 작아 종종 빠진다) 실제 검색 결과 페이지 → 상품 상세 페이지를 거쳐 한 번 더 시도한다.
pub(crate) async fn kyobo_meta(isbn: &str) -> KyoboMeta {
    let isbn = isbn.trim();
    if isbn.is_empty() {
        return KyoboMeta::default();
    }
    let client = kyobo_client();
    let primary = kyobo_meta_via_autocomplete(&client, isbn).await;
    if !primary.intro.is_empty() || !primary.genre.is_empty() || !primary.cover_url.is_empty() {
        return primary;
    }
    kyobo_meta_via_search(&client, isbn).await
}

async fn kyobo_meta_via_autocomplete(client: &reqwest::Client, isbn: &str) -> KyoboMeta {
    let url = format!(
        "https://search.kyobobook.co.kr/srp/api/v1/search/autocomplete/shop?callback=autocompleteShop&keyword={isbn}"
    );
    let text = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => return KyoboMeta::default(),
    };
    parse_kyobo_jsonp(&text)
}

/// 자동완성 색인에 없는 책을 위한 폴백: 검색 결과 페이지에서 상품 코드(dq_ID)를 찾고,
/// 상품 상세 페이지의 og:메타 태그·카테고리로 메타를 채운다. (평점은 이 경로에서 얻지 못함)
async fn kyobo_meta_via_search(client: &reqwest::Client, isbn: &str) -> KyoboMeta {
    let search_url =
        format!("https://search.kyobobook.co.kr/search?keyword={isbn}&target=total");
    let search_html = match client.get(&search_url).send().await {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => return KyoboMeta::default(),
    };
    let Some(dq_id) = extract_kyobo_dq_id(&search_html, isbn) else {
        return KyoboMeta::default();
    };

    // 상품 상세 페이지는 Referer 없이 요청하면 200에 빈 본문을 준다 (검색에서 들어온 것처럼 보여야 함)
    let detail_url = format!("https://product.kyobobook.co.kr/detail/{dq_id}");
    let detail_html = match client.get(&detail_url).header("Referer", &search_url).send().await {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => return KyoboMeta::default(),
    };
    parse_kyobo_detail_html(&detail_html)
}

/// 검색 결과 페이지에 SSR로 박혀 있는 로그용 JSON(`"cmdtcode":"{isbn}"...` 근방)에서
/// 상품 상세 페이지 코드(dq_ID)를 뽑아낸다.
fn extract_kyobo_dq_id(html: &str, isbn: &str) -> Option<String> {
    let marker = format!("\"cmdtcode\":\"{isbn}\"");
    let start = html.find(&marker)?;
    let window_end = (start + 2000).min(html.len());
    let window = &html[start..window_end];
    let key = "\"dq_ID\":\"";
    let key_pos = window.find(key)? + key.len();
    let rest = &window[key_pos..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 상품 상세 페이지 HTML에서 소개·분류·표지를 파싱한다.
/// og:description은 검색엔진용으로 "..."로 잘려 있어, 본문의 `#bookDescription` 섹션에서
/// 전체 소개를 먼저 시도하고 없을 때만 og:description으로 대체한다.
fn parse_kyobo_detail_html(html: &str) -> KyoboMeta {
    let full_intro = extract_kyobo_full_intro(html);
    let intro = if !full_intro.is_empty() {
        full_intro
    } else {
        html_unescape(&meta_content(html, "og:description"))
    };
    KyoboMeta {
        intro,
        genre: extract_kyobo_genre_breadcrumb(html),
        cover_url: html_unescape(&meta_content(html, "og:image")),
        rating: String::new(),
    }
}

/// `id="bookDescription"` 섹션(`</section>`까지)에서 전체 책 소개 텍스트를 뽑는다.
fn extract_kyobo_full_intro(html: &str) -> String {
    let marker = "id=\"bookDescription\"";
    let Some(marker_pos) = html.find(marker) else {
        return String::new();
    };
    // marker는 여는 태그 속성 중간이므로, 그 태그의 '>'까지 건너뛴 뒤부터 내용을 읽는다.
    let after_marker = &html[marker_pos..];
    let Some(tag_end) = after_marker.find('>') else {
        return String::new();
    };
    let content_start = marker_pos + tag_end + 1;
    let rest = &html[content_start..];
    let end = rest.find("</section>").unwrap_or(rest.len());
    strip_html_to_text(&rest[..end])
}

/// 태그 사이에 줄바꿈을 끼워 넣은 뒤 태그를 제거해 대략적인 텍스트로 변환한다.
/// (교보 상세 페이지는 문단마다 형제 `<div>`로 나뉘어 있어, 태그 경계에 줄바꿈이 없으면
/// 문단이 그대로 붙어버린다.)
pub(crate) fn strip_html_to_text(html: &str) -> String {
    let spaced = html
        .replace("><", ">\n<")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n");
    let mut out = String::new();
    let mut in_tag = false;
    for ch in spaced.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let unescaped = html_unescape(&out);
    let lines: Vec<&str> = unescaped
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n\n")
}

/// `<meta property="{property}" content="...">` 의 content 값을 뽑는다.
pub(crate) fn meta_content(html: &str, property: &str) -> String {
    let marker = format!("property=\"{property}\" content=\"");
    let Some(start) = html.find(&marker) else {
        return String::new();
    };
    let rest = &html[start + marker.len()..];
    match rest.find('"') {
        Some(end) => rest[..end].to_string(),
        None => String::new(),
    }
}

/// `.../category/domestic/...">라벨</a>` 형태의 분류 브레드크럼에서 두 번째 항목(대분류,
/// 첫 항목은 항상 "국내도서")을 분야로 사용한다.
fn extract_kyobo_genre_breadcrumb(html: &str) -> String {
    let marker = "store.kyobobook.co.kr/category/domestic";
    let mut labels: Vec<String> = Vec::new();
    let mut pos = 0;
    while let Some(rel) = html[pos..].find(marker) {
        let idx = pos + rel;
        if let Some(gt) = html[idx..].find('>') {
            let after = idx + gt + 1;
            if let Some(lt) = html[after..].find('<') {
                labels.push(html[after..after + lt].trim().to_string());
            }
        }
        pos = idx + marker.len();
        if labels.len() >= 2 {
            break;
        }
    }
    labels.get(1).cloned().unwrap_or_default()
}

/// 교보 JSONP 응답 텍스트에서 책 메타를 파싱한다 (네트워크 없음, 테스트 가능).
pub(crate) fn parse_kyobo_jsonp(text: &str) -> KyoboMeta {
    // JSONP 언랩: `autocompleteShop( {...} );`
    let json_str = text
        .trim()
        .strip_prefix("autocompleteShop(")
        .and_then(|s| s.strip_suffix(");"))
        .unwrap_or("");
    let json: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return KyoboMeta::default(),
    };
    let list = json["data"]["resultDocuments"][0]["TOT_RELATE_HTML_LIST"]
        .as_str()
        .unwrap_or("");
    if list.is_empty() {
        return KyoboMeta::default();
    }
    // `$@` 구분: [1]=분야 [14]=표지 [20]=평점 [21]=책소개
    let parts: Vec<&str> = list.split("$@").collect();
    let get = |i: usize| {
        parts
            .get(i)
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    KyoboMeta {
        genre: get(1),
        cover_url: get(14),
        rating: get(20),
        intro: get(21),
    }
}

/// 교보 자동완성 API로 제목/ISBN 검색 → 다건 결과. 실패 시 빈 벡터.
pub(crate) async fn kyobo_search(query: &str) -> Vec<KyoboHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let client = kyobo_client();
    let text = match client
        .get("https://search.kyobobook.co.kr/srp/api/v1/search/autocomplete/shop")
        .query(&[("callback", "autocompleteShop"), ("keyword", q)])
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => return Vec::new(),
    };
    parse_kyobo_search(&text)
}

/// 교보 자동완성 JSONP 응답에서 여러 책을 파싱한다 (네트워크 없음, 테스트 가능).
/// TOT_RELATE_HTML_LIST 인덱스: [0]=ISBN [2]=제목 [3]=저자 [4]=출판사 [5]=출간연도 [14]=표지.
fn parse_kyobo_search(text: &str) -> Vec<KyoboHit> {
    let json_str = text
        .trim()
        .strip_prefix("autocompleteShop(")
        .and_then(|s| s.strip_suffix(");"))
        .unwrap_or("");
    let json: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let docs = json["data"]["resultDocuments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    docs.iter()
        .filter_map(|d| {
            let list = d["TOT_RELATE_HTML_LIST"].as_str().unwrap_or("");
            if list.is_empty() {
                return None;
            }
            let parts: Vec<&str> = list.split("$@").collect();
            let get = |i: usize| {
                parts
                    .get(i)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default()
            };
            let title = get(2);
            if title.is_empty() {
                return None;
            }
            Some(KyoboHit {
                isbn: get(0),
                title,
                author: get(3),
                publisher: get(4),
                published: get(5),
                cover_url: get(14),
            })
        })
        .collect()
}

/// 교보 히트를 카카오 doc 형태(Value)로 변환 — 하위 보강 로직이 카카오 doc를 기대하므로.
pub(crate) fn kyobo_hit_to_doc(h: &KyoboHit) -> serde_json::Value {
    serde_json::json!({
        "authors": if h.author.is_empty() { Vec::<String>::new() } else { vec![h.author.clone()] },
        "publisher": h.publisher,
        "isbn": h.isbn,
        "thumbnail": h.cover_url,
    })
}

#[cfg(test)]
mod kyobo_tests {
    use super::{
        extract_kyobo_dq_id, extract_kyobo_full_intro, extract_kyobo_genre_breadcrumb,
        kyobo_hit_to_doc, parse_kyobo_detail_html, parse_kyobo_jsonp, parse_kyobo_search,
    };

    /// 실제 검색 결과 페이지에서 관찰된 SSR 로그용 JSON 구조 (축약)
    const SEARCH_HTML_SAMPLE: &str = r#"
        <script id="search_result_script_transfer">
            function getSearchResultItemToLogList() {
                return [{"cmdtcode":"9791186409473","sale_CMDT_SAPR":"20700","cmdt_NAME":"창조 기사 논쟁","dq_ID":"S000001884604"}];
            }
        </script>
    "#;

    /// 실제 상품 상세 페이지에서 관찰된 og:메타 + 분류 브레드크럼 + 책소개 섹션 구조 (축약).
    /// og:description은 "..."로 잘린 SEO 요약이고, `#bookDescription`에 전체 텍스트가 따로 있다
    /// (실제로 확인된 구조: https://product.kyobobook.co.kr/detail/S000001884604).
    const DETAIL_HTML_SAMPLE: &str = r#"
        <meta property="og:title" content="창조 기사 논쟁 - 교보문고" />
        <meta property="og:description" content="다섯 명의 신학자들이 창조 기사를 두고 &amp;대화&amp;한다..." />
        <meta property="og:image" content="https://contents.kyobobook.co.kr/sih/fit-in/400x0/pdt/9791186409473.jpg?t=2974069" />
        <a href="https://store.kyobobook.co.kr/category/domestic">국내도서</a>
        <a href="https://store.kyobobook.co.kr/category/domestic/21">종교</a>
        <a href="https://store.kyobobook.co.kr/category/domestic/2103">기독교(개신교)</a>
        <section id="bookIntro" class="w-full"><h2 class="fz-20 font-bold">책 소개</h2>
        <div id="bookDescription" class="fz-14 flex flex-col gap-3">
        <div class="flex flex-col gap-4 text-gray-800">
        <div class="">다섯 명의 신학자들이 창조 기사를 두고 대화한다. 성서와 과학의 상관관계에 집중하기보다 창조 기사 자체에 집중하면서, 이 기사가 지닌 의미를 탐구한다.</div>
        </div></div></section>
    "#;

    /// og:description만 있고 `#bookDescription` 섹션은 없는 페이지 (폴백 확인용)
    const DETAIL_HTML_NO_FULL_INTRO: &str = r#"
        <meta property="og:description" content="짧은 요약만 있는 경우" />
        <meta property="og:image" content="https://img.example/x.jpg" />
    "#;

    #[test]
    fn extracts_dq_id_from_search_page() {
        let id = extract_kyobo_dq_id(SEARCH_HTML_SAMPLE, "9791186409473");
        assert_eq!(id.as_deref(), Some("S000001884604"));
        assert_eq!(extract_kyobo_dq_id(SEARCH_HTML_SAMPLE, "0000000000000"), None);
    }

    #[test]
    fn extracts_genre_breadcrumb_second_level() {
        assert_eq!(extract_kyobo_genre_breadcrumb(DETAIL_HTML_SAMPLE), "종교");
    }

    #[test]
    fn full_intro_prefers_book_description_section_over_truncated_og_tag() {
        let full = extract_kyobo_full_intro(DETAIL_HTML_SAMPLE);
        assert!(full.contains("성서와 과학의 상관관계"), "got: {full}");
        assert!(!full.ends_with("..."), "여전히 잘려있음: {full}");
    }

    #[test]
    fn parses_detail_page_meta_tags() {
        let m = parse_kyobo_detail_html(DETAIL_HTML_SAMPLE);
        assert_eq!(m.genre, "종교");
        // 잘린 og:description이 아니라 #bookDescription의 전체 텍스트를 써야 한다
        assert!(m.intro.contains("성서와 과학의 상관관계"), "got: {}", m.intro);
        assert!(!m.intro.ends_with("..."));
        assert_eq!(
            m.cover_url,
            "https://contents.kyobobook.co.kr/sih/fit-in/400x0/pdt/9791186409473.jpg?t=2974069"
        );
        assert_eq!(m.rating, "");
    }

    #[test]
    fn falls_back_to_og_description_when_no_book_description_section() {
        let m = parse_kyobo_detail_html(DETAIL_HTML_NO_FULL_INTRO);
        assert_eq!(m.intro, "짧은 요약만 있는 경우");
    }

    #[test]
    fn strip_html_to_text_separates_sibling_paragraphs() {
        let html = r#"<div id="bookDescription"><div class="">첫 문단.</div><div class="">둘째 문단.</div></section>"#;
        let text = extract_kyobo_full_intro(html);
        assert_eq!(text, "첫 문단.\n\n둘째 문단.");
    }

    #[test]
    fn parses_tot_relate_html_list_indices() {
        // 실제 응답과 동일한 구조($@ 구분, 인덱스 0~22)
        let list = "9788937460722$@소설$@구운몽$@김만중$@민음사$@2009$@01$@8000.00$@7200.00$@10.00$@400$@N$@N$@KOR$@https://img.example/cover.jpg$@0$@0$@0$@0$@0$@5.00$@성진은 당나라 고승의 제자다.$@$@0";
        let jsonp = format!(
            "autocompleteShop({{\"data\":{{\"resultDocuments\":[{{\"TOT_RELATE_HTML_LIST\":\"{list}\"}}]}}}});"
        );
        let m = parse_kyobo_jsonp(&jsonp);
        assert_eq!(m.genre, "소설");
        assert_eq!(m.cover_url, "https://img.example/cover.jpg");
        assert_eq!(m.rating, "5.00");
        assert_eq!(m.intro, "성진은 당나라 고승의 제자다.");
    }

    #[test]
    fn empty_on_malformed() {
        assert_eq!(parse_kyobo_jsonp("not jsonp").intro, "");
        assert_eq!(parse_kyobo_jsonp("autocompleteShop({});").intro, "");
    }

    #[test]
    fn parses_multiple_search_hits() {
        // resultDocuments 다건 — 인덱스 [0]ISBN [2]제목 [3]저자 [4]출판사 [5]연도 [14]표지
        let list1 = "9788937460722$@소설$@구운몽$@김만중$@민음사$@2009$@01$@0$@0$@0$@0$@N$@N$@KOR$@https://img.example/a.jpg$@0$@0$@0$@0$@0$@5.00$@소개A$@$@0";
        let list2 = "9791186409473$@종교$@창조 기사 논쟁$@다섯 신학자$@새물결플러스$@2016$@01$@0$@0$@0$@0$@N$@N$@KOR$@https://img.example/b.jpg$@0$@0$@0$@0$@0$@4.50$@소개B$@$@0";
        let jsonp = format!(
            "autocompleteShop({{\"data\":{{\"resultDocuments\":[{{\"TOT_RELATE_HTML_LIST\":\"{list1}\"}},{{\"TOT_RELATE_HTML_LIST\":\"{list2}\"}}]}}}});"
        );
        let hits = parse_kyobo_search(&jsonp);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].isbn, "9788937460722");
        assert_eq!(hits[0].title, "구운몽");
        assert_eq!(hits[0].author, "김만중");
        assert_eq!(hits[0].publisher, "민음사");
        assert_eq!(hits[0].published, "2009");
        assert_eq!(hits[0].cover_url, "https://img.example/a.jpg");
        assert_eq!(hits[1].isbn, "9791186409473");
        assert_eq!(hits[1].title, "창조 기사 논쟁");
    }

    #[test]
    fn search_empty_on_malformed() {
        assert!(parse_kyobo_search("not jsonp").is_empty());
        assert!(parse_kyobo_search("autocompleteShop({});").is_empty());
    }

    #[test]
    fn hit_to_doc_maps_fields_for_downstream() {
        let h = super::KyoboHit {
            isbn: "9788937460722".into(),
            title: "구운몽".into(),
            author: "김만중".into(),
            publisher: "민음사".into(),
            published: "2009".into(),
            cover_url: "https://img.example/a.jpg".into(),
        };
        let d = kyobo_hit_to_doc(&h);
        assert_eq!(super::books::join_authors(&d), "김만중");
        assert_eq!(d["publisher"].as_str().unwrap(), "민음사");
        assert_eq!(d["isbn"].as_str().unwrap(), "9788937460722");
        assert_eq!(d["thumbnail"].as_str().unwrap(), "https://img.example/a.jpg");
    }
}

#[cfg(test)]
mod kyobo_live_probe {
    // 네트워크 의존 — 기본 실행에서 제외. `cargo test kyobo_live_probe -- --ignored --nocapture`로만.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn autocomplete_없는_책도_검색_폴백으로_채워지는지() {
        let m = super::kyobo_meta("9791186409473").await;
        eprintln!("genre={:?} intro_len={} cover={:?}", m.genre, m.intro.len(), m.cover_url);
        assert!(!m.genre.is_empty(), "genre가 비어있음 — 폴백 실패");
        assert!(!m.intro.is_empty(), "intro가 비어있음 — 폴백 실패");
        assert!(!m.cover_url.is_empty(), "cover_url이 비어있음 — 폴백 실패");
        assert!(m.intro.contains("창조") || m.intro.contains("복음"), "intro 내용이 이상함: {}", m.intro);
        assert!(!m.intro.ends_with("..."), "og:description 요약으로 잘린 채 남음: {}", m.intro);
        assert!(m.intro.len() > 200, "너무 짧음(요약만 온 듯): len={} text={}", m.intro.len(), m.intro);
    }
}
