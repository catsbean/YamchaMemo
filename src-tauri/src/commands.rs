use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use tauri::{Emitter, Manager, State};
use yamcha_core::schema::{builtin_defs, EntryKind};
use yamcha_core::{
    Backlink, FieldDef, FileIndexStatus, Indexer, NoteContent, NoteRef, NoteSummary, SearchEngine,
    SearchHit,
    TagCount,
    TypeDef, Vault,
};

/// 빌드 시 주입된 카카오 키 (build.rs가 환경변수 또는 src-tauri/.env에서 읽어 넘긴다).
/// 소스에는 키를 두지 않는다 — 주입이 없으면 빈 문자열이고, 앱은 교보 폴백으로 동작한다.
fn default_kakao_key() -> &'static str {
    option_env!("YAMCHA_KAKAO_KEY").unwrap_or("")
}

/// 사용자 키가 비어 있으면 빌드 주입 키를 쓴다. 둘 다 없으면 빈 문자열.
fn effective_key(user: &str) -> &str {
    if user.trim().is_empty() {
        default_kakao_key()
    } else {
        user.trim()
    }
}

/// 브라우저처럼 보이는 UA. UA가 없으면 교보는 500, 위키백과는 403으로 거부한다 —
/// 두 곳 다 겪어서 확인했다.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// 타임아웃을 건 일반 HTTP 클라이언트 (15초 전체 / 5초 연결).
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default()
}

/// reqwest 오류를 한국어 완결문으로 변환한다 (영어 원문 노출 방지).
fn net_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "요청 시간이 초과됐습니다. 잠시 후 다시 시도해주세요.".into()
    } else if e.is_connect() {
        "인터넷 연결을 확인해주세요.".into()
    } else {
        "네트워크 오류가 발생했습니다.".into()
    }
}

/// 일괄 자동채우기 취소 플래그 (enrich_books/enrich_preview 시작 시 reset, cancel_enrich가 set)
static ENRICH_CANCEL: AtomicBool = AtomicBool::new(false);

// ---------- URL 붙여넣기: 제목만 가져오기 ----------

// ---------- 웹 스크랩 (7-3) ----------
//
// 갈래①(원본 HTML을 그냥 받는다)과 갈래②(숨은 창으로 JS를 실행시켜 받는다)가
// 똑같은 추출 파이프라인(readability + htmd)을 공유한다 — 둘 다 결국 "HTML 문자열"을
// 만들어 주는 것뿐이고, 그 HTML에서 본문을 골라내는 일은 렌더링 방식과 무관하다.
// 7-0에서 실측한 기준을 그대로 쓴다: 본문이 200자 미만이면 실패로 보고 갈래②를 시도한다.

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

/// 스크랩 저장 — `info` 타입 노트로 만든다. 새 분류를 만들지 않는다:
/// Info 타입에 이미 `source` 필드가 있다(0.3 버전부터, 이 기능을 염두에 두고
/// 설계돼 있었다). `create_note`가 만드는 기본 템플릿 본문을 실제 스크랩 본문으로
/// 갈아끼운다 — frontmatter는 create_note가 정규화해 둔 것을 그대로 유지한다.
#[tauri::command]
#[specta::specta]
pub fn save_scrap(
    state: State<'_, AppState>,
    title: String,
    url: String,
    body: String,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("제목이 비어 있습니다".into());
    }
    with_ctx_write(&state, |c| {
        let rel = c.vault.create_note("info", title, serde_json::json!({ "source": url }))?;
        let note = c.vault.read_note(&rel)?;
        c.vault.save_note(&rel, note.frontmatter, &body)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 붙여넣기용 짧은 타임아웃 클라이언트. `http_client()`(15초)는 붙여넣는 순간에는 느리다 —
/// 실패해도 원본 URL이 그대로 남으므로 길게 기다릴 이유가 없다.
fn quick_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default()
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

/// 카카오 isbn 필드("10자리 13자리")에서 13자리(마지막 토큰)를 뽑는다.
fn isbn13(raw: &str) -> String {
    raw.split_whitespace().last().unwrap_or(raw).to_string()
}

/// 카카오 doc의 authors 배열을 ", "로 합친다.
fn join_authors(doc: &serde_json::Value) -> String {
    doc["authors"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

/// vault + 인덱스 + 검색엔진 묶음
pub struct Ctx {
    pub vault: Vault,
    pub indexer: Indexer,
    pub search: SearchEngine,
}

pub struct AppState(pub Mutex<Option<Ctx>>);

/// 파일 감시 핸들 (set_vault 시 교체)
pub struct WatcherState(pub Mutex<Option<crate::watcher::WatcherHandle>>);

fn with_ctx<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Ctx) -> Result<T, yamcha_core::CoreError>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let ctx = guard.as_mut().ok_or("vault가 설정되지 않았습니다")?;
    f(ctx).map_err(|e| e.to_string())
}

/// 쓰기 커맨드용: 감시 억제 마킹 후 실행
fn with_ctx_write<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Ctx) -> Result<T, yamcha_core::CoreError>,
) -> Result<T, String> {
    crate::watcher::mark_self_write();
    let r = with_ctx(state, f);
    crate::watcher::mark_self_write();
    r
}

/// 노트 변경 후 인덱스 갱신 (파일이 없으면 인덱스에서 제거)
pub(crate) fn refresh_note(ctx: &mut Ctx, rel: &str) -> Result<(), yamcha_core::CoreError> {
    crate::watcher::mark_self_write();
    match ctx.vault.parse_full(rel) {
        Ok(parsed) => {
            ctx.indexer.upsert(&parsed)?;
            ctx.search.upsert(&parsed)?;
        }
        Err(_) => {
            ctx.indexer.remove(rel)?;
            ctx.search.remove(rel)?;
        }
    }
    ctx.search.commit()
}

#[tauri::command]
#[specta::specta]
pub fn core_version() -> String {
    yamcha_core::version()
}

/// 경로를 폴더 이름으로 쓸 수 있는 짧은 값으로 (사람이 알아볼 힌트 + 충돌 없는 지문).
///
/// FNV-1a를 직접 쓴다. `DefaultHasher`는 릴리스마다 결과가 달라도 된다고 문서에
/// 못박혀 있어서, 앱을 새로 빌드할 때마다 색인 폴더가 갈릴 수 있다.
fn vault_key(vault_root: &Path) -> String {
    let raw = vault_root.to_string_lossy();
    // Windows는 대소문자를 가리지 않으므로 같은 폴더가 두 벌로 갈리지 않게 맞춘다
    let normalized = if cfg!(windows) {
        raw.to_lowercase()
    } else {
        raw.to_string()
    };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in normalized.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // 힌트도 소문자로 맞춘다 — 지문이 같은데 힌트만 달라 폴더가 갈리면
    // 같은 vault를 열 때마다 색인을 처음부터 다시 만든다
    let hint: String = vault_root
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .take(24)
        .collect();
    if hint.is_empty() {
        format!("vault-{hash:016x}")
    } else {
        format!("{hint}-{hash:016x}")
    }
}

/// 색인을 둘 곳 — **vault 밖**이다.
///
/// vault는 클라우드 동기화 폴더에 두라고 권하는 자리다(README). 그런데 색인은
/// SQLite와 tantivy로, 동기화 에이전트가 실시간으로 건드리면 깨지기 쉬운 파일이다.
/// 게다가 파일에서 언제든 다시 만들 수 있는 파생 데이터라 기기 사이로 옮길 이유가 없다.
/// vault마다 폴더를 나눠 여러 vault를 오가도 섞이지 않게 한다.
fn index_dir_for(app: &tauri::AppHandle, vault_root: &Path) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 폴더를 찾지 못했습니다: {e}"))?;
    Ok(base.join("index").join(vault_key(vault_root)))
}

/// 예전 버전이 vault 안에 만들어 둔 색인을 치운다.
///
/// 순수 파생 데이터라 지워도 바로 뒤 `reindex_all`이 새 자리에 다시 만든다. 그냥 두면
/// 클라우드 동기화가 계속 그 파일들을 실어 나른다. **휴지통과 히스토리는 사용자 데이터라
/// 절대 건드리지 않는다** — 지우는 대상을 index.db 계열과 search 폴더로 못박는다.
fn remove_legacy_index(vault_root: &Path) {
    let dot = vault_root.join(".yamcha");
    let _ = std::fs::remove_dir_all(dot.join("search"));
    // SQLite는 -wal·-shm 형제 파일을 남긴다
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(dot.join(format!("index.db{suffix}")));
    }
}

/// vault 폴더를 열고 (없으면 폴더 구조 생성) 전체 재색인
#[tauri::command]
#[specta::specta]
pub fn set_vault(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    // 로컬 이미지(표지 등)를 asset:// 프로토콜로 표시할 수 있게 vault를 스코프에 허용
    let _ = app
        .asset_protocol_scope()
        .allow_directory(std::path::Path::new(&path), true);
    // 락을 먼저 잡아 동시 호출을 직렬화하고, 기존 Ctx를 놓아
    // tantivy IndexWriter 잠금(LockBusy)을 해제한 뒤 새로 연다.
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.vault.root() == std::path::Path::new(&path) {
            return Ok(()); // 같은 vault 중복 호출 무시
        }
    }
    *guard = None;
    let vault = Vault::open(&path).map_err(|e| e.to_string())?;
    let index_dir = index_dir_for(&app, vault.root())?;
    std::fs::create_dir_all(&index_dir).map_err(|e| e.to_string())?;
    let mut indexer = Indexer::open(&index_dir.join("index.db")).map_err(|e| e.to_string())?;
    let mut search = SearchEngine::open(&index_dir.join("search")).map_err(|e| e.to_string())?;
    remove_legacy_index(vault.root());
    yamcha_core::reindex_all(&vault, &mut indexer, &mut search).map_err(|e| e.to_string())?;
    let root = vault.root().to_path_buf();
    *guard = Some(Ctx {
        vault,
        indexer,
        search,
    });
    drop(guard);
    crate::watcher::mark_self_write();
    // 파일 감시 시작 (기존 감시는 교체)
    let watcher_state = app.state::<WatcherState>();
    let handle = crate::watcher::start(app.clone(), root);
    if let Ok(mut w) = watcher_state.0.lock() {
        *w = handle;
    }
    Ok(())
}

/// 첫 실행 화면에 제안할 저장 위치 (클라우드 동기화 폴더 등)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct StorageDir {
    pub label: String,
    pub path: String,
}

/// 존재하는 클라우드 동기화 폴더를 감지해 제안 목록으로 반환한다.
/// 마지막 항목은 항상 문서 폴더. 없는 경로는 건너뛴다.
#[tauri::command]
#[specta::specta]
pub fn detect_storage_dirs() -> Vec<StorageDir> {
    let mut out: Vec<StorageDir> = Vec::new();
    let mut push_if_exists = |label: &str, path: std::path::PathBuf| {
        if path.is_dir() && !out.iter().any(|d| d.path == path.to_string_lossy()) {
            out.push(StorageDir {
                label: label.to_string(),
                path: path.to_string_lossy().to_string(),
            });
        }
    };

    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        if let Ok(od) = std::env::var("OneDrive") {
            push_if_exists("☁️ OneDrive — 자동 백업(권장)", std::path::PathBuf::from(od));
        }
        if !home.is_empty() {
            push_if_exists(
                "☁️ OneDrive — 자동 백업(권장)",
                std::path::Path::new(&home).join("OneDrive"),
            );
            push_if_exists(
                "☁️ iCloud Drive",
                std::path::Path::new(&home).join("iCloudDrive"),
            );
            push_if_exists(
                "☁️ Google Drive",
                std::path::Path::new(&home).join("Google Drive"),
            );
            push_if_exists("☁️ Dropbox", std::path::Path::new(&home).join("Dropbox"));
        }
        push_if_exists("☁️ Google Drive", std::path::PathBuf::from("G:\\My Drive"));
        if !home.is_empty() {
            push_if_exists(
                "📁 문서 폴더",
                std::path::Path::new(&home).join("Documents"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            let h = std::path::Path::new(&home);
            push_if_exists("☁️ iCloud Drive — 자동 백업(권장)", h.join("Library/Mobile Documents/com~apple~CloudDocs"));
            // Google Drive: ~/Library/CloudStorage/GoogleDrive-* (글롭)
            if let Ok(entries) = std::fs::read_dir(h.join("Library/CloudStorage")) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with("GoogleDrive-") {
                        push_if_exists("☁️ Google Drive", e.path());
                    }
                }
            }
            push_if_exists("☁️ Dropbox", h.join("Dropbox"));
            push_if_exists("📁 문서 폴더", h.join("Documents"));
        }
    }

    out
}

#[tauri::command]
#[specta::specta]
pub fn get_vault_path(state: State<'_, AppState>) -> Option<String> {
    state
        .0
        .lock()
        .ok()?
        .as_ref()
        .map(|c| c.vault.root().to_string_lossy().to_string())
}

/// 타입 정의 목록 (내장 + 사용자 정의). vault가 없으면 내장만.
#[tauri::command]
#[specta::specta]
pub fn get_schemas(state: State<'_, AppState>) -> Vec<TypeDef> {
    state
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.vault.types().to_vec()))
        .unwrap_or_else(builtin_defs)
}

/// 사용자 정의 분류 추가
#[tauri::command]
#[specta::specta]
pub fn add_custom_type(
    state: State<'_, AppState>,
    label: String,
    fields: Vec<FieldDef>,
    template: String,
) -> Result<TypeDef, String> {
    with_ctx_write(&state, |c| c.vault.add_custom_type(&label, fields, &template))
}

/// 사용자 정의 분류의 본문 템플릿 수정 (생성 후에도 언제든 변경 가능)
#[tauri::command]
#[specta::specta]
pub fn update_custom_type_template(
    state: State<'_, AppState>,
    id: String,
    template: String,
) -> Result<TypeDef, String> {
    with_ctx_write(&state, |c| {
        c.vault.update_custom_type_template(&id, &template)
    })
}

/// 사용자 정의 분류 제거 — 내부 노트는 자유노트로 이동
#[tauri::command]
#[specta::specta]
pub fn remove_custom_type(state: State<'_, AppState>, id: String) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        c.vault.remove_custom_type(&id)?;
        yamcha_core::reindex_all(&c.vault, &mut c.indexer, &mut c.search)?;
        Ok(())
    })
}

/// 노트 제목 변경 (파일명 + 링크 연쇄 수정, 책이면 독서기록도 연동) → 새 rel 경로
#[tauri::command]
#[specta::specta]
pub fn rename_note(
    state: State<'_, AppState>,
    rel_path: String,
    new_title: String,
) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        let new_rel = c.vault.rename_note(&rel_path, &new_title)?;
        // 경로·링크가 광범위하게 바뀌므로 전체 재색인
        yamcha_core::reindex_all(&c.vault, &mut c.indexer, &mut c.search)?;
        Ok(new_rel)
    })
}

/// frontmatter 일부 필드만 갱신 (목록 뷰 인라인 편집용)
#[tauri::command]
#[specta::specta]
pub fn update_frontmatter(
    state: State<'_, AppState>,
    rel_path: String,
    patch: serde_json::Value,
) -> Result<(), String> {
    with_ctx(&state, |c| {
        c.vault.update_frontmatter(&rel_path, patch)?;
        refresh_note(c, &rel_path)
    })
}

/// 이미지 파일을 책 표지로 첨부하고 frontmatter cover에 기록 → 표지 rel 경로 반환
#[tauri::command]
#[specta::specta]
pub fn attach_cover(
    state: State<'_, AppState>,
    book_rel_path: String,
    src_path: String,
) -> Result<String, String> {
    with_ctx(&state, |c| {
        let note = c.vault.read_note(&book_rel_path)?;
        let title = note
            .frontmatter
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .unwrap_or_else(|| {
                std::path::Path::new(&book_rel_path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        let cover_rel = c
            .vault
            .attach_cover(&title, std::path::Path::new(&src_path))?;
        c.vault
            .update_frontmatter(&book_rel_path, serde_json::json!({ "cover": cover_rel }))?;
        refresh_note(c, &book_rel_path)?;
        Ok(cover_rel)
    })
}

/// 외부 파일을 일반 첨부로 복사 → rel 경로 반환
#[tauri::command]
#[specta::specta]
pub fn import_attachment(state: State<'_, AppState>, src_path: String) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        c.vault.import_attachment(std::path::Path::new(&src_path))
    })
}

/// 클립보드에서 붙여넣은 이미지 저장 (base64) → rel 경로 반환
#[tauri::command]
#[specta::specta]
pub fn save_pasted_image(
    state: State<'_, AppState>,
    data_base64: String,
    ext: String,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("이미지 디코드 실패: {e}"))?;
    with_ctx_write(&state, |c| c.vault.save_pasted_image(&bytes, &ext))
}

/// 클립보드/붙여넣기 이미지를 책 표지로 저장하고 frontmatter cover 갱신 → 표지 rel 경로
#[tauri::command]
#[specta::specta]
pub fn attach_cover_pasted(
    state: State<'_, AppState>,
    book_rel_path: String,
    data_base64: String,
    ext: String,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("이미지 디코드 실패: {e}"))?;
    with_ctx_write(&state, |c| {
        let note = c.vault.read_note(&book_rel_path)?;
        let title = note
            .frontmatter
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .unwrap_or_else(|| {
                std::path::Path::new(&book_rel_path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        let cover_rel = c.vault.attach_cover_bytes(&title, &bytes, &ext)?;
        c.vault
            .update_frontmatter(&book_rel_path, serde_json::json!({ "cover": cover_rel }))?;
        refresh_note(c, &book_rel_path)?;
        Ok(cover_rel)
    })
}

/// 미러 폴더들로 동기화 (vault 우선, 미러가 더 새로우면 충돌 보고)
#[tauri::command]
#[specta::specta]
pub fn mirror_sync(
    state: State<'_, AppState>,
    targets: Vec<String>,
) -> Result<Vec<yamcha_core::mirror::MirrorReport>, String> {
    // vault 전체를 훑는 느린 IO다. 필요한 정보만 뽑고 **잠금을 놓은 뒤** 복사한다 —
    // 쥔 채로 돌면 그동안 저장·검색을 포함한 모든 커맨드가 뒤에 줄을 선다.
    let source = with_ctx(&state, |c| {
        Ok(yamcha_core::mirror::MirrorSource::of(&c.vault))
    })?;

    let mut reports = Vec::new();
    for t in &targets {
        reports.push(
            yamcha_core::mirror::sync_to(&source, std::path::Path::new(t))
                .map_err(|e| e.to_string())?,
        );
    }
    Ok(reports)
}

/// 낡은 `_index.md`를 지금 다시 만든다 → 다시 만든 타입 수.
///
/// 저장할 때마다 만들면 vault 전체를 다시 읽게 되어(실측 2,000편에 345ms) 자동저장이
/// 도는 내내 앱이 멈춘다. 그래서 저장은 표시만 하고, 손을 멈췄을 때 프론트가 이걸 부른다.
#[tauri::command]
#[specta::specta]
pub fn flush_index_files(state: State<'_, AppState>) -> Result<u32, String> {
    with_ctx_write(&state, |c| {
        c.vault.flush_index_files().map(|n| n as u32)
    })
}

/// 미러 충돌 해결: pull=true면 미러 내용을 vault로 가져오고 재색인
#[tauri::command]
#[specta::specta]
pub fn mirror_resolve(
    state: State<'_, AppState>,
    target: String,
    rel_path: String,
    pull: bool,
) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        yamcha_core::mirror::resolve(&c.vault, std::path::Path::new(&target), &rel_path, pull)?;
        if pull && rel_path.ends_with(".md") {
            refresh_note(c, &rel_path)?;
        }
        Ok(())
    })
}

/// 카카오 책 검색 결과 한 건
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct BookSearchHit {
    pub title: String,
    pub authors: String,
    pub publisher: String,
    pub isbn: String,
    pub thumbnail_url: String,
    pub published: String,
}

/// 교보 자동완성 검색 결과 한 건 (카카오 실패 시 폴백용)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct KyoboHit {
    pub isbn: String,
    pub title: String,
    pub author: String,
    pub publisher: String,
    pub published: String,
    pub cover_url: String,
}

/// 카카오 책 검색 API로 도서 검색. 키가 비면 내장 키를 쓰고,
/// 카카오가 실패하거나 결과가 없으면 교보 자동완성으로 폴백한다.
#[tauri::command]
#[specta::specta]
pub async fn search_books(query: String, api_key: String) -> Result<Vec<BookSearchHit>, String> {
    let key = effective_key(&api_key);
    // 1) 카카오 시도
    let kakao = kakao_docs(&query, key).await;
    if let Ok(docs) = &kakao {
        if !docs.is_empty() {
            let hits = docs
                .iter()
                .map(|d| BookSearchHit {
                    title: d["title"].as_str().unwrap_or("").to_string(),
                    authors: join_authors(d),
                    publisher: d["publisher"].as_str().unwrap_or("").to_string(),
                    isbn: isbn13(d["isbn"].as_str().unwrap_or("")),
                    thumbnail_url: d["thumbnail"].as_str().unwrap_or("").to_string(),
                    published: d["datetime"]
                        .as_str()
                        .map(|s| s.chars().take(10).collect())
                        .unwrap_or_default(),
                })
                .collect();
            return Ok(hits);
        }
    }
    // 2) 교보 폴백 (카카오 에러 또는 0건)
    let hits: Vec<BookSearchHit> = kyobo_search(&query)
        .await
        .into_iter()
        .map(|h| BookSearchHit {
            title: h.title,
            authors: h.author,
            publisher: h.publisher,
            isbn: h.isbn,
            thumbnail_url: h.cover_url,
            published: h.published,
        })
        .collect();
    Ok(hits)
}

/// URL에서 표지 이미지를 내려받아 책에 첨부하고 frontmatter cover 갱신 → 표지 rel 경로
#[tauri::command]
#[specta::specta]
pub async fn attach_cover_from_url(
    state: State<'_, AppState>,
    book_rel_path: String,
    url: String,
) -> Result<String, String> {
    // 다운로드는 락 밖에서 (await 동안 락 유지 금지)
    let resp = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| net_err(&e))?;
    if !resp.status().is_success() {
        return Err(format!("표지 다운로드 실패 ({})", resp.status()));
    }
    let ext = url
        .split('?')
        .next()
        .and_then(|p| p.rsplit('.').next())
        .filter(|e| ["jpg", "jpeg", "png", "webp", "gif"].contains(&e.to_lowercase().as_str()))
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "jpg".into());
    let bytes = resp.bytes().await.map_err(|e| net_err(&e))?;

    with_ctx(&state, |c| {
        let note = c.vault.read_note(&book_rel_path)?;
        let title = note
            .frontmatter
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .unwrap_or_else(|| {
                std::path::Path::new(&book_rel_path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        let cover_rel = c.vault.attach_cover_bytes(&title, &bytes, &ext)?;
        c.vault
            .update_frontmatter(&book_rel_path, serde_json::json!({ "cover": cover_rel }))?;
        refresh_note(c, &book_rel_path)?;
        Ok(cover_rel)
    })
}

#[tauri::command]
#[specta::specta]
pub fn list_notes(state: State<'_, AppState>) -> Result<Vec<NoteSummary>, String> {
    with_ctx(&state, |c| c.vault.list_notes())
}

#[tauri::command]
#[specta::specta]
pub fn read_note(state: State<'_, AppState>, rel_path: String) -> Result<NoteContent, String> {
    with_ctx(&state, |c| c.vault.read_note(&rel_path))
}

#[tauri::command]
#[specta::specta]
pub fn save_note(
    state: State<'_, AppState>,
    rel_path: String,
    frontmatter: serde_json::Value,
    body: String,
) -> Result<(), String> {
    with_ctx(&state, |c| {
        c.vault.save_note(&rel_path, frontmatter, &body)?;
        refresh_note(c, &rel_path)
    })
}

/// 노트 생성 → 생성된 rel 경로 반환
#[tauri::command]
#[specta::specta]
pub fn create_note(
    state: State<'_, AppState>,
    note_type: String,
    title: String,
    fields: serde_json::Value,
) -> Result<String, String> {
    with_ctx(&state, |c| {
        let rel = c.vault.create_note(&note_type, &title, fields)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

#[tauri::command]
#[specta::specta]
pub fn delete_note(state: State<'_, AppState>, rel_path: String) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        c.vault.delete_note(&rel_path)?;
        c.indexer.remove(&rel_path)?;
        c.search.remove(&rel_path)?;
        c.search.commit()
    })
}

/// 오늘의 데일리노트 열기 (없으면 생성)
#[tauri::command]
#[specta::specta]
pub fn open_today_daily(state: State<'_, AppState>) -> Result<String, String> {
    with_ctx(&state, |c| {
        let rel = c.vault.open_daily(&Vault::today())?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 내보내기 파일 쓰기 — 사용자가 저장 대화상자에서 고른 경로에 그대로 쓴다.
/// (vault 밖이어도 된다. 사용자가 직접 고른 자리이므로)
#[tauri::command]
#[specta::specta]
pub fn write_export(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))
}

/// 특정 날짜의 데일리노트 열기 (없으면 생성)
#[tauri::command]
#[specta::specta]
pub fn open_daily(state: State<'_, AppState>, date: String) -> Result<String, String> {
    with_ctx(&state, |c| {
        let rel = c.vault.open_daily(&date)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 책 노트 → 연결된 독서기록 찾기/생성
#[tauri::command]
#[specta::specta]
pub fn reading_for_book(
    state: State<'_, AppState>,
    book_rel_path: String,
) -> Result<String, String> {
    with_ctx(&state, |c| {
        let rel = c.vault.reading_for_book(&book_rel_path)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 독서기록에 엔트리 추가 → 갱신된 노트 반환
#[tauri::command]
#[specta::specta]
pub fn append_reading_entry(
    state: State<'_, AppState>,
    rel_path: String,
    kind: EntryKind,
    text: String,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c.vault.append_reading_entry(&rel_path, kind, &text)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

/// 데일리노트 빠른 입력 (할 일/기록/느낌) → 갱신된 노트 반환
#[tauri::command]
#[specta::specta]
pub fn append_daily_entry(
    state: State<'_, AppState>,
    rel_path: String,
    kind: yamcha_core::schema::DailyKind,
    text: String,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c.vault.append_daily_entry(&rel_path, kind, &text)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

// ---------- 빠른 담기 ----------

/// 빠른 담기 — 한 줄을 오늘 일지의 `기록`에 붙이고 그 노트의 rel 경로를 돌려준다.
///
/// 앱 화면을 거치지 않고 불릴 수 있으므로(전역 단축키 → 작은 창) **여기서 스스로
/// 오늘 일지를 만든다.**
#[tauri::command]
#[specta::specta]
pub fn quick_capture(state: State<'_, AppState>, text: String) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("담을 내용이 비어 있습니다".into());
    }
    with_ctx_write(&state, |c| {
        let rel = c.vault.open_daily(&Vault::today())?;
        c.vault
            .append_daily_entry(&rel, yamcha_core::schema::DailyKind::Log, &text)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 일지의 할 일 한 건 (index는 문서에 적힌 순서 — 화면 정렬과 무관하게 이 값으로 조작한다)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct NoteTodo {
    pub index: u32,
    pub done: bool,
    pub text: String,
}

/// 일지의 할 일 목록 (`## 할 일` 섹션, 없으면 본문 전체). 완료·미완료 모두.
#[tauri::command]
#[specta::specta]
pub fn note_todos(state: State<'_, AppState>, rel_path: String) -> Result<Vec<NoteTodo>, String> {
    with_ctx(&state, |c| {
        let note = c.vault.read_note(&rel_path)?;
        let scope = yamcha_core::template::section_text(&note.body, "## 할 일")
            .unwrap_or_else(|| note.body.clone());
        Ok(yamcha_core::template::parse_todos(&scope)
            .into_iter()
            .enumerate()
            .map(|(i, t)| NoteTodo {
                index: i as u32,
                done: t.done,
                text: t.text,
            })
            .collect())
    })
}

/// 할 일 완료 여부 토글 → 갱신된 노트
#[tauri::command]
#[specta::specta]
pub fn toggle_todo(
    state: State<'_, AppState>,
    rel_path: String,
    index: u32,
    expected_text: String,
    done: bool,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c.vault.toggle_todo(&rel_path, index, &expected_text, done)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

/// 할 일 내용 수정 (완료 여부 유지) → 갱신된 노트
#[tauri::command]
#[specta::specta]
pub fn update_todo(
    state: State<'_, AppState>,
    rel_path: String,
    index: u32,
    expected_text: String,
    new_text: String,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c
            .vault
            .update_todo(&rel_path, index, &expected_text, &new_text)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

/// 할 일 삭제 → 갱신된 노트
#[tauri::command]
#[specta::specta]
pub fn delete_todo(
    state: State<'_, AppState>,
    rel_path: String,
    index: u32,
    expected_text: String,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c.vault.delete_todo(&rel_path, index, &expected_text)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

/// 사용자 정의 종류로 기록 추가 → 갱신된 노트
#[tauri::command]
#[specta::specta]
pub fn append_callout(
    state: State<'_, AppState>,
    rel_path: String,
    label: String,
    text: String,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c.vault.append_callout(&rel_path, &label, &text)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

/// 항목 종류 변경. `source`는 "entry"(기록 콜아웃) 또는 "todo".
/// `new_kind`가 "할 일"이면 체크박스로 바뀌며 섹션도 함께 옮겨진다.
#[tauri::command]
#[specta::specta]
pub fn change_kind(
    state: State<'_, AppState>,
    rel_path: String,
    source: String,
    index: u32,
    expected_text: String,
    new_kind: String,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c
            .vault
            .change_kind(&rel_path, &source, index, &expected_text, &new_kind)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

/// vault에 저장된 사용자 정의 콜아웃 목록
#[tauri::command]
#[specta::specta]
pub fn list_callouts(state: State<'_, AppState>) -> Result<Vec<yamcha_core::CalloutDef>, String> {
    with_ctx(&state, |c| Ok(c.vault.list_callouts()))
}

/// 사용자 정의 콜아웃 추가 → 갱신된 목록
#[tauri::command]
#[specta::specta]
pub fn add_callout(
    state: State<'_, AppState>,
    def: yamcha_core::CalloutDef,
) -> Result<Vec<yamcha_core::CalloutDef>, String> {
    with_ctx_write(&state, |c| c.vault.add_callout(def))
}

/// 사용자 정의 콜아웃 제거 → 갱신된 목록 (이미 쓴 노트 내용은 건드리지 않는다)
#[tauri::command]
#[specta::specta]
pub fn remove_callout(
    state: State<'_, AppState>,
    label: String,
) -> Result<Vec<yamcha_core::CalloutDef>, String> {
    with_ctx_write(&state, |c| c.vault.remove_callout(&label))
}

/// 보기 화면에 그릴 블록 하나.
/// `kind`가 "callout"이면 `entry_index`로 수정·삭제할 수 있고,
/// "raw"면 외부 편집기에서 콜아웃 없이 써 넣은 원문이라 보여주기만 한다.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct NoteBlock {
    pub kind: String,
    pub entry_index: Option<u32>,
    pub kind_label: String,
    pub date: String,
    pub text: String,
    /// raw 블록이 어느 섹션에서 왔는지 (기록 섹션 안이면 빈 문자열)
    pub section: String,
}

/// 보기 화면용 블록 목록.
/// `## 기록`은 콜아웃/원문을 순서대로, 그 밖의 섹션은 원문 블록으로 덧붙인다 —
/// 화면이 파일 내용을 조용히 숨기지 않도록.
#[tauri::command]
#[specta::specta]
pub fn note_blocks(state: State<'_, AppState>, rel_path: String) -> Result<Vec<NoteBlock>, String> {
    use yamcha_core::template::{parse_record_blocks, sections, RecordBlock};
    with_ctx(&state, |c| {
        let note = c.vault.read_note(&rel_path)?;
        let mut out: Vec<NoteBlock> = Vec::new();

        let records =
            yamcha_core::template::section_text(&note.body, "## 기록").unwrap_or_default();
        for b in parse_record_blocks(&records) {
            out.push(match b {
                RecordBlock::Callout { index, entry } => NoteBlock {
                    kind: "callout".into(),
                    entry_index: Some(index as u32),
                    kind_label: entry.kind_label,
                    date: entry.date,
                    text: entry.text,
                    section: String::new(),
                },
                RecordBlock::Raw(text) => NoteBlock {
                    kind: "raw".into(),
                    entry_index: None,
                    kind_label: String::new(),
                    date: String::new(),
                    text,
                    section: String::new(),
                },
            });
        }

        // 보기 화면이 따로 그려 주는 섹션은 건너뛴다 (기록=위 목록, 할 일=하단 영역, 소개=정보 화면)
        let handled = ["## 기록", "## 할 일", "## 소개"];
        for (name, body) in sections(&note.body) {
            if handled.contains(&name.as_str()) || body.trim().is_empty() {
                continue;
            }
            out.push(NoteBlock {
                kind: "raw".into(),
                entry_index: None,
                kind_label: String::new(),
                date: String::new(),
                text: body,
                section: if name.is_empty() {
                    "(머리말)".into()
                } else {
                    name
                },
            });
        }
        Ok(out)
    })
}

/// 기록 콜아웃 한 건의 본문 수정 (종류·날짜 유지) → 갱신된 노트.
/// `expected_text`는 화면에서 보던 내용 — 그 사이 파일이 바뀌었으면 거부한다.
#[tauri::command]
#[specta::specta]
pub fn update_entry(
    state: State<'_, AppState>,
    rel_path: String,
    index: u32,
    expected_text: String,
    new_text: String,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c
            .vault
            .update_entry(&rel_path, index, &expected_text, &new_text)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

/// 기록 콜아웃 한 건 삭제 → 갱신된 노트. `expected_text`가 다르면 거부한다.
#[tauri::command]
#[specta::specta]
pub fn delete_entry(
    state: State<'_, AppState>,
    rel_path: String,
    index: u32,
    expected_text: String,
) -> Result<NoteContent, String> {
    with_ctx(&state, |c| {
        let note = c.vault.delete_entry(&rel_path, index, &expected_text)?;
        refresh_note(c, &rel_path)?;
        Ok(note)
    })
}

/// 전문검색 (제목·본문·태그, 한국어 부분 문자열 지원). filter가 비면 전체 검색.
#[tauri::command]
#[specta::specta]
pub fn search(
    state: State<'_, AppState>,
    query: String,
    filter: yamcha_core::SearchFilter,
) -> Result<Vec<SearchHit>, String> {
    with_ctx(&state, |c| c.search.search_filtered(&query, &filter, 50))
}

/// 현재 노트를 가리키는 노트들 (백링크)
#[tauri::command]
#[specta::specta]
pub fn get_backlinks(
    state: State<'_, AppState>,
    rel_path: String,
) -> Result<Vec<NoteRef>, String> {
    with_ctx(&state, |c| {
        let vault = &c.vault;
        c.indexer.backlinks(vault, &rel_path)
    })
}

/// 백링크 + 문맥 (링크로 이어진 것과 제목만 언급한 것)
#[tauri::command]
#[specta::specta]
pub fn get_backlinks_detailed(
    state: State<'_, AppState>,
    rel_path: String,
) -> Result<Vec<Backlink>, String> {
    with_ctx(&state, |c| {
        let vault = &c.vault;
        c.indexer.backlinks_detailed(vault, &rel_path)
    })
}

/// 템플릿 미리보기 — 오늘 날짜로 자리표시자를 채워 돌려준다.
/// 화면에서 직접 치환하지 않고 이 명령을 쓰는 이유는, 실제로 노트를 만들 때와
/// 똑같은 함수를 거쳐야 미리보기가 거짓말을 하지 않기 때문이다.
#[tauri::command]
#[specta::specta]
pub fn preview_template(content: String, title: String) -> Result<String, String> {
    let today = yamcha_core::Vault::today();
    let t = if title.trim().is_empty() { "제목".to_string() } else { title };
    Ok(yamcha_core::template::render_template(&content, &today, &t))
}

/// 태그 이름 바꾸기 / 병합 → 바뀐 노트 수.
/// `to`가 이미 쓰이는 태그면 그게 곧 병합이다.
#[tauri::command]
#[specta::specta]
pub fn rename_tag(state: State<'_, AppState>, from: String, to: String) -> Result<u32, String> {
    with_ctx(&state, |c| {
        let changed = c.vault.rename_tag(&from, &to)?;
        // 바뀐 노트만 다시 색인한다 (전체 재색인은 비싸다)
        for rel in &changed {
            let rel = rel.clone();
            let parsed = c.vault.parse_full(&rel)?;
            c.indexer.upsert(&parsed)?;
            c.search.upsert(&parsed)?;
        }
        c.search.commit()?;
        Ok(changed.len() as u32)
    })
}

/// 전체 태그와 사용 횟수
#[tauri::command]
#[specta::specta]
pub fn get_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>, String> {
    with_ctx(&state, |c| c.indexer.all_tags())
}

/// 특정 태그가 달린 노트들
#[tauri::command]
#[specta::specta]
pub fn notes_by_tag(state: State<'_, AppState>, tag: String) -> Result<Vec<NoteRef>, String> {
    with_ctx(&state, |c| c.indexer.notes_by_tag(&tag))
}

/// 저장된 노트의 frontmatter에서 `genre`를 뽑는다 (book 분야 → 태그 제안용).
fn genre_of(parsed: &yamcha_core::ParsedNote) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&parsed.frontmatter_json)
        .ok()
        .and_then(|v| v.get("genre").and_then(|g| g.as_str()).map(str::to_string))
}

fn tag_input_of(parsed: &yamcha_core::ParsedNote) -> yamcha_core::TagInput {
    yamcha_core::TagInput {
        title: parsed.title.clone(),
        body: parsed.body.clone(),
        note_type: parsed.note_type.clone(),
        genre: genre_of(parsed),
        current_tags: parsed.tags.clone(),
    }
}

/// 자동 태그 제안 — 저장 전 초안(에디터·담기 창)용. 파일을 읽지 않고 넘어온 내용만 본다.
#[tauri::command]
#[specta::specta]
pub fn suggest_tags_for_text(
    state: State<'_, AppState>,
    input: yamcha_core::TagInput,
) -> Result<Vec<yamcha_core::TagSuggestion>, String> {
    with_ctx(&state, |c| {
        let dict = c.indexer.proper_noun_dict()?;
        Ok(yamcha_core::suggest_tags(&input, &dict, 8))
    })
}

/// 자동 태그 제안 — 여러 노트를 한 번에 (태그 없는 노트 일괄 정리 화면용).
/// vocab을 한 번만 읽고 IPC도 한 번으로 끝낸다.
#[tauri::command]
#[specta::specta]
pub fn suggest_tags_batch(
    state: State<'_, AppState>,
    rel_paths: Vec<String>,
) -> Result<Vec<(String, Vec<yamcha_core::TagSuggestion>)>, String> {
    with_ctx(&state, |c| {
        let dict = c.indexer.proper_noun_dict()?;
        let mut out = Vec::with_capacity(rel_paths.len());
        for rel in rel_paths {
            if let Ok(parsed) = c.vault.parse_full(&rel) {
                let input = tag_input_of(&parsed);
                let sugg = yamcha_core::suggest_tags(&input, &dict, 5);
                out.push((rel, sugg));
            }
        }
        Ok(out)
    })
}

/// 태그가 하나도 없는 노트들 (자동 태그 일괄 정리 화면용)
#[tauri::command]
#[specta::specta]
pub fn untagged_notes(state: State<'_, AppState>) -> Result<Vec<NoteRef>, String> {
    with_ctx(&state, |c| c.indexer.untagged_notes())
}

/// 휴지통 목록
#[tauri::command]
#[specta::specta]
pub fn list_trash(state: State<'_, AppState>) -> Result<Vec<yamcha_core::TrashItem>, String> {
    with_ctx(&state, |c| c.vault.list_trash())
}

/// 휴지통에서 노트 복구 → 복구된 rel 경로
#[tauri::command]
#[specta::specta]
pub fn restore_trash(state: State<'_, AppState>, file_name: String) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        let rel = c.vault.restore_trash(&file_name)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 휴지통에서 retention_days보다 오래된 항목 영구 삭제 (0이면 안 함) → 삭제 개수
#[tauri::command]
#[specta::specta]
pub fn purge_trash(state: State<'_, AppState>, retention_days: u32) -> Result<u32, String> {
    with_ctx(&state, |c| c.vault.purge_trash(retention_days))
}

// ---------- 독서기록 엔트리 모아보기 ----------

/// 책 한 권의 기록 콜아웃 한 건 (어느 책의 것인지까지 붙여 평탄화한 형태)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct ReadingEntry {
    pub book_rel: String,
    pub book_title: String,
    pub book_author: String,
    /// 책의 분야 (장르별 보기·필터용)
    pub genre: String,
    /// 책에 달린 태그
    pub tags: Vec<String>,
    /// 표지 rel 경로 (없으면 빈 문자열)
    pub cover: String,
    pub kind_label: String,
    pub date: String,
    pub text: String,
}

/// 전체 책의 기록을 엔트리 단위로 펼쳐 반환한다 (정렬·필터는 화면에서).
#[tauri::command]
#[specta::specta]
pub fn list_entries(state: State<'_, AppState>) -> Result<Vec<ReadingEntry>, String> {
    with_ctx(&state, |c| {
        let mut out = Vec::new();
        for n in c.vault.list_notes()? {
            if n.note_type != "book" {
                continue;
            }
            let Ok(note) = c.vault.read_note(&n.rel_path) else {
                continue;
            };
            let fm = |k: &str| {
                n.frontmatter
                    .get(k)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let (_, records) = yamcha_core::template::split_book_body(&note.body);
            for e in yamcha_core::template::parse_entries(&records) {
                out.push(ReadingEntry {
                    book_rel: n.rel_path.clone(),
                    book_title: n.title.clone(),
                    book_author: fm("author"),
                    genre: fm("genre"),
                    tags: n.tags.clone(),
                    cover: fm("cover"),
                    kind_label: e.kind_label,
                    date: e.date,
                    text: e.text,
                });
            }
        }
        Ok(out)
    })
}

// ---------- 미완 할 일 모아보기 ----------

/// 어느 노트에 있는 미완 할 일 한 줄
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct TodoItem {
    pub rel_path: String,
    pub note_type: String,
    pub note_title: String,
    pub date: String,
    pub text: String,
}

/// vault 전체의 미완 할 일 (내용이 있는 `- [ ]`만). 최근 노트가 앞에 온다.
#[tauri::command]
#[specta::specta]
pub fn list_open_todos(state: State<'_, AppState>, limit: u32) -> Result<Vec<TodoItem>, String> {
    with_ctx(&state, |c| {
        let limit = limit.clamp(1, 500) as usize;
        let mut out: Vec<TodoItem> = Vec::new();
        // list_notes는 날짜 내림차순이라 순회 순서가 곧 최신순이다
        for n in c.vault.list_notes()? {
            let Ok(note) = c.vault.read_note(&n.rel_path) else {
                continue;
            };
            for text in yamcha_core::parse::open_todo_texts(&note.body) {
                out.push(TodoItem {
                    rel_path: n.rel_path.clone(),
                    note_type: n.note_type.clone(),
                    note_title: n.title.clone(),
                    date: n.date.clone(),
                    text,
                });
            }
        }
        // 데일리노트를 먼저 (하루 운영에 바로 쓰이는 목록이라)
        out.sort_by_key(|t| u8::from(t.note_type != "daily"));
        out.truncate(limit);
        Ok(out)
    })
}

// ---------- 데일리노트 요약 ----------

/// 그 날짜에 기록이 추가된 책 하나
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
pub struct DigestBookEntry {
    pub book_rel: String,
    pub book_title: String,
    pub count: u32,
}

/// 데일리노트 하단 요약 바에 뿌릴 값들 (템플릿과 무관하게 항상 계산한다)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct DailyDigest {
    /// vault 전체의 미완 할 일
    pub open_todos_total: u32,
    /// 그 날짜 데일리노트 안의 미완 할 일
    pub open_todos_today: u32,
    /// 읽는 중인 책 제목 (최대 3권)
    pub reading_titles: Vec<String>,
    /// 읽는 중인 책의 rel 경로 (1권일 때 바로 열기용)
    pub reading_rels: Vec<String>,
    pub reading_count: u32,
    pub finished_total: u32,
    pub finished_this_year: u32,
    /// 그 날짜에 기록을 남긴 책들
    pub today_entries: Vec<DigestBookEntry>,
    pub today_entry_count: u32,
}

/// 데일리노트 요약. `date`는 `YYYY-MM-DD`.
#[tauri::command]
#[specta::specta]
pub fn daily_digest(state: State<'_, AppState>, date: String) -> Result<DailyDigest, String> {
    with_ctx(&state, |c| {
        let mut d = DailyDigest::default();
        let year = date.get(..4).unwrap_or("").to_string();

        for n in c.vault.list_notes()? {
            let Ok(note) = c.vault.read_note(&n.rel_path) else {
                continue;
            };
            let open = yamcha_core::parse::count_open_todos(&note.body);
            d.open_todos_total += open;
            if n.note_type == "daily" && n.date == date {
                d.open_todos_today += open;
            }
            if n.note_type != "book" {
                continue;
            }

            let fm = |k: &str| n.frontmatter.get(k).and_then(|v| v.as_str()).unwrap_or("");
            match fm("status") {
                "reading" => {
                    d.reading_count += 1;
                    if d.reading_titles.len() < 3 {
                        d.reading_titles.push(n.title.clone());
                        d.reading_rels.push(n.rel_path.clone());
                    }
                }
                "finished" => {
                    d.finished_total += 1;
                    // 완독일이 없으면 노트 날짜로 대신 본다
                    let when = if fm("finished").is_empty() {
                        n.date.as_str()
                    } else {
                        fm("finished")
                    };
                    if !year.is_empty() && when.starts_with(&year) {
                        d.finished_this_year += 1;
                    }
                }
                _ => {}
            }

            // 그 날짜에 남긴 기록
            let (_, records) = yamcha_core::template::split_book_body(&note.body);
            let count = yamcha_core::template::parse_entries(&records)
                .iter()
                .filter(|e| e.date == date)
                .count() as u32;
            if count > 0 {
                d.today_entry_count += count;
                d.today_entries.push(DigestBookEntry {
                    book_rel: n.rel_path.clone(),
                    book_title: n.title.clone(),
                    count,
                });
            }
        }

        d.today_entries.sort_by(|a, b| b.count.cmp(&a.count));
        Ok(d)
    })
}

// ---------- 무결성 점검 (외부 편집 흡수) ----------

/// vault에서 규격에 어긋난 노트를 찾는다 (고치지는 않는다)
#[tauri::command]
#[specta::specta]
pub fn audit_vault(state: State<'_, AppState>) -> Result<Vec<yamcha_core::NoteIssue>, String> {
    with_ctx(&state, |c| Ok(yamcha_core::audit::audit(&c.vault)))
}

/// 점검 항목 한 건 수리 → (바뀌었을 수 있는) rel 경로
#[tauri::command]
#[specta::specta]
pub fn fix_issue(
    state: State<'_, AppState>,
    rel_path: String,
    kind: yamcha_core::IssueKind,
) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        let new_rel = yamcha_core::audit::fix(&c.vault, &rel_path, kind)?;
        if new_rel != rel_path {
            c.indexer.remove(&rel_path)?;
            c.search.remove(&rel_path)?;
        }
        refresh_note(c, &new_rel)?;
        Ok(new_rel)
    })
}

/// 파싱 못 하는 파일의 원문 읽기 (수리 화면 전용)
#[tauri::command]
#[specta::specta]
pub fn read_raw(state: State<'_, AppState>, rel_path: String) -> Result<String, String> {
    with_ctx(&state, |c| c.vault.read_raw(&rel_path))
}

/// 파일 원문 그대로 쓰기 (수리 화면 전용 — 정규화하지 않는다)
#[tauri::command]
#[specta::specta]
pub fn write_raw(
    state: State<'_, AppState>,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        c.vault.snapshot_before_change(&rel_path)?;
        c.vault.write_raw(&rel_path, &content)?;
        let _ = refresh_note(c, &rel_path);
        Ok(())
    })
}

// ---------- 편집 스냅샷 ----------

/// 노트의 스냅샷 목록 (최신 우선)
#[tauri::command]
#[specta::specta]
pub fn list_history(
    state: State<'_, AppState>,
    rel_path: String,
) -> Result<Vec<yamcha_core::HistoryItem>, String> {
    with_ctx(&state, |c| yamcha_core::history::list(&c.vault, &rel_path))
}

/// 스냅샷 원문 (미리보기용)
#[tauri::command]
#[specta::specta]
pub fn read_history(
    state: State<'_, AppState>,
    rel_path: String,
    stamp: String,
) -> Result<String, String> {
    with_ctx(&state, |c| {
        yamcha_core::history::read(&c.vault, &rel_path, &stamp)
    })
}

/// 해당 스냅샷으로 되돌린다 (되돌리기 직전 상태도 스냅샷으로 남는다)
#[tauri::command]
#[specta::specta]
pub fn restore_history(
    state: State<'_, AppState>,
    rel_path: String,
    stamp: String,
) -> Result<(), String> {
    with_ctx_write(&state, |c| {
        let policy = c.vault.history_policy();
        yamcha_core::history::restore(&c.vault, &rel_path, &stamp, policy)?;
        refresh_note(c, &rel_path)
    })
}

/// 스냅샷 전부 삭제 → 지운 개수
#[tauri::command]
#[specta::specta]
pub fn purge_history(state: State<'_, AppState>) -> Result<u32, String> {
    with_ctx(&state, |c| yamcha_core::history::purge_all(&c.vault))
}

/// 스냅샷 보관 정책 변경 (설정에서 호출)
#[tauri::command]
#[specta::specta]
pub fn set_history_policy(
    state: State<'_, AppState>,
    max_per_note: u32,
    min_interval_secs: u32,
) -> Result<(), String> {
    with_ctx(&state, |c| {
        c.vault.set_history_policy(yamcha_core::HistoryPolicy {
            max_per_note,
            min_interval_secs: min_interval_secs as u64,
        });
        Ok(())
    })
}

/// 전체 재색인 (인덱스 손상 대비 수동 명령)
#[tauri::command]
#[specta::specta]
pub fn reindex(state: State<'_, AppState>) -> Result<u32, String> {
    with_ctx(&state, |c| {
        let n = yamcha_core::reindex_all(&c.vault, &mut c.indexer, &mut c.search)?;
        // 재색인은 색인을 비우고 노트만 다시 넣는다. 첨부 검색이 켜져 있으면
        // 캐시에서 첨부도 다시 채운다 (재추출 없음).
        if FILE_INDEX_ON.load(Ordering::Relaxed) {
            yamcha_core::file_index::rebuild_from_cache(&c.vault, &mut c.indexer, &mut c.search)?;
        }
        Ok(n as u32)
    })
}

// ---------- 첨부 문서 검색 (검색창 `📄 파일 속` 토글) ----------

/// 첨부 색인 취소 플래그. 토글을 끄면 진행 중인 추출이 즉시 멈춘다.
static FILE_INDEX_CANCEL: AtomicBool = AtomicBool::new(false);
/// 지금 색인이 돌고 있는지 (같은 작업이 두 번 돌지 않게)
static FILE_INDEX_RUNNING: AtomicBool = AtomicBool::new(false);
/// 첨부가 색인에 들어가 있는지. watcher가 첨부 변경을 따라갈지 판단하는 데 쓴다.
static FILE_INDEX_ON: AtomicBool = AtomicBool::new(false);

/// 첨부 검색이 켜져 있는지 (watcher용)
pub(crate) fn file_index_active() -> bool {
    FILE_INDEX_ON.load(Ordering::Relaxed) || FILE_INDEX_RUNNING.load(Ordering::Relaxed)
}

/// 첨부 색인 현황 (색인된 수 · 스캔본 · 암호 · 실패)
#[tauri::command]
#[specta::specta]
pub fn file_index_status(state: State<'_, AppState>) -> Result<FileIndexStatus, String> {
    with_ctx(&state, |c| yamcha_core::file_index::status_of(&c.indexer))
}

/// 코어에 인덱스를 빌려주는 방식 — **파일 하나 쓸 때만** 잠금을 쥔다.
/// 추출은 잠금 밖에서 일어나므로 15초짜리 PDF를 읽는 동안에도 앱이 멈추지 않는다.
struct StateAccess<'a>(&'a tauri::State<'a, AppState>);

impl yamcha_core::file_index::IndexAccess for StateAccess<'_> {
    fn with<R>(
        &self,
        f: impl FnOnce(&mut Indexer, &mut SearchEngine) -> Result<R, yamcha_core::CoreError>,
    ) -> Result<R, yamcha_core::CoreError> {
        let mut guard = self
            .0
             .0
            .lock()
            .map_err(|e| yamcha_core::CoreError::Invalid(e.to_string()))?;
        let ctx = guard
            .as_mut()
            .ok_or_else(|| yamcha_core::CoreError::Invalid("vault가 설정되지 않았습니다".into()))?;
        f(&mut ctx.indexer, &mut ctx.search)
    }
}

/// 첨부 색인 시작. **바로 돌려주고 백그라운드에서 추출한다** —
/// PDF 한 건이 15초까지 걸려서(실측) 커맨드가 기다리면 앱이 멈춘 것처럼 보인다.
///
/// 진행 상황은 `file-index-progress`, 끝나면 `file-index-done` 이벤트로 알린다.
/// 이미 추출해 둔 문서는 캐시에서 즉시 채우므로 두 번째부터는 사실상 즉시 끝난다.
#[tauri::command]
#[specta::specta]
pub fn build_file_index(app: tauri::AppHandle) -> Result<(), String> {
    if FILE_INDEX_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(()); // 이미 돌고 있다
    }
    FILE_INDEX_CANCEL.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        // 첨부 목록은 짧게 잠금을 쥐고 뜬다
        let listed = {
            match state.0.lock() {
                Ok(guard) => guard
                    .as_ref()
                    .map(|c| {
                        (
                            c.vault.root().to_path_buf(),
                            yamcha_core::file_index::list_attachments(&c.vault),
                        )
                    })
                    .ok_or("vault가 설정되지 않았습니다".to_string()),
                Err(e) => Err(e.to_string()),
            }
        };

        let result = match listed {
            Ok((root, rels)) => {
                let cancel = std::sync::Arc::new(AtomicBool::new(false));
                let access = StateAccess(&state);
                // vault에서 사라진 첨부의 캐시 정리는 **전체 색인일 때만** 한다.
                // (build 안에서 하면 파일 하나만 넘기는 watcher 경로가 나머지를 다 지운다)
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(ctx) = guard.as_mut() {
                        let _ = ctx.indexer.prune_docs(&rels);
                    }
                }
                let progress_app = app.clone();
                let cancel_for_loop = cancel.clone();
                yamcha_core::file_index::build(
                    &root,
                    &rels,
                    &access,
                    cancel_for_loop,
                    |p| {
                        // 토글이 꺼졌으면 다음 파일로 넘어가지 않는다
                        if FILE_INDEX_CANCEL.load(Ordering::Relaxed) {
                            cancel.store(true, Ordering::Relaxed);
                        }
                        let _ = progress_app.emit("file-index-progress", p);
                    },
                )
                .map_err(|e| e.to_string())
            }
            Err(e) => Err(e),
        };

        FILE_INDEX_RUNNING.store(false, Ordering::SeqCst);
        match result {
            Ok(status) => {
                FILE_INDEX_ON.store(true, Ordering::SeqCst);
                let _ = app.emit("file-index-done", status);
            }
            Err(e) => {
                let _ = app.emit("file-index-error", e);
            }
        }
    });
    Ok(())
}

/// 바뀐 첨부만 다시 읽는다 (watcher가 부른다).
/// `file_index::build`와 같은 경로를 쓴다 — 추출은 잠금 밖, 색인 쓰기만 잠금 안.
/// 사라진 파일은 추출할 것이 없으니 색인·캐시에서 뺀다.
pub(crate) fn refresh_attachments(app: &tauri::AppHandle, rels: &[String]) {
    let state = app.state::<AppState>();
    let Some(root) = state
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.vault.root().to_path_buf()))
    else {
        return;
    };

    let (gone, present): (Vec<String>, Vec<String>) = rels
        .iter()
        .cloned()
        .partition(|rel| !root.join(rel).exists());

    // 사라진 파일 — 추출할 것이 없으니 잠금을 짧게 쥐고 지운다
    if !gone.is_empty() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(ctx) = guard.as_mut() {
                for rel in &gone {
                    let _ = yamcha_core::file_index::refresh_one(
                        &ctx.vault,
                        &mut ctx.indexer,
                        &mut ctx.search,
                        rel,
                    );
                }
            }
        }
    }
    if !present.is_empty() {
        let access = StateAccess(&state);
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let _ = yamcha_core::file_index::build(&root, &present, &access, cancel, |_| {});
    }
}

/// 첨부를 색인에서 뺀다 (토글 끄기). 추출 캐시는 남겨 다시 켤 때 즉시 복구한다.
#[tauri::command]
#[specta::specta]
pub fn drop_file_index(state: State<'_, AppState>) -> Result<(), String> {
    FILE_INDEX_CANCEL.store(true, Ordering::SeqCst);
    FILE_INDEX_ON.store(false, Ordering::SeqCst);
    with_ctx(&state, |c| {
        yamcha_core::file_index::drop_all(&mut c.search)
    })
}

/// 추출 캐시를 비우고 처음부터 다시 읽는다 (설정의 "문서 다시 읽기").
/// 깨졌던 파일이 고쳐졌거나 추출기가 개선됐을 때 쓴다.
#[tauri::command]
#[specta::specta]
pub fn reset_file_index(state: State<'_, AppState>) -> Result<(), String> {
    FILE_INDEX_ON.store(false, Ordering::SeqCst);
    with_ctx(&state, |c| {
        yamcha_core::file_index::drop_all(&mut c.search)?;
        c.indexer.clear_docs()
    })
}

// ---------- 책 정보 자동 보강 ----------

/// 자동 보강 결과 보고
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct EnrichReport {
    /// 처리 대상(부실한 책) 총 개수
    pub candidates: u32,
    /// 이번에 실제로 처리한 책 수
    pub processed: u32,
    /// 한 가지 이상 채워진 책 수
    pub enriched: u32,
    pub filled_genre: u32,
    pub filled_intro: u32,
    pub filled_meta: u32,
    /// API 한도(429) 도달로 중단됨
    pub stopped_rate_limit: bool,
    /// 아직 처리하지 못한 남은 책 수 (한도/제한으로)
    pub remaining: u32,
    pub errors: Vec<String>,
}

/// 보강 대상 스냅샷 (락 밖에서 네트워크 처리하려고 미리 복사)
struct Cand {
    rel: String,
    isbn: String,
    title: String,
    author: String,
    publisher: String,
    genre: String,
    has_cover: bool,
    need_meta: bool,
    need_intro: bool,
    need_genre: bool,
}

enum KakaoErr {
    RateLimited,
    /// 쓸 수 있는 키가 없음 — 호출하지 않았다는 뜻이며, 호출부는 조용히 교보로 폴백한다.
    NoKey,
    Other(String),
}

/// 카카오 책 검색 → 문서 배열(Value). 429는 RateLimited로 구분.
async fn kakao_docs(query: &str, api_key: &str) -> Result<Vec<serde_json::Value>, KakaoErr> {
    if api_key.trim().is_empty() {
        return Err(KakaoErr::NoKey);
    }
    let client = http_client();
    let resp = client
        .get("https://dapi.kakao.com/v3/search/book")
        .query(&[("query", query), ("size", "5")])
        .header("Authorization", format!("KakaoAK {}", api_key.trim()))
        .send()
        .await
        .map_err(|e| KakaoErr::Other(net_err(&e)))?;
    let code = resp.status().as_u16();
    if code == 429 {
        return Err(KakaoErr::RateLimited);
    }
    if code == 401 {
        return Err(KakaoErr::Other("API 키 인증 실패(401)".into()));
    }
    if !resp.status().is_success() {
        return Err(KakaoErr::Other(format!("카카오 API 오류 {code}")));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| KakaoErr::Other(net_err(&e)))?;
    Ok(json["documents"].as_array().cloned().unwrap_or_default())
}

/// 부실한 책들을 카카오 책 API + 분야 추정으로 자동 보강.
/// 빈 필드만 채우고(사용자 입력 보존), API 한도(429)에 닿으면 즉시 멈춘다.
#[tauri::command]
#[specta::specta]
pub async fn enrich_books(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    api_key: String,
    limit: u32,
) -> Result<EnrichReport, String> {
    let key = effective_key(&api_key);
    let limit = limit.clamp(1, 500) as usize;
    ENRICH_CANCEL.store(false, Ordering::Relaxed);

    // 1단계: 부실한 책 스냅샷 (락 짧게)
    let cands = snapshot_candidates(&state)?;
    let total = cands.len().min(limit);

    let mut report = EnrichReport {
        candidates: cands.len() as u32,
        ..Default::default()
    };

    for (i, c) in cands.iter().enumerate() {
        if i >= limit {
            break;
        }
        if ENRICH_CANCEL.load(Ordering::Relaxed) {
            break;
        }
        let _ = app.emit(
            "enrich-progress",
            serde_json::json!({ "done": i + 1, "total": total, "title": c.title }),
        );

        // 카카오 조회 (메타/소개가 필요할 때만)
        let mut doc: Option<serde_json::Value> = None;
        if c.need_meta || c.need_intro {
            let query = if !c.isbn.is_empty() {
                c.isbn.clone()
            } else if !c.author.is_empty() {
                format!("{} {}", c.title, c.author)
            } else {
                c.title.clone()
            };
            match kakao_docs(&query, key).await {
                Ok(docs) => {
                    doc = docs
                        .iter()
                        .find(|d| {
                            !c.isbn.is_empty()
                                && d["isbn"].as_str().unwrap_or("").contains(&c.isbn)
                        })
                        .or_else(|| docs.first())
                        .cloned();
                }
                Err(KakaoErr::RateLimited) => {
                    report.stopped_rate_limit = true;
                    break;
                }
                // 키가 없으면 아래 교보 폴백이 처리한다 (오류로 보고하지 않음)
                Err(KakaoErr::NoKey) => {}
                Err(KakaoErr::Other(e)) => {
                    report.errors.push(format!("{}: {e}", c.title));
                }
            }
            // 카카오가 못 찾으면 교보 자동완성으로 폴백
            if doc.is_none() {
                let hits = kyobo_search(&query).await;
                if let Some(h) = hits
                    .iter()
                    .find(|h| !c.isbn.is_empty() && h.isbn.contains(&c.isbn))
                    .or_else(|| hits.first())
                {
                    doc = Some(kyobo_hit_to_doc(h));
                }
            }
        }

        // 표지 다운로드 (락 밖, 필요 시)
        let mut cover_bytes: Option<(Vec<u8>, String)> = None;
        if c.need_meta {
            if let Some(d) = &doc {
                let thumb = d["thumbnail"].as_str().unwrap_or("").to_string();
                if !thumb.is_empty() {
                    if let Ok(resp) = http_client().get(&thumb).send().await {
                        if resp.status().is_success() {
                            let ext = thumb
                                .split('?')
                                .next()
                                .and_then(|p| p.rsplit('.').next())
                                .filter(|e| {
                                    ["jpg", "jpeg", "png", "webp", "gif"]
                                        .contains(&e.to_lowercase().as_str())
                                })
                                .map(|e| e.to_lowercase())
                                .unwrap_or_else(|| "jpg".into());
                            if let Ok(bytes) = resp.bytes().await {
                                cover_bytes = Some((bytes.to_vec(), ext));
                            }
                        }
                    }
                }
            }
        }

        // 책소개·분야는 교보문고에서 (ISBN 확보 시). 락 밖에서 조회.
        let effective_isbn = if !c.isbn.is_empty() {
            c.isbn.clone()
        } else {
            doc.as_ref()
                .and_then(|d| d["isbn"].as_str())
                .map(isbn13)
                .unwrap_or_default()
        };
        let kyobo = if (c.need_intro || c.need_genre) && !effective_isbn.is_empty() {
            kyobo_meta(&effective_isbn).await
        } else {
            KyoboMeta::default()
        };

        // 저장 (락 짧게)
        report.processed += 1;
        let apply = {
            let mut guard = state.0.lock().map_err(|e| e.to_string())?;
            let ctx = guard.as_mut().ok_or("vault가 설정되지 않았습니다")?;
            apply_enrichment(ctx, c, doc.as_ref(), &kyobo, cover_bytes)
        };
        match apply {
            Ok((meta, intro, genre)) => {
                if meta || intro || genre {
                    report.enriched += 1;
                }
                if meta {
                    report.filled_meta += 1;
                }
                if intro {
                    report.filled_intro += 1;
                }
                if genre {
                    report.filled_genre += 1;
                }
            }
            Err(e) => report.errors.push(format!("{}: {e}", c.title)),
        }
    }

    report.remaining = cands.len().saturating_sub(report.processed as usize) as u32;
    Ok(report)
}

/// 카카오 doc + 교보 메타에서 값을 뽑아 빈 필드만 채운다 (락 안). 반환: (메타, 소개, 분야)
fn apply_enrichment(
    ctx: &mut Ctx,
    c: &Cand,
    doc: Option<&serde_json::Value>,
    kyobo: &KyoboMeta,
    cover_bytes: Option<(Vec<u8>, String)>,
) -> Result<(bool, bool, bool), yamcha_core::CoreError> {
    let (author, publisher, isbn) = match doc {
        Some(d) => {
            let p = d["publisher"].as_str().unwrap_or("").to_string();
            (join_authors(d), p, isbn13(d["isbn"].as_str().unwrap_or("")))
        }
        None => (String::new(), String::new(), String::new()),
    };
    fill_book_fields(
        ctx, &c.rel, &c.title, &author, &publisher, &isbn, &kyobo.genre, &kyobo.intro, cover_bytes,
    )
}

/// 책 노트의 빈 필드만 주어진 값으로 채워 저장한다. 반환: (메타채움, 소개채움, 분야채움).
/// 분야는 값이 비어 있으면 제목·소개로 추정(suggest_genre)을 시도한다.
#[allow(clippy::too_many_arguments)]
fn fill_book_fields(
    ctx: &mut Ctx,
    rel: &str,
    fallback_title: &str,
    new_author: &str,
    new_publisher: &str,
    new_isbn: &str,
    new_genre: &str,
    new_intro: &str,
    cover_bytes: Option<(Vec<u8>, String)>,
) -> Result<(bool, bool, bool), yamcha_core::CoreError> {
    let note = ctx.vault.read_note(rel)?;
    let mut fm = note.frontmatter.as_object().cloned().unwrap_or_default();
    let is_empty = |m: &serde_json::Map<String, serde_json::Value>, k: &str| {
        m.get(k).and_then(|v| v.as_str()).unwrap_or("").is_empty()
    };

    let (mut intro, records) = yamcha_core::template::split_book_body(&note.body);
    let mut filled_meta = false;
    let mut filled_intro = false;
    let mut filled_genre = false;

    if is_empty(&fm, "author") && !new_author.is_empty() {
        fm.insert("author".into(), serde_json::json!(new_author));
        filled_meta = true;
    }
    if is_empty(&fm, "publisher") && !new_publisher.is_empty() {
        fm.insert("publisher".into(), serde_json::json!(new_publisher));
        filled_meta = true;
    }
    if is_empty(&fm, "isbn") && !new_isbn.is_empty() {
        fm.insert("isbn".into(), serde_json::json!(new_isbn));
        filled_meta = true;
    }
    if intro.trim().is_empty() && !new_intro.trim().is_empty() {
        intro = new_intro.trim().to_string();
        filled_intro = true;
    }

    if is_empty(&fm, "cover") {
        if let Some((bytes, ext)) = cover_bytes {
            let title = fm
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(|| fallback_title.to_string());
            if let Ok(cover_rel) = ctx.vault.attach_cover_bytes(&title, &bytes, &ext) {
                fm.insert("cover".into(), serde_json::json!(cover_rel));
                filled_meta = true;
            }
        }
    }

    if is_empty(&fm, "genre") {
        let g = if !new_genre.trim().is_empty() {
            Some(new_genre.trim().to_string())
        } else {
            yamcha_core::suggest_genre(fallback_title, &intro)
        };
        if let Some(g) = g {
            fm.insert("genre".into(), serde_json::json!(g));
            filled_genre = true;
        }
    }

    if filled_meta || filled_intro || filled_genre {
        let new_body = yamcha_core::template::compose_book_body(&intro, &records);
        ctx.vault
            .save_note(rel, serde_json::Value::Object(fm), &new_body)?;
        refresh_note(ctx, rel)?;
    }
    Ok((filled_meta, filled_intro, filled_genre))
}

// ---------- 교보문고 책소개 ----------

/// 교보문고 자동완성 API로 얻은 책 메타 (없으면 빈 문자열)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct KyoboMeta {
    pub intro: String,
    pub genre: String,
    pub cover_url: String,
    pub rating: String,
}

/// 교보는 UA 없는 요청을 500으로 거부한다 — BROWSER_UA를 기본으로 싣는다.
fn kyobo_client() -> reqwest::Client {
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
async fn kyobo_meta(isbn: &str) -> KyoboMeta {
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
fn strip_html_to_text(html: &str) -> String {
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
fn meta_content(html: &str, property: &str) -> String {
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

/// 최소한의 HTML 엔티티 언이스케이프 (og:description/og:image 값에 흔한 것만)
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// 교보 JSONP 응답 텍스트에서 책 메타를 파싱한다 (네트워크 없음, 테스트 가능).
fn parse_kyobo_jsonp(text: &str) -> KyoboMeta {
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
async fn kyobo_search(query: &str) -> Vec<KyoboHit> {
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
fn kyobo_hit_to_doc(h: &KyoboHit) -> serde_json::Value {
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
        assert_eq!(super::join_authors(&d), "김만중");
        assert_eq!(d["publisher"].as_str().unwrap(), "민음사");
        assert_eq!(d["isbn"].as_str().unwrap(), "9788937460722");
        assert_eq!(d["thumbnail"].as_str().unwrap(), "https://img.example/a.jpg");
    }
}

/// 교보문고에서 ISBN으로 책 메타 조회 (프론트 직접 호출용)
#[tauri::command]
#[specta::specta]
pub async fn fetch_kyobo_meta(isbn: String) -> Result<KyoboMeta, String> {
    Ok(kyobo_meta(&isbn).await)
}

// ---------- 수동 입력 자동 채우기 ----------

/// 수동 입력 화면에서 제안할 책 메타 (카카오 검색 + 교보 소개)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct BookMeta {
    pub author: String,
    pub publisher: String,
    pub isbn: String,
    pub genre: String,
    pub cover_url: String,
    pub intro: String,
    pub rating: String,
}

/// 제목(+저자)으로 카카오에서 첫 히트를 찾고, ISBN으로 교보 소개까지 붙여 제안 메타를 반환.
#[tauri::command]
#[specta::specta]
pub async fn autofill_book(
    title: String,
    author: String,
    api_key: String,
) -> Result<BookMeta, String> {
    let key = effective_key(&api_key);
    let query = if author.trim().is_empty() {
        title.trim().to_string()
    } else {
        format!("{} {}", title.trim(), author.trim())
    };
    if query.is_empty() {
        return Err("제목을 먼저 입력해주세요.".into());
    }

    // 카카오 첫 히트를 doc로. 한도 초과는 명시적 안내, 그 외 실패·0건이면 교보로 폴백.
    let mut doc: Option<serde_json::Value> = None;
    match kakao_docs(&query, key).await {
        Ok(docs) => doc = docs.into_iter().next(),
        Err(KakaoErr::RateLimited) => {
            return Err(
                "카카오 API 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.".into(),
            )
        }
        Err(KakaoErr::NoKey) | Err(KakaoErr::Other(_)) => {}
    }
    if doc.is_none() {
        if let Some(h) = kyobo_search(&query).await.into_iter().next() {
            doc = Some(kyobo_hit_to_doc(&h));
        }
    }
    let doc = doc.ok_or("검색 결과가 없습니다.")?;

    let isbn = isbn13(doc["isbn"].as_str().unwrap_or(""));
    let mut meta = BookMeta {
        author: join_authors(&doc),
        publisher: doc["publisher"].as_str().unwrap_or("").to_string(),
        isbn: isbn.clone(),
        cover_url: doc["thumbnail"].as_str().unwrap_or("").to_string(),
        ..Default::default()
    };
    if !isbn.is_empty() {
        let k = kyobo_meta(&isbn).await;
        meta.intro = k.intro;
        meta.genre = k.genre;
        meta.rating = k.rating;
        if meta.cover_url.is_empty() {
            meta.cover_url = k.cover_url;
        }
    }
    Ok(meta)
}

// ---------- 일괄 자동 채우기: 책마다 확인(미리보기) 모드 ----------

/// 한 권에 대한 보강 제안 (빈 필드에 채울 후보값만 담는다)
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct EnrichProposal {
    pub rel: String,
    pub title: String,
    pub cur_author: String,
    pub new_author: String,
    pub new_publisher: String,
    pub new_isbn: String,
    pub new_genre: String,
    pub new_intro: String,
    pub new_cover_url: String,
}

/// 미리보기 결과
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]
pub struct EnrichPreview {
    pub candidates: u32,
    pub stopped_rate_limit: bool,
    pub proposals: Vec<EnrichProposal>,
}

/// 부실한 책들의 보강 제안을 저장하지 않고 미리 계산해 반환 (책마다 확인 모드용)
#[tauri::command]
#[specta::specta]
pub async fn enrich_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    api_key: String,
    limit: u32,
) -> Result<EnrichPreview, String> {
    let key = effective_key(&api_key);
    let limit = limit.clamp(1, 500) as usize;
    ENRICH_CANCEL.store(false, Ordering::Relaxed);
    let cands = snapshot_candidates(&state)?;
    let total = cands.len().min(limit);
    let mut preview = EnrichPreview {
        candidates: cands.len() as u32,
        ..Default::default()
    };

    for (i, c) in cands.iter().enumerate() {
        if i >= limit {
            break;
        }
        if ENRICH_CANCEL.load(Ordering::Relaxed) {
            break;
        }
        let _ = app.emit(
            "enrich-progress",
            serde_json::json!({ "done": i + 1, "total": total, "title": c.title }),
        );
        let mut doc: Option<serde_json::Value> = None;
        if c.need_meta || c.need_intro {
            let query = if !c.isbn.is_empty() {
                c.isbn.clone()
            } else if !c.author.is_empty() {
                format!("{} {}", c.title, c.author)
            } else {
                c.title.clone()
            };
            match kakao_docs(&query, key).await {
                Ok(docs) => {
                    doc = docs
                        .iter()
                        .find(|d| {
                            !c.isbn.is_empty() && d["isbn"].as_str().unwrap_or("").contains(&c.isbn)
                        })
                        .or_else(|| docs.first())
                        .cloned();
                }
                Err(KakaoErr::RateLimited) => {
                    preview.stopped_rate_limit = true;
                    break;
                }
                Err(KakaoErr::NoKey) | Err(KakaoErr::Other(_)) => {}
            }
            // 카카오가 못 찾으면 교보 자동완성으로 폴백
            if doc.is_none() {
                let hits = kyobo_search(&query).await;
                if let Some(h) = hits
                    .iter()
                    .find(|h| !c.isbn.is_empty() && h.isbn.contains(&c.isbn))
                    .or_else(|| hits.first())
                {
                    doc = Some(kyobo_hit_to_doc(h));
                }
            }
        }

        let effective_isbn = if !c.isbn.is_empty() {
            c.isbn.clone()
        } else {
            doc.as_ref()
                .and_then(|d| d["isbn"].as_str())
                .map(isbn13)
                .unwrap_or_default()
        };
        let kyobo = if (c.need_intro || c.need_genre) && !effective_isbn.is_empty() {
            kyobo_meta(&effective_isbn).await
        } else {
            KyoboMeta::default()
        };

        // 빈 필드에 대해서만 후보값 구성
        let mut p = EnrichProposal {
            rel: c.rel.clone(),
            title: c.title.clone(),
            cur_author: c.author.clone(),
            ..Default::default()
        };
        if let Some(d) = &doc {
            if c.author.is_empty() {
                p.new_author = join_authors(d);
            }
            if c.publisher.is_empty() {
                p.new_publisher = d["publisher"].as_str().unwrap_or("").to_string();
            }
            if c.isbn.is_empty() {
                p.new_isbn = isbn13(d["isbn"].as_str().unwrap_or(""));
            }
            if !c.has_cover {
                p.new_cover_url = d["thumbnail"].as_str().unwrap_or("").to_string();
            }
        }
        if c.need_intro {
            p.new_intro = kyobo.intro.clone();
        }
        if c.genre.is_empty() {
            p.new_genre = kyobo.genre.clone();
        }

        let has_change = !p.new_author.is_empty()
            || !p.new_publisher.is_empty()
            || !p.new_isbn.is_empty()
            || !p.new_genre.is_empty()
            || !p.new_intro.is_empty()
            || !p.new_cover_url.is_empty();
        if has_change {
            preview.proposals.push(p);
        }
    }
    Ok(preview)
}

/// 미리보기 제안 한 건을 실제로 적용 (빈 필드만 채움, 표지는 URL에서 재다운로드)
#[tauri::command]
#[specta::specta]
pub async fn enrich_apply_one(
    state: State<'_, AppState>,
    proposal: EnrichProposal,
) -> Result<(), String> {
    // 표지 다운로드 (락 밖)
    let cover_bytes = download_cover(&proposal.new_cover_url).await;

    with_ctx_write(&state, |ctx| {
        fill_book_fields(
            ctx,
            &proposal.rel,
            &proposal.title,
            &proposal.new_author,
            &proposal.new_publisher,
            &proposal.new_isbn,
            &proposal.new_genre,
            &proposal.new_intro,
            cover_bytes,
        )?;
        Ok(())
    })
    .map(|_| ())
}

/// 진행 중인 일괄 자동채우기를 취소 요청한다 (다음 루프에서 중단).
#[tauri::command]
#[specta::specta]
pub fn cancel_enrich() {
    ENRICH_CANCEL.store(true, Ordering::Relaxed);
}

/// 부실한 책 후보 스냅샷 (enrich_books / enrich_preview 공용)
fn snapshot_candidates(state: &State<'_, AppState>) -> Result<Vec<Cand>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let ctx = guard.as_ref().ok_or("vault가 설정되지 않았습니다")?;
    let mut v = Vec::new();
    for n in ctx.vault.list_notes().map_err(|e| e.to_string())? {
        if n.note_type != "book" {
            continue;
        }
        let get = |k: &str| {
            n.frontmatter
                .get(k)
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string()
        };
        let author = get("author");
        let need_meta = author.is_empty()
            || get("publisher").is_empty()
            || get("isbn").is_empty()
            || get("cover").is_empty();
        let need_genre = get("genre").is_empty();
        let need_intro = ctx
            .vault
            .read_note(&n.rel_path)
            .map(|note| {
                yamcha_core::template::split_book_body(&note.body)
                    .0
                    .trim()
                    .is_empty()
            })
            .unwrap_or(false);
        if need_meta || need_genre || need_intro {
            v.push(Cand {
                rel: n.rel_path,
                isbn: get("isbn"),
                title: n.title,
                publisher: get("publisher"),
                genre: get("genre"),
                has_cover: !get("cover").is_empty(),
                author,
                need_meta,
                need_intro,
                need_genre,
            });
        }
    }
    Ok(v)
}

/// URL에서 표지 이미지를 내려받아 (bytes, ext) 반환. 실패 시 None.
async fn download_cover(url: &str) -> Option<(Vec<u8>, String)> {
    if url.is_empty() {
        return None;
    }
    let resp = http_client().get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ext = url
        .split('?')
        .next()
        .and_then(|p| p.rsplit('.').next())
        .filter(|e| ["jpg", "jpeg", "png", "webp", "gif"].contains(&e.to_lowercase().as_str()))
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "jpg".into());
    let bytes = resp.bytes().await.ok()?;
    Some((bytes.to_vec(), ext))
}

// ---------- 노트 템플릿 (고급) ----------

/// 노트 본문 템플릿 읽기 (kind: "daily"|"free"|"info"|"writing"). 커스텀 없으면 기본값.
#[tauri::command]
#[specta::specta]
pub fn get_note_template(state: State<'_, AppState>, kind: String) -> Result<String, String> {
    with_ctx(&state, |c| c.vault.read_body_template_file(&kind))
}

/// 데일리/자유노트 본문 템플릿 저장 (빈 내용이면 기본값으로 되돌림)
#[tauri::command]
#[specta::specta]
pub fn set_note_template(
    state: State<'_, AppState>,
    kind: String,
    content: String,
) -> Result<(), String> {
    with_ctx_write(&state, |c| c.vault.write_body_template_file(&kind, &content))
}

/// 타입별 제목 머릿글 템플릿 조회 (쓸 수 없는 타입이면 빈 문자열)
#[tauri::command]
#[specta::specta]
pub fn get_title_template(state: State<'_, AppState>, type_id: String) -> Result<String, String> {
    with_ctx(&state, |c| c.vault.read_title_template(&type_id))
}

/// 타입별 제목 머릿글 템플릿 저장
#[tauri::command]
#[specta::specta]
pub fn set_title_template(
    state: State<'_, AppState>,
    type_id: String,
    content: String,
) -> Result<(), String> {
    with_ctx_write(&state, |c| c.vault.write_title_template(&type_id, &content))
}

/// 제목 없이 닫은 노트에 `{날짜} {본문 첫머리}`로 이름을 붙인다.
/// 이미 이름이 있거나 본문이 비었으면 아무것도 하지 않고 원래 rel을 돌려준다.
#[tauri::command]
#[specta::specta]
pub fn auto_title_note(state: State<'_, AppState>, rel_path: String) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        let new_rel = c.vault.auto_title_if_untitled(&rel_path)?;
        if new_rel != rel_path {
            c.indexer.remove(&rel_path)?;
            c.search.remove(&rel_path)?;
        }
        refresh_note(c, &new_rel)?;
        Ok(new_rel)
    })
}

#[cfg(test)]
mod index_location_tests {
    use super::*;

    #[test]
    fn 같은_vault는_늘_같은_폴더_다른_vault는_다른_폴더() {
        let a = Path::new("E:/Projects/YamchaMemo/testvault");
        let b = Path::new("E:/Projects/YamchaMemo/다른창고");
        assert_eq!(vault_key(a), vault_key(a), "같은 경로가 두 값을 냈다");
        assert_ne!(vault_key(a), vault_key(b));
        // 사람이 알아볼 힌트가 앞에 붙는다
        assert!(vault_key(a).starts_with("testvault-"), "{}", vault_key(a));
    }

    /// Windows에서 대소문자만 다른 경로는 같은 폴더다 — 두 벌로 갈리면
    /// 같은 vault를 열 때마다 색인을 처음부터 다시 만든다.
    #[test]
    #[cfg(windows)]
    fn 윈도우에서는_대소문자를_가리지_않는다() {
        assert_eq!(
            vault_key(Path::new("E:/Projects/Vault")),
            vault_key(Path::new("e:/projects/vault"))
        );
    }

    /// 옛 색인을 치울 때 **사용자 데이터는 건드리지 않는다**.
    #[test]
    fn 옛_색인만_치우고_휴지통과_히스토리는_남긴다() {
        let d = tempfile::tempdir().unwrap();
        let dot = d.path().join(".yamcha");
        std::fs::create_dir_all(dot.join("search")).unwrap();
        std::fs::create_dir_all(dot.join("trash")).unwrap();
        std::fs::create_dir_all(dot.join("history").join("Free__메모.md")).unwrap();
        std::fs::write(dot.join("search").join("meta.json"), "{}").unwrap();
        std::fs::write(dot.join("index.db"), "sqlite").unwrap();
        std::fs::write(dot.join("index.db-wal"), "wal").unwrap();
        std::fs::write(dot.join("trash").join("20260101-000000_지운것.md"), "본문").unwrap();
        std::fs::write(
            dot.join("history").join("Free__메모.md").join("20260101-000000-000.md"),
            "예전 판",
        )
        .unwrap();

        remove_legacy_index(d.path());

        assert!(!dot.join("search").exists(), "search가 남았다");
        assert!(!dot.join("index.db").exists(), "index.db가 남았다");
        assert!(!dot.join("index.db-wal").exists(), "wal이 남았다");
        // 여기부터가 진짜 확인하고 싶은 것
        assert!(
            dot.join("trash").join("20260101-000000_지운것.md").exists(),
            "휴지통을 지웠다"
        );
        assert!(
            dot.join("history").join("Free__메모.md").join("20260101-000000-000.md").exists(),
            "히스토리를 지웠다"
        );
    }
}

#[cfg(test)]
mod key_tests {
    use super::*;

    #[test]
    fn 사용자키가_빌드주입키보다_우선한다() {
        assert_eq!(effective_key("  내키  "), "내키");
    }

    #[test]
    fn 빈_사용자키는_빌드주입키로_떨어진다() {
        assert_eq!(effective_key("   "), default_kakao_key());
    }

    /// 빌드 타임 주입이 실제로 걸렸는지 눈으로 확인하는 진단용.
    /// `cargo test -p yamcha-app --lib 주입_확인 -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn 주입_확인() {
        let k = default_kakao_key();
        eprintln!(
            "YAMCHA_KAKAO_KEY 주입: {} (길이 {})",
            if k.is_empty() { "없음" } else { "있음" },
            k.len()
        );
    }

    #[tokio::test]
    async fn 키가_없으면_카카오를_호출하지_않는다() {
        // 빈 키로는 네트워크를 타지 않고 즉시 NoKey — 호출부는 교보로 폴백한다.
        assert!(matches!(
            kakao_docs("아무거나", "").await,
            Err(KakaoErr::NoKey)
        ));
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
