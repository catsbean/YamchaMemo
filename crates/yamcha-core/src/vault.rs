//! Vault: 마크다운 파일 저장소. 파일 IO, 파일명 규칙, 노트 CRUD, 타입 관리, 첨부파일.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::CoreError;
use crate::parse;
use crate::schema::{builtin_defs, normalize_frontmatter, Builtin, EntryKind, TypeDef};
use crate::template;

/// 휴지통에 있는 삭제된 노트 한 건
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TrashItem {
    /// 휴지통 내 실제 파일명 (복구 시 키로 사용): `{YYYYMMDD-HHMMSS}_{원래이름}.md`
    pub file_name: String,
    /// 삭제 전 원래 파일 이름 (스탬프 접두어 제거)
    pub original_name: String,
    /// 삭제 시각 (읽기 좋은 형식)
    pub deleted_at: String,
}

/// 휴지통 파일명(`{YYYYMMDD-HHMMSS}_이름.md`)의 스탬프를 삭제 시각으로 파싱. 형식이 다르면 None.
fn parse_trash_datetime(file_name: &str) -> Option<chrono::DateTime<Local>> {
    let stamp = file_name.split_once('_')?.0;
    let naive = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()?;
    naive.and_local_timezone(Local).single()
}

/// "YYYYMMDD-HHMMSS" 스탬프를 "YYYY-MM-DD HH:MM"로 변환. 형식이 다르면 원문 반환.
fn format_trash_stamp(stamp: &str) -> String {
    if stamp.len() == 15 && stamp.as_bytes().get(8) == Some(&b'-') {
        format!(
            "{}-{}-{} {}:{}",
            &stamp[0..4],
            &stamp[4..6],
            &stamp[6..8],
            &stamp[9..11],
            &stamp[11..13],
        )
    } else {
        stamp.to_string()
    }
}

/// 사용자 정의 타입 정의 파일 (vault 루트, 미러링 대상에 포함)
const TYPES_FILE: &str = "_types.json";

/// 사이드바/대시보드 목록용 요약 정보
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NoteSummary {
    pub rel_path: String,
    pub note_type: String,
    pub title: String,
    pub date: String,
    pub tags: Vec<String>,
    /// 본문 글자 수 (공백 제외) — 글쓰기 진행 표시용
    pub char_count: u32,
    /// 독서기록(콜아웃) 엔트리 수 — 책의 기록 활동 표시용
    pub entry_count: u32,
    /// frontmatter 전체 (책장 뷰 등이 genre/status/cover 등을 사용)
    pub frontmatter: Value,
}

/// 편집기용 노트 전체 내용
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NoteContent {
    pub rel_path: String,
    pub note_type: String,
    pub frontmatter: Value,
    pub body: String,
}

/// 인덱싱용으로 완전히 파싱된 노트
#[derive(Debug, Clone)]
pub struct ParsedNote {
    pub rel_path: String,
    pub note_type: String,
    pub title: String,
    pub stem: String,
    pub date: String,
    /// frontmatter tags + 본문 인라인 #태그 (중복 제거)
    pub tags: Vec<String>,
    /// 본문 + frontmatter 문자열 값에서 추출한 위키링크 타깃
    pub links: Vec<String>,
    pub body: String,
    pub frontmatter_json: String,
}

pub struct Vault {
    root: PathBuf,
    types: Vec<TypeDef>,
    history: crate::history::HistoryPolicy,
}

impl Vault {
    /// vault를 열고 타입 정의를 로드하고 폴더 구조를 보장한다.
    pub fn open(root: impl Into<PathBuf>) -> Result<Vault, CoreError> {
        let root: PathBuf = root.into();
        let mut types = builtin_defs();
        // 사용자 정의 타입 로드 (깨진 파일은 무시)
        let types_path = root.join(TYPES_FILE);
        if let Ok(raw) = fs::read_to_string(&types_path) {
            if let Ok(customs) = serde_json::from_str::<Vec<TypeDef>>(&raw) {
                for mut c in customs {
                    c.builtin = false;
                    if !types.iter().any(|t| t.id == c.id || t.folder == c.folder) {
                        types.push(c);
                    }
                }
            }
        }
        let vault = Vault {
            root,
            types,
            history: crate::history::HistoryPolicy::default(),
        };
        vault.ensure_layout()?;
        // 옛 독서기록 파일을 책 파일로 통합 (있을 때만, 실패해도 vault 열기는 계속)
        let _ = vault.migrate_readings();
        Ok(vault)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn history_policy(&self) -> crate::history::HistoryPolicy {
        self.history
    }

    pub fn set_history_policy(&mut self, policy: crate::history::HistoryPolicy) {
        self.history = policy;
    }

    /// 파일을 바꾸기 직전에 현재 상태를 스냅샷으로 남긴다 (실패해도 저장은 계속한다).
    /// `incoming`은 곧 쓰일 새 내용 — 대량 삭제 판정에 쓰인다.
    pub(crate) fn snapshot_before(&self, rel: &str, incoming: Option<&str>) {
        let _ = crate::history::snapshot(self, rel, incoming, self.history);
    }

    /// 외부(점검 수리 등)에서 명시적으로 스냅샷을 요청할 때
    pub fn snapshot_before_change(&self, rel: &str) -> Result<(), CoreError> {
        crate::history::snapshot(self, rel, None, self.history).map(|_| ())
    }

    /// 전체 타입 정의 (내장 + 사용자 정의)
    pub fn types(&self) -> &[TypeDef] {
        &self.types
    }

    pub fn def_by_id(&self, id: &str) -> Option<&TypeDef> {
        self.types.iter().find(|t| t.id == id)
    }

    pub(crate) fn def_by_folder(&self, folder: &str) -> Option<&TypeDef> {
        self.types.iter().find(|t| t.folder == folder)
    }

    fn ensure_layout(&self) -> Result<(), CoreError> {
        for t in &self.types {
            fs::create_dir_all(self.root.join(&t.folder))?;
        }
        fs::create_dir_all(self.root.join("_attachments"))?;
        fs::create_dir_all(self.root.join(".yamcha").join("trash"))?;
        Ok(())
    }

    // ---------- 사용자 정의 타입 ----------

    /// 사용자 정의 타입 추가. label로 id/folder를 만들고 `_types.json`에 저장한다.
    pub fn add_custom_type(
        &mut self,
        label: &str,
        fields: Vec<crate::schema::FieldDef>,
        template: &str,
    ) -> Result<TypeDef, CoreError> {
        let label = label.trim();
        if label.is_empty() {
            return Err(CoreError::Invalid("분류 이름을 입력하세요".into()));
        }
        let folder = Self::sanitize_filename(label);
        let id = folder.clone();
        if self
            .types
            .iter()
            .any(|t| t.id == id || t.folder == folder || t.label == label)
        {
            return Err(CoreError::Invalid(format!(
                "이미 존재하는 분류입니다: {label}"
            )));
        }
        // 공통 필드(date/tags)를 앞에 보장
        let mut all_fields = vec![
            crate::schema::FieldDef::new("date", "날짜", crate::schema::FieldKind::Date, true),
            crate::schema::FieldDef::new("tags", "태그", crate::schema::FieldKind::Tags, true),
        ];
        for f in fields {
            if f.name != "date" && f.name != "tags" && f.name != "type" && !f.name.is_empty() {
                all_fields.push(f);
            }
        }
        let def = TypeDef {
            id,
            label: label.to_string(),
            folder,
            fields: all_fields,
            template: template.to_string(),
            builtin: false,
        };
        self.types.push(def.clone());
        self.save_custom_types()?;
        self.ensure_layout()?;
        Ok(def)
    }

    /// 사용자 정의 분류의 본문 템플릿을 수정한다 (생성 후에도 언제든 변경 가능).
    /// 이미 만들어진 노트에는 영향을 주지 않고, 앞으로 이 분류로 만드는 새 노트부터 적용된다.
    pub fn update_custom_type_template(
        &mut self,
        id: &str,
        template: &str,
    ) -> Result<TypeDef, CoreError> {
        let def = self
            .types
            .iter_mut()
            .find(|t| !t.builtin && t.id == id)
            .ok_or_else(|| CoreError::Invalid(format!("수정할 분류가 없습니다: {id}")))?;
        def.template = template.to_string();
        let updated = def.clone();
        self.save_custom_types()?;
        Ok(updated)
    }

    /// 사용자 정의 타입 제거 — 내부 노트는 자유노트로 이동한다.
    pub fn remove_custom_type(&mut self, id: &str) -> Result<(), CoreError> {
        let def = self
            .types
            .iter()
            .find(|t| !t.builtin && t.id == id)
            .cloned()
            .ok_or_else(|| CoreError::Invalid(format!("삭제할 분류가 없습니다: {id}")))?;

        // 노트를 Free/로 이동하고 type frontmatter를 free로 갱신
        let free_dir = self.root.join(Builtin::Free.folder());
        let moved: Vec<String> = self
            .list_notes()?
            .into_iter()
            .filter(|n| n.note_type == id)
            .map(|n| n.rel_path)
            .collect();
        for rel in moved {
            let abs = self.abs(&rel)?;
            let stem = Path::new(&rel)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "무제".into());
            let dest = self.unique_path(&free_dir, &stem);
            fs::rename(&abs, &dest)?;
            let dest_rel = self.rel_of(&dest);
            // save_note가 type을 free로 normalize
            let note = self.read_note(&dest_rel)?;
            self.save_note(&dest_rel, note.frontmatter, &note.body)?;
        }

        // 폴더 정리: _index.md 제거 후 비어 있으면 삭제 (남은 파일 있으면 유지)
        let folder_abs = self.root.join(&def.folder);
        let _ = fs::remove_file(folder_abs.join("_index.md"));
        let _ = fs::remove_dir(&folder_abs);

        self.types.retain(|t| t.builtin || t.id != id);
        self.save_custom_types()?;
        crate::index_file::update_index(self, Builtin::Free.id())
    }

    // ---------- 제목 변경 ----------

    /// 모든 노트에서 `[[old]]` 링크를 `[[new]]`로 치환 (본문·frontmatter 원문 기준)
    fn replace_links(&self, olds: &[String], new: &str) -> Result<(), CoreError> {
        for n in self.list_notes()? {
            let abs = self.abs(&n.rel_path)?;
            let Ok(content) = fs::read_to_string(&abs) else {
                continue;
            };
            let mut updated = content.clone();
            for old in olds {
                if old == new || old.is_empty() {
                    continue;
                }
                updated = updated
                    .replace(&format!("[[{old}]]"), &format!("[[{new}]]"))
                    .replace(&format!("[[{old}|"), &format!("[[{new}|"))
                    .replace(&format!("[[{old}#"), &format!("[[{new}#"));
            }
            if updated != content {
                self.atomic_write(&abs, &updated)?;
            }
        }
        Ok(())
    }

    /// 노트 제목 변경: 파일명 변경 + frontmatter title 갱신 + 다른 노트의 위키링크 일괄 수정.
    /// 책은 연결된 독서기록 파일명도 함께 바뀐다. 새 rel 경로를 반환.
    pub fn rename_note(&self, rel: &str, new_title: &str) -> Result<String, CoreError> {
        let new_title = new_title.trim();
        if new_title.is_empty() {
            return Err(CoreError::Invalid("새 제목을 입력하세요".into()));
        }
        let note = self.read_note(rel)?;
        let type_id = note.note_type.clone();
        if type_id == Builtin::Daily.id() {
            return Err(CoreError::Invalid(
                "데일리노트는 제목을 바꿀 수 없습니다".into(),
            ));
        }
        let fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        let old_stem = Path::new(rel)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_title = fm
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .unwrap_or_else(|| old_stem.clone());

        // 새 파일명: 정보노트는 날짜 접두어 유지
        let new_stem = if type_id == Builtin::Info.id() {
            let date_prefix = old_stem
                .get(..10)
                .filter(|p| p.chars().enumerate().all(|(i, c)| {
                    if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() }
                }))
                .map(String::from)
                .unwrap_or_else(|| {
                    fm.get("date")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .unwrap_or_else(Self::today)
                });
            format!("{date_prefix} {}", Self::sanitize_filename(new_title))
        } else {
            Self::sanitize_filename(new_title)
        };

        // 파일 이동
        let abs_old = self.abs(rel)?;
        let dir = abs_old
            .parent()
            .ok_or_else(|| CoreError::Invalid("잘못된 경로".into()))?
            .to_path_buf();
        let mut new_rel = rel.to_string();
        if new_stem != old_stem {
            let dest = self.unique_path(&dir, &new_stem);
            fs::rename(&abs_old, &dest)?;
            new_rel = self.rel_of(&dest);
        }

        // frontmatter title 갱신 (save_note가 인덱스 파일도 갱신)
        let mut fm2 = fm.clone();
        fm2.insert("title".into(), json!(new_title));
        self.save_note(&new_rel, Value::Object(fm2), &note.body)?;

        // 링크 일괄 치환: 옛 파일명·옛 제목 → 새 파일명
        let final_stem = Path::new(&new_rel)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or(new_stem);
        self.replace_links(&[old_stem, old_title.clone()], &final_stem)?;
        Ok(new_rel)
    }

    fn save_custom_types(&self) -> Result<(), CoreError> {
        let customs: Vec<&TypeDef> = self.types.iter().filter(|t| !t.builtin).collect();
        let json = serde_json::to_string_pretty(&customs)
            .map_err(|e| CoreError::Invalid(e.to_string()))?;
        fs::write(self.root.join(TYPES_FILE), json)?;
        Ok(())
    }

    // ---------- 공통 유틸 ----------

    pub fn today() -> String {
        Local::now().format("%Y-%m-%d").to_string()
    }

    /// Windows 금지 문자 치환 + 후행 마침표/공백 제거
    pub fn sanitize_filename(name: &str) -> String {
        let mut s: String = name
            .chars()
            .map(|c| match c {
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
                '\n' | '\r' | '\t' => ' ',
                c => c,
            })
            .collect();
        while s.contains("  ") {
            s = s.replace("  ", " ");
        }
        let s = s.trim().trim_end_matches('.').trim().to_string();
        if s.is_empty() {
            "무제".to_string()
        } else {
            s
        }
    }

    pub(crate) fn abs(&self, rel: &str) -> Result<PathBuf, CoreError> {
        if rel.split(['/', '\\']).any(|seg| seg == "..") {
            return Err(CoreError::Invalid(format!("잘못된 경로: {rel}")));
        }
        Ok(self.root.join(rel))
    }

    /// 원자적 쓰기: 같은 디렉토리에 임시 파일을 쓰고 rename
    pub(crate) fn atomic_write(&self, abs: &Path, content: &str) -> Result<(), CoreError> {
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = abs.with_extension("md.tmp");
        fs::write(&tmp, content)?;
        if abs.exists() {
            fs::remove_file(abs)?;
        }
        fs::rename(&tmp, abs)?;
        Ok(())
    }

    /// rel 경로에서 타입 id 추론 (최상위 폴더 기준)
    pub(crate) fn type_of_rel(&self, rel: &str) -> Result<String, CoreError> {
        let first = rel.split(['/', '\\']).next().unwrap_or("");
        self.def_by_folder(first)
            .map(|d| d.id.clone())
            .ok_or_else(|| CoreError::Invalid(format!("알 수 없는 노트 폴더: {rel}")))
    }

    // ---------- 목록 ----------

    pub fn list_notes(&self) -> Result<Vec<NoteSummary>, CoreError> {
        let mut out = Vec::new();
        for t in &self.types {
            let dir = self.root.join(&t.folder);
            self.collect_notes(&dir, &t.id, &mut out)?;
        }
        out.sort_by(|a, b| b.date.cmp(&a.date).then(a.title.cmp(&b.title)));
        Ok(out)
    }

    fn collect_notes(
        &self,
        dir: &Path,
        type_id: &str,
        out: &mut Vec<NoteSummary>,
    ) -> Result<(), CoreError> {
        if !dir.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                self.collect_notes(&path, type_id, out)?;
            } else if name.ends_with(".md") && !name.starts_with('_') {
                if let Ok(summary) = self.summarize(&path, type_id) {
                    out.push(summary);
                }
            }
        }
        Ok(())
    }

    fn summarize(&self, abs: &Path, type_id: &str) -> Result<NoteSummary, CoreError> {
        let content = fs::read_to_string(abs)?;
        let (fm_str, body) = parse::split_frontmatter(&content);
        let char_count = body.chars().filter(|c| !c.is_whitespace()).count() as u32;
        let entry_count = body
            .lines()
            .filter(|l| l.trim_start().starts_with("> [!"))
            .count() as u32;
        let fm = fm_str
            .map(parse::parse_frontmatter)
            .transpose()?
            .unwrap_or_default();
        let stem = abs
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let title = fm
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or(stem);
        let date = fm
            .get("date")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let tags = fm
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let rel = abs
            .strip_prefix(&self.root)
            .map_err(|_| CoreError::Invalid("경로가 vault 밖에 있습니다".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        Ok(NoteSummary {
            rel_path: rel,
            note_type: type_id.to_string(),
            title,
            date,
            tags,
            char_count,
            entry_count,
            frontmatter: Value::Object(fm),
        })
    }

    // ---------- 읽기/저장/삭제 ----------

    pub fn read_note(&self, rel: &str) -> Result<NoteContent, CoreError> {
        let abs = self.abs(rel)?;
        if !abs.exists() {
            return Err(CoreError::NotFound(rel.to_string()));
        }
        let t = self.type_of_rel(rel)?;
        let content = fs::read_to_string(&abs)?;
        let (fm_str, body) = parse::split_frontmatter(&content);
        let fm = fm_str
            .map(parse::parse_frontmatter)
            .transpose()?
            .unwrap_or_default();
        Ok(NoteContent {
            rel_path: rel.to_string(),
            note_type: t,
            frontmatter: Value::Object(fm),
            body: body.to_string(),
        })
    }

    /// 파싱하지 않고 파일 원문을 그대로 읽는다 (frontmatter가 깨진 파일 수리용).
    pub fn read_raw(&self, rel: &str) -> Result<String, CoreError> {
        let abs = self.abs(rel)?;
        if !abs.exists() {
            return Err(CoreError::NotFound(rel.to_string()));
        }
        Ok(fs::read_to_string(&abs)?)
    }

    /// 파일 원문을 그대로 쓴다 (정규화·검증 없음 — 수리 화면 전용).
    pub fn write_raw(&self, rel: &str, content: &str) -> Result<(), CoreError> {
        let abs = self.abs(rel)?;
        if !abs.exists() {
            return Err(CoreError::NotFound(rel.to_string()));
        }
        self.atomic_write(&abs, content)
    }

    pub fn save_note(&self, rel: &str, frontmatter: Value, body: &str) -> Result<(), CoreError> {
        let abs = self.abs(rel)?;
        let t = self.type_of_rel(rel)?;
        let mut fm = match frontmatter {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        normalize_frontmatter(&mut fm, &t, &Self::today());
        let content = parse::compose(&fm, body)?;
        self.snapshot_before(rel, Some(&content));
        self.atomic_write(&abs, &content)?;
        crate::index_file::update_index(self, &t)
    }

    /// frontmatter 일부 필드만 갱신 (본문 유지) — 목록 뷰 인라인 편집용
    pub fn update_frontmatter(&self, rel: &str, patch: Value) -> Result<(), CoreError> {
        let note = self.read_note(rel)?;
        let mut fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        if let Value::Object(patch) = patch {
            for (k, v) in patch {
                if v.is_null() {
                    fm.remove(&k);
                } else {
                    fm.insert(k, v);
                }
            }
        }
        self.save_note(rel, Value::Object(fm), &note.body)
    }

    pub fn delete_note(&self, rel: &str) -> Result<(), CoreError> {
        let abs = self.abs(rel)?;
        if !abs.exists() {
            return Err(CoreError::NotFound(rel.to_string()));
        }
        let t = self.type_of_rel(rel)?;
        let trash = self.root.join(".yamcha").join("trash");
        fs::create_dir_all(&trash)?;
        let stamp = Local::now().format("%Y%m%d-%H%M%S");
        let name = abs
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "note.md".into());
        fs::rename(&abs, trash.join(format!("{stamp}_{name}")))?;
        crate::index_file::update_index(self, &t)
    }

    /// 휴지통(.yamcha/trash) 목록 — 최근 삭제가 위로.
    pub fn list_trash(&self) -> Result<Vec<TrashItem>, CoreError> {
        let trash = self.root.join(".yamcha").join("trash");
        let mut out = Vec::new();
        if !trash.is_dir() {
            return Ok(out);
        }
        for entry in fs::read_dir(&trash)? {
            let entry = entry?;
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !path.is_file() || !file_name.ends_with(".md") {
                continue;
            }
            let (stamp, original) = match file_name.split_once('_') {
                Some((s, rest)) => (s.to_string(), rest.to_string()),
                None => (String::new(), file_name.clone()),
            };
            out.push(TrashItem {
                file_name,
                original_name: original,
                deleted_at: format_trash_stamp(&stamp),
            });
        }
        // 파일명이 시간 스탬프로 시작하므로 내림차순 = 최근순
        out.sort_by(|a, b| b.file_name.cmp(&a.file_name));
        Ok(out)
    }

    /// 휴지통에서 노트를 복구한다. frontmatter의 type으로 원래 폴더를 정하고
    /// (타입이 사라졌거나 파싱 실패면 자유노트로), 이름 충돌은 unique_path로 피한다.
    /// 반환: 복구된 노트의 rel 경로.
    pub fn restore_trash(&self, file_name: &str) -> Result<String, CoreError> {
        if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
            return Err(CoreError::Invalid(format!("잘못된 파일명: {file_name}")));
        }
        let src = self.root.join(".yamcha").join("trash").join(file_name);
        if !src.is_file() {
            return Err(CoreError::NotFound(file_name.to_string()));
        }
        let content = fs::read_to_string(&src)?;
        let (fm_str, _body) = parse::split_frontmatter(&content);
        let fm = fm_str
            .map(parse::parse_frontmatter)
            .transpose()
            .unwrap_or(None)
            .unwrap_or_default();
        let type_id = fm.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let (folder, resolved_type) = match self.def_by_id(type_id) {
            Some(d) => (d.folder.clone(), d.id.clone()),
            None => (
                Builtin::Free.folder().to_string(),
                Builtin::Free.id().to_string(),
            ),
        };
        let dir = self.root.join(&folder);
        fs::create_dir_all(&dir)?;
        let original = file_name
            .split_once('_')
            .map(|(_, r)| r.to_string())
            .unwrap_or_else(|| file_name.to_string());
        let stem = original.strip_suffix(".md").unwrap_or(&original);
        let dest = self.unique_path(&dir, stem);
        fs::rename(&src, &dest)?;
        let rel = self.rel_of(&dest);
        crate::index_file::update_index(self, &resolved_type)?;
        Ok(rel)
    }

    /// 휴지통에서 retention_days보다 오래된 항목을 영구 삭제한다. 0이면 아무것도 안 함.
    /// 스탬프를 못 읽는 파일은 안전하게 남긴다. 반환: 삭제한 개수.
    pub fn purge_trash(&self, retention_days: u32) -> Result<u32, CoreError> {
        if retention_days == 0 {
            return Ok(0);
        }
        let trash = self.root.join(".yamcha").join("trash");
        if !trash.is_dir() {
            return Ok(0);
        }
        let cutoff = Local::now() - chrono::Duration::days(retention_days as i64);
        let mut removed = 0;
        for entry in fs::read_dir(&trash)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(deleted_at) = parse_trash_datetime(&name) {
                if deleted_at < cutoff && fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    // ---------- 생성 ----------

    pub(crate) fn unique_path(&self, dir: &Path, stem: &str) -> PathBuf {
        let candidate = dir.join(format!("{stem}.md"));
        if !candidate.exists() {
            return candidate;
        }
        for i in 2.. {
            let candidate = dir.join(format!("{stem} ({i}).md"));
            if !candidate.exists() {
                return candidate;
            }
        }
        unreachable!()
    }

    pub(crate) fn rel_of(&self, abs: &Path) -> String {
        abs.strip_prefix(&self.root)
            .expect("생성 경로는 항상 vault 내부")
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// 데일리/자유 커스텀 템플릿 파일 경로 (kind: "daily"|"free")
    fn template_file_path(&self, kind: &str) -> Option<PathBuf> {
        let name = match kind {
            "daily" => "daily.md",
            "free" => "free.md",
            _ => return None,
        };
        Some(self.root.join(".yamcha").join("templates").join(name))
    }

    fn builtin_for_kind(kind: &str) -> Option<Builtin> {
        match kind {
            "daily" => Some(Builtin::Daily),
            "free" => Some(Builtin::Free),
            _ => None,
        }
    }

    /// 생성 시 쓸 본문 템플릿: 커스텀 파일이 있으면 그 내용, 없으면 내장 기본값.
    /// frontmatter에는 영향을 주지 않는다(본문만).
    fn body_template(&self, b: Builtin) -> String {
        let kind = match b {
            Builtin::Daily => "daily",
            Builtin::Free => "free",
            _ => return template::builtin_body_template(b).to_string(),
        };
        if let Some(p) = self.template_file_path(kind) {
            if let Ok(s) = fs::read_to_string(&p) {
                return s;
            }
        }
        template::builtin_body_template(b).to_string()
    }

    /// 설정 화면용: 커스텀 템플릿이 있으면 그 내용, 없으면 내장 기본값을 돌려준다.
    pub fn read_body_template_file(&self, kind: &str) -> Result<String, CoreError> {
        let b = Self::builtin_for_kind(kind)
            .ok_or_else(|| CoreError::Invalid(format!("알 수 없는 템플릿: {kind}")))?;
        Ok(self.body_template(b))
    }

    /// 커스텀 본문 템플릿 저장. 내용이 비면 파일을 지워 내장 기본값으로 되돌린다.
    pub fn write_body_template_file(&self, kind: &str, content: &str) -> Result<(), CoreError> {
        let path = self
            .template_file_path(kind)
            .ok_or_else(|| CoreError::Invalid(format!("알 수 없는 템플릿: {kind}")))?;
        if content.trim().is_empty() {
            if path.exists() {
                fs::remove_file(&path)?;
            }
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;
        Ok(())
    }

    /// 노트 생성. `fields`는 타입별 frontmatter 초기값.
    /// 생성된 노트의 rel 경로를 반환한다.
    pub fn create_note(
        &self,
        type_id: &str,
        title: &str,
        fields: Value,
    ) -> Result<String, CoreError> {
        let today = Self::today();
        let def = self
            .def_by_id(type_id)
            .ok_or_else(|| CoreError::Invalid(format!("알 수 없는 분류: {type_id}")))?
            .clone();
        let mut fm = match fields {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        normalize_frontmatter(&mut fm, type_id, &today);

        let (abs, body): (PathBuf, String) = match Builtin::from_id(type_id) {
            Some(Builtin::Daily) => return self.open_daily(&today),
            Some(Builtin::Book) => {
                let title = Self::sanitize_filename(title);
                fm.insert("title".into(), json!(title));
                let abs = self.unique_path(&self.root.join(&def.folder), &title);
                (abs, template::render_template(&def.template, &today, &title))
            }
            Some(Builtin::Info) => {
                let title = Self::sanitize_filename(title);
                let stem = format!("{today} {title}");
                let abs = self.unique_path(&self.root.join(&def.folder), &stem);
                (abs, template::render_template(&def.template, &today, &title))
            }
            Some(Builtin::Free) | Some(Builtin::Writing) | None => {
                // 자유노트·글쓰기·사용자 정의 타입은 제목 = 파일명
                let title = Self::sanitize_filename(title);
                if title != "무제" {
                    fm.insert("title".into(), json!(title));
                }
                // 글쓰기: 시작일 = 생성일 자동 채움 (없을 때만)
                if type_id == Builtin::Writing.id() && !fm.contains_key("started") {
                    fm.insert("started".into(), json!(today));
                }
                // 자유노트는 사용자 템플릿 우선, 그 외는 타입 정의 템플릿
                let tmpl = if type_id == Builtin::Free.id() {
                    self.body_template(Builtin::Free)
                } else {
                    def.template.clone()
                };
                let abs = self.unique_path(&self.root.join(&def.folder), &title);
                (abs, template::render_template(&tmpl, &today, &title))
            }
        };

        let content = parse::compose(&fm, &body)?;
        self.atomic_write(&abs, &content)?;
        crate::index_file::update_index(self, type_id)?;
        Ok(self.rel_of(&abs))
    }

    /// 오늘의 데일리노트 (없으면 템플릿으로 생성)
    pub fn open_daily(&self, date: &str) -> Result<String, CoreError> {
        let (year, month) = (&date[..4], &date[5..7]);
        let dir = self.root.join(Builtin::Daily.folder()).join(year).join(month);
        let abs = dir.join(format!("{date}.md"));
        if !abs.exists() {
            let mut fm = Map::new();
            fm.insert("date".into(), json!(date));
            normalize_frontmatter(&mut fm, Builtin::Daily.id(), date);
            let tmpl = self.body_template(Builtin::Daily);
            let body = template::render_template(&tmpl, date, date);
            let content = parse::compose(&fm, &body)?;
            self.atomic_write(&abs, &content)?;
            crate::index_file::update_index(self, Builtin::Daily.id())?;
        }
        Ok(self.rel_of(&abs))
    }

    /// 책의 독서기록 = 책 파일 자체. 책이면 그 rel을 그대로 돌려준다.
    pub fn reading_for_book(&self, book_rel: &str) -> Result<String, CoreError> {
        let book = self.read_note(book_rel)?;
        if book.note_type != Builtin::Book.id() {
            return Err(CoreError::Invalid("book 노트가 아닙니다".into()));
        }
        Ok(book_rel.to_string())
    }

    /// 인덱싱용 완전 파싱
    pub fn parse_full(&self, rel: &str) -> Result<ParsedNote, CoreError> {
        let note = self.read_note(rel)?;
        let fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        let stem = Path::new(rel)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let title = fm
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .unwrap_or_else(|| stem.clone());
        let date = fm
            .get("date")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let mut tags: Vec<String> = fm
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        for t in crate::parse::extract_inline_tags(&note.body) {
            if !tags.contains(&t) {
                tags.push(t);
            }
        }

        let mut links = crate::parse::extract_wikilinks(&note.body);
        for v in fm.values() {
            if let Some(s) = v.as_str() {
                for l in crate::parse::extract_wikilinks(s) {
                    if !links.contains(&l) {
                        links.push(l);
                    }
                }
            }
        }

        Ok(ParsedNote {
            rel_path: rel.to_string(),
            note_type: note.note_type,
            title,
            stem,
            date,
            tags,
            links,
            body: note.body,
            frontmatter_json: Value::Object(fm).to_string(),
        })
    }

    /// 독서기록 엔트리 추가 — 책 파일의 `## 기록` 섹션 끝에 콜아웃을 누적한다.
    pub fn append_reading_entry(
        &self,
        rel: &str,
        kind: EntryKind,
        text: &str,
    ) -> Result<NoteContent, CoreError> {
        let note = self.read_note(rel)?;
        if note.note_type != Builtin::Book.id() {
            return Err(CoreError::Invalid("책 노트가 아닙니다".into()));
        }
        let (intro, records) = template::split_book_body(&note.body);
        let block = template::reading_entry_block(&records, &Self::today(), kind, text);
        let new_records = format!("{}{block}", records.trim_end());
        let new_body = template::compose_book_body(&intro, &new_records);
        let fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        let content = parse::compose(&fm, &new_body)?;
        self.snapshot_before(rel, Some(&content));
        self.atomic_write(&self.abs(rel)?, &content)?;
        self.read_note(rel)
    }

    // ---------- 독서기록 → 책 통합 마이그레이션 ----------

    /// 옛 `Reading/` 폴더의 독서기록 파일을 해당 책의 `## 기록` 섹션으로 병합한다.
    /// 병합 후 독서기록 파일은 휴지통으로 옮기고, 빈 폴더는 삭제한다.
    pub fn migrate_readings(&self) -> Result<u32, CoreError> {
        let reading_dir = self.root.join("Reading");
        if !reading_dir.exists() {
            return Ok(0);
        }
        let trash = self.root.join(".yamcha").join("trash");
        fs::create_dir_all(&trash)?;
        let mut migrated = 0u32;

        let entries: Vec<PathBuf> = fs::read_dir(&reading_dir)?
            .flatten()
            .map(|e| e.path())
            .collect();
        for path in entries {
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if !name.ends_with(".md") || name.starts_with('_') {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let (fm_str, r_body) = parse::split_frontmatter(&content);
            let r_fm = fm_str
                .map(parse::parse_frontmatter)
                .transpose()
                .unwrap_or(None)
                .unwrap_or_default();

            // 책 제목: book 링크 우선, 없으면 파일명(독서기록_제목_저자)에서 추출
            let title = r_fm
                .get("book")
                .and_then(|v| v.as_str())
                .and_then(|s| {
                    s.trim()
                        .strip_prefix("[[")
                        .and_then(|s| s.strip_suffix("]]"))
                })
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    let stem = name.trim_end_matches(".md");
                    let rest = stem.strip_prefix("독서기록_").unwrap_or(stem);
                    rest.split('_').next().unwrap_or(rest).to_string()
                });
            let author = r_fm
                .get("author")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let r_tags = r_fm.get("tags").cloned();

            // 책 찾기 (제목/파일명 일치), 없으면 생성
            let book_rel = self
                .list_notes()?
                .into_iter()
                .find(|n| {
                    n.note_type == Builtin::Book.id()
                        && (n.title == title
                            || n.rel_path.trim_end_matches(".md").ends_with(&title))
                })
                .map(|n| n.rel_path);
            let book_rel = match book_rel {
                Some(r) => r,
                None => self.create_note(
                    Builtin::Book.id(),
                    &title,
                    json!({ "author": author, "status": "finished" }),
                )?,
            };

            // 책 본문의 기록 섹션에 독서기록 본문을 병합
            let book = self.read_note(&book_rel)?;
            let (intro, records) = template::split_book_body(&book.body);
            let add = r_body.trim();
            let new_records = if records.trim().is_empty() {
                add.to_string()
            } else if add.is_empty() {
                records
            } else {
                format!("{}\n\n{}", records.trim_end(), add)
            };
            let new_body = template::compose_book_body(&intro, &new_records);
            // 태그 병합
            let mut bfm = book.frontmatter.as_object().cloned().unwrap_or_default();
            if let Some(Value::Array(rt)) = r_tags {
                let mut existing: Vec<Value> = bfm
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for t in rt {
                    if !existing.contains(&t) {
                        existing.push(t);
                    }
                }
                bfm.insert("tags".into(), Value::Array(existing));
            }
            self.save_note(&book_rel, Value::Object(bfm), &new_body)?;

            // 독서기록 파일 휴지통 이동
            let stamp = Local::now().format("%Y%m%d-%H%M%S");
            let _ = fs::rename(&path, trash.join(format!("{stamp}_migrated_{name}")));
            migrated += 1;
        }

        // 빈 Reading 폴더 정리
        let _ = fs::remove_file(reading_dir.join("_index.md"));
        let _ = fs::remove_dir(&reading_dir);
        Ok(migrated)
    }

    // ---------- 첨부파일 ----------
    //
    // 규칙:
    // - 책 표지: `_attachments/covers/{책제목}.{확장자}` (교체 시 덮어쓰기)
    // - 일반 첨부(이미지/PDF 등): `_attachments/{YYYY-MM}/{원본이름}` (중복 시 " (2)")
    // - 붙여넣은 이미지: `_attachments/{YYYY-MM}/paste-{일시}.{확장자}`

    /// 외부 파일을 책 표지로 복사 → rel 경로 반환
    pub fn attach_cover(&self, book_title: &str, src: &Path) -> Result<String, CoreError> {
        let ext = src
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "png".into());
        let dir = self.root.join("_attachments").join("covers");
        fs::create_dir_all(&dir)?;
        let dest = dir.join(format!("{}.{ext}", Self::sanitize_filename(book_title)));
        fs::copy(src, &dest)?;
        Ok(self.rel_of(&dest))
    }

    /// 이미지 바이트를 책 표지로 저장 (URL 다운로드 등) → rel 경로 반환
    pub fn attach_cover_bytes(
        &self,
        book_title: &str,
        bytes: &[u8],
        ext: &str,
    ) -> Result<String, CoreError> {
        let ext = if ext.is_empty() { "jpg" } else { ext };
        let dir = self.root.join("_attachments").join("covers");
        fs::create_dir_all(&dir)?;
        let dest = dir.join(format!("{}.{ext}", Self::sanitize_filename(book_title)));
        fs::write(&dest, bytes)?;
        Ok(self.rel_of(&dest))
    }

    /// 외부 파일을 일반 첨부로 복사 → rel 경로 반환
    pub fn import_attachment(&self, src: &Path) -> Result<String, CoreError> {
        let month = Local::now().format("%Y-%m").to_string();
        let dir = self.root.join("_attachments").join(&month);
        fs::create_dir_all(&dir)?;
        let stem = src
            .file_stem()
            .map(|s| Self::sanitize_filename(&s.to_string_lossy()))
            .unwrap_or_else(|| "첨부".into());
        let ext = src
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mut dest = dir.join(if ext.is_empty() {
            stem.clone()
        } else {
            format!("{stem}.{ext}")
        });
        let mut i = 2;
        while dest.exists() {
            dest = dir.join(if ext.is_empty() {
                format!("{stem} ({i})")
            } else {
                format!("{stem} ({i}).{ext}")
            });
            i += 1;
        }
        fs::copy(src, &dest)?;
        Ok(self.rel_of(&dest))
    }

    /// 붙여넣은 이미지 바이트 저장 → rel 경로 반환
    pub fn save_pasted_image(&self, bytes: &[u8], ext: &str) -> Result<String, CoreError> {
        let month = Local::now().format("%Y-%m").to_string();
        let dir = self.root.join("_attachments").join(&month);
        fs::create_dir_all(&dir)?;
        let stamp = Local::now().format("%Y%m%d-%H%M%S");
        let ext = if ext.is_empty() { "png" } else { ext };
        let mut dest = dir.join(format!("paste-{stamp}.{ext}"));
        let mut i = 2;
        while dest.exists() {
            dest = dir.join(format!("paste-{stamp} ({i}).{ext}"));
            i += 1;
        }
        fs::write(&dest, bytes)?;
        Ok(self.rel_of(&dest))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{FieldDef, FieldKind};

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    #[test]
    fn layout_created() {
        let (_d, v) = vault();
        for t in v.types() {
            assert!(v.root().join(&t.folder).is_dir());
        }
        assert!(v.root().join(".yamcha/trash").is_dir());
    }

    #[test]
    fn sanitize() {
        assert_eq!(Vault::sanitize_filename("a/b:c*d?e"), "a b c d e");
        assert_eq!(Vault::sanitize_filename("이름..."), "이름");
        assert_eq!(Vault::sanitize_filename("   "), "무제");
    }

    #[test]
    fn create_book_and_read() {
        let (_d, v) = vault();
        let rel = v
            .create_note(
                "book",
                "클린 코드",
                serde_json::json!({"author": "로버트 마틴", "genre": "개발"}),
            )
            .unwrap();
        assert_eq!(rel, "Books/클린 코드.md");
        let note = v.read_note(&rel).unwrap();
        assert_eq!(note.note_type, "book");
        assert_eq!(note.frontmatter["title"], "클린 코드");
        assert_eq!(note.frontmatter["status"], "wishlist");
        assert_eq!(note.frontmatter["author"], "로버트 마틴");
    }

    #[test]
    fn duplicate_titles_get_suffix() {
        let (_d, v) = vault();
        let a = v
            .create_note("free", "같은 제목", serde_json::json!({}))
            .unwrap();
        let b = v
            .create_note("free", "같은 제목", serde_json::json!({}))
            .unwrap();
        assert_eq!(a, "Free/같은 제목.md");
        assert_eq!(b, "Free/같은 제목 (2).md");
    }

    #[test]
    fn daily_is_idempotent() {
        let (_d, v) = vault();
        let a = v.open_daily("2026-07-18").unwrap();
        let b = v.open_daily("2026-07-18").unwrap();
        assert_eq!(a, "Daily/2026/07/2026-07-18.md");
        assert_eq!(a, b);
        let note = v.read_note(&a).unwrap();
        assert!(note.body.contains("## 할 일"));
    }

    #[test]
    fn reading_for_book_returns_self() {
        let (_d, v) = vault();
        let book = v
            .create_note(
                "book",
                "클린 코드",
                serde_json::json!({"author": "로버트 마틴"}),
            )
            .unwrap();
        // 책이 곧 독서기록 — 같은 파일을 돌려준다
        assert_eq!(v.reading_for_book(&book).unwrap(), book);
    }

    #[test]
    fn append_entries_into_book_records() {
        let (_d, v) = vault();
        let book = v
            .create_note("book", "책", serde_json::json!({"author": "저자"}))
            .unwrap();
        v.append_reading_entry(&book, EntryKind::Excerpt, "첫 인용")
            .unwrap();
        let note = v
            .append_reading_entry(&book, EntryKind::Thought, "둘째 생각")
            .unwrap();
        let today = Vault::today();
        // 소개/기록 섹션 구조 유지 + 콜아웃 누적
        assert!(note.body.contains("## 소개"));
        assert!(note.body.contains("## 기록"));
        assert!(note.body.contains(&format!("> [!발췌] {today}")));
        assert!(note.body.contains("> 첫 인용"));
        assert!(note.body.contains(&format!("> [!생각] {today}")));
        // 콜아웃 사이 빈 줄로 분리
        assert!(note.body.contains("> 첫 인용\n\n> [!생각]"));

        // entry_count 집계
        let summary = v
            .list_notes()
            .unwrap()
            .into_iter()
            .find(|n| n.rel_path == book)
            .unwrap();
        assert_eq!(summary.entry_count, 2);
    }

    #[test]
    fn migrate_old_reading_into_book() {
        let dir = tempfile::tempdir().unwrap();
        // 옛 구조를 수동으로 만든다: 책 + Reading 폴더의 독서기록
        {
            let v = Vault::open(dir.path()).unwrap();
            v.create_note("book", "옛 책", serde_json::json!({"author": "저자"}))
                .unwrap();
        }
        let reading_dir = dir.path().join("Reading");
        fs::create_dir_all(&reading_dir).unwrap();
        fs::write(
            reading_dir.join("독서기록_옛 책_저자.md"),
            "---\ntype: reading\ndate: 2026-07-01\ntags:\n- 소설\nbook: \"[[옛 책]]\"\nauthor: 저자\n---\n\n> [!발췌] 2026-07-01\n> 옛 기록\n",
        )
        .unwrap();

        // 재오픈 시 자동 마이그레이션
        let v = Vault::open(dir.path()).unwrap();
        assert!(!reading_dir.join("독서기록_옛 책_저자.md").exists());
        let book = v.read_note("Books/옛 책.md").unwrap();
        assert!(book.body.contains("> [!발췌] 2026-07-01"));
        assert!(book.body.contains("> 옛 기록"));
        // 태그 병합
        assert_eq!(book.frontmatter["tags"], serde_json::json!(["소설"]));
    }

    #[test]
    fn save_note_normalizes() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "메모", serde_json::json!({})).unwrap();
        v.save_note(&rel, serde_json::json!({}), "새 본문").unwrap();
        let note = v.read_note(&rel).unwrap();
        assert_eq!(note.note_type, "free");
        assert!(note.frontmatter["date"].is_string());
        assert!(note.body.contains("새 본문"));
    }

    #[test]
    fn update_frontmatter_patches_and_keeps_body() {
        let (_d, v) = vault();
        let rel = v
            .create_note("book", "책", serde_json::json!({"author": "저자"}))
            .unwrap();
        v.update_frontmatter(&rel, serde_json::json!({"rating": 4.5, "genre": "소설"}))
            .unwrap();
        let note = v.read_note(&rel).unwrap();
        assert_eq!(note.frontmatter["rating"], 4.5);
        assert_eq!(note.frontmatter["genre"], "소설");
        assert_eq!(note.frontmatter["author"], "저자");
        assert!(note.body.contains("## 소개"));
    }

    #[test]
    fn delete_moves_to_trash() {
        let (_d, v) = vault();
        let rel = v
            .create_note("free", "지울 메모", serde_json::json!({}))
            .unwrap();
        v.delete_note(&rel).unwrap();
        assert!(v.read_note(&rel).is_err());
        let trash = v.root().join(".yamcha/trash");
        assert_eq!(fs::read_dir(trash).unwrap().count(), 1);
    }

    #[test]
    fn trash_list_and_restore_roundtrip() {
        let (_d, v) = vault();
        let rel = v
            .create_note("book", "복구될 책", serde_json::json!({"author": "저자"}))
            .unwrap();
        v.delete_note(&rel).unwrap();
        assert!(v.read_note(&rel).is_err());

        let items = v.list_trash().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].original_name, "복구될 책.md");

        let restored_rel = v.restore_trash(&items[0].file_name).unwrap();
        // 책 타입이 살아있으므로 원래 폴더(Books)로 복귀
        assert_eq!(restored_rel, "Books/복구될 책.md");
        let note = v.read_note(&restored_rel).unwrap();
        assert_eq!(note.frontmatter["author"], "저자");
        // 휴지통은 비워졌다
        assert!(v.list_trash().unwrap().is_empty());
    }

    #[test]
    fn restore_missing_file_errs() {
        let (_d, v) = vault();
        assert!(v.restore_trash("없는파일.md").is_err());
    }

    #[test]
    fn purge_trash_removes_only_old_items() {
        let (_d, v) = vault();
        let trash = v.root().join(".yamcha/trash");
        fs::create_dir_all(&trash).unwrap();
        // 오래된 것(2020년) + 방금 삭제된 것
        fs::write(trash.join("20200101-000000_오래된.md"), "old").unwrap();
        let recent = Local::now().format("%Y%m%d-%H%M%S").to_string();
        fs::write(trash.join(format!("{recent}_최근.md")), "new").unwrap();

        let removed = v.purge_trash(7).unwrap();
        assert_eq!(removed, 1);
        let left = v.list_trash().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].original_name, "최근.md");

        // 0이면 아무것도 삭제하지 않는다
        fs::write(trash.join("20200101-000000_또오래된.md"), "old").unwrap();
        assert_eq!(v.purge_trash(0).unwrap(), 0);
        assert_eq!(v.list_trash().unwrap().len(), 2);
    }

    #[test]
    fn restore_falls_back_to_free_when_type_gone() {
        let (_d, v) = vault();
        // frontmatter type이 사라진(알 수 없는) 노트를 휴지통에 직접 만든다
        let trash = v.root().join(".yamcha/trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(
            trash.join("20260724-101500_떠도는 노트.md"),
            "---\ntype: 사라진분류\ntitle: 떠도는 노트\n---\n내용",
        )
        .unwrap();
        let rel = v.restore_trash("20260724-101500_떠도는 노트.md").unwrap();
        assert_eq!(rel, "Free/떠도는 노트.md");
    }

    #[test]
    fn list_notes_excludes_index() {
        let (_d, v) = vault();
        v.create_note("free", "보임", serde_json::json!({})).unwrap();
        let notes = v.list_notes().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "보임");
    }

    #[test]
    fn custom_type_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut v = Vault::open(dir.path()).unwrap();
            let def = v
                .add_custom_type(
                    "회의록",
                    vec![FieldDef::new("attendees", "참석자", FieldKind::Text, true)],
                    "## 안건\n\n## 결정사항\n",
                )
                .unwrap();
            assert_eq!(def.id, "회의록");
            assert!(v.root().join("회의록").is_dir());
            // 공통 필드 + 커스텀 필드
            assert!(def.fields.iter().any(|f| f.name == "date"));
            assert!(def.fields.iter().any(|f| f.name == "attendees"));

            let rel = v
                .create_note("회의록", "주간 회의", serde_json::json!({"attendees": "SG"}))
                .unwrap();
            assert_eq!(rel, "회의록/주간 회의.md");
            let note = v.read_note(&rel).unwrap();
            assert_eq!(note.note_type, "회의록");
            assert!(note.body.contains("## 안건"));
            assert_eq!(note.frontmatter["attendees"], "SG");

            // 중복 방지
            assert!(v.add_custom_type("회의록", vec![], "").is_err());
        }
        // 재오픈 시 커스텀 타입 유지
        {
            let v = Vault::open(dir.path()).unwrap();
            assert!(v.def_by_id("회의록").is_some());
            let notes = v.list_notes().unwrap();
            assert!(notes.iter().any(|n| n.note_type == "회의록"));
        }
        // 제거 시 정의가 사라지고 노트는 자유노트로 이동
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.remove_custom_type("회의록").unwrap();
            assert!(v.def_by_id("회의록").is_none());
            assert!(dir.path().join("Free/주간 회의.md").exists());
        }
    }

    #[test]
    fn rename_free_note_updates_links() {
        let (_d, v) = vault();
        let target = v.create_note("free", "옛 제목", serde_json::json!({})).unwrap();
        let linker = v.create_note("free", "링크하는 글", serde_json::json!({})).unwrap();
        v.save_note(&linker, serde_json::json!({}), "여기 [[옛 제목]] 참고").unwrap();

        let new_rel = v.rename_note(&target, "새 제목").unwrap();
        assert_eq!(new_rel, "Free/새 제목.md");
        assert!(v.read_note(&target).is_err());
        let renamed = v.read_note(&new_rel).unwrap();
        assert_eq!(renamed.frontmatter["title"], "새 제목");
        let linker_note = v.read_note(&linker).unwrap();
        assert!(linker_note.body.contains("[[새 제목]]"));
        assert!(!linker_note.body.contains("[[옛 제목]]"));
    }

    #[test]
    fn rename_book_moves_file_and_keeps_records() {
        let (_d, v) = vault();
        let book = v
            .create_note("book", "옛 책", serde_json::json!({"author": "저자"}))
            .unwrap();
        v.append_reading_entry(&book, EntryKind::Excerpt, "기록").unwrap();

        let new_book = v.rename_note(&book, "새 책").unwrap();
        assert_eq!(new_book, "Books/새 책.md");
        assert!(v.read_note(&book).is_err());
        let r = v.read_note(&new_book).unwrap();
        assert_eq!(r.frontmatter["title"], "새 책");
        assert!(r.body.contains("> 기록"));
        // 데일리 rename 제한
        assert!(v.rename_note(&v.open_daily("2026-07-18").unwrap(), "x").is_err());
    }

    #[test]
    fn rename_info_keeps_date_prefix() {
        let (_d, v) = vault();
        let rel = v.create_note("info", "원래 정보", serde_json::json!({})).unwrap();
        let new_rel = v.rename_note(&rel, "고친 정보").unwrap();
        let today = Vault::today();
        assert_eq!(new_rel, format!("Info/{today} 고친 정보.md"));
        assert_eq!(v.read_note(&new_rel).unwrap().frontmatter["title"], "고친 정보");
    }

    #[test]
    fn update_custom_type_template_applies_to_new_notes_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        v.add_custom_type("회의록", vec![], "## 안건\n").unwrap();

        let before = v.create_note("회의록", "첫 회의", serde_json::json!({})).unwrap();
        assert!(v.read_note(&before).unwrap().body.contains("## 안건"));

        v.update_custom_type_template("회의록", "## 결정사항\n").unwrap();
        assert_eq!(v.def_by_id("회의록").unwrap().template, "## 결정사항\n");

        // 기존 노트는 그대로
        assert!(v.read_note(&before).unwrap().body.contains("## 안건"));
        assert!(!v.read_note(&before).unwrap().body.contains("## 결정사항"));

        // 새 노트부터 새 템플릿 적용
        let after = v.create_note("회의록", "둘째 회의", serde_json::json!({})).unwrap();
        assert!(v.read_note(&after).unwrap().body.contains("## 결정사항"));
        assert!(!v.read_note(&after).unwrap().body.contains("## 안건"));

        // 재오픈해도 유지 (types.json에 저장됨)
        let reopened = Vault::open(dir.path()).unwrap();
        assert_eq!(reopened.def_by_id("회의록").unwrap().template, "## 결정사항\n");

        // 없는 분류는 오류
        assert!(v.update_custom_type_template("없음", "x").is_err());
    }

    #[test]
    fn remove_custom_type_moves_notes_to_free() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        v.add_custom_type("회의록", vec![], "").unwrap();
        let rel = v
            .create_note("회의록", "주간 회의", serde_json::json!({}))
            .unwrap();
        assert_eq!(rel, "회의록/주간 회의.md");

        v.remove_custom_type("회의록").unwrap();
        assert!(v.def_by_id("회의록").is_none());
        // 노트가 자유노트로 이동 + type 갱신
        let moved = v.read_note("Free/주간 회의.md").unwrap();
        assert_eq!(moved.note_type, "free");
        assert_eq!(moved.frontmatter["type"], "free");
        // 폴더는 비워져 삭제됨
        assert!(!dir.path().join("회의록").exists());
    }

    #[test]
    fn writing_type_with_char_count() {
        let (_d, v) = vault();
        let rel = v
            .create_note("writing", "첫 에세이", serde_json::json!({"category": "에세이"}))
            .unwrap();
        assert_eq!(rel, "Writing/첫 에세이.md");
        let note = v.read_note(&rel).unwrap();
        assert_eq!(note.frontmatter["status"], "idea");
        assert_eq!(note.frontmatter["category"], "에세이");

        v.save_note(&rel, note.frontmatter, "원고 본문 열 글자").unwrap();
        let summary = v
            .list_notes()
            .unwrap()
            .into_iter()
            .find(|n| n.rel_path == rel)
            .unwrap();
        // "원고 본문 열 글자" 공백 제외 7자
        assert_eq!(summary.char_count, 7);
    }

    #[test]
    fn attachments_rules() {
        let (_d, v) = vault();
        // 표지
        let src_dir = tempfile::tempdir().unwrap();
        let src = src_dir.path().join("cover.jpg");
        fs::write(&src, b"fake-image").unwrap();
        let rel = v.attach_cover("클린 코드", &src).unwrap();
        assert_eq!(rel, "_attachments/covers/클린 코드.jpg");
        assert!(v.root().join(&rel).exists());

        // 일반 첨부 (중복 시 접미)
        let doc = src_dir.path().join("자료.pdf");
        fs::write(&doc, b"pdf").unwrap();
        let a = v.import_attachment(&doc).unwrap();
        let b = v.import_attachment(&doc).unwrap();
        assert!(a.contains("_attachments/"));
        assert!(a.ends_with("자료.pdf"));
        assert!(b.ends_with("자료 (2).pdf"));

        // 붙여넣은 이미지
        let p = v.save_pasted_image(b"img-bytes", "png").unwrap();
        assert!(p.contains("/paste-"));
        assert!(v.root().join(&p).exists());
    }
}
