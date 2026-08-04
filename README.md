# YamchaMemo

마크다운 기반 독서·글쓰기 메모 데스크톱 앱. Windows/macOS.

모든 메모는 평범한 `.md` 파일로 저장됩니다. 앱이 사라져도 파일은 남고, 다른 편집기로 열어도 됩니다. 클라우드 동기화 폴더(OneDrive·iCloud·Dropbox 등)를 저장 위치로 잡으면 기기 사이에서 그대로 이어집니다.

**설치는 [설치방법.md](설치방법.md)를 참고하세요.** ([최신 릴리스 다운로드](https://github.com/catsbean/YamchaMemo/releases/latest))

## 주요 기능

- **분류별 노트** — 데일리노트(일지), 도서리스트·독서기록, 글쓰기(시리즈 연재), 정보노트, 자유노트 + 사용자 정의 분류
- **책 검색·자동 채우기** — 카카오 책 검색 API + 교보문고 폴백으로 제목만으로 저자·출판사·표지·소개 자동 완성
- **노트 연결** — `[[위키링크]]`로 노트 간 연결, 백링크(문맥 포함)·미연결 언급 확인
- **태그** — frontmatter/인라인 `#태그` 자동 인식, 이름 바꾸기·병합
- **검색** — 분류·기간·태그로 좁히는 전문검색
- **회고** — 주간·월간 단위로 일지의 기록·할 일을 모아 보기
- **내보내기** — 책 목록 CSV/마크다운 표, 노트를 스타일 있는 HTML로, 인쇄를 거쳐 PDF로
- **라이브 프리뷰 마크다운 에디터** — 서식 툴바 + 우클릭 메뉴, 콜아웃(기록/느낌/발췌/생각/요약/질문 + 사용자 정의)
- **다크 모드** — 라이트/다크/시스템 설정
- **안전장치** — 자동 저장, 스냅샷 히스토리, 휴지통, 외부 편집(예: 옵시디언) 감지, 여러 폴더로 미러

## 개발

```bash
npm install
npm run tauri dev      # 개발 실행 (Vite + Tauri)
npm test                # 프론트 테스트 (vitest)
cargo test              # Rust 테스트 (yamcha-core + yamcha-app)
npx tsc --noEmit -p tsconfig.json   # 타입체크
```

### 스택

| 층 | 기술 |
|---|---|
| 데스크톱 셸 | [Tauri 2](https://tauri.app) |
| 프론트엔드 | React 19 · TypeScript · Vite · Tailwind CSS 4 |
| 에디터 | [CodeMirror 6](https://codemirror.net) |
| 코어 로직 | Rust (`crates/yamcha-core`) |
| 검색 | [tantivy](https://github.com/quickwit-oss/tantivy) |

### 구조

```
crates/yamcha-core/   순수 Rust 코어 (vault·파싱·인덱스·검색·템플릿)
src-tauri/            Tauri 앱 셸, 커맨드, 외부 API 클라이언트
src/                  React 프론트엔드
  components/         화면 컴포넌트
  editor/             CodeMirror 설정·서식·라이브 프리뷰
  stores/             zustand 상태 관리
  lib/                공통 유틸 (IME 안전 입력, 단축키, 내보내기 등)
```

## 배포

카카오 REST API 키는 소스에 두지 않고 빌드 시점에 환경변수(`YAMCHA_KAKAO_KEY`)로 주입합니다. 키가 없어도 빌드되며, 그 경우 책 검색은 교보문고 경로로만 동작합니다.

```bash
npm run release:win    # Windows NSIS 설치본
npm run release:mac    # macOS 유니버설 (arm64+x86_64)
```

## 라이선스

개인 프로젝트입니다.
