//! 노트 자체를 다루는 커맨드 — 만들기·읽기·저장·이동·기록·할 일·첨부.

use super::*;

/// 노트를 다른 분류로 이동 (파일을 새 분류 폴더로 옮기고 type을 갱신) → 새 rel 경로
#[tauri::command]
#[specta::specta]
pub fn move_note(
    state: State<'_, AppState>,
    rel_path: String,
    new_type_id: String,
) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        let new_rel = c.vault.move_note(&rel_path, &new_type_id)?;
        // 폴더·타입이 바뀌므로 전체 재색인
        yamcha_core::reindex_all(&c.vault, &mut c.indexer, &mut c.search)?;
        Ok(new_rel)
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

#[tauri::command]
#[specta::specta]
pub fn list_notes(state: State<'_, AppState>) -> Result<Vec<NoteSummary>, String> {
    with_ctx(&state, |c| c.vault.list_notes())
}

/// 노트 한 편의 요약 — 저장 뒤 목록에서 그 줄만 갈아끼울 때.
/// 자동저장마다 `list_notes`로 전체를 다시 실어 나르지 않으려고 둔다.
#[tauri::command]
#[specta::specta]
pub fn note_summary(state: State<'_, AppState>, rel_path: String) -> Result<NoteSummary, String> {
    with_ctx(&state, |c| c.vault.note_summary(&rel_path))
}

#[tauri::command]
#[specta::specta]
pub fn read_note(state: State<'_, AppState>, rel_path: String) -> Result<NoteContent, String> {
    with_ctx(&state, |c| c.vault.read_note(&rel_path))
}

/// 노트 저장.
///
/// `expected_stamp`은 이 내용을 읽어 올 때 받은 파일 지문이다. 주면 쓰기 직전에
/// 파일이 그대로인지 확인하고, 그 사이에 누가 고쳤으면 **쓰지 않고** `conflict`로
/// 돌려준다 — 같은 저장소를 두 곳에서 열어 둔 사이에 남의 수정을 조용히 덮는 것을
/// 막는다. 사용자가 "내 편집 유지"를 골라 일부러 덮어쓸 때는 `null`을 준다.
#[tauri::command]
#[specta::specta]
pub fn save_note(
    state: State<'_, AppState>,
    rel_path: String,
    frontmatter: serde_json::Value,
    body: String,
    expected_stamp: Option<String>,
) -> Result<yamcha_core::SaveResult, String> {
    with_ctx(&state, |c| {
        let r = c
            .vault
            .save_note_checked(&rel_path, frontmatter, &body, expected_stamp.as_deref())?;
        if !r.conflict {
            refresh_note(c, &rel_path)?;
        }
        Ok(r)
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

/// 노트 본문 템플릿 읽기 (kind: "daily"|"free"|"writing"). 커스텀 없으면 기본값.
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
