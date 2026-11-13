//! 노트 자체를 다루는 커맨드 — 만들기·읽기·저장·이동·기록·할 일·첨부.

use super::*;

/// 노트를 다른 분류로 이동 (파일을 새 분류 폴더로 옮기고 type을 갱신) → 새 rel 경로.
///
/// 비동기 커맨드다(`rename_note`와 같은 까닭) — 진행은 `relocate-progress`로 알린다.
#[tauri::command]
#[specta::specta]
pub async fn move_note(
    app: tauri::AppHandle,
    rel_path: String,
    new_type_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut report = relocate_reporter(&app);
        with_ctx_write(&state, |c| move_note_in(c, &rel_path, &new_type_id, &mut report))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn move_note_in(
    c: &mut Ctx,
    rel_path: &str,
    new_type_id: &str,
    report: RelocateReport<'_>,
) -> Result<String, yamcha_core::CoreError> {
    let moved = c
        .vault
        .move_note_with(rel_path, new_type_id, &mut |d, t| report("links", d, t))?;
    catch_up_relocation(c, rel_path, &moved, &mut |d, t| report("index", d, t));
    Ok(moved.rel)
}

/// 노트 제목 변경 (파일명 + 링크 연쇄 수정, 책이면 독서기록도 연동) → 새 rel 경로.
///
/// **비동기 커맨드다.** 모두가 가리키는 노트면 수천 편의 링크를 고쳐 쓰느라 20초까지
/// 걸린다. 동기 커맨드는 메인 스레드에서 돌아서 그동안 창이 통째로 얼고 진행 알림도 못
/// 나간다(`set_vault`가 먼저 겪었다). 일은 `spawn_blocking`으로 보내고 진행은
/// `relocate-progress`로 알린다.
#[tauri::command]
#[specta::specta]
pub async fn rename_note(
    app: tauri::AppHandle,
    rel_path: String,
    new_title: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut report = relocate_reporter(&app);
        with_ctx_write(&state, |c| rename_note_in(c, &rel_path, &new_title, &mut report))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn rename_note_in(
    c: &mut Ctx,
    rel_path: &str,
    new_title: &str,
    report: RelocateReport<'_>,
) -> Result<String, yamcha_core::CoreError> {
    let moved = c
        .vault
        .rename_note_with(rel_path, new_title, &mut |d, t| report("links", d, t))?;
    catch_up_relocation(c, rel_path, &moved, &mut |d, t| report("index", d, t));
    Ok(moved.rel)
}

/// frontmatter 일부 필드만 갱신 (목록 뷰 인라인 편집용)
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
#[specta::specta]
pub fn import_attachment(state: State<'_, AppState>, src_path: String) -> Result<String, String> {
    with_ctx_write(&state, |c| {
        c.vault.import_attachment(std::path::Path::new(&src_path))
    })
}

/// 클립보드에서 붙여넣은 이미지 저장 (base64) → rel 경로 반환
#[tauri::command(async)]
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
#[tauri::command(async)]
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

#[tauri::command(async)]
#[specta::specta]
pub fn list_notes(state: State<'_, AppState>) -> Result<Vec<NoteSummary>, String> {
    with_ctx(&state, |c| c.vault.list_notes())
}

/// 노트 한 편의 요약 — 저장 뒤 목록에서 그 줄만 갈아끼울 때.
/// 자동저장마다 `list_notes`로 전체를 다시 실어 나르지 않으려고 둔다.
#[tauri::command(async)]
#[specta::specta]
pub fn note_summary(state: State<'_, AppState>, rel_path: String) -> Result<NoteSummary, String> {
    with_ctx(&state, |c| c.vault.note_summary(&rel_path))
}

#[tauri::command(async)]
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
#[tauri::command(async)]
#[specta::specta]
pub fn save_note(
    state: State<'_, AppState>,
    rel_path: String,
    frontmatter: serde_json::Value,
    body: String,
    expected_stamp: Option<String>,
) -> Result<yamcha_core::SaveResult, String> {
    with_ctx(&state, |c| {
        save_note_in(c, &rel_path, frontmatter, &body, expected_stamp.as_deref())
    })
}

pub(crate) fn save_note_in(
    c: &mut Ctx,
    rel_path: &str,
    frontmatter: serde_json::Value,
    body: &str,
    expected_stamp: Option<&str>,
) -> Result<yamcha_core::SaveResult, yamcha_core::CoreError> {
    let r = c
        .vault
        .save_note_checked(rel_path, frontmatter, body, expected_stamp)?;
    if !r.conflict {
        refresh_note(c, rel_path)?;
    }
    Ok(r)
}

/// 저장하지 못한 편집을 자유노트 사본으로 남긴다 → 사본의 rel.
/// 원래 노트가 밖에서 바뀌었거나 쓸 수 없을 때, 화면을 떠나거나 창을 닫기 전에 부른다.
#[tauri::command(async)]
#[specta::specta]
pub fn save_conflict_copy(
    state: State<'_, AppState>,
    rel_path: String,
    frontmatter: serde_json::Value,
    body: String,
) -> Result<String, String> {
    with_ctx(&state, |c| {
        let rel = c.vault.save_conflict_copy(&rel_path, frontmatter, &body)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 노트 생성 → 생성된 rel 경로 반환
#[tauri::command(async)]
#[specta::specta]
pub fn create_note(
    state: State<'_, AppState>,
    note_type: String,
    title: String,
    fields: serde_json::Value,
) -> Result<String, String> {
    with_ctx(&state, |c| create_note_in(c, &note_type, &title, fields))
}

pub(crate) fn create_note_in(
    c: &mut Ctx,
    note_type: &str,
    title: &str,
    fields: serde_json::Value,
) -> Result<String, yamcha_core::CoreError> {
    let rel = c.vault.create_note(note_type, title, fields)?;
    refresh_note(c, &rel)?;
    Ok(rel)
}

#[tauri::command(async)]
#[specta::specta]
pub fn delete_note(state: State<'_, AppState>, rel_path: String) -> Result<(), String> {
    with_ctx_write(&state, |c| delete_note_in(c, &rel_path))
}

pub(crate) fn delete_note_in(c: &mut Ctx, rel_path: &str) -> Result<(), yamcha_core::CoreError> {
    c.vault.delete_note(rel_path)?;
    c.indexer.remove(rel_path)?;
    c.search.remove(rel_path)?;
    c.search.commit()
}

/// 오늘의 데일리노트 열기 (없으면 생성)
#[tauri::command(async)]
#[specta::specta]
pub fn open_today_daily(state: State<'_, AppState>) -> Result<String, String> {
    with_ctx(&state, |c| {
        let rel = c.vault.open_daily(&Vault::today())?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 특정 날짜의 데일리노트 열기 (없으면 생성)
#[tauri::command(async)]
#[specta::specta]
pub fn open_daily(state: State<'_, AppState>, date: String) -> Result<String, String> {
    with_ctx(&state, |c| {
        let rel = c.vault.open_daily(&date)?;
        refresh_note(c, &rel)?;
        Ok(rel)
    })
}

/// 책 노트 → 연결된 독서기록 찾기/생성
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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

/// 노트 본문 → 할 일 목록 (`## 할 일` 섹션, 없으면 본문 전체).
///
/// 커맨드와 회고의 기간 읽기가 **같은 함수**를 봐야 한다 — 두 벌로 갈리면
/// 노트를 열면 보이는데 회고에서만 사라지는 할 일이 생긴다.
pub(crate) fn todos_of_body(body: &str) -> Vec<NoteTodo> {
    let scope =
        yamcha_core::template::section_text(body, "## 할 일").unwrap_or_else(|| body.to_string());
    yamcha_core::template::parse_todos(&scope)
        .into_iter()
        .enumerate()
        .map(|(i, t)| NoteTodo {
            index: i as u32,
            done: t.done,
            text: t.text,
        })
        .collect()
}

/// 일지의 할 일 목록 (`## 할 일` 섹션, 없으면 본문 전체). 완료·미완료 모두.
#[tauri::command(async)]
#[specta::specta]
pub fn note_todos(state: State<'_, AppState>, rel_path: String) -> Result<Vec<NoteTodo>, String> {
    with_ctx(&state, |c| {
        Ok(todos_of_body(&c.vault.read_note(&rel_path)?.body))
    })
}

/// 할 일 완료 여부 토글 → 갱신된 노트
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
#[specta::specta]
pub fn list_callouts(state: State<'_, AppState>) -> Result<Vec<yamcha_core::CalloutDef>, String> {
    with_ctx(&state, |c| Ok(c.vault.list_callouts()))
}

/// 사용자 정의 콜아웃 추가 → 갱신된 목록
#[tauri::command(async)]
#[specta::specta]
pub fn add_callout(
    state: State<'_, AppState>,
    def: yamcha_core::CalloutDef,
) -> Result<Vec<yamcha_core::CalloutDef>, String> {
    with_ctx_write(&state, |c| c.vault.add_callout(def))
}

/// 사용자 정의 콜아웃 제거 → 갱신된 목록 (이미 쓴 노트 내용은 건드리지 않는다)
#[tauri::command(async)]
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

/// 노트 본문 → 보기 블록들.
/// `## 기록`은 콜아웃/원문을 순서대로, 그 밖의 섹션은 원문 블록으로 덧붙인다 —
/// 화면이 파일 내용을 조용히 숨기지 않도록.
///
/// `todos_of_body`와 같은 이유로 자유 함수다 — 노트 보기와 회고가 같은 눈으로 봐야 한다.
pub(crate) fn blocks_of_body(body: &str) -> Vec<NoteBlock> {
    use yamcha_core::template::{parse_record_blocks, sections, RecordBlock};
    let mut out: Vec<NoteBlock> = Vec::new();

    let records = yamcha_core::template::section_text(body, "## 기록").unwrap_or_default();
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
    for (name, section_body) in sections(body) {
        if handled.contains(&name.as_str()) || section_body.trim().is_empty() {
            continue;
        }
        out.push(NoteBlock {
            kind: "raw".into(),
            entry_index: None,
            kind_label: String::new(),
            date: String::new(),
            text: section_body,
            section: if name.is_empty() {
                "(머리말)".into()
            } else {
                name
            },
        });
    }
    out
}

/// 보기 화면용 블록 목록.
#[tauri::command(async)]
#[specta::specta]
pub fn note_blocks(state: State<'_, AppState>, rel_path: String) -> Result<Vec<NoteBlock>, String> {
    with_ctx(&state, |c| {
        Ok(blocks_of_body(&c.vault.read_note(&rel_path)?.body))
    })
}

/// 기록 콜아웃 한 건의 본문 수정 (종류·날짜 유지) → 갱신된 노트.
/// `expected_text`는 화면에서 보던 내용 — 그 사이 파일이 바뀌었으면 거부한다.
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
#[specta::specta]
pub fn get_note_template(state: State<'_, AppState>, kind: String) -> Result<String, String> {
    with_ctx(&state, |c| c.vault.read_body_template_file(&kind))
}

/// 데일리/자유노트 본문 템플릿 저장 (빈 내용이면 기본값으로 되돌림)
#[tauri::command(async)]
#[specta::specta]
pub fn set_note_template(
    state: State<'_, AppState>,
    kind: String,
    content: String,
) -> Result<(), String> {
    with_ctx_write(&state, |c| c.vault.write_body_template_file(&kind, &content))
}

/// 타입별 제목 머릿글 템플릿 조회 (쓸 수 없는 타입이면 빈 문자열)
#[tauri::command(async)]
#[specta::specta]
pub fn get_title_template(state: State<'_, AppState>, type_id: String) -> Result<String, String> {
    with_ctx(&state, |c| c.vault.read_title_template(&type_id))
}

/// 타입별 제목 머릿글 템플릿 저장
#[tauri::command(async)]
#[specta::specta]
pub fn set_title_template(
    state: State<'_, AppState>,
    type_id: String,
    content: String,
) -> Result<(), String> {
    with_ctx_write(&state, |c| c.vault.write_title_template(&type_id, &content))
}

/// 제목 없이 떠나는 노트를 정리한다: 아무것도 안 친 빈 노트는 지우고 `None`,
/// 본문이 있으면 `{날짜} {본문 첫머리}`로 이름을 붙여 새 rel을 돌려준다.
/// 이미 이름이 있으면 아무것도 하지 않고 원래 rel을 돌려준다.
#[tauri::command(async)]
#[specta::specta]
pub fn auto_title_note(
    state: State<'_, AppState>,
    rel_path: String,
) -> Result<Option<String>, String> {
    with_ctx_write(&state, |c| auto_title_note_in(c, &rel_path))
}

pub(crate) fn auto_title_note_in(
    c: &mut Ctx,
    rel_path: &str,
) -> Result<Option<String>, yamcha_core::CoreError> {
    match c.vault.settle_untitled(rel_path)? {
        // 이름을 붙였으면 제목 바꾸기와 같다 — `[[무제]]`를 고쳐 쓴 다른 노트들도 따라잡는다
        Some(moved) => {
            catch_up_relocation(c, rel_path, &moved, &mut |_, _| {});
            Ok(Some(moved.rel))
        }
        // 아무것도 안 친 빈 노트라 지웠다
        None => {
            refresh_note(c, rel_path)?;
            Ok(None)
        }
    }
}

/// 가리키는 글이 없는 `[[링크]]` 대상을 자유노트에 만든다 → 만든 글들.
///
/// 화면이 "없다"고 본 이름을 그대로 믿지 않고 여기서 다시 풀어 본다(다른 창이 방금 만든
/// 글과 겹치지 않게). 규칙과 만들지 않는 이름은 `yamcha_core::linkstub`.
#[tauri::command(async)]
#[specta::specta]
pub fn ensure_link_targets(
    state: State<'_, AppState>,
    targets: Vec<String>,
) -> Result<Vec<yamcha_core::CreatedLink>, String> {
    with_ctx_write(&state, |c| ensure_link_targets_in(c, &targets))
}

pub(crate) fn ensure_link_targets_in(
    c: &mut Ctx,
    targets: &[String],
) -> Result<Vec<yamcha_core::CreatedLink>, yamcha_core::CoreError> {
    let made = c.vault.ensure_link_targets(targets)?;
    refresh_notes(c, made.iter().map(|m| m.rel_path.as_str()))?;
    Ok(made)
}

/// 링크에서 자동으로 만든 글 가운데 **아무도 손대지 않았고 아무도 가리키지 않는** 것을
/// 휴지통으로 보낸다 → 보낸 글들의 rel.
///
/// `[[회의]]`를 `[[회의록]]`으로 고치면 `회의`가 빈 채로 남는다. 그걸 치우는 자리다.
/// 세 조건(자동 생성 표시 · 만들 때 그대로인 본문 · 백링크 0)을 **여기서** 다시 확인한다 —
/// 화면이 넘긴 목록은 후보일 뿐이다. `even_if_linked`는 방금 만든 것을 [되돌리기]할 때만
/// 쓴다(링크가 아직 본문에 있어 백링크가 0이 아니다). 그때도 손댄 글은 건드리지 않는다.
#[tauri::command(async)]
#[specta::specta]
pub fn prune_link_stubs(
    state: State<'_, AppState>,
    rel_paths: Vec<String>,
    even_if_linked: bool,
) -> Result<Vec<String>, String> {
    with_ctx_write(&state, |c| prune_link_stubs_in(c, &rel_paths, even_if_linked))
}

pub(crate) fn prune_link_stubs_in(
    c: &mut Ctx,
    rel_paths: &[String],
    even_if_linked: bool,
) -> Result<Vec<String>, yamcha_core::CoreError> {
    let mut gone = Vec::new();
    for rel in rel_paths {
        // 이미 없거나 못 읽는 글은 건너뛴다 — 치우는 일이 다른 일을 막으면 안 된다
        if !matches!(c.vault.is_untouched_link_stub(rel), Ok(true)) {
            continue;
        }
        if !even_if_linked && !c.indexer.backlinks(&c.vault, rel)?.is_empty() {
            continue;
        }
        delete_note_in(c, rel)?;
        gone.push(rel.clone());
    }
    Ok(gone)
}

#[cfg(test)]
mod link_stub_tests {
    use super::*;
    use std::path::Path;

    fn ctx(vault_root: &Path, index_root: &Path) -> Ctx {
        Ctx {
            vault: Vault::open(vault_root).unwrap(),
            indexer: Indexer::open(&index_root.join("index.db")).unwrap(),
            search: SearchEngine::open(&index_root.join("search")).unwrap(),
            todo_cache: dashboard::TodoCache::default(),
        }
    }

    /// 원글의 본문을 바꿔 저장한다 (색인까지)
    fn write_body(c: &mut Ctx, rel: &str, body: &str) {
        let note = c.vault.read_note(rel).unwrap();
        save_note_in(c, rel, note.frontmatter, body, None).unwrap();
    }

    fn one(s: &str) -> Vec<String> {
        vec![s.to_string()]
    }

    /// `[[회의]]`를 `[[회의록]]`으로 고치면 빈 `회의`는 치워지고, 그 전에는 남는다.
    #[test]
    fn 아무도_가리키지_않게_된_빈_글만_치운다() {
        let (v, i) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut c = ctx(v.path(), i.path());
        let src = create_note_in(&mut c, "free", "원글", serde_json::Value::Null).unwrap();
        write_body(&mut c, &src, "오늘 [[회의]] 했다");
        let stub = ensure_link_targets_in(&mut c, &one("회의")).unwrap().remove(0).rel_path;

        // 아직 원글이 가리킨다 — 남는다
        assert!(prune_link_stubs_in(&mut c, std::slice::from_ref(&stub), false).unwrap().is_empty());
        assert!(v.path().join(&stub).exists());

        write_body(&mut c, &src, "오늘 [[회의록]] 썼다");
        assert_eq!(prune_link_stubs_in(&mut c, std::slice::from_ref(&stub), false).unwrap(), vec![stub.clone()]);
        assert!(!v.path().join(&stub).exists(), "빈 글이 남았다");
        // 지운 게 아니라 휴지통에 있다
        assert_eq!(c.vault.list_trash().unwrap().len(), 1);
        // 색인에서도 빠졌다
        assert!(!c.indexer.note_states().unwrap().contains_key(&stub));
    }

    /// 손댄 글은 아무도 안 가리켜도, [되돌리기]로 불러도 치우지 않는다.
    #[test]
    fn 손댄_글은_어떤_경우에도_치우지_않는다() {
        let (v, i) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut c = ctx(v.path(), i.path());
        let stub = ensure_link_targets_in(&mut c, &one("회의")).unwrap().remove(0).rel_path;
        let body = format!("{}\n안건 하나", c.vault.read_note(&stub).unwrap().body);
        write_body(&mut c, &stub, &body);

        assert!(prune_link_stubs_in(&mut c, std::slice::from_ref(&stub), false).unwrap().is_empty());
        assert!(prune_link_stubs_in(&mut c, std::slice::from_ref(&stub), true).unwrap().is_empty());
        assert!(v.path().join(&stub).exists());
    }

    /// 사람이 직접 만든 빈 글은 후보로 넘어와도 치우지 않는다. 없는 경로는 조용히 건너뛴다.
    #[test]
    fn 자동으로_만든_글이_아니면_치우지_않는다() {
        let (v, i) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut c = ctx(v.path(), i.path());
        let mine = create_note_in(&mut c, "free", "내 빈 글", serde_json::Value::Null).unwrap();
        let gone = prune_link_stubs_in(&mut c, &[mine.clone(), "Free/없는 글.md".into()], true).unwrap();
        assert!(gone.is_empty());
        assert!(v.path().join(&mine).exists());
    }

    /// [되돌리기] — 링크가 아직 본문에 있어도 방금 만든 빈 글은 거둔다.
    #[test]
    fn 되돌리기는_링크가_남아_있어도_거둔다() {
        let (v, i) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut c = ctx(v.path(), i.path());
        let src = create_note_in(&mut c, "free", "원글", serde_json::Value::Null).unwrap();
        write_body(&mut c, &src, "[[회의]]");
        let stub = ensure_link_targets_in(&mut c, &one("회의")).unwrap().remove(0).rel_path;
        assert_eq!(prune_link_stubs_in(&mut c, std::slice::from_ref(&stub), true).unwrap(), vec![stub.clone()]);
        assert!(!v.path().join(&stub).exists());
    }

    /// 만든 글은 색인에 들어가 곧바로 백링크·검색에 잡힌다.
    #[test]
    fn 만든_글은_색인에_들어간다() {
        let (v, i) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut c = ctx(v.path(), i.path());
        let src = create_note_in(&mut c, "free", "원글", serde_json::Value::Null).unwrap();
        write_body(&mut c, &src, "[[회의: 3월]]");
        let stub = ensure_link_targets_in(&mut c, &one("회의: 3월")).unwrap().remove(0).rel_path;
        assert!(c.indexer.note_states().unwrap().contains_key(&stub));
        // 다듬어진 제목이어도 원글이 백링크로 잡힌다 (별칭을 심었다)
        let back = c.indexer.backlinks(&c.vault, &stub).unwrap();
        assert_eq!(back.len(), 1, "{back:?}");
        assert_eq!(back[0].rel_path, src);
    }
}

/// 여러 편을 한 번에 옮긴 결과
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct MovedNotes {
    /// 옮긴 노트 (옛 rel → 새 rel)
    pub moved: Vec<MovedNote>,
    /// 옮기지 못한 노트와 까닭 — 나머지는 옮긴 대로다
    pub skipped: Vec<SkippedNote>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SkippedNote {
    pub rel_path: String,
    pub reason: String,
}

/// 노트 여러 편을 한 번에 다른 분류로 옮긴다.
///
/// `move_note`를 편수만큼 부르지 않는 까닭: 편마다 vault 전체를 훑어 경로 링크를 고친다.
/// 여기서는 파일을 다 옮긴 뒤 한 번만 훑고, 색인도 한 번에 따라잡는다. 한 편이 안 돼도
/// 나머지는 옮기고 못 옮긴 것을 까닭과 함께 돌려준다. 진행은 `relocate-progress`.
#[tauri::command]
#[specta::specta]
pub async fn move_notes(
    app: tauri::AppHandle,
    rel_paths: Vec<String>,
    new_type_id: String,
) -> Result<MovedNotes, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut report = relocate_reporter(&app);
        with_ctx_write(&state, |c| move_notes_in(c, &rel_paths, &new_type_id, &mut report))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn move_notes_in(
    c: &mut Ctx,
    rel_paths: &[String],
    new_type_id: &str,
    report: RelocateReport<'_>,
) -> Result<MovedNotes, yamcha_core::CoreError> {
    let r = c
        .vault
        .move_notes_with(rel_paths, new_type_id, &mut |d, t| report("links", d, t))?;
    catch_up_moves(c, &r.moved, &r.rewritten, &r.warnings, &mut |d, t| report("index", d, t));
    for (rel, why) in &r.skipped {
        crate::applog::warn(format!("옮기지 못한 노트 — {rel}: {why}"));
    }
    Ok(MovedNotes {
        moved: r.moved.into_iter().map(|(from, to)| MovedNote { from, to }).collect(),
        skipped: r
            .skipped
            .into_iter()
            .map(|(rel_path, reason)| SkippedNote { rel_path, reason })
            .collect(),
    })
}

#[cfg(test)]
mod move_notes_tests {
    use super::*;
    use std::path::Path;

    fn ctx(vault_root: &Path, index_root: &Path) -> Ctx {
        Ctx {
            vault: Vault::open(vault_root).unwrap(),
            indexer: Indexer::open(&index_root.join("index.db")).unwrap(),
            search: SearchEngine::open(&index_root.join("search")).unwrap(),
            todo_cache: dashboard::TodoCache::default(),
        }
    }

    /// 옮긴 뒤 색인이 따라온다 — 옛 경로는 빠지고 새 경로가 들어가며, 경로 링크를 고쳐 쓴
    /// 글의 백링크도 새 자리를 가리킨다.
    #[test]
    fn 여러_편을_옮기면_색인이_따라온다() {
        let (v, i) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut c = ctx(v.path(), i.path());
        let a = create_note_in(&mut c, "free", "가", serde_json::Value::Null).unwrap();
        let b = create_note_in(&mut c, "free", "나", serde_json::Value::Null).unwrap();
        let book = create_note_in(&mut c, "book", "어떤 책", serde_json::Value::Null).unwrap();
        let watcher = create_note_in(&mut c, "writing", "지켜보는 글", serde_json::Value::Null).unwrap();
        let fm = c.vault.read_note(&watcher).unwrap().frontmatter;
        save_note_in(&mut c, &watcher, fm, "[[Free/가]]", None).unwrap();

        let r = move_notes_in(&mut c, &[a.clone(), book.clone(), b.clone()], "writing", &mut |_, _, _| {})
            .unwrap();
        assert_eq!(r.moved.len(), 2);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].rel_path, book);

        let states = c.indexer.note_states().unwrap();
        for m in &r.moved {
            assert!(!states.contains_key(&m.from), "옛 경로가 색인에 남았다: {}", m.from);
            assert!(states.contains_key(&m.to), "새 경로가 색인에 없다: {}", m.to);
        }
        let back = c.indexer.backlinks(&c.vault, "Writing/가.md").unwrap();
        assert_eq!(back.len(), 1, "{back:?}");
        assert_eq!(back[0].rel_path, watcher);
    }
}
