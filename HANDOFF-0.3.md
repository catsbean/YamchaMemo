# YamchaMemo 0.3 실행 명세 — 실용성 강화

> [HANDOFF.md](HANDOFF.md)(0.2 제품화)의 후속. 규약·환경·함정은 그 문서를 그대로 따르고, 여기서는 **0.3에서 새로 하는 일**만 정의한다.
> 목표: 쌓기(입력)와 꺼내기(출력)의 마찰 제거 + 외부 편집(옵시디언) 공존 + 편집 신뢰.

---

## 0. 절대 규칙 (0.2에서 이어짐)

1. 명세에 없는 개선 아이디어는 구현하지 말고 §9에 메모만 남긴다.
2. 기존 패턴을 따른다(HANDOFF.md §3). 임의 라이브러리 추가 금지 — 이 문서가 지정한 `@codemirror/search`만 예외.
3. **각 Phase 끝에 검증 게이트(§8) 통과** 후 다음으로. 실패 상태로 진행 금지.
4. UI 문구는 한국어, 기존 톤(짧은 명사형 라벨 + "~합니다/~해주세요").
5. Rust 커맨드 시그니처 변경 시 바인딩 재생성(HANDOFF.md §2.3).
6. **사용자 데이터를 말없이 고치지 않는다.** 모든 보정은 사용자의 명시적 클릭으로만, 그리고 보정 직전에 스냅샷(P2)을 남긴다.

구현 순서: **P0 → P1 → P2 → P3 → P4 → P5 → P6**.

---

## 1. 설계 결정 (먼저 답해야 했던 두 가지)

### 1.1 옵시디언에서 고친 파일이 규격에 어긋날 때 — "조용한 소실"을 없앤다

**현재 동작(문제):** `Vault::collect_notes`(vault.rs:445)가 `if let Ok(summary)`로 감싸고 있어서, frontmatter YAML이 깨진 파일은 **목록에서 그냥 사라진다.** 사용자 입장에서는 "옵시디언에서 고쳤더니 노트가 없어졌다"로 보인다. 이게 외부 편집 허용의 가장 큰 위험이다. 그 외에도:

| 위반 | 현재 결과 |
|---|---|
| frontmatter YAML 파싱 실패 | 목록에서 소실 (경고 없음) |
| 타입 폴더 밖(vault 루트 등)에 생성 | 목록에서 소실 (`list_notes`는 타입 폴더만 walk) |
| frontmatter 자체가 없음 | 제목=파일명, `date=""` → 정렬 맨 뒤, 대시보드에서 빈칸 |
| frontmatter `type` ≠ 폴더 | 폴더 기준으로 취급되고, 저장하면 `type`이 **말없이** 덮어써짐 |
| book `status` 값이 목록 밖 | 책장 어느 칸에도 안 잡힘. 저장 시 `wishlist`로 말없이 교체 |

**방침 (P1에서 구현):**

1. **폴더가 타입의 진실원본**이다. frontmatter `type`은 파생 값 — 불일치 시 폴더를 따른다. 다만 **말없이 고치지 않고 점검 항목으로 보고**한다.
2. **소실 금지.** 스캔은 vault 전체(`.yamcha`, `_attachments` 제외)를 walk하고, 읽지 못한 파일도 "점검" 화면에는 반드시 나타난다.
3. **자동 수정 없음.** 항목마다 [고치기]를 눌러야 적용되고, 적용 직전 스냅샷을 남긴다. 고칠 수 없는 것(YAML 문법 오류)은 **원문 그대로 편집**할 길을 준다.
4. 점검 대기 건수는 사이드바 배지로 상시 노출 — 모르고 지나칠 수 없게.

### 1.2 API 키를 git에 올리지 않는 방법

**현재:** `src-tauri/src/commands.rs:14`에 카카오 REST 키가 평문 상수. 지금 저장소는 아직 `git init` 전이라 히스토리 오염은 없다 — **지금이 고칠 마지막 기회.**

**방침 (P0에서 구현):** 소스에서 지우고 **빌드 타임 주입**으로 바꾼다.

- `src-tauri/build.rs`가 `src-tauri/.env`(gitignore) 또는 환경변수 `YAMCHA_KAKAO_KEY`를 읽어 `cargo:rustc-env`로 넘긴다.
- 코드는 `option_env!("YAMCHA_KAKAO_KEY").unwrap_or("")` — **키가 없어도 컴파일되고, 없으면 카카오를 아예 호출하지 않고 교보 폴백으로 간다**(이미 폴백이 있으므로 기능 손실 없음).
- CI는 GitHub Secrets → 워크플로 `env`로 주입.

**사용자가 해야 할 일:** 소스에 평문으로 박혀 있던 기존 키는 **유출된 것으로 간주하고 카카오 개발자 콘솔에서 재발급**할 것. 기존 키는 작업 중 `src-tauri/.env`(gitignore)로 옮겨 두었으므로 앱 동작에는 지장이 없다 — 재발급한 새 키로 그 파일의 값만 교체하면 된다.

---

## 2. P0 — API 키 분리

**P0-1** `src-tauri/build.rs`: 기존 `tauri_build::build()` 앞에 키 전달 로직 추가.
- `std::env::var("YAMCHA_KAKAO_KEY")` 우선, 없으면 `src-tauri/.env`에서 `YAMCHA_KAKAO_KEY=값` 줄 파싱.
- 찾으면 `println!("cargo:rustc-env=YAMCHA_KAKAO_KEY={v}")`.
- `cargo:rerun-if-changed=.env`, `cargo:rerun-if-env-changed=YAMCHA_KAKAO_KEY` 출력.

**P0-2** `commands.rs`: `DEFAULT_KAKAO_API_KEY` 상수 삭제 → `fn default_kakao_key() -> &'static str { option_env!("YAMCHA_KAKAO_KEY").unwrap_or("") }`. `effective_key`는 사용자 키 → 빌드 주입 키 → `""` 순.
- `search_books` / `autofill_book` / `enrich_books` / `enrich_preview`: `key.is_empty()`면 카카오 호출을 **건너뛰고** 곧장 교보 경로로. (지금처럼 401을 받고 폴백하지 말 것 — 무의미한 왕복.)

**P0-3** `.gitignore`에 `.env`, `.env.*`, `!.env.example` 추가. `src-tauri/.env.example`에 키 이름만 담아 커밋.

**P0-4** `.github/workflows/release.yml` 빌드 스텝에 `env: YAMCHA_KAKAO_KEY: ${{ secrets.YAMCHA_KAKAO_KEY }}`. `RELEASE.md`에 "① 카카오 키는 저장소 Secrets에 `YAMCHA_KAKAO_KEY`로 등록" 절 추가.

**DoD:** 추적 대상 파일에 키 문자열 0건(`.env`·`target/` 제외). 키 없이 `cargo build -p yamcha-app` 성공. 키 없는 빌드에서 책 검색 시 교보 결과가 나온다.

---

## 3. P1 — vault 무결성 점검

**P1-1** 신규 `crates/yamcha-core/src/audit.rs`

```rust
pub enum IssueKind {          // serde rename_all = "snake_case"
    ParseError,               // YAML 파싱 실패 — 고칠 수 없음(수동)
    OutsideTypeFolder,        // 타입 폴더 밖의 .md
    NoFrontmatter,            // --- 블록 자체가 없음
    MissingDate,              // date 누락 또는 YYYY-MM-DD 아님
    TypeMismatch,             // frontmatter type ≠ 폴더
    UnknownStatus,            // book/writing의 status가 정의 밖
}
pub struct NoteIssue { pub rel_path: String, pub kind: IssueKind,
                       pub detail: String, pub fixable: bool, pub suggestion: String }
pub fn audit(vault: &Vault) -> Vec<NoteIssue>;
pub fn fix(vault: &Vault, rel: &str, kind: IssueKind) -> Result<String, CoreError>; // 새 rel 반환
```

- `audit`: vault 루트를 재귀 walk. 제외 = `.yamcha/`, `_attachments/`, `_`로 시작하는 파일, `.md` 아닌 파일. 파일 하나당 최대 1건만 보고(위 열거 순서 = 우선순위).
- `fix` 동작:
  - `OutsideTypeFolder` → `Free/`로 이동(`unique_path`로 충돌 회피) + 최소 frontmatter 주입.
  - `NoFrontmatter` → 파일 mtime의 날짜로 `date`, 폴더 기준 `type`, `tags: []` 주입(본문 보존).
  - `MissingDate` → 파일 mtime 날짜.
  - `TypeMismatch` → 폴더 기준 `type`으로 교체.
  - `UnknownStatus` → book은 `wishlist`, writing은 `idea`.
  - `ParseError` → `Err`("직접 고쳐야 합니다") — UI가 이 항목엔 [고치기]를 안 띄운다.
- **`fix`는 파일을 만지기 전에 `history::snapshot`(P2)을 호출한다.** 그래서 P2보다 먼저 만들되, 스냅샷 호출은 P2에서 배선한다(P1 구현 시 TODO 주석 + P2에서 제거).
- 유닛 테스트: 각 IssueKind 1건씩 생성 → `audit`에 잡힘 → `fix` → 재`audit`에 안 잡힘 + 본문 보존. `ParseError`는 fix가 Err.

**P1-2** `commands.rs` + `lib.rs`: `audit_vault() -> Vec<NoteIssue>`, `fix_issue(rel, kind) -> Result<String>`(성공 후 `refresh_note`), `open_raw(rel) -> String` / `save_raw(rel, content)` — 파싱 못 하는 파일을 원문 그대로 읽고 쓰기 위한 통로.

**P1-3** 프론트
- 스토어: `issues: NoteIssue[]`, `refreshIssues()`, `fixIssue(rel, kind)`. `refresh()` 끝에서 `refreshIssues()`를 같이 호출(실패는 무시).
- `Sidebar`: 설정 위에 점검 메뉴 — 건수 0이면 숨김, 있으면 `⚠️ 점검 N`(rose 계열). 클릭 → `setNav("audit")`.
- 신규 `src/components/AuditDashboard.tsx` (`Dashboard`에서 `noteType === "audit"` 분기): 종류별 그룹 목록, 행마다 파일 경로·설명·제안, [고치기] 버튼(불가하면 [원문 열기]). 상단에 "같은 종류 N건 모두 고치기". 전부 해결되면 "모든 노트가 규격에 맞습니다" 안내.
- 신규 `src/components/RawEditModal.tsx`: `open_raw`로 원문을 textarea에 띄우고 [저장]으로 `save_raw`. 상단에 오류 원문 표시.

**DoD:** testvault에 (a) YAML 깨진 파일, (b) 루트의 `.md`, (c) frontmatter 없는 파일을 두고 앱 실행 → 배지 3건 → 각각 고치기/원문 편집으로 해소 → 배지 사라지고 노트가 목록에 정상 등장.

---

## 4. P2 — 스냅샷 히스토리

**P2-1** 신규 `crates/yamcha-core/src/history.rs`

- 저장 위치: `.yamcha/history/{rel의 '/'를 '__'로 치환}/{YYYYMMDD-HHMMSS}.md` (파일 전체 = frontmatter 포함).
- `pub struct HistoryItem { stamp: String, saved_at: String, char_count: u32 }`
- `pub struct HistoryPolicy { max_per_note: u32, min_interval_secs: u64 }` — 기본 `{ 20, 300 }`.
- `pub fn snapshot(vault, rel, policy) -> Result<bool, CoreError>` — 저장 **직전** 파일 내용을 뜬다.
  - 파일이 없으면 no-op.
  - 직전 스냅샷과 내용이 같으면 skip.
  - 직전 스냅샷이 `min_interval_secs` 이내면 skip. **단, 새 내용이 직전 스냅샷보다 글자 수가 20% 이상 줄어들면 간격을 무시하고 뜬다**(대량 삭제 사고를 반드시 잡기 위함).
  - `max_per_note` 초과 시 오래된 것부터 삭제.
- `pub fn list(vault, rel) -> Result<Vec<HistoryItem>, CoreError>` (최신 우선)
- `pub fn read(vault, rel, stamp) -> Result<String, CoreError>`
- `pub fn restore(vault, rel, stamp) -> Result<(), CoreError>` — **복원 전에 현재 상태를 먼저 스냅샷**한 뒤 덮어쓴다.
- `pub fn purge_all(vault) -> Result<u32, CoreError>` — 설정의 "기록 비우기"용.
- 유닛 테스트: 간격 내 중복 skip / 내용 동일 skip / 20% 급감 시 강제 스냅샷 / max 초과 시 오래된 것 삭제 / restore 왕복.

**P2-2** 배선
- `Vault::save_note` 진입부에서 기존 파일이 있으면 `history::snapshot`. 정책은 `Vault`가 필드로 들고 있고(`set_history_policy`), 기본값은 `{20, 300}`.
- `append_reading_entry`도 동일. `update_frontmatter`는 `save_note` 경유라 자동.
- `audit::fix`의 TODO를 실제 `snapshot` 호출로 교체.
- 미러 대상에서 제외됨을 확인(`mirror::file_list`는 타입 폴더+`_attachments`만 — 이미 안전).

**P2-3** 커맨드 + UI
- `list_history(rel)`, `read_history(rel, stamp)`, `restore_history(rel, stamp)`, `purge_history()`.
- `EditorPane` 헤더 [저장] 왼쪽에 `🕘` 버튼 → 신규 `src/components/HistoryModal.tsx`: 좌측 스냅샷 목록(시각·글자수), 우측 본문 미리보기, [이 버전으로 되돌리기](2단계 확인). 되돌린 뒤 `reloadCurrent()`.
- `SettingsModal`에 "편집 기록" 섹션: 노트당 보관 개수(5/20/50), 최소 간격(1분/5분/30분), [기록 모두 비우기]. 값은 settings.json(`historyMax`, `historyIntervalSecs`) → `init()`에서 읽어 `set_history_policy` 커맨드로 전달.

**DoD:** 노트를 여러 번 나눠 편집 → `🕘`에 스냅샷 여러 개 → 문단을 통째로 지우고 저장하면 간격과 무관하게 스냅샷이 하나 더 생김 → 되돌리기로 복구. `.yamcha/history` 크기가 노트당 20개를 넘지 않음.

---

## 5. P3 — 발췌 모아보기

**P3-1** `crates/yamcha-core/src/template.rs`에 파서 추가

```rust
pub struct ParsedEntry { pub kind_label: String, pub date: String, pub text: String }
pub fn parse_entries(records: &str) -> Vec<ParsedEntry>;
```
- `> [!종류] 날짜`로 시작하는 블록을 잡고, 이어지는 `>` 줄을 본문으로(선행 `> ` 제거, 빈 `>` 줄은 문단 구분으로 보존). 날짜가 없으면 빈 문자열.
- 종류는 자유 문자열로 받는다(사용자가 옵시디언에서 `> [!메모]`를 넣었을 수 있음).
- 테스트: 다건 연속, 여러 줄, 날짜 없는 콜아웃, 빈 콜아웃, 콜아웃 아닌 인용문은 무시.

**P3-2** `commands.rs`: `list_entries() -> Vec<ReadingEntry>`
```rust
pub struct ReadingEntry { book_rel, book_title, book_author, cover, kind_label, date, text }
```
- 전 book 노트를 순회 → `split_book_body` → `parse_entries` → 평탄화. 정렬은 프론트에서.

**P3-3** `src/components/ReadingDashboard.tsx` 전면 개편 (책 목록 → **엔트리 대시보드**)
- 헤더: `독서기록 N개 · 책 M권` + [새로 만들기](기존 `BookPickerDialog` 유지).
- 필터 바 한 줄: 종류 칩(발췌/생각/요약/질문 + 기타 — 각 칩에 개수), 책 셀렉트(전체/책별), 기간 셀렉트(전체/최근 1개월/6개월/올해), 텍스트 검색 입력.
- 정렬 셀렉트: 최신순 / 오래된순 / 책별.
- 상단 우측 [🎲 다시 보기] — 필터 결과에서 랜덤 3개만 표시하는 토글.
- 카드: 표지 썸네일(48px) + 책 제목·저자(클릭 → 책 열기) / 종류 뱃지(livePreview의 콜아웃 색과 동일 계열) / 날짜 / 본문(4줄 clamp, 클릭 시 펼침) / [복사](본문만, 클립보드).
- 결과 0건 안내 문구 분기(기록 자체가 없음 / 필터에 안 걸림).

**DoD:** 기록이 있는 책 2권 이상에서 종류·책·기간 필터가 각각 동작, 복사 버튼이 본문만 복사, 랜덤 다시 보기가 매번 다른 조합.

---

## 6. P4 — 데일리노트 강화

### 6.1 템플릿 점검 결과

현재 기본 템플릿은 `"## 할 일\n\n- [ ] \n\n## 기록\n\n"`. 점검에서 나온 문제:

1. **빈 체크박스가 미완 할 일로 집계된다.** 템플릿이 항상 `- [ ] `(텍스트 없음)를 넣으므로, 아무것도 안 쓴 날에도 "미완 1건"이 된다. → **텍스트 없는 체크박스는 집계에서 제외**한다(P4-2).
2. 플레이스홀더가 `{{date}}`/`{{title}}` 둘뿐이라 요일을 넣을 수 없다. → `{{weekday}}`, `{{yesterday}}`, `{{time}}` 추가.
3. 설정의 템플릿 편집기에 쓸 수 있는 플레이스홀더 안내가 없다. → 도움말 한 줄 추가.

템플릿 기본값 자체는 바꾸지 않는다(기존 사용자의 습관 유지). 새 플레이스홀더는 원하는 사람만 쓴다.

**P4-1** `template.rs::render_template(template, date, title)` → `render_template(template, date, title)` 유지하되 내부에서 `{{weekday}}`(월·화·…·일), `{{yesterday}}`(date-1일), `{{time}}`(HH:MM) 치환 추가. `date`는 `YYYY-MM-DD` 가정, 파싱 실패 시 해당 플레이스홀더는 원문 유지. 테스트 추가.
`SettingsModal` 템플릿 편집 영역 아래에 `사용 가능: {{date}} {{title}} {{weekday}} {{yesterday}} {{time}}` 안내.

### 6.2 하단 요약 바 (템플릿과 무관하게 항상 표시)

**P4-2** `crates/yamcha-core/src/lib.rs`에 `pub fn count_open_todos(body: &str) -> u32` — `- [ ]` / `* [ ]` 중 **뒤에 공백 아닌 글자가 있는 것만** 센다. `- [x]`는 제외. 콜아웃(`>`) 안의 체크박스도 센다.

**P4-3** `commands.rs`: `daily_digest(date: String) -> DailyDigest`
```rust
pub struct DigestBookEntry { pub book_title: String, pub count: u32 }
pub struct DailyDigest {
    pub open_todos_total: u32,      // vault 전체 미완
    pub open_todos_today: u32,      // 해당 날짜 데일리노트 안
    pub reading_titles: Vec<String>,// status=reading 책 제목 (최대 3개)
    pub reading_count: u32,
    pub finished_total: u32,
    pub finished_this_year: u32,
    pub today_entries: Vec<DigestBookEntry>, // 그 날짜에 추가된 책 기록 (책별 건수)
    pub today_entry_count: u32,
}
```
- 오늘 책기록: 전 book 노트의 `parse_entries` 결과에서 `date == 인자`인 것만 책별로 묶는다.
- 완독 수: `status == "finished"`. 올해 = `finished` 필드(없으면 `date`)가 올해로 시작.

**P4-4** 신규 `src/components/DailyDigestBar.tsx` — `EditorPane`에서 `current.note_type === "daily"`일 때 `StatusBar` **위**에 렌더. 노트가 바뀌거나 저장될 때(`notes` 변경) 재조회.
- 한 줄, 작은 글씨, 항목 사이 `·`:
  `☑ 미완 4 (오늘 2) · 📖 읽는 중 «클린 코드» 외 1권 · ✅ 올해 12권 (누적 37) · ✍️ 오늘 기록 3 (클린 코드 2 · 사피엔스 1)`
- 값이 0인 항목은 통째로 생략. 읽는 중 0권이면 `📖 읽는 중 없음`.
- 클릭 동작: 읽는 중 부분 → 그 책 열기(1권일 때) 또는 책장으로, 오늘 기록 부분 → 독서기록 대시보드.

**DoD:** 새 데일리노트를 만들자마자 "미완 1"이 뜨지 않는다. 할 일을 쓰면 숫자가 오르고 `[x]`로 바꾸면 내려간다. 오늘 어떤 책에 발췌를 넣으면 요약 바에 즉시 반영된다.

---

## 7. P5·P6 — 검색 필터와 에디터

**P5-1** `SearchFilter { types: Vec<String>, days: u32, tags: Vec<String> }`(`days == 0`이면 전체). `search(query, filter)`로 시그니처 변경 → 바인딩 재생성.
- `search.rs::search`는 tantivy 상한을 넉넉히(200) 잡고 결과를 필터링한 뒤 상위 50만 반환. 필터가 비었으면 기존과 동일 동작.
- 테스트: 타입 필터·기간 필터가 각각 결과를 줄이는지.

**P5-2** `SearchModal`: 입력 아래 필터 바 — 타입 칩(다중 선택, 스키마에서 생성), 기간 셀렉트(전체/1주/1개월/1년). 필터 변경 시 즉시 재검색. 선택된 필터 수를 헤더에 표시하고 [초기화] 제공. 필터 상태는 모달 로컬 state(세션 저장 안 함).

**P6-1** `pnpm add @codemirror/search`. `Editor.tsx`에 `search({ top: true })` + `searchKeymap` + `highlightSelectionMatches()`. `EditorState.phrases`로 패널 라벨 한국어화(`Find`→"찾기", `Replace`→"바꾸기", `next`→"다음", `previous`→"이전", `all`→"전체", `match case`→"대소문자 구분", `replace all`→"모두 바꾸기", `close`→"닫기", `regexp`→"정규식", `by word`→"단어 단위").

**P6-2** 신규 `src/editor/format.ts` — 서식 토글 키맵:
- `Mod-b` `**`, `Mod-i` `*`, `Mod-Shift-c` `` ` ``: 선택이 이미 해당 기호로 감싸져 있으면 해제, 아니면 감싸기. 선택이 없으면 기호만 삽입하고 커서를 가운데로.
- `Mod-Shift-k`: `[[]]` 삽입 후 커서를 가운데로(자동완성이 바로 뜬다).
- **`Mod-k`는 전역 검색이므로 쓰지 않는다.**
- 키맵은 `defaultKeymap`보다 **앞에** 둔다.

**P6-3** 리스트 들여쓰기: `Tab`/`Shift-Tab`이 **리스트 항목 줄에서만** 들여쓰기/내어쓰기, 그 외에는 기본 동작(포커스 이동)을 유지. `format.ts`에 함께 둔다.

**P6-4** 목차: `EditorPane` 헤더에 `☰` 버튼 → 본문에서 `^#{1,6} ` 줄을 뽑아 팝오버 목록 → 클릭 시 해당 줄로 스크롤·커서 이동. `Editor`가 `scrollToLine(line)`을 ref로 노출한다. 헤딩이 없으면 버튼을 숨긴다.

**DoD:** Ctrl+F로 문서 내 검색·치환이 한국어 패널로 동작(전역 Ctrl+K와 충돌 없음). Ctrl+B/I가 토글로 동작. 리스트에서 Tab이 들여쓰기, 본문에서는 기존 동작. 목차 클릭으로 점프.

---

## 8. 검증 프로토콜

**단계 게이트(매 Phase 후):**
```bash
cargo test -p yamcha-core && cargo test -p yamcha-app --lib
```
```bash
npx tsc --noEmit -p tsconfig.json
```
Rust 커맨드를 바꾼 Phase는 바인딩 재생성(HANDOFF.md §2.3) + `grep <새커맨드명> src/bindings.ts` 확인.

**회귀 기준선:** 시작 시점 core 테스트 46개 + app 8개(+ignored 1). 감소 금지. P1·P2·P3·P4·P5에서 증가 예상.

**최종 회귀(`pnpm tauri dev`):**
1. 키 없는 빌드로 책 검색 → 교보 결과.
2. 깨진 파일 3종 → 점검 배지 → 고치기 → 해소.
3. 편집 → 스냅샷 → 문단 삭제 → 되돌리기.
4. 발췌 모아보기 필터·복사·랜덤.
5. 새 데일리노트에서 미완 0 → 할 일 추가 → 숫자 반영, 요약 바 4개 항목 확인.
6. 검색 타입·기간 필터.
7. Ctrl+F, Ctrl+B/I, Tab, 목차.
8. 기존 회귀(HANDOFF.md §6) 중 모달 Esc·휴지통·창닫기 저장은 그대로 통과해야 함.

---

## 8-1. 구현 결과 (2026-07-27 완료)

전 Phase 구현 완료. 테스트: **core 75개**(시작 46) / **app 14개 + ignored 2**(시작 8+1), 전부 통과.
`npx tsc --noEmit` 통과, `npx vite build` 통과, `pnpm tauri dev` 기동 확인.

명세와 달라진 부분(의도적):

1. **P2 코어를 P1보다 먼저 넣었다.** `audit::fix`가 "수리 전 스냅샷"을 요구하므로, 스텁을 두는 대신 `history.rs`를 먼저 완성하고 배선했다. 화면 작업 순서는 명세 그대로.
2. **스냅샷 스탬프에 밀리초를 붙였다** (`YYYYMMDD-HHMMSS-mmm`). 초 단위로는 같은 초에 두 번 뜰 때 충돌한다. 시각 파싱은 앞 15자만 쓴다 — chrono의 `%3f`는 파싱 지원이 들쭉날쭉하다(실제로 여기서 한 번 물렸다).
3. **대량 삭제 판정은 파일 전체(frontmatter 포함) 글자 수로 비교한다.** `save_note`가 넘기는 값이 파일 전문이라 본문끼리 비교하면 기준이 어긋난다. 원래 짧은 노트(공백 제외 50자 미만)는 비율이 요동쳐 판정에서 제외한다.
4. **검색 인덱스의 `tags` 필드를 STORED로 바꿨다.** 태그 필터가 결과에서 태그를 읽어야 한다. 스키마가 바뀌면 `SearchEngine::open`이 인덱스를 지우고 다시 만들고 `set_vault`가 재색인하므로 마이그레이션은 자동이다.
5. **사이드바 "독서기록" 숫자를 책 권수 → 기록 개수로 바꿨다.** 화면이 엔트리 단위가 됐으니 숫자도 그래야 맞다.
6. `HistoryButton`은 `HistoryModal.tsx`에 두었다(EditorPane ↔ BookView 순환 import 회피).
7. 기존 카카오 키는 `src-tauri/.env`(gitignore)로 옮겨 동작을 유지했다. **재발급 필요**는 그대로다.

## 9. 범위 밖 (하지 말 것 — 아이디어만 기록)

- 트레이 상주 + 글로벌 단축키 퀵캡처(다음 순위 1번), 커맨드 팔레트.
- 데일리노트 **미완 할 일 이월**(어제 미완을 오늘로 자동 복사) — 유용하지만 이번 스코프 밖.
- 자동 업데이트(updater), 코드 서명.
- 옵시디언 플러그인/양방향 동기화. 이번에 하는 것은 "외부 편집을 안전하게 흡수"까지다.
- 스냅샷의 라인 단위 diff 뷰(현재는 전문 미리보기).
- 검색 결과 정렬 옵션, 저장된 검색.
