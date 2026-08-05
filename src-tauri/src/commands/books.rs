//! 책 — 카카오 검색·표지·자동 채우기·일괄 보강.

use super::*;

/// 일괄 자동채우기 취소 플래그 (enrich_books/enrich_preview 시작 시 reset, cancel_enrich가 set)
static ENRICH_CANCEL: AtomicBool = AtomicBool::new(false);

/// 카카오 isbn 필드("10자리 13자리")에서 13자리(마지막 토큰)를 뽑는다.
fn isbn13(raw: &str) -> String {
    raw.split_whitespace().last().unwrap_or(raw).to_string()
}

/// 카카오 doc의 authors 배열을 ", "로 합친다.
pub(crate) fn join_authors(doc: &serde_json::Value) -> String {
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

/// 교보문고에서 ISBN으로 책 메타 조회 (프론트 직접 호출용)
#[tauri::command]
#[specta::specta]
pub async fn fetch_kyobo_meta(isbn: String) -> Result<KyoboMeta, String> {
    Ok(kyobo_meta(&isbn).await)
}

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

#[cfg(test)]
mod kakao_call_tests {
    use super::*;

    #[tokio::test]
    async fn 키가_없으면_카카오를_호출하지_않는다() {
        // 빈 키로는 네트워크를 타지 않고 즉시 NoKey — 호출부는 교보로 폴백한다.
        assert!(matches!(
            kakao_docs("아무거나", "").await,
            Err(KakaoErr::NoKey)
        ));
    }
}
