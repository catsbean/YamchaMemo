//! 웹 스크랩과 URL 붙여넣기(제목만 가져오기).

use super::*;

/// 본문이 이 글자 수 미만이면 실패로 본다 (7-0 스파이크 기준)
const SCRAP_MIN_CHARS: usize = 200;

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct ScrapedArticle {
    pub title: String,
    pub body_md: String,
    /// 어느 갈래로 얻었는지 — 화면에 작게 보여 주면 "왜 짧지"를 사용자가 스스로 안다
    pub via: String,
}

/// HTML 문자열에서 본문을 골라 마크다운으로. 갈래①·②가 공유한다.
fn extract_article_html(html: &str, base: &url::Url) -> Option<(String, String)> {
    let mut cursor = std::io::Cursor::new(html.as_bytes());
    let product = readability::extractor::extract(&mut cursor, base).ok()?;
    let body_md = htmd::convert(&product.content).unwrap_or_default();
    let title = product.title.trim().to_string();
    if title.is_empty() && body_md.trim().is_empty() {
        return None;
    }
    Some((title, body_md))
}

/// 갈래① — 그냥 받은 HTML
async fn fetch_article(url: &url::Url) -> Option<(String, String)> {
    let client = quick_http_client();
    let resp = client.get(url.as_str()).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let html = resp.text().await.ok()?;
    extract_article_html(&html, url)
}

/// 갈래② — 숨은 창으로 JS를 실행시켜 렌더링이 끝난 HTML을 받는다 (7-3a에서 검증).
async fn render_article(app: &tauri::AppHandle, url: &url::Url) -> Option<(String, String)> {
    use std::sync::Arc;
    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let label = format!(
        "scrap-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis()
    );
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Arc::new(std::sync::Mutex::new(Some(tx)));
    let tx_for_load = tx.clone();

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .visible(false)
        .inner_size(1280.0, 2000.0) // 일부 사이트는 화면 크기로 렌더 여부를 가른다
        .on_page_load(move |w, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let w2 = w.clone();
            let tx2 = tx_for_load.clone();
            // SPA 하이드레이션 시간을 준다 — Finished는 초기 HTML 로드 시점이지
            // 클라이언트 JS가 본문을 다 그린 시점이 아니다 (7-0에서 Threads로 확인한 문제)
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                let _ = w2.eval_with_callback(
                    "JSON.stringify(document.documentElement.outerHTML)",
                    move |result| {
                        if let Some(sender) = tx2.lock().unwrap().take() {
                            let _ = sender.send(result);
                        }
                    },
                );
            });
        })
        .build()
        .ok()?;

    let outcome = tokio::time::timeout(Duration::from_secs(15), rx).await;
    // **어떤 경로로 나가든 숨은 창을 닫는다.** 예전에는 `?`로 조기 반환하는 바람에
    // 타임아웃이나 채널 실패 때 close를 못 지나쳤다. 보이지 않는 창이 그대로 남아
    // 원격 페이지의 JS를 계속 돌렸고, 스크랩이 실패할 때마다 하나씩 쌓였다.
    let _ = window.close();
    let result = outcome.ok()?.ok()?;
    let html = unwrap_eval_json(&result);
    extract_article_html(&html, url)
}

/// `eval_with_callback`이 문자열을 몇 겹으로 감싸 주는지가 페이지마다 다르게 보였다
/// (실측 — Threads 글 하나는 한 겹, 다른 하나는 두 겹). JSON으로 파싱했는데 그 결과가
/// 또 문자열이면 한 번 더 푼다. 몇 겹이든 안전하게 알맹이까지 내려간다.
fn unwrap_eval_json(raw: &str) -> String {
    let mut cur = raw.to_string();
    for _ in 0..3 {
        match serde_json::from_str::<serde_json::Value>(&cur) {
            Ok(serde_json::Value::String(inner)) => cur = inner,
            _ => break,
        }
    }
    cur
}

/// 스크랩 팝업이 부르는 커맨드. 실패해도 에러로 올리지 않는다(`None`) —
/// 화면은 그 자리에 "브라우저에서 복사해 붙여넣기" 칸을 보여 준다.
#[tauri::command]
#[specta::specta]
pub async fn scrape_article(app: tauri::AppHandle, url: String) -> Option<ScrapedArticle> {
    let parsed = url::Url::parse(&url).ok()?;

    let html_result = fetch_article(&parsed).await;
    let html_len = html_result
        .as_ref()
        .map(|(_, b)| b.trim().chars().count())
        .unwrap_or(0);

    if html_len >= SCRAP_MIN_CHARS {
        let (title, body_md) = html_result.unwrap();
        return Some(ScrapedArticle { title, body_md, via: "html".into() });
    }

    // 짧거나 실패 — 갈래②를 시도하고, 그게 기준을 넘고 ①보다 길면 그걸 쓴다.
    // (기준 미달이면 실패로 친다 — 안 그러면 ①이 아예 실패해 html_len이 0일 때,
    //  "서버를 찾을 수 없습니다" 같은 브라우저 자체 오류 페이지까지 성공으로 둔갑한다.)
    if let Some((title, body_md)) = render_article(&app, &parsed).await {
        let render_len = body_md.trim().chars().count();
        if render_len >= SCRAP_MIN_CHARS && render_len > html_len {
            return Some(ScrapedArticle { title, body_md, via: "render".into() });
        }
    }
    // ②도 안 되거나 안 나았으면, ①이 짧게라도 얻은 게 있으면 그거라도 준다
    // (사용자가 편집·붙여넣기로 보완할 수 있게 — 아예 없는 것보다 낫다)
    html_result.map(|(title, body_md)| ScrapedArticle { title, body_md, via: "html".into() })
}

/// 저장 결과 — `type_id`는 실제로 쓰인 분류다. 요청한 분류가 없어졌거나
/// (커스텀 분류 삭제 등) 책·데일리처럼 쓸 수 없는 분류면 자유노트로 대신
/// 저장하고, 호출부가 이 값으로 설정을 되돌릴 수 있게 한다.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct ScrapSaved {
    pub rel: String,
    pub type_id: String,
}

/// 요청한 분류로 스크랩을 저장해도 되는지 정한다. 비어 있거나, 책·데일리처럼
/// 파일명·연동 규칙이 확고한 분류거나, vault에 더 이상 없는 분류(커스텀 분류
/// 삭제 등)면 자유노트로 대신 쓴다.
fn resolve_scrap_type<'a>(vault: &Vault, requested: &'a str) -> &'a str {
    let requested = requested.trim();
    let locked = matches!(
        Builtin::from_id(requested),
        Some(Builtin::Daily) | Some(Builtin::Book)
    );
    if requested.is_empty() || locked || vault.def_by_id(requested).is_none() {
        Builtin::Free.id()
    } else {
        requested
    }
}

/// 스크랩 저장 — `type_id` 분류로 만들고 frontmatter에 `source`(원본 URL)를 심는다.
/// `create_note`가 만드는 기본 템플릿 본문을 실제 스크랩 본문으로 갈아끼운다 —
/// frontmatter는 create_note가 정규화해 둔 것을 그대로 유지한다.
#[tauri::command]
#[specta::specta]
pub fn save_scrap(
    state: State<'_, AppState>,
    title: String,
    url: String,
    body: String,
    type_id: String,
) -> Result<ScrapSaved, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("제목이 비어 있습니다".into());
    }
    with_ctx_write(&state, |c| {
        let effective = resolve_scrap_type(&c.vault, &type_id).to_string();
        let rel = c
            .vault
            .create_note(&effective, title, serde_json::json!({ "source": url }))?;
        let note = c.vault.read_note(&rel)?;
        c.vault.save_note(&rel, note.frontmatter, &body)?;
        refresh_note(c, &rel)?;
        Ok(ScrapSaved { rel, type_id: effective })
    })
}

/// `<title>...</title>`를 뽑아 엔티티를 풀고 공백을 정리한다. 없으면 None.
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let open_end = html[start..].find('>')? + start + 1;
    let close = html[open_end..].to_lowercase().find("</title>")? + open_end;
    let raw = html_unescape(&html[open_end..close]);
    let cleaned: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// URL에서 호스트의 첫 라벨을 뽑는다 (`www.threads.com` → `threads`).
fn host_label(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1)?;
    let host = after_scheme.split(['/', '?', '#']).next()?;
    let host = host.split('@').next_back()?; // user:pass@host 형태 방어
    let host = host.split(':').next()?; // 포트 제거
    let host = host.strip_prefix("www.").unwrap_or(host);
    host.split('.').next().map(|s| s.to_lowercase())
}

/// 제목이 사이트 이름뿐이라 쓸모없는지 — SPA 껍데기가 `<title>앱이름</title>`만
/// 주는 흔한 패턴을 잡는다 (예: threads.com → "Threads"). 소문자·공백 제거한 값이
/// 호스트 첫 라벨과 같으면 의미없다고 본다.
fn is_meaningless_title(title: &str, url: &str) -> bool {
    let Some(label) = host_label(url) else {
        return false;
    };
    let normalized: String = title
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect();
    normalized == label
}

/// URL 붙여넣기용 — 페이지 제목만 가져온다. 실패·의미없는 제목이면 `Ok(None)`.
/// (편집기가 "실패하면 원본 URL을 그대로 둔다"로 처리하므로 여기서는 실패를 에러로
/// 올리지 않는다 — 에러 문구를 화면에 보여줄 자리가 없다)
#[tauri::command]
#[specta::specta]
pub async fn fetch_page_title(url: String) -> Option<String> {
    let client = quick_http_client();
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let html = resp.text().await.ok()?;
    let title = extract_title(&html)?;
    if is_meaningless_title(&title, &url) {
        return None;
    }
    Some(title)
}

#[cfg(test)]
mod save_scrap_tests {
    use super::resolve_scrap_type;
    use yamcha_core::Vault;

    #[test]
    fn falls_back_to_free_when_type_missing_locked_or_gone() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        v.add_custom_type("회사", "company", vec![], "").unwrap();

        assert_eq!(resolve_scrap_type(&v, "company"), "company");
        assert_eq!(resolve_scrap_type(&v, ""), "free");
        assert_eq!(resolve_scrap_type(&v, "book"), "free");
        assert_eq!(resolve_scrap_type(&v, "daily"), "free");
        assert_eq!(resolve_scrap_type(&v, "없어진분류"), "free");

        v.remove_custom_type("company").unwrap();
        assert_eq!(resolve_scrap_type(&v, "company"), "free");
    }
}

#[cfg(test)]
mod scrap_tests {
    use super::*;

    fn html_doc(title: &str, body: &str) -> String {
        format!(
            r#"<!doctype html><html><head><title>{title}</title></head>
            <body><article><h1>{title}</h1>{body}</article></body></html>"#
        )
    }

    #[test]
    fn extracts_title_and_body_as_markdown() {
        let base = url::Url::parse("https://example.com/post").unwrap();
        let html = html_doc(
            "글 제목",
            "<p>첫 문단입니다.</p><p>둘째 문단, <a href=\"/x\">링크</a> 포함.</p>",
        );
        let (title, body_md) = extract_article_html(&html, &base).unwrap();
        assert!(title.contains("글 제목"));
        assert!(body_md.contains("첫 문단"));
        assert!(body_md.contains("둘째 문단"));
        // htmd가 링크를 마크다운으로 바꾼다 — 절대경로로 풀려야 한다(base URL 사용)
        assert!(body_md.contains("example.com/x") || body_md.contains("](/x)"));
    }

    #[test]
    fn threshold_matches_7_0_spike() {
        // 실측(7-0)에서 정한 기준 — 200자 미만은 실패로 본다
        assert_eq!(SCRAP_MIN_CHARS, 200);
    }

    #[test]
    fn unwrap_eval_json_handles_zero_one_two_layers() {
        // 0겹 — JSON이 아닌 그냥 문자열은 그대로 돌아온다
        assert_eq!(unwrap_eval_json("plain"), "plain");
        // 1겹
        let once = serde_json::to_string("한 겹").unwrap();
        assert_eq!(unwrap_eval_json(&once), "한 겹");
        // 2겹 — eval_with_callback이 이미 JSON 문자열인 값을 또 감싼 실측 케이스
        let twice = serde_json::to_string(&once).unwrap();
        assert_eq!(unwrap_eval_json(&twice), "한 겹");
    }

    #[test]
    fn empty_html_yields_none() {
        let base = url::Url::parse("https://example.com/").unwrap();
        assert!(extract_article_html("", &base).is_none());
        assert!(extract_article_html("<html></html>", &base).is_none());
    }
}

#[cfg(test)]
mod url_paste_tests {
    use super::*;

    #[test]
    fn extracts_title_and_unescapes_entities() {
        let html = r#"<html><head><title>클린 코드 &amp; 리팩터링</title></head></html>"#;
        assert_eq!(extract_title(html).as_deref(), Some("클린 코드 & 리팩터링"));
    }

    #[test]
    fn title_can_have_attributes_and_whitespace() {
        let html = "<title lang=\"ko\">\n  줄바꿈이   섞인   제목\n</title>";
        assert_eq!(extract_title(html).as_deref(), Some("줄바꿈이 섞인 제목"));
    }

    #[test]
    fn no_title_tag_returns_none() {
        assert_eq!(extract_title("<html><body>본문만</body></html>"), None);
        assert_eq!(extract_title("<title></title>"), None);
        assert_eq!(extract_title("<title>   </title>"), None);
    }

    #[test]
    fn host_label_strips_www_port_and_path() {
        assert_eq!(host_label("https://www.threads.com/share/abc").as_deref(), Some("threads"));
        assert_eq!(host_label("https://d2.naver.com:443/home").as_deref(), Some("d2"));
        assert_eq!(host_label("https://ko.wikipedia.org/wiki/x").as_deref(), Some("ko"));
    }

    /// threads.com이 실제로 주는 값 — 7-0 스파이크에서 실측한 것과 같다
    #[test]
    fn meaningless_title_matches_bare_hostname() {
        assert!(is_meaningless_title("Threads", "https://www.threads.com/share/x"));
        assert!(is_meaningless_title("  threads  ", "https://threads.com/x"));
        assert!(!is_meaningless_title(
            "왕숙 아테라 공고문 - 자세히 보기",
            "https://www.threads.com/share/x"
        ));
        assert!(!is_meaningless_title(
            "클린 코드",
            "https://ko.wikipedia.org/wiki/클린_코드"
        ));
    }

    #[tokio::test]
    async fn fetch_page_title_returns_none_on_bad_url() {
        assert_eq!(fetch_page_title("not-a-url".into()).await, None);
        assert_eq!(
            fetch_page_title("https://127.0.0.1:1".into()).await,
            None,
            "연결이 안 되는 주소는 조용히 None"
        );
    }
}

#[cfg(test)]
mod url_paste_live_probe {
    // 네트워크 의존 — 기본 실행에서 제외.
    // cargo test -p yamcha-app --lib url_paste_live_probe -- --ignored --nocapture
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn 실제_위키백과_제목을_뽑아내는지() {
        let url = "https://ko.wikipedia.org/wiki/마크다운";
        let client = super::quick_http_client();
        let resp = client.get(url).send().await.unwrap();
        eprintln!("status={}", resp.status());
        let html = resp.text().await.unwrap();
        eprintln!("html bytes={}", html.len());
        let lower_bytes = html.to_lowercase().len();
        eprintln!("lowercased bytes={lower_bytes}");
        let title = super::extract_title(&html);
        eprintln!("extract_title={title:?}");
        assert!(title.is_some(), "제목을 못 뽑았다");
    }
}
