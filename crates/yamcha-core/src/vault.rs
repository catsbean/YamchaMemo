//! Vault: 마크다운 파일 저장소. 파일 IO, 파일명 규칙, 노트 CRUD, 타입 관리, 첨부파일.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::CoreError;
use crate::parse;
use crate::schema::{builtin_defs, normalize_frontmatter, Builtin, DailyKind, EntryKind, TypeDef};
use crate::template;

/// 사용자 정의 콜아웃 종류 (vault의 `_callouts.json`에 저장 — vault를 옮기면 함께 간다)
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CalloutDef {
    pub label: String,
    /// 이모지 아이콘
    pub icon: String,
    /// 고정 팔레트 이름 (amber/sky/emerald/violet/rose/neutral)
    pub color: String,
    /// 어디에 쓸지: "daily" | "book" | "both"
    pub scope: String,
}

const CALLOUTS_FILE: &str = "_callouts.json";
/// 일지·책 각각 최대 몇 개까지 추가할 수 있는지
pub const MAX_CALLOUTS_PER_SCOPE: usize = 5;
/// 종류 이름으로 쓸 수 없는 기본 이름들
pub const BUILTIN_KIND_LABELS: [&str; 7] =
    ["발췌", "생각", "요약", "질문", "기록", "느낌", "할 일"];
/// 종류 변경에서 "할 일"을 뜻하는 값 (콜아웃이 아니라 체크박스로 간다)
pub const TODO_KIND: &str = "할 일";

fn visible_in(scope: &str, target: &str) -> bool {
    scope == target || scope == "both"
}

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

/// 필드 목록에 별칭 칸이 없으면 태그 바로 뒤에 끼워 넣는다 (있으면 그대로 둔다).
/// 자리를 태그 뒤로 잡는 이유는 내장 분류의 칸 순서와 맞추기 위해서다.
fn ensure_aliases_field(fields: &mut Vec<crate::schema::FieldDef>) {
    if fields.iter().any(|f| f.name == "aliases") {
        return;
    }
    let at = fields
        .iter()
        .position(|f| f.name == "tags")
        .map(|i| i + 1)
        .unwrap_or(fields.len());
    fields.insert(at, crate::schema::aliases_field());
}

/// 클라우드 동기화·백신이 파일을 **잠깐** 붙들고 있어서 나는 오류인가.
/// 윈도우: 5 ACCESS_DENIED · 32 SHARING_VIOLATION · 33 LOCK_VIOLATION.
/// 권한이 아예 없거나 디스크가 찬 것과는 다르다 — 그건 기다려 봐야 소용없다.
fn is_transient_lock(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
        || e.kind() == std::io::ErrorKind::PermissionDenied
}

/// 잠깐 붙들린 파일이면 조금씩 기다리며 다시 해 본다 (최대 ~1초).
///
/// iCloud Drive 같은 동기화 폴더에서는 클라이언트가 파일을 올리는 동안 핸들을 쥐고 있어
/// 그 찰나에 겹친 저장이 실패한다. 사람은 아무 잘못이 없는데 "저장 실패"만 본다.
/// 대부분 수십 밀리초면 풀리므로 한 번 실패했다고 포기할 이유가 없다.
/// 잠금이 아닌 오류는 그 자리에서 그대로 돌려준다.
fn retry_while_locked<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    const BACKOFF_MS: [u64; 5] = [20, 50, 120, 300, 600];
    let mut last = match op() {
        Ok(v) => return Ok(v),
        Err(e) => e,
    };
    for ms in BACKOFF_MS {
        if !is_transient_lock(&last) {
            return Err(last);
        }
        std::thread::sleep(std::time::Duration::from_millis(ms));
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
    }
    Err(last)
}

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

/// 파일 하나의 신원 — 내용을 읽지 않고 "바뀌었나"만 가리는 값들
#[derive(Debug, Clone)]
pub struct NoteFile {
    pub rel_path: String,
    pub note_type: String,
    /// 수정 시각 (epoch 밀리초). 읽을 수 없으면 0 — 늘 바뀐 것으로 본다.
    pub mtime: i64,
    pub size: i64,
}

/// 편집기용 노트 전체 내용
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NoteContent {
    pub rel_path: String,
    pub note_type: String,
    pub frontmatter: Value,
    pub body: String,
    /// 이 내용을 읽어 온 시점의 파일 지문. 저장할 때 되돌려 주면
    /// 그 사이에 파일이 바뀌었는지 알 수 있다 (`save_note_checked`).
    pub stamp: String,
}

/// 저장 결과.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SaveResult {
    /// 지금 디스크에 있는 내용의 지문 — 저장했으면 방금 쓴 내용의 것,
    /// 충돌이면 **남이 써 넣은** 내용의 것.
    pub stamp: String,
    /// 우리가 읽은 뒤에 파일이 바뀌어 있어 **아무것도 쓰지 않았다**
    pub conflict: bool,
}

/// 파일 내용을 가리키는 짧은 지문 (FNV-1a 64비트 + 길이).
///
/// 수정시각을 쓰지 않는 이유: 클라우드 동기화(iCloud·OneDrive)는 내용이 같아도
/// 파일을 다시 내려받으며 mtime을 갈아치운다. 그걸 잣대로 삼으면 아무도 고치지
/// 않은 노트에 "외부에서 바뀌었다"는 경고가 뜨고, 반대로 같은 밀리초 안에 일어난
/// 진짜 변경은 놓친다. 내용이 곧 신원이다.
pub fn fingerprint(content: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in content.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:x}-{:x}", content.len())
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
    /// frontmatter `aliases` — 이 노트를 부르는 다른 이름들.
    /// `[[별칭]]`도 이 노트로 이어지고, 백링크에도 함께 잡힌다.
    pub aliases: Vec<String>,
    /// 본문 + frontmatter 문자열 값에서 추출한 위키링크 타깃
    pub links: Vec<String>,
    pub body: String,
    pub frontmatter_json: String,
}

pub struct Vault {
    root: PathBuf,
    types: Vec<TypeDef>,
    history: crate::history::HistoryPolicy,
    /// `_index.md`를 다시 만들어야 하는 타입들.
    ///
    /// 예전에는 노트를 저장할 때마다 그 자리에서 목록 파일을 다시 만들었다. 그런데 그
    /// 작업은 **vault 전체를 읽어 파싱**한다(실측: 2,000편에서 저장 한 번에 345ms,
    /// 태그 일괄변경은 O(n²)라 771초). 자동저장이 3초마다 도는 앱에서 감당할 수 없다.
    ///
    /// 이제 저장은 "낡았다"고 표시만 하고 즉시 끝난다. 실제 재생성은 손을 멈췄을 때
    /// `flush_index_files`가 한 번에 한다. `_index.md`는 다른 편집기에서 훑어보라고
    /// 만들어 두는 파일이라 몇 초 늦어도 문제가 없다.
    index_stale: Mutex<HashSet<String>>,
    /// 노트 요약 캐시 — 경로 → (수정시각, 크기, 요약).
    ///
    /// 목록을 그릴 때마다 편마다 파일을 열어 파싱했다(실측: 2,000편에 356ms).
    /// 저장할 때마다 화면을 갱신하니 자동저장이 도는 내내 그 값을 치렀다.
    /// 파일이 그대로면 지난번 요약을 그대로 쓴다 — 진실원본은 여전히 파일이고,
    /// 캐시는 (수정시각, 크기)가 어긋나는 순간 버려진다.
    summaries: Mutex<HashMap<String, (i64, i64, NoteSummary)>>,
    /// 앱이 마지막으로 써 넣은 내용의 지문 (경로 → 지문).
    ///
    /// 파일 감시가 "이건 내가 쓴 것"을 알아보는 데 쓴다. 예전에는 마지막 쓰기
    /// **시각**으로 판단했다 — 2.5초 안에 들어온 변경은 전부 자기 쓰기로 봤다.
    /// 그런데 그 창은 파일을 가리지 않아서, 같은 저장소를 두 곳에서 열어 두면
    /// 내가 A를 저장하는 사이에 도착한 **남의 B 저장 알림까지 함께 삼켰다**.
    /// 알림을 못 받은 쪽은 낡은 내용을 들고 있다가 그대로 덮어썼다.
    /// 시각이 아니라 내용으로 판단하면 그 구멍이 없다.
    self_writes: Mutex<HashMap<String, String>>,
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
                    // 별칭은 나중에 생긴 칸이라 예전 `_types.json`에는 없다.
                    // 없으면 여기서 끼워 넣는다 — 안 그러면 사용자가 만든 분류만
                    // 별칭을 못 쓰는, 설명할 수 없는 차이가 생긴다.
                    ensure_aliases_field(&mut c.fields);
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
            index_stale: Mutex::new(HashSet::new()),
            summaries: Mutex::new(HashMap::new()),
            self_writes: Mutex::new(HashMap::new()),
        };
        vault.ensure_layout()?;
        // 옛 독서기록 파일을 책 파일로 통합 (있을 때만, 실패해도 vault 열기는 계속)
        let _ = vault.migrate_readings();
        Ok(vault)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 이 타입의 `_index.md`가 낡았다고 표시한다 (실제 재생성은 `flush_index_files`가 한다)
    pub(crate) fn mark_index_stale(&self, type_id: &str) {
        if let Ok(mut set) = self.index_stale.lock() {
            set.insert(type_id.to_string());
        }
    }

    /// 낡은 `_index.md`를 모두 다시 만든다 → 다시 만든 타입 수.
    ///
    /// 손을 멈췄을 때 한 번만 부르면 된다. 여러 번 저장했어도 타입당 한 번만 돈다.
    pub fn flush_index_files(&self) -> Result<usize, CoreError> {
        let stale: Vec<String> = match self.index_stale.lock() {
            Ok(mut set) => set.drain().collect(),
            Err(_) => return Ok(0),
        };
        let mut done = 0;
        for type_id in &stale {
            crate::index_file::update_index(self, type_id)?;
            done += 1;
        }
        Ok(done)
    }

    /// 아직 반영되지 않은 목록 파일이 있는가 (창을 닫기 전 확인용)
    pub fn has_stale_index(&self) -> bool {
        self.index_stale
            .lock()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
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

    /// 크래시로 남은 `.md.tmp`를 걷는다 → 지운 개수.
    ///
    /// `atomic_write`는 정상 경로에서 임시파일을 반드시 치우지만(rename 실패 시에도),
    /// 그 사이에 프로세스가 강제 종료되면 파일이 남는다. watcher와 목록이 `.md`만 보므로
    /// 아무도 그 파일을 다시 쳐다보지 않는다 — 계속 쌓이기만 한다.
    ///
    /// `max_age`보다 오래된 것만 지운다 — 방금 만들어진 것은 지금 다른 창이 쓰는 중일
    /// 수 있다. 기준을 인자로 받는 이유는 시계를 건드리지 않고 시험하기 위해서다.
    pub fn sweep_stale_tmp(&self, max_age: std::time::Duration) -> Result<u32, CoreError> {
        fn walk(dir: &Path, cutoff: std::time::SystemTime, removed: &mut u32) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, cutoff, removed);
                    continue;
                }
                if !entry.file_name().to_string_lossy().ends_with(".md.tmp") {
                    continue;
                }
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .map(|t| t < cutoff)
                    .unwrap_or(false);
                if old && fs::remove_file(&path).is_ok() {
                    *removed += 1;
                }
            }
        }

        let cutoff = std::time::SystemTime::now() - max_age;
        let mut removed = 0;
        // 지금 쓰는 자리(.yamcha/tmp)와, 예전에 노트 옆에 쓰던 자리를 함께 걷는다
        walk(&self.root.join(".yamcha").join("tmp"), cutoff, &mut removed);
        for t in &self.types {
            walk(&self.root.join(&t.folder), cutoff, &mut removed);
        }
        Ok(removed)
    }

    // ---------- 사용자 정의 타입 ----------

    /// 사용자 정의 타입 추가. label로 folder를 만들고, id(frontmatter `type` 값)는
    /// 사용자가 직접 정한 값을 그대로 쓴다. `_types.json`에 저장한다.
    pub fn add_custom_type(
        &mut self,
        label: &str,
        id: &str,
        fields: Vec<crate::schema::FieldDef>,
        template: &str,
    ) -> Result<TypeDef, CoreError> {
        let label = label.trim();
        if label.is_empty() {
            return Err(CoreError::Invalid("분류 이름을 입력하세요".into()));
        }
        let id = id.trim();
        if id.is_empty() {
            return Err(CoreError::Invalid("타입 ID를 입력하세요".into()));
        }
        if id.chars().any(|c| c.is_whitespace() || c == '/' || c == '\\') {
            return Err(CoreError::Invalid(
                "타입 ID에는 공백이나 슬래시를 쓸 수 없습니다".into(),
            ));
        }
        let folder = Self::sanitize_filename(label);
        if self
            .types
            .iter()
            .any(|t| t.id == id || t.folder == folder || t.label == label)
        {
            return Err(CoreError::Invalid(format!(
                "이미 존재하는 분류이거나 타입 ID입니다: {label}"
            )));
        }
        // 공통 필드(date/tags/aliases)를 앞에 보장
        let mut all_fields = vec![
            crate::schema::FieldDef::new("date", "날짜", crate::schema::FieldKind::Date, true),
            crate::schema::FieldDef::new("tags", "태그", crate::schema::FieldKind::Tags, true),
            crate::schema::aliases_field(),
        ];
        for f in fields {
            if !matches!(f.name.as_str(), "date" | "tags" | "aliases" | "type") && !f.name.is_empty()
            {
                all_fields.push(f);
            }
        }
        let def = TypeDef {
            id: id.to_string(),
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

    /// 목록 화면 각 줄에 값을 내보일 칸을 정한다 (이름이 `names`에 있는 칸만 켠다).
    ///
    /// 목록이 보여 주는 것은 원래 고정이었다 — 날짜·제목·태그. 사용자가 만든 칸은
    /// 분류마다 다르므로 앱이 무엇이 중요한지 알 수 없어, 켤 칸을 사람이 고른다.
    /// 날짜·태그는 이미 줄에 나오므로 여기서 고르는 대상이 아니다.
    pub fn set_list_fields(&mut self, id: &str, names: &[String]) -> Result<TypeDef, CoreError> {
        let def = self
            .types
            .iter_mut()
            .find(|t| !t.builtin && t.id == id)
            .ok_or_else(|| CoreError::Invalid(format!("수정할 분류가 없습니다: {id}")))?;
        for f in def.fields.iter_mut() {
            f.in_list = names.iter().any(|n| n == &f.name);
        }
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
        self.mark_index_stale(Builtin::Free.id());
        Ok(())
    }

    /// 노트를 다른 분류로 옮긴다. 파일을 새 분류의 폴더로 옮기고(파일명 충돌 시
    /// 유니크 접미사) frontmatter의 `type`을 새로 정규화한다. 새 rel 경로를 반환.
    ///
    /// 책·데일리는 파일명·폴더 규칙(연/월, 독서기록 연동)이 확고해 원본·대상
    /// 어느 쪽으로도 이동을 허용하지 않는다.
    pub fn move_note(&self, rel: &str, new_type_id: &str) -> Result<String, CoreError> {
        let note = self.read_note(rel)?;
        let cur_type = note.note_type.clone();
        if cur_type == new_type_id {
            return Err(CoreError::Invalid("이미 그 분류에 있는 노트입니다".into()));
        }
        let locked = |id: &str| {
            matches!(
                Builtin::from_id(id),
                Some(Builtin::Daily) | Some(Builtin::Book)
            )
        };
        if locked(&cur_type) || locked(new_type_id) {
            return Err(CoreError::Invalid(
                "책·데일리는 다른 분류로 옮길 수 없습니다".into(),
            ));
        }
        let dest_def = self
            .def_by_id(new_type_id)
            .ok_or_else(|| CoreError::Invalid(format!("알 수 없는 분류: {new_type_id}")))?
            .clone();

        let abs = self.abs(rel)?;
        let stem = Path::new(rel)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "무제".into());
        let dest_dir = self.root.join(&dest_def.folder);
        let dest = self.unique_path(&dest_dir, &stem);
        fs::rename(&abs, &dest)?;
        let dest_rel = self.rel_of(&dest);
        // 스냅샷도 따라 옮긴다. **save_note보다 먼저** 해야 한다 —
        // save_note가 새 경로로 스냅샷을 하나 뜨고 나면 옮겨갈 자리가 이미 차 있다.
        crate::history::move_note(self, rel, &dest_rel)?;
        // save_note가 새 경로 기준으로 type을 다시 정규화한다
        let moved = self.read_note(&dest_rel)?;
        self.save_note(&dest_rel, moved.frontmatter, &moved.body)?;
        // 폴더까지 적어 가리킨 링크는 따라와야 한다 (`[[Free/메모]]` → `[[Writing/메모]]`)
        self.replace_path_links(rel, &dest_rel)?;

        self.mark_index_stale(&cur_type);
        self.mark_index_stale(new_type_id);
        Ok(dest_rel)
    }

    // ---------- 제목 변경 ----------

    /// 파일이 자리를 옮겼을 때 **폴더까지 적어 가리킨 링크**를 새 경로로 고친다
    /// (`[[Free/메모]]` → `[[Writing/메모]]`).
    ///
    /// 이름만 적은 `[[메모]]`는 **일부러 건드리지 않는다.** 옮기고 나면 그 폴더에
    /// 같은 이름의 글이 둘이 될 수 있는데, 그 링크가 원래 있던 글을 가리켰는지
    /// 방금 옮겨 온 글을 가리켰는지 글자만 봐서는 알 수 없다. 잘못 고치느니 둔다.
    /// 경로로 적은 링크는 그런 모호함이 없어서 — 정확히 이 파일 하나였으므로 —
    /// 고치는 것이 언제나 옳다.
    ///
    /// `.md`를 붙여 적은 형태도 함께 받는다. 고친 결과는 확장자 없는 쪽으로 모은다
    /// (해석기가 둘 다 받으므로 표기를 하나로 모아도 손해가 없다).
    ///
    /// 확장자는 **한 번만 뗀다.** 반복해서 떼면 제목이 `메모.md`인 글(`Free/메모.md.md`)에서
    /// `Free/메모`가 나오는데, 그건 **다른 글**(`Free/메모.md`)의 경로 키다. 남의 링크를
    /// 고치면서 정작 이 파일의 링크(`[[Free/메모.md]]`)는 놓친다.
    fn replace_path_links(&self, old_rel: &str, new_rel: &str) -> Result<(), CoreError> {
        let key = |r: &str| r.strip_suffix(".md").unwrap_or(r).to_string();
        let olds = vec![key(old_rel), old_rel.to_string()];
        self.replace_links(&olds, &key(new_rel))
    }

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

        let new_stem = Self::sanitize_filename(new_title);

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
            // 되돌릴 지점은 제목을 바꿨다고 사라지면 안 된다 (save_note보다 먼저)
            crate::history::move_note(self, rel, &new_rel)?;
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
        // 제목을 바꾸면 파일명이 바뀌므로 경로도 바뀐다 — 폴더까지 적은 링크도 따라와야 한다
        self.replace_path_links(rel, &new_rel)?;
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

    /// vault 상대경로 → 절대경로. **vault 밖을 가리키면 거절한다.**
    ///
    /// `..`만 막던 때가 있었는데 그걸로는 모자란다. `Path::join`은 인자가 절대경로면
    /// 앞을 통째로 버려서, `C:\Windows\...`나 `/etc/passwd`를 넘기면 vault와 상관없는
    /// 파일이 나온다. 대부분의 커맨드는 `type_of_rel`이 최상위 폴더를 검사해 우연히
    /// 막히지만 `read_raw`·`write_raw`(수리 화면)는 그 검사를 거치지 않는다.
    ///
    /// 그래서 "합친 결과가 vault 안인가"를 직접 본다 — 절대경로·루트 상대경로·
    /// 드라이브 상대경로가 한 검사로 다 걸린다.
    pub(crate) fn abs(&self, rel: &str) -> Result<PathBuf, CoreError> {
        if rel.split(['/', '\\']).any(|seg| seg == "..") {
            return Err(CoreError::Invalid(format!("잘못된 경로: {rel}")));
        }
        let joined = self.root.join(rel);
        if !joined.starts_with(&self.root) {
            return Err(CoreError::Invalid(format!("vault 밖의 경로: {rel}")));
        }
        Ok(joined)
    }

    /// 임시파일을 두는 곳 — **노트 폴더 안이 아니다**.
    ///
    /// 예전에는 노트 옆에 `제목.md.tmp`를 만들었다. vault가 클라우드 동기화 폴더
    /// (iCloud·OneDrive) 안에 있으면 저장할 때마다 그 폴더에서 파일이 생겼다 사라지고,
    /// 동기화 클라이언트가 그 찰나의 파일까지 업로드하려 든다. 올라간 tmp는 다른 기기로
    /// 내려가고, 이름이 겹치면 충돌 사본까지 따라 붙는다 — 앱은 `.md`만 보므로 아무도
    /// 치우지 않는다. 같은 볼륨이면 폴더가 달라도 rename은 그대로 원자적이다.
    fn tmp_path_for(&self, abs: &Path) -> PathBuf {
        let name = abs
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "note.md".into());
        let dir = self.root.join(".yamcha").join("tmp");
        if fs::create_dir_all(&dir).is_err() {
            // 임시 폴더를 못 만들면 예전처럼 노트 옆에 쓴다 (저장 자체는 살린다)
            return abs.with_extension("md.tmp");
        }
        // 같은 이름의 노트가 폴더마다 있을 수 있으니 경로 지문으로 구분한다
        let key = fingerprint(&abs.to_string_lossy());
        dir.join(format!("{key}-{name}.tmp"))
    }

    /// 원자적 쓰기: 임시 파일에 다 쓰고 rename으로 갈아 끼운다.
    ///
    /// **원본을 미리 지우지 않는다.** `fs::rename`은 Windows에서도 대상 파일을 덮어쓴다
    /// (MoveFileEx + MOVEFILE_REPLACE_EXISTING). 예전에는 rename 전에 `remove_file`을 했는데,
    /// 그 두 줄 사이에 노트가 존재하지 않는 창이 생겼다 — 백신이나 클라우드 동기화가 갓 만들어진
    /// 임시파일을 잠그면 rename만 실패해서 **원본은 지워지고 내용은 tmp에만 남았다**.
    ///
    /// rename 전에 `sync_all`로 내용을 디스크에 확정한다. 안 하면 정전 시 rename만 살아남아
    /// 빈 파일이 남을 수 있다.
    pub(crate) fn atomic_write(&self, abs: &Path, content: &str) -> Result<(), CoreError> {
        use std::io::Write;

        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.tmp_path_for(abs);
        retry_while_locked(|| {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()
        })?;
        // 실패하면 tmp를 치우고 원본은 그대로 둔다 (반쯤 지워진 상태를 남기지 않는다)
        if let Err(e) = retry_while_locked(|| fs::rename(&tmp, abs)) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        // 방금 쓴 내용을 적어 둔다 — 파일 감시가 이걸로 자기 쓰기를 알아본다
        if let Ok(rel) = abs.strip_prefix(&self.root) {
            if let Ok(mut map) = self.self_writes.lock() {
                map.insert(
                    rel.to_string_lossy().replace('\\', "/"),
                    fingerprint(content),
                );
            }
        }
        Ok(())
    }

    /// 지금 디스크에 있는 내용이 **앱이 마지막으로 써 넣은 그것**인가.
    ///
    /// 파일 감시가 자기 쓰기를 외부 변경으로 오인하지 않게 한다. 시간이 아니라 내용으로
    /// 판단하므로, 저장이 늦게 반영되거나 그 사이에 다른 창이 저장해도 헷갈리지 않는다.
    pub fn is_self_write(&self, rel: &str) -> bool {
        let Ok(abs) = self.abs(rel) else { return false };
        let Ok(content) = fs::read_to_string(&abs) else {
            return false;
        };
        let now = fingerprint(&content);
        self.self_writes
            .lock()
            .ok()
            .and_then(|m| m.get(rel).cloned())
            .is_some_and(|last| last == now)
    }

    /// rel 경로에서 타입 id 추론 (최상위 폴더 기준)
    pub(crate) fn type_of_rel(&self, rel: &str) -> Result<String, CoreError> {
        let first = rel.split(['/', '\\']).next().unwrap_or("");
        self.def_by_folder(first)
            .map(|d| d.id.clone())
            .ok_or_else(|| CoreError::Invalid(format!("알 수 없는 노트 폴더: {rel}")))
    }

    // ---------- 목록 ----------

    /// 태그 이름 바꾸기 / 병합 → 바뀐 노트 수.
    ///
    /// 태그는 두 곳에 있다: frontmatter의 `tags` 배열과 본문의 인라인 `#태그`.
    /// 둘 다 고쳐야 이름이 진짜 바뀐다.
    /// `to`가 이미 있는 태그면 그게 곧 **병합**이다 (중복은 합쳐진다).
    pub fn rename_tag(&self, from: &str, to: &str) -> Result<Vec<String>, CoreError> {
        let from = from.trim();
        let to = to.trim();
        if from.is_empty() || to.is_empty() || from == to {
            return Ok(Vec::new());
        }
        // 태그에 쓸 수 없는 글자를 막는다 (공백·# 등이 들어가면 다시 못 찾는다)
        if to.chars().any(|c| !(c.is_alphanumeric() || "/-_".contains(c))) {
            return Err(CoreError::Invalid(
                "태그에는 글자·숫자와 - _ / 만 쓸 수 있습니다".into(),
            ));
        }

        let mut changed = Vec::new();
        for summary in self.list_notes()? {
            let rel = summary.rel_path.clone();
            let parsed = self.parse_full(&rel)?;
            let mut fm = match serde_json::from_str::<Value>(&parsed.frontmatter_json) {
                Ok(Value::Object(m)) => m,
                _ => Map::new(),
            };

            // ① frontmatter의 tags 배열
            let mut fm_hit = false;
            if let Some(Value::Array(list)) = fm.get("tags").cloned() {
                let mut out: Vec<Value> = Vec::new();
                for v in list {
                    let t = v.as_str().unwrap_or_default().to_string();
                    let next = if t == from {
                        fm_hit = true;
                        to.to_string()
                    } else {
                        t
                    };
                    // 병합이면 같은 이름이 둘이 될 수 있다
                    if !next.is_empty() && !out.iter().any(|x| x.as_str() == Some(next.as_str())) {
                        out.push(Value::String(next));
                    }
                }
                if fm_hit {
                    fm.insert("tags".into(), Value::Array(out));
                }
            }

            // ② 본문의 인라인 #태그
            let body = replace_inline_tag(&parsed.body, from, to);
            let body_hit = body != parsed.body;

            if fm_hit || body_hit {
                self.save_note(&rel, Value::Object(fm), &body)?;
                changed.push(rel);
            }
        }
        Ok(changed)
    }

    /// 요약 하나 — 파일이 그대로면 캐시에서, 아니면 열어서 만들고 캐시에 넣는다.
    ///
    /// 판단 잣대는 (수정시각, 크기)로 증분 색인과 같다. 수정시각은 나노초까지 본다 —
    /// 밀리초로 자르면 같은 밀리초 안에 크기가 같게 다시 저장된 편을 놓칠 수 있다.
    fn summary_of(&self, file: &NoteFile) -> Option<NoteSummary> {
        if let Ok(cache) = self.summaries.lock() {
            if let Some((mtime, size, cached)) = cache.get(&file.rel_path) {
                if *mtime == file.mtime && *size == file.size {
                    return Some(cached.clone());
                }
            }
        }
        let fresh = self
            .summarize(&self.root.join(&file.rel_path), &file.note_type)
            .ok()?;
        if let Ok(mut cache) = self.summaries.lock() {
            cache.insert(
                file.rel_path.clone(),
                (file.mtime, file.size, fresh.clone()),
            );
        }
        Some(fresh)
    }

    /// 사라진 파일의 요약은 버린다 (안 버리면 캐시가 계속 자란다)
    fn prune_summaries(&self, live: &[NoteFile]) {
        let Ok(mut cache) = self.summaries.lock() else {
            return;
        };
        if cache.len() <= live.len() {
            return;
        }
        let alive: HashSet<&str> = live.iter().map(|f| f.rel_path.as_str()).collect();
        cache.retain(|rel, _| alive.contains(rel.as_str()));
    }

    /// 노트 **한 편**의 요약. 저장 뒤 목록에서 그 한 줄만 갈아끼울 때 쓴다.
    ///
    /// 자동저장은 3초마다 도는데 그때마다 `list_notes()`로 vault 전체 요약을 다시
    /// 만들어 화면까지 실어 나를 이유가 없다 — 바뀐 건 방금 저장한 한 편뿐이다.
    /// 캐시를 거치므로 다음 `list_notes()`도 이 편을 다시 읽지 않는다.
    pub fn note_summary(&self, rel: &str) -> Result<NoteSummary, CoreError> {
        let abs = self.abs(rel)?;
        let meta = fs::metadata(&abs)?;
        let file = NoteFile {
            rel_path: rel.replace('\\', "/"),
            note_type: self.type_of_rel(rel)?,
            // list_note_files와 같은 잣대(나노초)여야 캐시가 어긋나지 않는다
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as i64)
                .unwrap_or(0),
            size: meta.len() as i64,
        };
        self.summary_of(&file)
            .ok_or_else(|| CoreError::NotFound(rel.to_string()))
    }

    pub fn list_notes(&self) -> Result<Vec<NoteSummary>, CoreError> {
        let files = self.list_note_files()?;
        let mut out: Vec<NoteSummary> =
            files.iter().filter_map(|f| self.summary_of(f)).collect();
        self.prune_summaries(&files);
        out.sort_by(|a, b| b.date.cmp(&a.date).then(a.title.cmp(&b.title)));
        Ok(out)
    }

    /// 노트 파일의 경로·수정시각·크기만 훑는다 (**내용은 읽지 않는다**).
    ///
    /// 증분 색인이 "무엇이 바뀌었나"를 판단할 때 쓴다. `list_notes()`는 편마다 파일을
    /// 열어 파싱하므로(2,000편에 377ms) 바뀐 게 없는지 확인하는 데 쓸 수 없다.
    /// 여기는 디렉터리 목록과 메타데이터만 본다.
    pub fn list_note_files(&self) -> Result<Vec<NoteFile>, CoreError> {
        fn walk(
            root: &Path,
            dir: &Path,
            type_id: &str,
            out: &mut Vec<NoteFile>,
        ) -> Result<(), CoreError> {
            if !dir.exists() {
                return Ok(());
            }
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if path.is_dir() {
                    walk(root, &path, type_id, out)?;
                } else if name.ends_with(".md") && !name.starts_with('_') {
                    let Ok(meta) = entry.metadata() else { continue };
                    // 수정시각을 못 읽는 파일은 늘 바뀐 것으로 본다 (0)
                    let mtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos() as i64)
                        .unwrap_or(0);
                    let Ok(rel) = path.strip_prefix(root) else {
                        continue;
                    };
                    out.push(NoteFile {
                        rel_path: rel.to_string_lossy().replace('\\', "/"),
                        note_type: type_id.to_string(),
                        mtime,
                        size: meta.len() as i64,
                    });
                }
            }
            Ok(())
        }

        let mut out = Vec::new();
        for t in &self.types {
            walk(&self.root, &self.root.join(&t.folder), &t.id, &mut out)?;
        }
        Ok(out)
    }

    /// 한 타입의 노트만 (`_index.md` 생성처럼 한 폴더만 필요할 때).
    ///
    /// `list_notes()`로 전부 읽고 걸러내면 나머지 폴더까지 파싱하는 값을 치른다 —
    /// 목록 파일 하나 만들려고 vault 전체를 읽을 이유가 없다.
    pub fn list_notes_of_type(&self, type_id: &str) -> Result<Vec<NoteSummary>, CoreError> {
        let mut out: Vec<NoteSummary> = self
            .list_note_files()?
            .iter()
            .filter(|f| f.note_type == type_id)
            .filter_map(|f| self.summary_of(f))
            .collect();
        out.sort_by(|a, b| b.date.cmp(&a.date).then(a.title.cmp(&b.title)));
        Ok(out)
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
            stamp: fingerprint(&content),
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
        self.save_note_checked(rel, frontmatter, body, None)
            .map(|_| ())
    }

    /// 저장하되, `expected`(읽어 올 때 받은 지문)를 주면 **그 사이에 파일이 바뀌었는지
    /// 먼저 확인한다.** 바뀌었으면 아무것도 쓰지 않고 `conflict`로 돌려준다.
    ///
    /// 같은 저장소를 두 곳(다른 기기·다른 창)에서 열어 두면 양쪽 다 화면에 든 본문을
    /// 통째로 써 넣는다. 나중에 저장한 쪽이 이기고, 진 쪽의 수정은 흔적도 없이 사라진다.
    /// 파일 감시 알림이 늦거나(클라우드 동기화는 몇 초씩 걸린다) 그 사이 내 저장에 묻히면
    /// 경고조차 뜨지 않는다. 그래서 **쓰기 직전에 파일 자신에게 다시 묻는다** — 알림에
    /// 기대지 않는 마지막 방어선이다.
    pub fn save_note_checked(
        &self,
        rel: &str,
        frontmatter: Value,
        body: &str,
        expected: Option<&str>,
    ) -> Result<SaveResult, CoreError> {
        let abs = self.abs(rel)?;
        let t = self.type_of_rel(rel)?;
        if let Some(expected) = expected {
            // 파일이 없으면(방금 지워졌거나 아직 안 만들어졌다) 막을 것이 없다 — 그냥 쓴다
            if let Ok(on_disk) = fs::read_to_string(&abs) {
                let now = fingerprint(&on_disk);
                if now != expected {
                    return Ok(SaveResult {
                        stamp: now,
                        conflict: true,
                    });
                }
            }
        }
        let mut fm = match frontmatter {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        normalize_frontmatter(&mut fm, &t, &Self::today());
        let content = parse::compose(&fm, body)?;
        self.snapshot_before(rel, Some(&content));
        self.atomic_write(&abs, &content)?;
        self.mark_index_stale(&t);
        Ok(SaveResult {
            stamp: fingerprint(&content),
            conflict: false,
        })
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
        // 스냅샷을 남겨 두면 지운 글의 본문이 최대 20벌 vault 안에 계속 남는다.
        // 파일 자체는 휴지통에 통째로 있으므로 되돌릴 길은 그대로다.
        let _ = crate::history::clear_note(self, rel);
        self.mark_index_stale(&t);
        Ok(())
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
        self.mark_index_stale(&resolved_type);
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

    /// 타입별 제목 머릿글 템플릿 파일 경로 (`.yamcha/templates/title-{type}.txt`)
    fn title_template_path(&self, type_id: &str) -> PathBuf {
        let safe = Self::sanitize_filename(type_id);
        self.root
            .join(".yamcha")
            .join("templates")
            .join(format!("title-{safe}.txt"))
    }

    /// 제목 머릿글을 쓸 수 있는 타입인가.
    /// 책·글쓰기·데일리는 파일명 규칙(제목/시리즈/날짜)이 이미 확고해서 제외한다.
    pub fn supports_title_prefix(type_id: &str) -> bool {
        !matches!(
            Builtin::from_id(type_id),
            Some(Builtin::Book) | Some(Builtin::Writing) | Some(Builtin::Daily)
        )
    }

    /// 타입별 기본 머릿글. 기본은 없음(빈 문자열) — 필요하면 설정에서 직접 정한다.
    fn default_title_template(_type_id: &str) -> &'static str {
        ""
    }

    /// 설정 화면용: 저장된 머릿글이 있으면 그것, 없으면 기본값
    pub fn read_title_template(&self, type_id: &str) -> Result<String, CoreError> {
        if !Self::supports_title_prefix(type_id) {
            return Ok(String::new());
        }
        match fs::read_to_string(self.title_template_path(type_id)) {
            Ok(s) => Ok(s),
            Err(_) => Ok(Self::default_title_template(type_id).to_string()),
        }
    }

    /// 머릿글 저장. 기본값과 같으면 파일을 지워 기본값으로 되돌린다.
    pub fn write_title_template(&self, type_id: &str, content: &str) -> Result<(), CoreError> {
        if !Self::supports_title_prefix(type_id) {
            return Err(CoreError::Invalid(format!(
                "'{type_id}' 분류는 제목 머릿글을 쓸 수 없습니다."
            )));
        }
        let path = self.title_template_path(type_id);
        if content == Self::default_title_template(type_id) {
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

    /// 제목 앞에 머릿글을 붙인다 (플레이스홀더는 template::render_template과 동일)
    fn apply_title_prefix(&self, type_id: &str, date: &str, title: &str) -> String {
        if !Self::supports_title_prefix(type_id) {
            return title.to_string();
        }
        let prefix = self
            .read_title_template(type_id)
            .unwrap_or_default();
        if prefix.trim().is_empty() {
            return title.to_string();
        }
        format!(
            "{}{title}",
            template::render_template(&prefix, date, title)
        )
    }

    /// 커스텀 템플릿 파일 경로 (kind: "daily"|"free"|"writing")
    fn template_file_path(&self, kind: &str) -> Option<PathBuf> {
        let name = match kind {
            "daily" => "daily.md",
            "free" => "free.md",
            "writing" => "writing.md",
            _ => return None,
        };
        Some(self.root.join(".yamcha").join("templates").join(name))
    }

    fn builtin_for_kind(kind: &str) -> Option<Builtin> {
        match kind {
            "daily" => Some(Builtin::Daily),
            "free" => Some(Builtin::Free),
            "writing" => Some(Builtin::Writing),
            _ => None,
        }
    }

    /// 생성 시 쓸 본문 템플릿: 커스텀 파일이 있으면 그 내용, 없으면 내장 기본값.
    /// frontmatter에는 영향을 주지 않는다(본문만).
    fn body_template(&self, b: Builtin) -> String {
        let kind = match b {
            Builtin::Daily => "daily",
            Builtin::Free => "free",
            Builtin::Writing => "writing",
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
            Some(Builtin::Free) | Some(Builtin::Writing) | None => {
                // 자유노트·글쓰기·사용자 정의 타입은 제목 = 파일명
                let raw = Self::sanitize_filename(title);
                let title =
                    Self::sanitize_filename(&self.apply_title_prefix(type_id, &today, &raw));
                if title != "무제" {
                    fm.insert("title".into(), json!(title));
                }
                // 글쓰기: 시작일 = 생성일 자동 채움 (없을 때만)
                if type_id == Builtin::Writing.id() && !fm.contains_key("started") {
                    fm.insert("started".into(), json!(today));
                }
                // 자유노트·글쓰기는 사용자 템플릿 우선, 그 외(사용자 정의 타입)는 타입 정의 템플릿
                let tmpl = if type_id == Builtin::Free.id() {
                    self.body_template(Builtin::Free)
                } else if type_id == Builtin::Writing.id() {
                    self.body_template(Builtin::Writing)
                } else {
                    def.template.clone()
                };
                let abs = self.unique_path(&self.root.join(&def.folder), &title);
                // 본문의 {{title}}은 머릿글을 뺀, 사용자가 실제로 입력한 제목
                (abs, template::render_template(&tmpl, &today, &raw))
            }
        };

        let content = parse::compose(&fm, &body)?;
        self.atomic_write(&abs, &content)?;
        self.mark_index_stale(type_id);
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
            self.mark_index_stale(Builtin::Daily.id());
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

    /// 본문 첫 줄에서 제목감을 뽑는다 (마크다운 기호·콜아웃 기호를 걷어내고 앞 24자).
    fn title_from_body(body: &str) -> String {
        for line in body.lines() {
            let t = line
                .trim()
                .trim_start_matches('>')
                .trim_start()
                .trim_start_matches(['#', '-', '*', '+'])
                .trim_start();
            // 빈 체크박스만 있는 템플릿 줄은 건너뛴다
            let t = t.strip_prefix("[ ]").unwrap_or(t).trim();
            let t = t.strip_prefix("[x]").or_else(|| t.strip_prefix("[X]")).unwrap_or(t).trim();
            if t.is_empty() {
                continue;
            }
            let short: String = t.chars().take(24).collect();
            return short.trim().to_string();
        }
        String::new()
    }

    /// 제목을 정하지 않고 닫은 노트에 이름을 붙여 준다.
    /// 이미 이름이 있으면 그대로 두고, 없을 때만 `{날짜} {본문 첫머리}`로 바꾼다.
    /// 바뀌었으면 새 rel, 아니면 원래 rel을 돌려준다.
    pub fn auto_title_if_untitled(&self, rel: &str) -> Result<String, CoreError> {
        let note = self.read_note(rel)?;
        if !Self::supports_title_prefix(&note.note_type) {
            return Ok(rel.to_string());
        }
        let stem = Path::new(rel)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let fm_title = note
            .frontmatter
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let current = if fm_title.is_empty() { stem.clone() } else { fm_title };

        // "무제" 또는 "무제 (2)"처럼 자동 부여된 이름만 대상으로 한다
        let untitled = current == "무제"
            || (current.starts_with("무제 (") && current.ends_with(')'));
        if !untitled {
            return Ok(rel.to_string());
        }

        let head = Self::title_from_body(&note.body);
        if head.is_empty() {
            return Ok(rel.to_string()); // 본문도 비었으면 건드리지 않는다
        }
        let date = note
            .frontmatter
            .get("date")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let date = if date.is_empty() { Self::today() } else { date };
        self.rename_note(rel, &format!("{date} {head}"))
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

        let aliases = crate::parse::extract_aliases(&fm);

        Ok(ParsedNote {
            rel_path: rel.to_string(),
            note_type: note.note_type,
            title,
            stem,
            date,
            tags,
            aliases,
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

    /// 데일리노트에 빠른 입력을 추가한다.
    /// 할 일은 `## 할 일`에 체크박스로, 기록·느낌은 `## 기록`에 시각이 붙은 콜아웃으로 들어간다.
    /// 해당 섹션이 없으면(사용자가 템플릿을 고친 경우) 본문 끝에 새로 만든다.
    pub fn append_daily_entry(
        &self,
        rel: &str,
        kind: DailyKind,
        text: &str,
    ) -> Result<NoteContent, CoreError> {
        let note = self.read_note(rel)?;
        if note.note_type != Builtin::Daily.id() {
            return Err(CoreError::Invalid("데일리노트가 아닙니다".into()));
        }
        let text = text.trim();
        if text.is_empty() {
            return Err(CoreError::Invalid("내용을 입력해주세요".into()));
        }
        let time = Local::now().format("%H:%M").to_string();
        let block = template::daily_entry_block(kind, &time, text);
        let tight = matches!(kind, DailyKind::Todo);
        let new_body = template::append_to_section(&note.body, kind.section(), &block, tight);
        let fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        let content = parse::compose(&fm, &new_body)?;
        self.snapshot_before(rel, Some(&content));
        self.atomic_write(&self.abs(rel)?, &content)?;
        self.read_note(rel)
    }

    /// 노트의 `## 기록` 섹션을 꺼낸다 (책·일지 공통).
    fn records_of(&self, note: &NoteContent) -> Result<String, CoreError> {
        template::section_text(&note.body, "## 기록")
            .ok_or_else(|| CoreError::Invalid("기록 섹션이 없습니다".into()))
    }

    /// 수정·삭제 대상이 화면에서 본 그 항목이 맞는지 확인한다.
    /// 그 사이 파일이 바뀌었으면(외부 편집·다른 창) 엉뚱한 항목을 건드리지 않도록 막는다.
    fn check_entry(
        entries: &[template::ParsedEntry],
        index: u32,
        expected_text: &str,
    ) -> Result<(), CoreError> {
        let e = entries.get(index as usize).ok_or_else(|| {
            CoreError::Invalid("기록 목록이 바뀌었습니다. 새로고침 후 다시 시도해주세요.".into())
        })?;
        if e.text.trim() != expected_text.trim() {
            return Err(CoreError::Invalid(
                "기록 목록이 바뀌었습니다. 새로고침 후 다시 시도해주세요.".into(),
            ));
        }
        Ok(())
    }

    /// 기록 섹션의 index번째 콜아웃 본문을 고친다 (종류·날짜는 유지).
    /// `expected_text`가 현재 내용과 다르면 거부한다.
    pub fn update_entry(
        &self,
        rel: &str,
        index: u32,
        expected_text: &str,
        new_text: &str,
    ) -> Result<NoteContent, CoreError> {
        let new_text = new_text.trim();
        if new_text.is_empty() {
            return Err(CoreError::Invalid("내용을 입력해주세요".into()));
        }
        let note = self.read_note(rel)?;
        let records = self.records_of(&note)?;
        Self::check_entry(&template::parse_entries(&records), index, expected_text)?;
        let new_records = template::replace_entry_text(&records, index as usize, new_text)
            .ok_or_else(|| CoreError::Invalid("기록을 찾을 수 없습니다".into()))?;
        self.write_records(rel, &note, &new_records)
    }

    /// 기록 섹션의 index번째 콜아웃을 지운다. `expected_text`가 다르면 거부한다.
    pub fn delete_entry(
        &self,
        rel: &str,
        index: u32,
        expected_text: &str,
    ) -> Result<NoteContent, CoreError> {
        let note = self.read_note(rel)?;
        let records = self.records_of(&note)?;
        Self::check_entry(&template::parse_entries(&records), index, expected_text)?;
        let new_records = template::remove_entry(&records, index as usize)
            .ok_or_else(|| CoreError::Invalid("기록을 찾을 수 없습니다".into()))?;
        self.write_records(rel, &note, &new_records)
    }

    /// 바뀐 기록 섹션을 본문에 되붙여 저장한다 (되돌리기용 스냅샷 포함).
    fn write_records(
        &self,
        rel: &str,
        note: &NoteContent,
        new_records: &str,
    ) -> Result<NoteContent, CoreError> {
        let new_body = template::replace_section_text(&note.body, "## 기록", new_records)
            .ok_or_else(|| CoreError::Invalid("기록 섹션이 없습니다".into()))?;
        let fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        let content = parse::compose(&fm, &new_body)?;
        self.snapshot_before(rel, Some(&content));
        self.atomic_write(&self.abs(rel)?, &content)?;
        self.read_note(rel)
    }

    /// 할 일이 적힌 범위: `## 할 일` 섹션이 있으면 그 안, 없으면(템플릿을 고친 경우) 본문 전체.
    fn todos_scope(note: &NoteContent) -> (String, bool) {
        match template::section_text(&note.body, "## 할 일") {
            Some(s) => (s, true),
            None => (note.body.clone(), false),
        }
    }

    /// 바뀐 할 일 범위를 본문에 되붙여 저장한다.
    fn write_todos(
        &self,
        rel: &str,
        note: &NoteContent,
        in_section: bool,
        new_text: &str,
    ) -> Result<NoteContent, CoreError> {
        let new_body = if in_section {
            template::replace_section_text(&note.body, "## 할 일", new_text)
                .ok_or_else(|| CoreError::Invalid("할 일 섹션이 없습니다".into()))?
        } else {
            new_text.to_string()
        };
        let fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        let content = parse::compose(&fm, &new_body)?;
        self.snapshot_before(rel, Some(&content));
        self.atomic_write(&self.abs(rel)?, &content)?;
        self.read_note(rel)
    }

    /// 화면에서 본 그 할 일이 맞는지 확인 (엉뚱한 줄을 건드리지 않도록)
    fn check_todo(
        todos: &[template::ParsedTodo],
        index: u32,
        expected_text: &str,
    ) -> Result<(), CoreError> {
        let t = todos.get(index as usize).ok_or_else(|| {
            CoreError::Invalid("할 일 목록이 바뀌었습니다. 새로고침 후 다시 시도해주세요.".into())
        })?;
        if t.text.trim() != expected_text.trim() {
            return Err(CoreError::Invalid(
                "할 일 목록이 바뀌었습니다. 새로고침 후 다시 시도해주세요.".into(),
            ));
        }
        Ok(())
    }

    /// 할 일 완료 여부 토글
    pub fn toggle_todo(
        &self,
        rel: &str,
        index: u32,
        expected_text: &str,
        done: bool,
    ) -> Result<NoteContent, CoreError> {
        let note = self.read_note(rel)?;
        let (scope, in_section) = Self::todos_scope(&note);
        Self::check_todo(&template::parse_todos(&scope), index, expected_text)?;
        let updated = template::set_todo_done(&scope, index as usize, done)
            .ok_or_else(|| CoreError::Invalid("할 일을 찾을 수 없습니다".into()))?;
        self.write_todos(rel, &note, in_section, &updated)
    }

    /// 할 일 내용 수정 (완료 여부는 유지)
    pub fn update_todo(
        &self,
        rel: &str,
        index: u32,
        expected_text: &str,
        new_text: &str,
    ) -> Result<NoteContent, CoreError> {
        let new_text = new_text.trim();
        if new_text.is_empty() {
            return Err(CoreError::Invalid("내용을 입력해주세요".into()));
        }
        let note = self.read_note(rel)?;
        let (scope, in_section) = Self::todos_scope(&note);
        Self::check_todo(&template::parse_todos(&scope), index, expected_text)?;
        let updated = template::replace_todo_text(&scope, index as usize, new_text)
            .ok_or_else(|| CoreError::Invalid("할 일을 찾을 수 없습니다".into()))?;
        self.write_todos(rel, &note, in_section, &updated)
    }

    /// 할 일 삭제
    pub fn delete_todo(
        &self,
        rel: &str,
        index: u32,
        expected_text: &str,
    ) -> Result<NoteContent, CoreError> {
        let note = self.read_note(rel)?;
        let (scope, in_section) = Self::todos_scope(&note);
        Self::check_todo(&template::parse_todos(&scope), index, expected_text)?;
        let updated = template::remove_todo(&scope, index as usize)
            .ok_or_else(|| CoreError::Invalid("할 일을 찾을 수 없습니다".into()))?;
        self.write_todos(rel, &note, in_section, &updated)
    }

    /// 항목의 종류를 바꾼다. `new_kind`가 "할 일"이면 체크박스로, 아니면 콜아웃으로 —
    /// 형식이 바뀌면 섹션(`## 기록` ↔ `## 할 일`)도 함께 옮긴다.
    /// `source`: "entry"(기록 콜아웃) 또는 "todo"(할 일).
    pub fn change_kind(
        &self,
        rel: &str,
        source: &str,
        index: u32,
        expected_text: &str,
        new_kind: &str,
    ) -> Result<NoteContent, CoreError> {
        let note = self.read_note(rel)?;
        let new_kind = new_kind.trim();
        let to_todo = new_kind == TODO_KIND;
        let time = Local::now().format("%H:%M").to_string();

        let new_body = match source {
            "entry" => {
                let records = self.records_of(&note)?;
                let entries = template::parse_entries(&records);
                Self::check_entry(&entries, index, expected_text)?;
                let entry = &entries[index as usize];

                if !to_todo {
                    // 같은 섹션 안에서 이름만 교체
                    let updated = template::replace_entry_kind(&records, index as usize, new_kind)
                        .ok_or_else(|| CoreError::Invalid("기록을 찾을 수 없습니다".into()))?;
                    return self.write_records(rel, &note, &updated);
                }
                // 콜아웃 → 할 일: 기록에서 빼고 할 일에 체크박스로 넣는다
                let text = entry.text.replace('\n', " ");
                let removed = template::remove_entry(&records, index as usize)
                    .ok_or_else(|| CoreError::Invalid("기록을 찾을 수 없습니다".into()))?;
                let body = template::replace_section_text(&note.body, "## 기록", &removed)
                    .ok_or_else(|| CoreError::Invalid("기록 섹션이 없습니다".into()))?;
                template::append_to_section(&body, "## 할 일", &format!("- [ ] {text}"), true)
            }
            "todo" => {
                let (scope, in_section) = Self::todos_scope(&note);
                let todos = template::parse_todos(&scope);
                Self::check_todo(&todos, index, expected_text)?;
                if to_todo {
                    return Ok(note); // 바꿀 게 없다
                }
                let text = todos[index as usize].text.clone();
                let removed = template::remove_todo(&scope, index as usize)
                    .ok_or_else(|| CoreError::Invalid("할 일을 찾을 수 없습니다".into()))?;
                let body = if in_section {
                    template::replace_section_text(&note.body, "## 할 일", &removed)
                        .ok_or_else(|| CoreError::Invalid("할 일 섹션이 없습니다".into()))?
                } else {
                    removed
                };
                let block = template::callout_block(new_kind, &time, &text);
                template::append_to_section(&body, "## 기록", &block, false)
            }
            _ => return Err(CoreError::Invalid("알 수 없는 항목 종류입니다".into())),
        };

        let fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        let content = parse::compose(&fm, &new_body)?;
        self.snapshot_before(rel, Some(&content));
        self.atomic_write(&self.abs(rel)?, &content)?;
        self.read_note(rel)
    }

    /// 임의 이름의 콜아웃을 `## 기록`에 붙인다 (사용자 정의 종류용 — 책·일지 공통).
    pub fn append_callout(
        &self,
        rel: &str,
        label: &str,
        text: &str,
    ) -> Result<NoteContent, CoreError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(CoreError::Invalid("내용을 입력해주세요".into()));
        }
        let note = self.read_note(rel)?;
        let time = Local::now().format("%H:%M").to_string();
        let block = template::callout_block(label, &time, text);
        let new_body = template::append_to_section(&note.body, "## 기록", &block, false);
        let fm = note.frontmatter.as_object().cloned().unwrap_or_default();
        let content = parse::compose(&fm, &new_body)?;
        self.snapshot_before(rel, Some(&content));
        self.atomic_write(&self.abs(rel)?, &content)?;
        self.read_note(rel)
    }

    // ---------- 사용자 정의 콜아웃 ----------

    fn callouts_path(&self) -> PathBuf {
        self.root.join(CALLOUTS_FILE)
    }

    /// vault에 저장된 사용자 정의 콜아웃 (파일이 없거나 깨졌으면 빈 목록)
    pub fn list_callouts(&self) -> Vec<CalloutDef> {
        fs::read_to_string(self.callouts_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<CalloutDef>>(&s).ok())
            .unwrap_or_default()
    }

    fn save_callouts(&self, list: &[CalloutDef]) -> Result<(), CoreError> {
        let json = serde_json::to_string_pretty(list)
            .map_err(|e| CoreError::Invalid(format!("콜아웃 저장 실패: {e}")))?;
        fs::write(self.callouts_path(), json)?;
        Ok(())
    }

    /// 사용자 정의 콜아웃 추가. 이름 중복·기본 종류와 충돌·화면당 상한을 검사한다.
    pub fn add_callout(&self, def: CalloutDef) -> Result<Vec<CalloutDef>, CoreError> {
        let label = def.label.trim().to_string();
        if label.is_empty() {
            return Err(CoreError::Invalid("이름을 입력하세요".into()));
        }
        if BUILTIN_KIND_LABELS.contains(&label.as_str()) {
            return Err(CoreError::Invalid(format!(
                "'{label}'은 기본 종류라 쓸 수 없습니다"
            )));
        }
        let mut list = self.list_callouts();
        if list.iter().any(|c| c.label == label) {
            return Err(CoreError::Invalid(format!("이미 있는 이름입니다: {label}")));
        }
        // 일지·책 각각 최대 5개까지
        for target in ["daily", "book"] {
            if !visible_in(&def.scope, target) {
                continue;
            }
            let used = list.iter().filter(|c| visible_in(&c.scope, target)).count();
            if used >= MAX_CALLOUTS_PER_SCOPE {
                let where_ = if target == "daily" { "일지" } else { "책" };
                return Err(CoreError::Invalid(format!(
                    "{where_}에 쓸 수 있는 콜아웃은 {MAX_CALLOUTS_PER_SCOPE}개까지입니다"
                )));
            }
        }
        list.push(CalloutDef { label, ..def });
        self.save_callouts(&list)?;
        Ok(list)
    }

    /// 사용자 정의 콜아웃 제거 (이미 쓴 노트의 내용은 그대로 두고 목록에서만 뺀다)
    pub fn remove_callout(&self, label: &str) -> Result<Vec<CalloutDef>, CoreError> {
        let mut list = self.list_callouts();
        list.retain(|c| c.label != label);
        self.save_callouts(&list)?;
        Ok(list)
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

/// 본문의 인라인 `#from`을 `#to`로 바꾼다.
/// `#클린` 을 바꿀 때 `#클린코드` 가 함께 바뀌지 않도록 뒤 글자까지 확인한다.
fn replace_inline_tag(body: &str, from: &str, to: &str) -> String {
    // `(?m)`이 있어야 `$`가 줄 끝을 가리킨다 — 태그는 보통 줄 끝에 있다.
    // regex 크레이트에는 look-around가 없어서 뒤 글자를 잡아 두고 그대로 되돌려 붙인다.
    let pattern = format!(
        r"(?m)(^|\s)#{}([^\p{{L}}\p{{N}}/_-]|$)",
        regex::escape(from)
    );
    match regex::Regex::new(&pattern) {
        Ok(re) => re
            .replace_all(body, format!("${{1}}#{to}${{2}}").as_str())
            .into_owned(),
        Err(_) => body.to_string(),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{FieldDef, FieldKind};
    use std::time::Duration;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    /// 목록 요약은 캐시에서 오지만, **파일이 바뀌면 반드시 새 값이 나와야 한다.**
    /// 여기가 어긋나면 고친 제목이 목록에 영영 안 뜬다.
    #[test]
    fn 목록_캐시는_파일이_바뀌면_따라온다() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "처음 제목", json!({})).unwrap();

        let before = v.list_notes().unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].title, "처음 제목");

        // 제목을 바꾼다 (frontmatter만 바뀌므로 크기가 비슷하다 — 캐시가 속기 쉬운 자리)
        v.save_note(&rel, json!({ "title": "고친 제목" }), "본문").unwrap();

        let after = v.list_notes().unwrap();
        assert_eq!(after[0].title, "고친 제목", "낡은 요약이 나왔다");
    }

    /// 앱 밖에서 지운 파일은 목록에서도 빠져야 한다 (캐시에 유령이 남으면 안 된다)
    #[test]
    fn 목록_캐시에_유령이_남지_않는다() {
        let (_d, v) = vault();
        let a = v.create_note("free", "남을 노트", json!({})).unwrap();
        let b = v.create_note("free", "사라질 노트", json!({})).unwrap();
        assert_eq!(v.list_notes().unwrap().len(), 2);

        fs::remove_file(v.abs(&b).unwrap()).unwrap();

        let after = v.list_notes().unwrap();
        assert_eq!(after.len(), 1, "지운 노트가 목록에 남았다");
        assert_eq!(after[0].rel_path, a);
    }

    /// 본문만 고쳐도 글자 수는 따라와야 한다 (글쓰기 화면이 이 값으로 진행을 보여준다)
    #[test]
    fn 본문을_고치면_글자수가_따라온다() {
        let (_d, v) = vault();
        let rel = v.create_note("writing", "글", json!({})).unwrap();
        v.save_note(&rel, json!({}), "짧다").unwrap();
        let before = v.list_notes().unwrap()[0].char_count;

        v.save_note(&rel, json!({}), &"길게 쓴 문장이다 ".repeat(20)).unwrap();
        let after = v.list_notes().unwrap()[0].char_count;

        assert!(after > before, "글자 수가 그대로다 ({before} → {after})");
    }

    /// 저장 중에도 노트 파일은 **한 순간도 사라지지 않아야 한다.**
    /// 예전 구현은 rename 전에 원본을 지웠고, 그 틈에 rename이 실패하면(백신·클라우드 동기화가
    /// tmp를 잠그는 흔한 상황) 노트가 통째로 날아갔다. 읽는 쪽에서 파일이 없어 보이는 순간이
    /// 있는지 직접 확인한다.
    #[test]
    fn 저장_중에도_파일이_사라지지_않는다() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let (_d, v) = vault();
        let rel = v.create_note("free", "쓰는중", json!({})).unwrap();
        let abs = v.abs(&rel).unwrap();

        let done = Arc::new(AtomicBool::new(false));
        let missing = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (abs, done, missing) = (abs.clone(), done.clone(), missing.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    if !abs.exists() {
                        missing.store(true, Ordering::Relaxed);
                        return;
                    }
                }
            })
        };

        for i in 0..300 {
            v.atomic_write(&abs, &format!("---\ntype: free\n---\n\n{i}번째 저장"))
                .unwrap();
        }
        done.store(true, Ordering::Relaxed);
        watcher.join().unwrap();

        assert!(
            !missing.load(Ordering::Relaxed),
            "저장 도중 노트 파일이 사라지는 순간이 있었다"
        );
        assert!(fs::read_to_string(&abs).unwrap().contains("299번째 저장"));
    }

    /// 성공한 쓰기는 임시파일을 남기지 않는다 (watcher가 `.md.tmp`를 무시하므로
    /// 남으면 그대로 유령 파일이 된다)
    #[test]
    fn 저장_뒤_임시파일이_남지_않는다() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        let abs = v.abs(&rel).unwrap();
        v.atomic_write(&abs, "---\ntype: free\n---\n\n덮어쓴 내용").unwrap();

        assert!(!abs.with_extension("md.tmp").exists(), "tmp가 남았다");
        assert!(fs::read_to_string(&abs).unwrap().contains("덮어쓴 내용"));
    }

    /// **vault 밖을 가리키는 경로는 어떤 모양이어도 거절한다.**
    /// `..`만 막던 때는 절대경로가 그대로 통과했다 — `Path::join`이 앞을 버리기 때문에
    /// 수리 화면의 read_raw·write_raw로 vault 밖 파일을 읽고 덮어쓸 수 있었다.
    #[test]
    fn vault_밖_경로는_거절한다() {
        let (_d, v) = vault();
        let 밖 = [
            "../몰래.md",
            "Free/../../몰래.md",
            "/etc/passwd",
            "C:\\Windows\\System32\\drivers\\etc\\hosts",
            "\\\\서버\\공유\\몰래.md",
        ];
        for rel in 밖 {
            assert!(v.abs(rel).is_err(), "vault 밖 경로가 통과했다: {rel}");
        }
        // 멀쩡한 상대경로는 그대로 통과해야 한다
        assert!(v.abs("Free/메모.md").is_ok());
        assert!(v.abs("Daily/2026/08/2026-08-05.md").is_ok());
    }

    /// 클라우드 동기화 폴더 안에서 저장할 때마다 노트 옆에 임시파일이 생겼다 사라지면
    /// 동기화 클라이언트가 그 찰나의 파일까지 올린다. 노트 폴더는 건드리지 않는다.
    #[test]
    fn 임시파일은_노트_폴더_밖에_쓴다() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        let dir = v.abs(&rel).unwrap().parent().unwrap().to_path_buf();

        v.save_note(&rel, json!({}), "본문을 고친다").unwrap();

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "노트 폴더에 임시파일이 남았다: {leftovers:?}"
        );
        assert!(v.read_note(&rel).unwrap().body.contains("본문을 고친다"));
    }

    /// 저장이 늦게 반영되거나 다른 창이 그 사이에 저장해도, "내가 쓴 것"은
    /// 시각이 아니라 **내용**으로 가린다.
    #[test]
    fn 자기가_쓴_내용을_알아본다() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "메모", json!({})).unwrap();

        v.save_note(&rel, json!({}), "내가 쓴 본문").unwrap();
        assert!(v.is_self_write(&rel), "방금 쓴 것을 남의 것으로 봤다");

        // 밖에서(다른 앱·다른 기기) 고친 파일은 내 것이 아니다
        let abs = v.abs(&rel).unwrap();
        let raw = fs::read_to_string(&abs).unwrap();
        fs::write(&abs, format!("{raw}\n밖에서 덧붙인 줄")).unwrap();
        assert!(!v.is_self_write(&rel), "남이 고친 것을 내 것으로 봤다");
    }

    /// 같은 저장소를 두 곳에서 열어 두면 나중에 저장한 쪽이 앞의 수정을 통째로 덮었다.
    /// 이제 쓰기 직전에 파일 자신에게 다시 묻는다.
    #[test]
    fn 읽은_뒤_바뀐_파일은_덮어쓰지_않는다() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "메모", json!({})).unwrap();

        // A가 노트를 열었다 (이때의 지문을 들고 편집을 시작한다)
        let opened = v.read_note(&rel).unwrap();

        // 그 사이 B가 같은 파일을 저장했다
        v.save_note(&rel, json!({}), "B가 쓴 본문").unwrap();

        // A가 저장을 시도한다 → 막힌다. 파일은 B의 것 그대로여야 한다.
        let r = v
            .save_note_checked(&rel, opened.frontmatter.clone(), "A가 쓴 본문", Some(&opened.stamp))
            .unwrap();
        assert!(r.conflict, "덮어쓰기를 막지 못했다");
        assert!(v.read_note(&rel).unwrap().body.contains("B가 쓴 본문"));

        // 사용자가 "내 편집 유지"를 고르면(지문 없이) 일부러 덮어쓴다
        let forced = v
            .save_note_checked(&rel, opened.frontmatter, "A가 쓴 본문", None)
            .unwrap();
        assert!(!forced.conflict);
        assert!(v.read_note(&rel).unwrap().body.contains("A가 쓴 본문"));
    }

    /// 저장하고 나면 그 결과 지문으로 이어서 저장할 수 있어야 한다 —
    /// 아니면 자기가 방금 쓴 내용과 충돌한다.
    #[test]
    fn 저장이_돌려준_지문으로_이어서_저장한다() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        let opened = v.read_note(&rel).unwrap();

        let first = v
            .save_note_checked(&rel, opened.frontmatter.clone(), "첫 번째", Some(&opened.stamp))
            .unwrap();
        assert!(!first.conflict);

        let second = v
            .save_note_checked(&rel, opened.frontmatter, "두 번째", Some(&first.stamp))
            .unwrap();
        assert!(!second.conflict, "방금 내가 쓴 내용을 남의 것으로 봤다");
        assert!(v.read_note(&rel).unwrap().body.contains("두 번째"));
    }

    /// 강제 종료로 남은 임시파일은 걷되, **갓 만들어진 건 건드리지 않는다**
    /// (지금 다른 창이 저장하는 중일 수 있다)
    #[test]
    fn 오래된_임시파일만_걷는다() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "메모", json!({})).unwrap();
        let dir = v.abs(&rel).unwrap().parent().unwrap().to_path_buf();

        let tmp = dir.join("죽은 저장.md.tmp");
        fs::write(&tmp, "반쯤 쓰인 내용").unwrap();

        // 갓 만들어진 것은 지금 쓰는 중일 수 있으니 건드리지 않는다
        assert_eq!(v.sweep_stale_tmp(Duration::from_secs(3600)).unwrap(), 0);
        assert!(tmp.exists(), "지금 쓰는 중일 수 있는 임시파일을 지웠다");

        // 기준을 넘긴 것은 걷는다
        assert_eq!(v.sweep_stale_tmp(Duration::ZERO).unwrap(), 1);
        assert!(!tmp.exists(), "오래된 임시파일이 남았다");
        assert!(v.abs(&rel).unwrap().exists(), "멀쩡한 노트를 건드렸다");
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
    fn daily_entry_appends_to_matching_sections() {
        let (_d, v) = vault();
        let rel = v.open_daily(&Vault::today()).unwrap();

        v.append_daily_entry(&rel, DailyKind::Todo, "우유 사기").unwrap();
        v.append_daily_entry(&rel, DailyKind::Log, "회의함").unwrap();
        let note = v
            .append_daily_entry(&rel, DailyKind::Feeling, "후련하다")
            .unwrap();

        // 할 일은 체크박스로, 나머지는 기록 섹션 콜아웃으로
        assert!(note.body.contains("- [ ] 우유 사기"), "got: {}", note.body);
        assert!(note.body.contains("> [!기록]"), "got: {}", note.body);
        assert!(note.body.contains("> 회의함"), "got: {}", note.body);
        assert!(note.body.contains("> [!느낌]"), "got: {}", note.body);
        assert!(note.body.contains("> 후련하다"), "got: {}", note.body);
        // 섹션 구조는 유지되고, 할 일이 기록 섹션으로 새지 않는다
        let todo_pos = note.body.find("- [ ] 우유 사기").unwrap();
        let record_pos = note.body.find("## 기록").unwrap();
        assert!(todo_pos < record_pos, "할 일이 기록 섹션 뒤로 갔음: {}", note.body);
    }

    #[test]
    fn todo_toggle_update_delete_on_daily() {
        let (_d, v) = vault();
        let rel = v.open_daily(&Vault::today()).unwrap();
        v.append_daily_entry(&rel, DailyKind::Todo, "우유 사기").unwrap();
        v.append_daily_entry(&rel, DailyKind::Todo, "설거지").unwrap();
        v.append_daily_entry(&rel, DailyKind::Log, "기록 한 줄").unwrap();

        // 완료 표시 — 기록 섹션은 건드리지 않는다
        let note = v.toggle_todo(&rel, 0, "우유 사기", true).unwrap();
        assert!(note.body.contains("- [x] 우유 사기"), "got: {}", note.body);
        assert!(note.body.contains("> 기록 한 줄"), "got: {}", note.body);

        // 내용 수정 — 완료 여부 유지
        let note = v.update_todo(&rel, 0, "우유 사기", "두유 사기").unwrap();
        assert!(note.body.contains("- [x] 두유 사기"), "got: {}", note.body);

        // 삭제
        let note = v.delete_todo(&rel, 0, "두유 사기").unwrap();
        assert!(!note.body.contains("두유 사기"), "got: {}", note.body);
        assert!(note.body.contains("- [ ] 설거지"), "got: {}", note.body);
    }

    #[test]
    fn change_kind_between_callout_and_todo() {
        let (_d, v) = vault();
        let rel = v.open_daily(&Vault::today()).unwrap();
        v.append_daily_entry(&rel, DailyKind::Log, "회의함").unwrap();

        // 콜아웃 → 콜아웃: 이름만 바뀌고 자리는 그대로
        let note = v.change_kind(&rel, "entry", 0, "회의함", "느낌").unwrap();
        assert!(note.body.contains("> [!느낌]"), "got: {}", note.body);
        assert!(!note.body.contains("[!기록]"), "got: {}", note.body);

        // 콜아웃 → 할 일: 기록에서 빠지고 할 일에 체크박스로 들어간다
        let note = v.change_kind(&rel, "entry", 0, "회의함", "할 일").unwrap();
        assert!(note.body.contains("- [ ] 회의함"), "got: {}", note.body);
        assert!(!note.body.contains("[!느낌]"), "got: {}", note.body);
        let todo_pos = note.body.find("- [ ] 회의함").unwrap();
        let rec_pos = note.body.find("## 기록").unwrap();
        assert!(todo_pos < rec_pos, "할 일 섹션에 있어야 함: {}", note.body);

        // 할 일 → 콜아웃: 다시 기록으로 이동
        let note = v.change_kind(&rel, "todo", 0, "회의함", "기록").unwrap();
        assert!(note.body.contains("> [!기록]"), "got: {}", note.body);
        assert!(!note.body.contains("- [ ] 회의함"), "got: {}", note.body);
    }

    #[test]
    fn custom_callouts_limit_and_duplicates() {
        let (_d, v) = vault();
        let mk = |l: &str, scope: &str| CalloutDef {
            label: l.into(),
            icon: "🔖".into(),
            color: "rose".into(),
            scope: scope.into(),
        };
        for i in 0..MAX_CALLOUTS_PER_SCOPE {
            v.add_callout(mk(&format!("일지{i}"), "daily")).unwrap();
        }
        // 일지는 꽉 찼지만 책은 아직 여유가 있다
        assert!(v.add_callout(mk("초과", "daily")).is_err());
        assert!(v.add_callout(mk("책것", "book")).is_ok());
        // 이름 중복·기본 종류와 충돌은 거부
        assert!(v.add_callout(mk("책것", "book")).is_err());
        assert!(v.add_callout(mk("발췌", "book")).is_err());

        assert_eq!(v.list_callouts().len(), MAX_CALLOUTS_PER_SCOPE + 1);
        v.remove_callout("책것").unwrap();
        assert!(!v.list_callouts().iter().any(|c| c.label == "책것"));
    }

    #[test]
    fn todo_ops_refuse_when_content_moved() {
        let (_d, v) = vault();
        let rel = v.open_daily(&Vault::today()).unwrap();
        v.append_daily_entry(&rel, DailyKind::Todo, "원래 할 일").unwrap();

        assert!(v.toggle_todo(&rel, 0, "엉뚱한 것", true).is_err());
        assert!(v.update_todo(&rel, 0, "엉뚱한 것", "새것").is_err());
        assert!(v.delete_todo(&rel, 0, "엉뚱한 것").is_err());
        assert!(v.delete_todo(&rel, 7, "원래 할 일").is_err());
        // 원본 보존
        let note = v.read_note(&rel).unwrap();
        assert!(note.body.contains("- [ ] 원래 할 일"));
    }

    #[test]
    fn update_and_delete_entry_on_book() {
        let (_d, v) = vault();
        let book = v.create_note("book", "책", serde_json::json!({})).unwrap();
        v.append_reading_entry(&book, EntryKind::Excerpt, "첫 인용").unwrap();
        v.append_reading_entry(&book, EntryKind::Thought, "둘째 생각").unwrap();

        // 수정: 종류·날짜는 유지되고 본문만 바뀐다
        let note = v.update_entry(&book, 0, "첫 인용", "고친 인용").unwrap();
        assert!(note.body.contains("> [!발췌]"), "got: {}", note.body);
        assert!(note.body.contains("> 고친 인용"), "got: {}", note.body);
        assert!(!note.body.contains("첫 인용"), "got: {}", note.body);
        // 소개 섹션과 옆 엔트리는 그대로
        assert!(note.body.contains("## 소개"));
        assert!(note.body.contains("> 둘째 생각"));

        // 삭제
        let note = v.delete_entry(&book, 0, "고친 인용").unwrap();
        let records = template::section_text(&note.body, "## 기록").unwrap();
        let left = template::parse_entries(&records);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "둘째 생각");
    }

    /// 외부 에디터(옵시디언 등)에서 콜아웃 없이 써 넣은 내용은 보기 화면에 안 보이지만,
    /// 항목을 고치거나 지워도 **파일에서 사라지지 않아야** 한다.
    #[test]
    fn non_callout_text_survives_entry_ops() {
        let (_d, v) = vault();
        let book = v.create_note("book", "책", serde_json::json!({})).unwrap();
        v.append_reading_entry(&book, EntryKind::Excerpt, "앱에서 넣은 인용").unwrap();

        // 외부 편집기로 평문·일반 인용문을 섞어 넣은 상황을 만든다
        let note = v.read_note(&book).unwrap();
        let records = template::section_text(&note.body, "## 기록").unwrap();
        let mixed = format!("{records}\n\n옵시디언에서 쓴 평문\n\n> 그냥 인용문\n");
        let body = template::replace_section_text(&note.body, "## 기록", &mixed).unwrap();
        v.save_note(&book, note.frontmatter.clone(), &body).unwrap();

        // 콜아웃 수정 → 평문·인용문은 그대로 남아야 한다
        let note = v.update_entry(&book, 0, "앱에서 넣은 인용", "고친 인용").unwrap();
        assert!(note.body.contains("옵시디언에서 쓴 평문"), "평문 유실: {}", note.body);
        assert!(note.body.contains("> 그냥 인용문"), "인용문 유실: {}", note.body);

        // 콜아웃 삭제 → 여전히 남아야 한다
        let note = v.delete_entry(&book, 0, "고친 인용").unwrap();
        assert!(note.body.contains("옵시디언에서 쓴 평문"), "평문 유실: {}", note.body);
        assert!(note.body.contains("> 그냥 인용문"), "인용문 유실: {}", note.body);
    }

    #[test]
    fn entry_ops_refuse_when_content_moved() {
        let (_d, v) = vault();
        let book = v.create_note("book", "책", serde_json::json!({})).unwrap();
        v.append_reading_entry(&book, EntryKind::Excerpt, "원래 내용").unwrap();

        // 화면에서 본 내용과 다르면 (그 사이 파일이 바뀐 것) 건드리지 않는다
        assert!(v.update_entry(&book, 0, "엉뚱한 내용", "새 내용").is_err());
        assert!(v.delete_entry(&book, 0, "엉뚱한 내용").is_err());
        // 범위 밖도 거부
        assert!(v.delete_entry(&book, 5, "원래 내용").is_err());
        // 원본은 그대로 남아 있다
        let note = v.read_note(&book).unwrap();
        assert!(note.body.contains("> 원래 내용"));
    }

    #[test]
    fn update_entry_works_on_daily_records() {
        let (_d, v) = vault();
        let rel = v.open_daily(&Vault::today()).unwrap();
        v.append_daily_entry(&rel, DailyKind::Todo, "할 일 하나").unwrap();
        v.append_daily_entry(&rel, DailyKind::Log, "원래 기록").unwrap();

        let note = v.update_entry(&rel, 0, "원래 기록", "고친 기록").unwrap();
        assert!(note.body.contains("> 고친 기록"), "got: {}", note.body);
        // 할 일 섹션은 손대지 않는다
        assert!(note.body.contains("- [ ] 할 일 하나"), "got: {}", note.body);
    }

    #[test]
    fn daily_entry_rejects_non_daily_and_empty() {
        let (_d, v) = vault();
        let book = v
            .create_note("book", "책", serde_json::json!({}))
            .unwrap();
        assert!(v.append_daily_entry(&book, DailyKind::Todo, "x").is_err());

        let daily = v.open_daily(&Vault::today()).unwrap();
        assert!(v.append_daily_entry(&daily, DailyKind::Todo, "   ").is_err());
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
                    "meeting",
                    vec![FieldDef::new("attendees", "참석자", FieldKind::Text, true)],
                    "## 안건\n\n## 결정사항\n",
                )
                .unwrap();
            assert_eq!(def.id, "meeting");
            assert!(v.root().join("회의록").is_dir());
            // 공통 필드 + 커스텀 필드
            assert!(def.fields.iter().any(|f| f.name == "date"));
            assert!(def.fields.iter().any(|f| f.name == "attendees"));

            let rel = v
                .create_note("meeting", "주간 회의", serde_json::json!({"attendees": "SG"}))
                .unwrap();
            assert_eq!(rel, "회의록/주간 회의.md");
            let note = v.read_note(&rel).unwrap();
            assert_eq!(note.note_type, "meeting");
            assert!(note.body.contains("## 안건"));
            assert_eq!(note.frontmatter["attendees"], "SG");

            // 중복 방지 (라벨·ID 둘 다 검사)
            assert!(v.add_custom_type("회의록", "meeting2", vec![], "").is_err());
            assert!(v.add_custom_type("다른 이름", "meeting", vec![], "").is_err());
        }
        // 재오픈 시 커스텀 타입 유지
        {
            let v = Vault::open(dir.path()).unwrap();
            assert!(v.def_by_id("meeting").is_some());
            let notes = v.list_notes().unwrap();
            assert!(notes.iter().any(|n| n.note_type == "meeting"));
        }
        // 제거 시 정의가 사라지고 노트는 자유노트로 이동
        {
            let mut v = Vault::open(dir.path()).unwrap();
            v.remove_custom_type("meeting").unwrap();
            assert!(v.def_by_id("meeting").is_none());
            assert!(dir.path().join("Free/주간 회의.md").exists());
        }
    }

    #[test]
    fn move_note_switches_folder_and_type() {
        let (_d, mut v) = vault();
        v.add_custom_type("회의록", "meeting", vec![], "").unwrap();
        v.add_custom_type("자료집", "archive", vec![], "").unwrap();
        let rel = v
            .create_note("meeting", "주간 회의", serde_json::json!({}))
            .unwrap();

        let new_rel = v.move_note(&rel, "archive").unwrap();
        assert_eq!(new_rel, "자료집/주간 회의.md");
        assert!(v.read_note(&rel).is_err());
        let moved = v.read_note(&new_rel).unwrap();
        assert_eq!(moved.note_type, "archive");

        // 같은 분류로는 이동 불가, 없는 분류로도 불가
        assert!(v.move_note(&new_rel, "archive").is_err());
        assert!(v.move_note(&new_rel, "없음").is_err());

        // 책·데일리는 원본·대상 어느 쪽으로도 이동 불가
        let book = v
            .create_note("book", "어떤 책", serde_json::json!({"author": "저자"}))
            .unwrap();
        assert!(v.move_note(&book, "archive").is_err());
        assert!(v.move_note(&new_rel, "book").is_err());
        let daily = v.open_daily("2026-07-18").unwrap();
        assert!(v.move_note(&daily, "archive").is_err());
    }

    /// **폴더까지 적어 가리킨 링크는 옮겨도 따라와야 한다.**
    ///
    /// 자동완성이 이름 겹칠 때 이 형태를 넣어 주고 고르는 창도 이 형태를 권한다.
    /// 조언을 따른 사람만 이동에서 링크가 끊기면, 그 조언이 함정이 된다.
    #[test]
    fn 옮기면_경로로_적은_링크가_따라온다() {
        let (_d, mut v) = vault();
        v.add_custom_type("회의록", "meeting", vec![], "").unwrap();
        let target = v.create_note("free", "메모", serde_json::json!({})).unwrap();
        assert_eq!(target, "Free/메모.md");
        let linker = v.create_note("writing", "가리키는 글", serde_json::json!({})).unwrap();
        v.save_note(
            &linker,
            serde_json::json!({}),
            "[[Free/메모]] · [[Free/메모.md]] · [[Free/메모|딴이름]] · [[Free/메모#절]] · [[메모]]",
        )
        .unwrap();

        let moved = v.move_note(&target, "meeting").unwrap();
        assert_eq!(moved, "회의록/메모.md");

        let body = v.read_note(&linker).unwrap().body;
        assert!(body.contains("[[회의록/메모]] ·"), "경로 링크가 안 따라왔다: {body}");
        assert!(body.contains("[[회의록/메모|딴이름]]"), "표시명 링크: {body}");
        assert!(body.contains("[[회의록/메모#절]]"), "섹션 링크: {body}");
        // `.md`를 붙여 쓴 것도 따라오되 표기는 확장자 없는 쪽으로 모은다
        assert!(!body.contains("Free/메모"), "옛 경로가 남았다: {body}");
        // **이름만 적은 링크는 건드리지 않는다** — 어느 글을 뜻했는지 알 수 없다
        assert!(body.contains("[[메모]]"), "이름 링크를 함부로 고쳤다: {body}");
    }

    /// 제목을 바꾸면 파일명이 바뀌므로 경로도 바뀐다
    #[test]
    fn 제목을_바꿔도_경로_링크가_따라온다() {
        let (_d, v) = vault();
        let target = v.create_note("free", "옛 이름", serde_json::json!({})).unwrap();
        let linker = v.create_note("free", "가리키는 글", serde_json::json!({})).unwrap();
        v.save_note(&linker, serde_json::json!({}), "[[Free/옛 이름]] 참고").unwrap();

        v.rename_note(&target, "새 이름").unwrap();
        let body = v.read_note(&linker).unwrap().body;
        assert!(body.contains("[[Free/새 이름]]"), "경로 링크가 안 따라왔다: {body}");
    }

    /// 제목에 `.md`가 든 글(`Free/메모.md.md`)을 옮겨도 **남의 링크는 건드리지 않는다.**
    ///
    /// 확장자를 두 번 떼면 이 파일의 옛 키가 `Free/메모`로 나오는데, 그건 옆에 있는
    /// 다른 글(`Free/메모.md`)의 경로 키다. 그 글을 가리키던 `[[Free/메모]]`를 엉뚱하게
    /// 고치면서, 정작 옮긴 글의 링크(`[[Free/메모.md]]`)는 놓친다.
    #[test]
    fn 제목에_점md가_든_글을_옮겨도_남의_링크는_그대로다() {
        let (_d, mut v) = vault();
        v.add_custom_type("회의록", "meeting", vec![], "").unwrap();
        let plain = v.create_note("free", "메모", serde_json::json!({})).unwrap();
        let dotmd = v.create_note("free", "메모.md", serde_json::json!({})).unwrap();
        assert_eq!(plain, "Free/메모.md");
        assert_eq!(dotmd, "Free/메모.md.md", "전제가 바뀌었다");

        let linker = v.create_note("writing", "가리키는 글", serde_json::json!({})).unwrap();
        v.save_note(
            &linker,
            serde_json::json!({}),
            "[[Free/메모]] · [[Free/메모.md]]",
        )
        .unwrap();

        // '메모.md' 쪽만 옮긴다
        assert_eq!(v.move_note(&dotmd, "meeting").unwrap(), "회의록/메모.md.md");

        let body = v.read_note(&linker).unwrap().body;
        // 안 옮긴 글을 가리키던 링크는 그대로
        assert!(body.contains("[[Free/메모]]"), "남의 링크를 고쳤다: {body}");
        // 옮긴 글을 가리키던 링크는 따라온다
        assert!(body.contains("[[회의록/메모.md]]"), "링크가 안 따라왔다: {body}");
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
    fn free_note_title_prefix_applies() {
        let (_d, v) = vault();
        let today = Vault::today();
        v.write_title_template("free", "{{date}} ").unwrap();
        let rel = v.create_note("free", "회의", serde_json::json!({})).unwrap();
        assert_eq!(rel, format!("Free/{today} 회의.md"));
        // 제목(frontmatter)도 머릿글이 붙은 값으로 맞춰진다
        assert_eq!(
            v.read_note(&rel).unwrap().frontmatter["title"],
            format!("{today} 회의")
        );
    }

    #[test]
    fn title_prefix_rejected_for_fixed_naming_types() {
        let (_d, v) = vault();
        assert!(v.write_title_template("book", "{{date}} ").is_err());
        assert!(v.write_title_template("daily", "x").is_err());
        assert!(v.read_title_template("book").unwrap().is_empty());
    }

    #[test]
    fn auto_title_names_untitled_note_from_body() {
        let (_d, v) = vault();
        let today = Vault::today();
        let rel = v.create_note("free", "", serde_json::json!({})).unwrap();
        assert_eq!(rel, "Free/무제.md");

        v.save_note(&rel, serde_json::json!({}), "# 오늘 배운 것\n\n본문이 이어진다")
            .unwrap();
        let new_rel = v.auto_title_if_untitled(&rel).unwrap();
        assert_eq!(new_rel, format!("Free/{today} 오늘 배운 것.md"));
    }

    #[test]
    fn auto_title_leaves_named_and_empty_notes_alone() {
        let (_d, v) = vault();
        // 이름이 있으면 그대로
        let named = v.create_note("free", "이미 제목 있음", serde_json::json!({})).unwrap();
        v.save_note(&named, serde_json::json!({}), "본문").unwrap();
        assert_eq!(v.auto_title_if_untitled(&named).unwrap(), named);

        // 본문이 비었으면 이름을 지어낼 근거가 없으니 그대로
        let empty = v.create_note("free", "", serde_json::json!({})).unwrap();
        assert_eq!(v.auto_title_if_untitled(&empty).unwrap(), empty);
    }

    #[test]
    fn auto_title_skips_template_scaffolding() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "", serde_json::json!({})).unwrap();
        // 빈 체크박스·헤딩만 있는 줄은 건너뛰고 실제 내용이 있는 첫 줄을 쓴다
        v.save_note(&rel, serde_json::json!({}), "## 할 일\n\n- [ ] \n- [ ] 장보기\n")
            .unwrap();
        let new_rel = v.auto_title_if_untitled(&rel).unwrap();
        assert!(new_rel.ends_with("할 일.md"), "{new_rel}");
    }

    #[test]
    fn update_custom_type_template_applies_to_new_notes_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        v.add_custom_type("회의록", "회의록", vec![], "## 안건\n").unwrap();

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
    fn set_list_fields_persists_and_old_types_json_defaults_off() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        v.add_custom_type(
            "용어집",
            "용어집",
            vec![FieldDef::new("분류", "분류", FieldKind::Text, false)],
            "",
        )
        .unwrap();

        // 켜기 전에는 꺼져 있다 (칸을 만들었다고 목록에 끼어들지 않는다)
        let before = v.def_by_id("용어집").unwrap().clone();
        assert!(before.fields.iter().all(|f| !f.in_list));

        v.set_list_fields("용어집", &["분류".to_string()]).unwrap();
        let after = Vault::open(dir.path()).unwrap();
        let f = after.def_by_id("용어집").unwrap();
        assert!(f.fields.iter().find(|f| f.name == "분류").unwrap().in_list);
        // 고른 칸 하나만 켜진다
        assert_eq!(f.fields.iter().filter(|f| f.in_list).count(), 1);

        // 빈 목록을 주면 전부 꺼진다
        let mut v = Vault::open(dir.path()).unwrap();
        v.set_list_fields("용어집", &[]).unwrap();
        let after = Vault::open(dir.path()).unwrap();
        assert!(after
            .def_by_id("용어집")
            .unwrap()
            .fields
            .iter()
            .all(|f| !f.in_list));

        // in_list가 아예 없는 예전 파일도 열린다 (없으면 꺼짐)
        fs::write(
            dir.path().join(TYPES_FILE),
            r#"[{"id":"옛분류","label":"옛분류","folder":"옛분류","fields":[{"name":"분류","label":"분류","kind":"text","required":false,"options":[],"option_labels":[]}],"template":"","builtin":false}]"#,
        )
        .unwrap();
        let old = Vault::open(dir.path()).unwrap();
        assert!(old
            .def_by_id("옛분류")
            .unwrap()
            .fields
            .iter()
            .all(|f| !f.in_list));

        // 내장 분류는 고를 수 없다 (목록 줄이 손으로 짜여 있다)
        let mut v = Vault::open(dir.path()).unwrap();
        assert!(v.set_list_fields("free", &["title".to_string()]).is_err());
    }

    #[test]
    fn remove_custom_type_moves_notes_to_free() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::open(dir.path()).unwrap();
        v.add_custom_type("회의록", "회의록", vec![], "").unwrap();
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

    #[test]
    fn rename_tag_fixes_frontmatter_and_inline() {
        let (_d, v) = vault();
        let a = v.create_note("free", "가", json!({"tags": ["클린", "독서"]})).unwrap();
        v.save_note(&a, json!({"tags": ["클린", "독서"]}), "본문에 #클린 그리고 #클린코드")
            .unwrap();
        let b = v.create_note("free", "나", json!({})).unwrap();
        v.save_note(&b, json!({}), "여기는 #클린 하나만").unwrap();
        let c = v.create_note("free", "다", json!({})).unwrap();
        v.save_note(&c, json!({}), "상관 없는 글").unwrap();

        let changed = v.rename_tag("클린", "청소").unwrap();
        assert_eq!(changed.len(), 2, "상관 없는 노트는 건드리지 않는다");

        let pa = v.parse_full(&a).unwrap();
        assert!(pa.body.contains("#청소"), "인라인 태그가 바뀐다");
        assert!(
            pa.body.contains("#클린코드"),
            "더 긴 태그(#클린코드)는 함께 바뀌지 않는다"
        );
        assert!(pa.tags.contains(&"청소".to_string()));
        assert!(!pa.tags.contains(&"클린".to_string()));

        let pb = v.parse_full(&b).unwrap();
        assert!(pb.body.contains("#청소"));
    }

    #[test]
    fn rename_tag_into_existing_merges() {
        let (_d, v) = vault();
        let rel = v.create_note("free", "가", json!({})).unwrap();
        v.save_note(&rel, json!({"tags": ["독서", "책"]}), "본문").unwrap();

        v.rename_tag("책", "독서").unwrap();

        let p = v.parse_full(&rel).unwrap();
        let count = p.tags.iter().filter(|t| *t == "독서").count();
        assert_eq!(count, 1, "병합하면 중복이 남지 않는다");
        assert!(!p.tags.contains(&"책".to_string()));
    }

    #[test]
    fn rename_tag_rejects_bad_name() {
        let (_d, v) = vault();
        assert!(v.rename_tag("가", "빈 칸 있음").is_err());
        assert!(v.rename_tag("가", "샵#포함").is_err());
        // 같은 이름이거나 비었으면 조용히 아무 일도 안 한다
        assert_eq!(v.rename_tag("가", "가").unwrap().len(), 0);
        assert_eq!(v.rename_tag("", "나").unwrap().len(), 0);
    }

}
