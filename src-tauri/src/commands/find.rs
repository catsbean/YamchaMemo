//! 찾기 — 전문검색·백링크·태그·자동 태그 제안.

use super::*;

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
