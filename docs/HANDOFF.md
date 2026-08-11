# YamchaMemo 제품화 개발 핸드오프

> 이 문서 하나로 작업을 시작할 수 있도록 쓴 실행 명세다. 대화 맥락 없이 이 문서 + 코드만 보고 진행한다.
> 목표: 기능 추가 없이 **"매일 실제로 쓸 수 있는 앱"** 만들기 — 데이터 안전, 네트워크 안정, 첫 실행 간소화, UX 일관성, 배포 파이프라인.

---

## 0. 절대 규칙

1. **새 기능을 만들지 않는다.** 이 문서의 작업 명세(§5)에 없는 개선 아이디어는 구현하지 말고 메모만 남긴다.
2. **기존 패턴을 따른다.** 새 코드는 주변 코드와 같은 스타일(§3)로. 임의로 라이브러리를 추가하지 않는다(명세에 지정된 것 제외).
3. **각 단계(Phase) 완료 시 검증 게이트(§6)를 통과**한 뒤 다음 단계로 넘어간다. 테스트 실패 상태로 진행 금지.
4. UI 문구는 **한국어, 기존 톤 유지**(짧은 명사형 라벨 + "~합니다/~해주세요" 설명문).
5. Rust 커맨드 시그니처를 추가/변경하면 반드시 **바인딩 재생성 절차(§2.3)** 를 수행한다.

---

## 1. 기술 스택과 아키텍처 지도

| 층 | 기술 | 위치 |
|---|---|---|
| 데스크톱 셸 | Tauri 2 | `src-tauri/` |
| 프론트 | React 19 + TypeScript + Vite + Tailwind CSS 4 | `src/` |
| 상태관리 | zustand 단일 스토어 | `src/stores/vault.ts` |
| 에디터 | CodeMirror 6 | `src/editor/` |
| 코어 로직(Rust) | 순수 크레이트 (vault/파싱/인덱스/검색/템플릿) | `crates/yamcha-core/` |
| Tauri 커맨드 | tauri-specta로 TS 바인딩 자동 생성 | `src-tauri/src/commands.rs` → `src/bindings.ts` |
| 검색 | tantivy (1~2그램 + 자모 퍼지 + 초성) | `crates/yamcha-core/src/search.rs`, `korean.rs` |
| 첨부 문서 검색 | 자체 hwp 파서(배포용 문서 복호 포함) + pdf-extract·calamine·zip·aes (feature `docs`) | `crates/yamcha-core/src/extract.rs`, `file_index.rs` |
| HTTP | reqwest 0.12 (`json`, `gzip` feature) | `src-tauri/Cargo.toml:24` |
| 설정 저장 | tauri-plugin-store → `settings.json` | `%APPDATA%\com.yamcha.memo\settings.json` |

**데이터 모델**: 노트 = vault 폴더의 마크다운 파일(frontmatter + 본문). 타입별 폴더(`Books/ Writing/ Daily/ Info/ Free/` + 사용자 정의). 책 = 독서기록(한 파일, 본문은 `## 소개` / `## 기록` 두 섹션). 스키마 정의: `crates/yamcha-core/src/schema.rs`.

**호출 흐름**: React 컴포넌트 → `useVault` 스토어 액션 → `commands.*`(bindings.ts) → `#[tauri::command]`(commands.rs) → `yamcha_core::Vault`. 커맨드 결과는 `Result<T,String>` → 프론트에서 `r.status === "ok"` 분기 또는 스토어 `unwrap()`+`guard()`.

**주요 파일 지도**:
- `src/App.tsx` — 진입, 레이아웃 3종, vault 선택 화면, 전역 에러 토스트, Ctrl+K
- `src/stores/vault.ts` — 모든 액션(`init/openNote/saveCurrent/createNote/updateFrontmatter/…`), `guard()` 에러 수집
- `src/components/` — `Bookshelf`(책장 그리드/목록), `BookView`(독서기록 화면), `BookInfoModal`, `BookCreateDialog`, `BookSearchDialog`, `EnrichDialog`(일괄 자동채우기), `SettingsModal`, `NewNoteDialog`, `EditorPane`, `SearchModal`, `BookPickerDialog`, `CustomTypeDialog`, `ReviewDashboard`+`ReviewFilterPanel`(회고와 고급 필터)
- `src/lib/date.ts` — `ymd`/`dateOf`/`weekdayOf`/`addDays`/`daysBetween`. 날짜는 앱 전체에서 `YYYY-MM-DD` **문자열**이라 기간 비교가 곧 사전순 비교다
- `src/lib/resolveLink.ts` — `[[…]]` 하나가 어느 노트를 가리키는지 정하는 **유일한 자리**. 겹 순서는 경로(`[[Free/중복노트]]`) → 제목 → 파일명 → 별칭(frontmatter `aliases`)이고, **앞 겹에 하나라도 걸리면 뒤 겹은 보지 않는다**(글이 별칭을 이긴다). 한 겹에서 여럿이 걸리면 전부 돌려주고 `LinkPickerDialog`가 고르게 한다. 자동완성 후보(`linkOptions`)도 여기서 나오며, 이름이 겹치는 후보는 폴더까지 넣어 준다. **대소문자를 가린다** — 백링크를 세는 SQLite `=`와 어긋나면 열리기는 하는데 백링크에는 안 잡히는 링크가 생긴다. 짝이 되는 백엔드는 `Indexer::link_names`(`indexer.rs`)로, 같은 "글이 별칭을 이긴다" 규칙을 SQL로 확인한다
- `src/lib/reviewFilter.ts` — 회고 필터 판정 전부(순수 함수). 일지 콜아웃과 독서기록을 `ReviewCard` 하나로 정규화한다 — **일지 콜아웃 헤더에는 시각(`15:17`), 독서기록에는 날짜(`2026-07-18`)가 들어 있어** 정규화 없이는 시간대 필터·정렬이 조용히 틀린다
- `src/lib/exportReview.ts` — 회고를 `NoteDoc`으로. 화면 칩과 문서 머리 줄이 `activeChips()` 하나를 공유한다
- `src-tauri/src/commands.rs` — 전 커맨드 + 카카오/교보 API 클라이언트 + 파서 + 테스트
- `src-tauri/src/commands/dashboard.rs` — 모아 보는 화면들의 커맨드. `review_range(from,to,with_reading)`는 회고 기간을 **한 번에** 준다 (날짜마다 `note_blocks`+`note_todos`를 부르면 한 달에 62번이 오간다). 필터는 일부러 백엔드에서 걸지 않는다 — 칩 하나 누를 때마다 파일을 다시 읽을 이유가 없다
- `src-tauri/src/lib.rs` — `collect_commands![]` 등록부 (커맨드 추가 시 여기도 추가)
- `src-tauri/src/watcher.rs` — vault 파일 감시, 자기쓰기 억제(전역 타임스탬프 2.5초)
- `crates/yamcha-core/src/vault.rs` — 파일 CRUD, 휴지통(`.yamcha/trash`), 템플릿, 미러
- `crates/yamcha-core/src/korean.rs` — 자모 분해·초성·오타 예산 (의존성 0, 퍼지 검색의 토대)
- `crates/yamcha-core/src/autotag.rs` — 자동 태그 추천(제안만, 파일을 고치지 않음). **고유명사만** 제안하며 후보는 vault 사전(`Indexer::proper_noun_dict` — 기존 태그·노트 제목·책 저자/출판사)뿐이다. 일반 키워드 추출은 하지 않는다. `korean::is_near`로 표기 흔들림 흡수
- `crates/yamcha-core/src/extract.rs` — 첨부 문서 평문 추출 (hwp는 자체 파서, §9 참고)
- `crates/yamcha-core/src/file_index.rs` — 첨부 색인 켜기/끄기, 추출 캐시(`doc_text`)

---

## 2. 개발 환경·워크플로

### 2.1 환경
- Windows 11, 셸은 PowerShell 5.1이 기본(파이프라인 `&&` 없음 — `;` 또는 `if ($?)`), Git Bash 사용 가능.
- cargo 산출물은 **워크스페이스 루트** `target/`에 생김 (`src-tauri/target` 아님).
- Python 3.13 설치돼 있음 (콘솔 한글 출력이 cp949로 깨지므로, 결과는 UTF-8 파일로 저장한 뒤 읽는다).

### 2.2 빌드/실행/테스트 명령
```bash
pnpm tauri dev                      # 개발 실행 (Vite:1420 + cargo run). 파일 변경 자동 반영
cargo test -p yamcha-core           # 코어 테스트 (현재 149개 통과 + ignored 3개)
cargo test -p yamcha-app --lib      # 앱 테스트 (현재 14개 + ignored 2개)
cargo test -p yamcha-app --lib kyobo_live_probe -- --ignored --nocapture   # 실네트워크 교보 검증
npx tsc --noEmit -p tsconfig.json   # 프론트 타입체크
npx vite build                      # 프론트 번들 검증
```

수동 실행용 측정·검증 테스트 (`--ignored`, **릴리스로 돌려야 수치가 의미 있다**):
```bash
# 검색 규모별 응답시간 (노트 2,000건 + 첨부 155건)
cargo test -p yamcha-core --release search_scale_bench -- --ignored --nocapture
# 실파일 하나 추출 확인 (바이너리 hwp는 fixture로 만들 수 없다)
YAMCHA_DOC_SAMPLE=<파일경로> cargo test -p yamcha-core --release real_document -- --ignored --nocapture
# 실제 vault로 첨부 색인 종단 확인
YAMCHA_VAULT=<vault경로> YAMCHA_FIND=<찾을말> cargo test -p yamcha-core --release real_vault_end_to_end -- --ignored --nocapture
```
⚠️ **dev 서버 실행 중엔 cargo가 빌드 락에 걸림**("Blocking waiting for file lock"). 오래 걸리면 dev 서버를 먼저 종료하거나 기다린다. dev 서버는 rs 파일 변경 시 자동 재컴파일하므로, 코드 수정 → 테스트는 별도 `cargo test`로 돌리고 실행 확인은 dev 창에서 하면 된다.

### 2.3 바인딩 재생성 (커맨드 추가/변경 시 필수)
`src/bindings.ts`는 손으로 고치지 않는다. `lib.rs`의 `builder.export`가 **debug 실행 시** `../src/bindings.ts`로 내보낸다(CWD 기준 상대경로).
- 가장 쉬운 방법: `pnpm tauri dev` 실행(자동 재빌드 후 export됨).
- dev 없이: `cd src-tauri` 상태에서 `E:\Projects\YamchaMemo\target\debug\yamcha-app.exe` 실행 후 종료. **CWD가 src-tauri가 아니면 엉뚱한 위치에 bindings.ts가 생기니 주의.**
- 재생성 후 `grep <새커맨드명> src/bindings.ts`로 확인.

### 2.4 커밋
사용자가 요청할 때만 커밋한다. 현재 git 저장소가 아닐 수 있음 — `git status`로 확인 후 없으면 사용자에게 물어본다.

---

## 3. 코드 규약 (기존 패턴)

**Rust 커맨드**:
```rust
#[tauri::command]
#[specta::specta]                      // 필수 — 빠지면 바인딩 누락
pub fn foo(state: State<'_, AppState>, …) -> Result<T, String> {
    with_ctx(&state, |c| { … })        // 읽기
    with_ctx_write(&state, |c| { … })  // 쓰기(watcher 자기쓰기 마킹 포함)
}
```
- **락 규율**: `AppState(Mutex<Option<Ctx>>)`. async 커맨드에서 **await 구간에 락을 잡지 않는다** — 스냅샷 뜨고(락 짧게) → HTTP(락 밖) → 저장(락 짧게). `enrich_books`(commands.rs)가 모범.
- 노트 파일 변경 후 `refresh_note(ctx, rel)` 호출(인덱스+검색 갱신).
- 바인딩을 건너는 struct는 `#[derive(serde::Serialize, serde::Deserialize, specta::Type, Default, Clone)]`.
- 에러 메시지는 한국어 완결문.
- 순수 파싱 로직은 함수로 분리하고 fixture 유닛테스트를 붙인다(`commands.rs`의 `kyobo_tests` 모듈 참고).

**프론트**:
- 스토어 액션은 `guard(async () => { unwrap(await commands.x(…)); await get().refresh(); })` 패턴.
- 컴포넌트 지역 비동기는 `busy` state로 연타 방지 + `r.status === "ok"` 분기.
- 스타일: Tailwind 유틸 직접 사용. 중립색(neutral-*) 기본, 강조는 amber/emerald/rose. 모달은 현재 `fixed inset-0 z-50 … bg-black/30` 보일러플레이트(→ D1에서 공통화 예정).
- settings.json 접근: `load("settings.json", { autoSave: true, defaults: {} })`.

---

## 4. 외부 API 지식 베이스 (이번에 실측 검증된 사실 — 재조사 불필요)

### 카카오 책 검색
- `GET https://dapi.kakao.com/v3/search/book?query=…&size=N`, 헤더 `Authorization: KakaoAK {key}`.
- 응답 `documents[]`: `title, authors[](배열→", "로 join), publisher, isbn("10자리 13자리" — 마지막 토큰이 13자리), thumbnail, contents(짧은 소개—사용 안 함), datetime`.
- 429 = 쿼터 초과(하루 단위), 401 = 키 오류. `kakao_docs()`가 `KakaoErr::RateLimited/Other`로 구분.

### 교보문고 (비공식 — 헤더 요구사항이 핵심)
- **autocomplete API**: `GET https://search.kyobobook.co.kr/srp/api/v1/search/autocomplete/shop?callback=autocompleteShop&keyword={ISBN 또는 제목}`
  - **User-Agent 없으면 500.** 브라우저 UA 필수(`KYOBO_UA` 상수 참조).
  - JSONP: `autocompleteShop( … );` 언랩 → `data.resultDocuments[]` (다건).
  - 각 문서의 `TOT_RELATE_HTML_LIST`를 `"$@"`로 split — **인덱스 맵(검증됨)**: `[0]`=ISBN, `[1]`=분야, `[2]`=제목, `[3]`=저자, `[4]`=출판사, `[5]`=출간연도, `[14]`=표지 URL, `[20]`=평점, `[21]`=책소개(전문).
  - 색인이 실제 카탈로그보다 작아 **일부 책이 안 잡힘**(예: 9791186409473) → 아래 폴백 필요.
- **검색 페이지 폴백**: `GET https://search.kyobobook.co.kr/search?keyword={q}&target=total` (UA 필요)
  - HTML 내 SSR JSON에서 `"cmdtcode":"{isbn}"` 근방의 `"dq_ID":"S…"` 추출(`extract_kyobo_dq_id`). `cmdt_NAME`=제목, `chrc_ALL`=`역할코드@id@이름|…`(001=저자, 003=역자).
- **상품 상세**: `GET https://product.kyobobook.co.kr/detail/{dq_ID}`
  - **Referer 헤더 없으면 200 + 빈 본문(0바이트).** 검색 URL을 Referer로 보낸다.
  - `og:description`은 "..."로 잘린 SEO 요약 — 쓰지 말 것. **본문 `id="bookDescription"` 섹션**(`</section>`까지)에서 전문 추출(`extract_kyobo_full_intro` + `strip_html_to_text`).
  - 분야는 `store.kyobobook.co.kr/category/domestic/…` 브레드크럼 2번째 라벨(`extract_kyobo_genre_breadcrumb`).
- reqwest에 `gzip` feature 필수(이미 켜져 있음) — 없으면 압축 응답이 깨진다.
- 표지 CDN(`contents.kyobobook.co.kr`)은 헤더 없이 접근 가능.

기존 구현·테스트: `commands.rs`의 `kyobo_meta / kyobo_meta_via_autocomplete / kyobo_meta_via_search / parse_kyobo_jsonp / parse_kyobo_detail_html` + `kyobo_tests`(fixture 8종) + `kyobo_live_probe`(ignored, 실네트워크).

---

## 5. 작업 명세

구현 순서: **A → B → E → C → D1·D2 → F → D3·D4 → G**. 각 항목에 완료 기준(DoD) 포함.

### Phase A. 데이터 안전 (최우선)

**A1. 창 닫기 시 dirty 플러시** — `src/App.tsx`
- `@tauri-apps/api/window`의 `getCurrentWindow().onCloseRequested(async (e) => …)`를 마운트 useEffect에서 1회 등록(unlisten 정리 포함).
- 핸들러: `useVault.getState().dirty`면 `e.preventDefault()` → `await saveCurrent()` → `getCurrentWindow().destroy()`. 저장이 throw해도 destroy(앱이 안 닫히는 상태 금지).
- DoD: dev 앱에서 타이핑 직후(autosave 3초 전) 창 닫기 → 재실행 시 내용 보존.

**A2. autosave의 외부 변경 덮어쓰기 방지** — `src/components/EditorPane.tsx` 49-54행
- autosave useEffect: `if (!dirty || externalChanged) return;` (`externalChanged`는 스토어에 이미 있음). 이 훅은 BookView 조기 return보다 위라 책 화면에도 적용됨.
- DoD: 외부 편집기로 열린 노트 수정 → 경고 배너 상태에서 3초 지나도 자동 저장 안 됨.

**A3. saveCurrent 재진입 가드** — `src/stores/vault.ts` `saveCurrent`
- 모듈 스코프 `let saving = false`로 in-flight 중복 무시.
- DoD: Ctrl+S 연타 시 저장 1회만(콘솔/동작 확인).

### Phase B. 네트워크 안정 + 키 없는 사용

**B0. 카카오 키 내장 + 교보 전면 폴백**
- Rust: `const DEFAULT_KAKAO_API_KEY: &str = "…"` — **사용자 settings.json(`%APPDATA%\com.yamcha.memo\settings.json`)의 `kakaoApiKey` 값을 읽어 넣는다.** 바로 위에 `// ⚠️ TODO(공개 배포 전): 이 키를 반드시 제거하고 사용자 키 필수로 되돌릴 것` 주석.
- `fn effective_key(user: &str) -> &str` — 비면 내장 키. `search_books/autofill_book/enrich_books/enrich_preview`의 "키 없음" 조기 에러 제거.
- `fn kyobo_search(query: &str) -> Vec<KyoboHit>` 신설 — autocomplete API를 **다건**으로 파싱(§4 인덱스 맵의 [0][2][3][4] + [14]). `KyoboHit { isbn, title, author, publisher, cover_url }`.
- 폴백 배선: 카카오가 에러이거나 0건이면 —
  - `search_books`: `kyobo_search` 결과를 `BookSearchHit`로 변환해 반환(published는 [5] 연도).
  - `autofill_book`/enrich 계열: 교보 히트로 author/publisher/isbn/cover 충당(소개·분야·평점은 기존 `kyobo_meta` 경로 그대로).
- 프론트: `BookSearchDialog/EnrichDialog/BookInfoModal/BookCreateDialog`의 `!apiKey` 차단·비활성 전부 제거(키 로드는 유지하되 없어도 동작). `SettingsModal` 키 설명을 "기본 제공 키 대신 내 키를 쓰려면 입력하세요"로.
- fixture 테스트: resultDocuments 다건 파싱, KyoboHit 필드 매핑.
- DoD: 설정에서 키 삭제 후 검색·자동채우기 정상 동작. 내장 키를 일부러 깨뜨리면 교보 폴백으로 검색 결과 나옴.

**B1. 타임아웃** — `fn http_client()`(15s total / 5s connect) 신설, `kyobo_client()`에도 동일 적용. `reqwest::get()` 직호출과 `Client::new()` 전부 교체(`search_books`, `kakao_docs`, `download_cover`, `attach_cover_from_url`, enrich 표지 다운로드).
- DoD: 네트워크 차단 상태에서 검색 → 15초 내 에러 반환(무한 대기 없음).

**B2. 에러 한국어화** — `fn net_err(e: &reqwest::Error) -> String`: `is_timeout()`→"요청 시간이 초과됐습니다. 잠시 후 다시 시도해주세요.", `is_connect()`→"인터넷 연결을 확인해주세요.", 기타→"네트워크 오류가 발생했습니다.". `{e}` 원문 노출 지점 전부 교체.
- DoD: 오프라인 에러 메시지에 영어 원문 미노출.

**B3. 일괄 자동채우기 진행률 + 취소**
- Rust: `static ENRICH_CANCEL: AtomicBool`. `enrich_books/enrich_preview` 시작 시 false로 reset, 루프마다 검사→true면 break(기존 report/preview에 처리분 반영). 루프마다 `app.emit("enrich-progress", json!({"done": i+1, "total": min(cands.len(), limit), "title": c.title}))` — 두 커맨드에 `app: AppHandle` 파라미터 추가(watcher.rs의 `app.emit` 패턴 참고). 신규 커맨드 `cancel_enrich()`(플래그만 set) + lib.rs 등록.
- 프론트 `EnrichDialog`: `listen("enrich-progress")`(vault.ts의 `listen` 임포트 패턴 참고)로 진행 바(`done/total`, 현재 책 제목) + `취소` 버튼→`cancelEnrich()`. busy 중 닫기 잠금은 D1 Modal의 `locked`로.
- DoD: 수십 권 vault에서 실행 시 진행 바 갱신, 취소 즉시 중단·부분 결과 리포트.

### Phase E. watcher 개선 — `src-tauri/src/watcher.rs`
- `suppressed()` 검사를 콜백 진입부(46-48행)에서 제거하고, **`app.emit("vault-external-change", …)` 직전으로 이동**. 인덱스 갱신(72-79행)은 항상 수행.
- 효과: 자기 저장 직후 2.5초 내 도착한 진짜 외부 변경도 인덱스에는 반영(UI 이벤트만 억제).
- DoD: 기존 테스트 전부 통과 + dev에서 저장 직후 외부 편집해도 검색 인덱스가 최신(재색인 없이 검색으로 확인).

### Phase C. 첫 실행 간소화

**C1. 클라우드 폴더 자동 감지 + 원클릭 시작**
- Rust 신규 커맨드 `detect_storage_dirs() -> Vec<StorageDir { label: String, path: String }>`:
  - OneDrive: `%OneDrive%` env / `~/OneDrive` · iCloud: `%USERPROFILE%\iCloudDrive`(Win), `~/Library/Mobile Documents/com~apple~CloudDocs`(mac) · Google Drive: `~\Google Drive`, `G:\My Drive`(Win), `~/Library/CloudStorage/GoogleDrive-*`(mac 글롭) · Dropbox: `~/Dropbox` — **존재하는 것만** 반환, 마지막에 문서 폴더(항상). home은 `std::env::var("USERPROFILE")`/`HOME`. `#[cfg(target_os)]`로 분기.
- `src/App.tsx` vault 선택 화면(48-65행) 개편: 감지된 위치를 카드 목록으로("☁️ OneDrive — 자동 백업(권장)" / "📁 문서 폴더"), 클릭 → `{path}/YamchaMemo`로 `setVault`(스토어에 `startAt(path)` 액션 신설 — settings에 vaultPath 저장 포함, 기존 `chooseVault` 후반부 재사용). 하단에 "다른 위치 직접 선택…" 링크 → 기존 `chooseVault`.
- `chooseVault`의 `${base}\\YamchaMemo` 백슬래시 하드코딩(vault.ts 192-194행) → `@tauri-apps/api/path`의 `join()`으로 교체.
- DoD: settings.json에서 vaultPath 제거 후 실행 → 감지 카드 표시, 원클릭으로 시작. 경로 구분자 하드코딩 잔존 0건(`grep '\\\\YamchaMemo'`).

### Phase D. UX 일관성

**D1. 공통 Modal** — 신규 `src/components/Modal.tsx`
- props: `onClose: () => void`, `locked?: boolean`, `width?: string`(tailwind 클래스), `children`. 기능: backdrop 클릭 닫기(locked면 무시), **Esc 닫기**(document keydown, locked면 무시), `role="dialog" aria-modal="true"`, 내부 stopPropagation. 열릴 때 내부 첫 포커스 가능 요소로 포커스(간단 구현이면 컨테이너 `tabIndex={-1}` focus).
- 9개 모달 교체: `SearchModal, BookSearchDialog, EnrichDialog, SettingsModal, BookInfoModal, BookPickerDialog, CustomTypeDialog, BookCreateDialog, NewNoteDialog` — 각각의 `fixed inset-0 …` 래퍼를 `<Modal>`로. `EnrichDialog`(busy 중)·`SettingsModal`(재색인 중)은 `locked` 전달. 각 input의 개별 Esc 핸들러는 남겨도 무해(중복 닫힘 없게 onClose 아이덤포턴트 확인).
- DoD: 9개 모달 전부 Esc로 닫힘, enrich 실행 중엔 Esc/backdrop 무시.

**D2. 휴지통 복구**
- `crates/yamcha-core/src/vault.rs`:
  - `pub fn list_trash(&self) -> Result<Vec<TrashItem>, CoreError>` — `.yamcha/trash`의 `{YYYYMMDD-HHMMSS}_{원래이름}.md` 나열, `TrashItem { file_name, original_name, deleted_at }`(specta Type는 커맨드 층에서).
  - `pub fn restore_trash(&self, file_name: &str) -> Result<String, CoreError>` — 파일 파싱해 frontmatter `type`으로 원 폴더 결정(파싱 실패·타입 소멸 시 `Free/`), `unique_path`로 충돌 회피 이동, rel 반환.
  - 유닛 테스트: 생성→삭제→list에 등장→restore→원 폴더 복귀+내용 보존, 없는 파일 복구 시 에러.
- `commands.rs`+`lib.rs`: `list_trash`/`restore_trash` 커맨드(복구 후 `refresh_note`).
- `SettingsModal`: "휴지통" 섹션 — 목록(원래 이름·삭제 시각) + [복구] 버튼, 비면 섹션 숨김.
- DoD: 앱에서 삭제→설정 휴지통에 표시→복구→목록/검색 재등장. 코어 테스트 통과.

**D3. 중복 유틸 통합**
- 신규 `src/lib/note.ts`: `fmStr(fm: unknown, key: string): string`(NoteSummary와 순수 객체 모두 수용하는 오버로드 1개로), `BOOK_STATUS_LABELS`, `BOOK_STATUS_ORDER`, `coverSrc(vaultPath, cover)`.
- 로컬 중복 제거: `Bookshelf, BookInfoModal, BookPickerDialog, BookView, Dashboard, HomeDashboard, ReadingDashboard, WritingDashboard`(글쓰기 상태 라벨은 유지).
- Rust `commands.rs`: `fn isbn13(raw: &str) -> String`(`split_whitespace().last()` 5곳), `fn join_authors(doc: &Value) -> String`(4곳) 통합.
- DoD: `grep -c "STATUS_LABELS\s*:" src/components` 책 상태 중복 0, tsc/테스트 통과, 동작 동일.

**D4. 소소한 정리**
- `SettingsModal`의 `window.confirm`(분류 제거) → 앱 스타일 2단계 확인(EditorPane `DeleteButton` 패턴 축소판).
- `BookCreateDialog.submit()` 실패 침묵 → 에러 텍스트 표시.
- `vault.ts reindexAll`이 `commands.reindex()` 반환 개수를 돌려주고 SettingsModal이 "N개 재색인 완료" 표시.
- DoD: 각 동작 수동 확인.

### Phase F. 마지막 상태 복원 — `src/stores/vault.ts`
- `setNav`/`openNote`/`closeNote`에서 settings에 `lastNav`, `lastNoteRel` 기록(없으면 삭제).
- `init()`: vault 로드 후 `lastNav` 복원, `lastNoteRel`이 notes에 존재하면 `openNote`. 모든 실패는 조용히 무시(기본 home).
- DoD: 노트 열어둔 채 재시작 → 같은 메뉴·노트로 복귀. lastNoteRel 파일을 지우고 재시작해도 크래시 없음.

### Phase G. 배포 준비 (Windows + macOS 유니버설, 모바일은 추후)

**G1. 메타데이터** — `src-tauri/tauri.conf.json`: `version 0.2.0`, bundle에 `publisher/copyright/shortDescription("마크다운 독서·글쓰기 메모")`, `windows.nsis: { languages: ["Korean"], installMode: "currentUser" }`.

**G2. 원커맨드 배포**
- `package.json`: `"release:win": "tauri build"`, `"release:mac": "tauri build --target universal-apple-darwin"`.
- `.github/workflows/release.yml` — `tauri-apps/tauri-action@v0`, 트리거 `push: tags: ['v*']`, 매트릭스 `windows-latest` / `macos-latest`(mac은 `rustup target add aarch64-apple-darwin x86_64-apple-darwin` 후 `--target universal-apple-darwin`), pnpm 셋업(`pnpm/action-setup` + node 20 + `pnpm install`), Release 초안 업로드(`releaseDraft: true`).
- `RELEASE.md`: ①버전 3곳(tauri.conf.json/양 Cargo.toml/package.json) 올리기 ②`git tag vX.Y.Z && git push --tags` ③Actions 완료 후 Release 초안 확인·발행 — 3단계 + 로컬 빌드 명령 + 추후 체크리스트(코드 서명/notarization/updater/`tauri android|ios init`).
- DoD: `pnpm release:win`으로 `target/release/bundle/nsis/*.exe` 생성 확인. release.yml은 YAML 문법·액션 파라미터 검토까지(실행은 태그 push 시).

---

## 6. 검증 프로토콜

**단계 게이트(매 Phase 후)**:
```bash
cargo test -p yamcha-core && cargo test -p yamcha-app --lib
npx tsc --noEmit -p tsconfig.json
```
둘 다 초록일 때만 다음 Phase. Rust 커맨드를 바꾼 Phase는 §2.3 바인딩 재생성 + `grep` 확인 추가.

**최종 회귀(전 Phase 완료 후, `pnpm tauri dev`로 실행하며)**:
1. settings.json 백업 → `vaultPath` 키 제거 → 첫 실행 화면에 감지된 클라우드 카드, 원클릭 시작.
2. 노트 타이핑 직후(3초 내) 창 닫기 → 재실행 시 내용 보존 + 마지막 메뉴·노트 복원.
3. 카카오 키 비운 상태로 책 검색/자동채우기 정상(내장 키). 내장 키 훼손 → 교보 폴백으로 결과 나옴 → 키 원복.
4. (가능하면 방화벽/기내모드로) 오프라인 검색 → 15초 내 한국어 에러.
5. 일괄 자동채우기: 진행 바·취소. 실행 중 Esc/backdrop 잠금.
6. 9개 모달 Esc 닫기 순회.
7. 노트 삭제 → 설정>휴지통 → 복구 → 재등장.
8. `pnpm release:win` → NSIS exe 생성.
9. 실네트워크 프로브: `cargo test -p yamcha-app --lib kyobo_live_probe -- --ignored --nocapture` 통과.

**회귀 기준선**: 0.5.6 시점 테스트 수 = **core 202(+ignored 4) + app 31(+ignored 3) + 프론트(vitest) 104**. 작업 후 감소 금지.
`--no-default-features`(docs 끔)로도 돌려 본다 — 137개 통과. 추출에 기대는 테스트는 feature 게이트를 달아야 한다.

**검색 기능 수동 회귀 (0.5.0에서 추가)** — `pnpm tauri dev`로 실행하며 Ctrl+K:
10. 토글 둘 다 꺼짐 — 기존 검색 결과·순위가 그대로인가.
11. `≈ 오타 허용` 켜고 오타("클닌 코드")·초성("ㅋㄹㅋㄷ") → 잡히는가. 정확 일치가 맨 위인가.
12. `📄 파일 속` 첫 켜기 — 진행률이 오르고, 그동안 검색·편집이 멈추지 않는가.
13. 첨부 문서의 본문 문구로 검색 → 해당 파일이 잡히고 발췌가 맞는가. 클릭=기본 앱, Ctrl+클릭=폴더.
14. `📄` 끄기 → 파일 결과가 즉시 사라지는가. 다시 켜면 재추출 없이 즉시 돌아오는가.
15. 앱 밖에서 첨부를 고치면 결과가 갱신되는가(watcher). 앱 재시작 후 토글 상태가 남는가.
16. 깨진·암호 문서를 넣어도 앱이 죽지 않고 "검색되지 않습니다" 안내가 뜨는가.

---

## 7. 함정 목록 (이번 세션에서 실제로 밟은 것들)

1. **교보 상세 페이지는 Referer 없으면 200+빈 본문** — 실패가 조용하다. 교보 관련 수정 후엔 반드시 live probe 테스트로 확인.
2. **교보 autocomplete는 UA 없으면 500**, og:description은 원래 잘린 값(재발 주의 — 소개는 `#bookDescription`에서).
3. **바인딩 미재생성** — 커맨드 추가 후 프론트에서 `commands.x is not a function`이면 §2.3 누락. export는 CWD 의존.
4. **dev 서버가 cargo 빌드 락 점유** — 테스트가 "Blocking waiting for file lock"에서 멈춘 것처럼 보임(기다리면 풀림).
5. **PowerShell 5.1**: `&&` 파서 에러. 콘솔 한글 출력 깨짐(cp949) — 확인용 텍스트는 UTF-8 파일로 쓰고 파일을 읽어라.
6. **tokio는 dev-dependency에만** 있음(`#[tokio::test]`는 테스트에서만 가능). 커맨드 본체는 tauri 런타임.
7. **HTML 파싱 시 태그 속성 중간부터 자르면 속성 텍스트가 새어 들어감** — 마커 찾은 뒤 그 태그의 `>`까지 스킵하고 시작(`extract_kyobo_full_intro`에서 이미 한 번 수정된 버그).
8. `Local::now()` 기반 로직 테스트는 날짜 고정 불가 — 오늘 날짜를 변수로 비교.
9. 프론트에서 frontmatter `null` 패치는 **필드 삭제**를 의미(`update_frontmatter`가 remove). 값 유지와 혼동 금지.
10. `with_ctx_write`가 자기쓰기 마킹을 담당 — vault 파일을 쓰는 새 커맨드에서 `with_ctx`를 쓰면 watcher가 외부 변경으로 오인한다.

**5단계(검색 강화)에서 밟은 것**

11. **오래 걸리는 일을 하면서 `AppState` 잠금을 쥐면 앱 전체가 멈춘다.** 모든 커맨드가 같은
    Mutex를 지나므로, 문서 추출(PDF 한 건 최악 15초) 같은 작업은 잠금 밖에서 해야 한다.
    `file_index::IndexAccess`가 그래서 있다 — 잠금 구간을 호출자가 정한다. watcher도 같다.
12. **`tauri dev`는 cargo를 `--no-default-features`로 실행한다.** 앱 크레이트에 default feature를
    두면 **dev에서만 조용히 꺼진다**. 그래서 `docs` feature는 yamcha-core 쪽에만 둔다.
13. **디버그 빌드로 성능을 재면 안 된다.** 첨부 105개 색인이 debug 9.7분 / release 수십 초다.
    측정 테스트는 반드시 `--release`로.
14. **tantivy 스키마를 바꾸면 `open()`이 인덱스를 지운다**(설계된 동작). `set_vault`가 곧바로
    재색인하므로 사용자에겐 첫 실행이 조금 느린 것으로만 보인다 — 노트 2,000건 0.9초.
15. **이벤트 payload 타입은 `bindings.ts`에 생성되지 않는다.** 커맨드 시그니처에서 도달할 수
    없기 때문이다. 프론트에 직접 타입을 적는다(`EnrichDialog`의 `Progress`와 같은 관례).
16. **pdf-extract는 실제로 패닉한다** (`unsupported encoding UniKS-UCS2-H` 등). `extract()`의
    `catch_unwind`를 걷어내면 앱이 죽는다.
17. **`docs` feature를 끈 빌드도 테스트해야 한다.** 추출에 기대는 테스트에 게이트를 안 달면
    초경량 빌드에서만 깨진다 — 실제로 `file_index` 테스트 4개가 그랬다.

**한글 입력·동시 편집에서 밟은 것 (0.5.6)**

18. **조합(composition) 이벤트를 아예 안 내는 한글 IME가 있다.** 음절을 곧바로 확정해 넣고,
    고쳐 쓸 때는 지웠다 다시 넣는다. Ctrl이 눌려 있으면 그 백스페이스가 브라우저에서
    `deleteWordBackward`가 되어 **단어가 통째로 날아간다** — `기록` + Ctrl+Enter가 `록`으로
    저장됐다. `isComposing`만 보는 코드에는 이 경로가 보이지 않는다(`lib/ime.ts` 참고).
18-b. **같은 IME 동작이 안내 문구(placeholder)를 깜빡이게 한다.** 첫 음절을 쓰는 동안
    값이 통째로 빈 칸이 되는 구간이 생겨서(실측 `기록` 한 단어에 3번, 매번 30~40ms)
    문구가 그때마다 번쩍인다. **감추는 건 즉시, 되살리는 건 한 박자 뒤**로 나눠야 한다
    (`syncPlaceholder`의 `PLACEHOLDER_GRACE_MS`).
19. **CDP(`Input.imeSetComposition`)로는 18번을 못 만든다.** Blink 조합만 흉내 낼 뿐 IME 엔진
    쪽 동작이 없다. 실제 IME 문제는 **`document`에 capture 리스너를 심어 사용자가 한 번
    재현하게 하고 그 순서를 읽는 것**이 가장 빠르다 (`scratchpad/record.mjs` 방식).
20. **자기 쓰기를 시각으로 가리면 안 된다.** 예전 watcher는 마지막 쓰기 후 2.5초 안의 변경을
    전부 자기 것으로 봤는데, 그 창이 파일을 구분하지 않아서 **내가 A를 저장하는 사이에 온
    남의 B 저장 알림까지 삼켰다**. 지금은 내용 지문으로 가린다(`Vault::is_self_write`).
21. **클라우드 동기화는 내용이 같아도 mtime을 갈아치운다.** "바뀌었나"의 잣대로 mtime을 쓰면
    헛된 충돌 경고가 뜬다. 저장 충돌 검사(`save_note_checked`)도 지문 기준이다.

**별칭·중복 이름 링크에서 밟은 것 (0.5.9)**

22. **링크 해석이 두 곳에 있다 — 프론트(`resolveLink.ts`)와 백엔드(`Indexer::link_names`).**
    둘이 어긋나면 "열리는 글과 백링크가 다른" 링크가 생기고, 그건 사용자가 알아챌 방법이 없다.
    한쪽 규칙을 고치면 반드시 다른 쪽도 고친다. 특히 **별칭은 같은 이름의 진짜 글이 없을 때만
    센다** — 이 조건을 백엔드에서 빼면 별칭이 남의 백링크를 가로챈다.
23. **`aliases`는 나중에 생긴 칸이라 예전 `_types.json`에는 없다.** `Vault::open`이 커스텀 타입에
    끼워 넣는다(`ensure_aliases_field`). 안 하면 사용자가 만든 분류만 별칭을 못 쓴다.
24. **`FieldKind`를 새로 만들지 않고 `Tags`를 다시 썼다.** 새 변종을 넣으면 `bindings.ts`를
    다시 내보내야 하는데(§2.3), 그럴 값어치가 없는 차이였다. 대신 태그 제안을 붙이는 조건을
    **종류(`kind === "tags"`)가 아니라 이름(`name === "tags"`)으로** 바꿔야 한다 — 안 그러면
    별칭 칸에 자동 태그 제안이 딸려 들어간다.
25. **`WikiLinkSuggest.refresh`는 keyup마다 돈다.** 후보 목록을 거기서 만들면 링크를 치는 내내
    vault 전체를 훑는다. `useMemo`로 노트 목록이 바뀔 때만 만든다.

---

## 8. 범위 밖 (하지 말 것)

- 가상화(react-window) 등 성능 리팩토링, 노트 타입 추가/변경, 편집기 기능 확장.
- 코드 서명, notarization, 자동 업데이트(updater) — RELEASE.md 체크리스트로만.
- Android/iOS 실제 초기화 — RELEASE.md에 절차 기록만.
- kakaoApiKey의 OS 키체인 이전(현행 평문 유지 — 토이 프로젝트 단계).
- 기존 UI 문구·레이아웃의 취향성 변경(명세에 있는 것만).

**검색 관련 범위 밖** (자세한 근거는 `HANDOFF-search.md` §7·§8)
- OCR(스캔 PDF·이미지) · 벡터/의미 검색 · AI 질의응답 — 모델이 수백MB다.
- **vault 밖 외부 폴더 색인 — 이 프로그램의 범위를 넘는다**(2026-07-30 결정). 다운로드 폴더
  하나가 105개·481MB였다. 수천 개짜리 업무 폴더는 아키텍처가 다른 Docufinder의 영역이다.
- HWP 3.0(1996~2002), 형태소 분석기(lindera ko-dic).
- Docufinder(BSL 1.1) 소스 재사용 — 크레이트 선택 근거만 참고했다.
