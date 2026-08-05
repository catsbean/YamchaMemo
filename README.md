# YamchaMemo

[![최신 릴리스 다운로드](https://img.shields.io/github/v/release/catsbean/YamchaMemo?label=%EC%B5%9C%EC%8B%A0%20%EB%A6%B4%EB%A6%AC%EC%A6%88%20%EB%8B%A4%EC%9A%B4%EB%A1%9C%EB%93%9C&style=for-the-badge)](https://github.com/catsbean/YamchaMemo/releases/latest)

마크다운 기반 독서·글쓰기 메모 데스크톱 앱. Windows/macOS.

모든 메모는 평범한 `.md` 파일로 저장됩니다. 앱이 사라져도 파일은 남고, 다른 편집기로 열어도 됩니다. 클라우드 동기화 폴더(OneDrive·iCloud·Dropbox 등)를 저장 위치로 잡으면 기기 사이에서 그대로 이어집니다.

## 설치

[최신 릴리스](https://github.com/catsbean/YamchaMemo/releases/latest) 페이지의 **Assets**에서 내 컴퓨터에 맞는 파일을 받으세요.

| 내 컴퓨터 | 받을 파일 |
| --- | --- |
| Windows | `YamchaMemo_x.x.x_x64-setup.exe` |
| Mac (Apple Silicon·Intel 공통) | `YamchaMemo_x.x.x_universal.dmg` |

정식 인증서로 서명하지 않은 개인 프로젝트라 설치 중 경고가 한 번 뜹니다. Windows는 **추가 정보 → 실행**을 누르면 되고, Mac은 같은 페이지의 `mac-unlock.zip`을 받아 압축을 풀고 `mac-unlock.command`를 더블클릭하면 열립니다.

화면과 함께 보는 자세한 안내는 **[설치방법.md](설치방법.md)** 에 있습니다.

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
pnpm install
pnpm tauri dev                      # 개발 실행 (Vite + Tauri)
pnpm test                           # 프론트 테스트 (vitest)
cargo test                          # Rust 테스트 (yamcha-core + yamcha-app)
pnpm exec tsc --noEmit -p tsconfig.json   # 타입체크
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

## 릴리스 만들기

`scripts\release.bat`을 실행하면 버전을 올리고 `vX.Y.Z` 태그를 push합니다. 태그가 올라가면 GitHub Actions가 Windows·macOS 설치본을 각각 빌드해 [릴리스](https://github.com/catsbean/YamchaMemo/releases) 초안으로 올립니다(10~20분 소요). macOS 빌드는 macOS에서만 가능하므로 로컬에서 두 플랫폼을 함께 만들 수는 없습니다.

### 카카오 API 키

카카오 REST API 키는 소스에 두지 않고 빌드 시점에 환경변수(`YAMCHA_KAKAO_KEY`)로 주입합니다. 키가 없어도 빌드되며, 그 경우 책 검색은 교보문고 경로로만 동작합니다.

키는 평문으로 넣지 않고 빌드마다 달라지는 패드로 XOR해 흩어 넣습니다. 다만 이건 **잠금이 아니라 속도 방지턱**입니다 — 클라이언트가 쓸 수 있는 키는 클라이언트를 뜯으면 반드시 나옵니다(암호화해도 복호화 키를 같이 실어야 하므로 마찬가지고, 진짜 해법은 키를 서버에만 두는 프록시뿐입니다). 배포 파일에 `strings`를 걸어 키를 긁어가는 자동 수집을 막는 것까지가 이 조치의 몫입니다. 무료 검색 API라 그 선에서 그칩니다.

남용이 확인되면(카카오 콘솔에서 호출량이 튀면) 이렇게 회수합니다.

1. 카카오 개발자 콘솔에서 키를 재발급한다 — 그 순간 옛 키는 죽는다
2. 저장소 Secrets의 `YAMCHA_KAKAO_KEY`를 새 키로 바꾸고 새 버전을 릴리스한다
3. 옛 버전을 쓰는 사용자는 **설정 → 카카오 API 키**에 자기 키를 넣으면 그대로 동작한다 (사용자 키가 있으면 내장 키보다 먼저 쓰인다)

3번 경로가 있어서 회수가 사용자를 막다른 곳에 두지 않습니다.

## 라이선스

개인 프로젝트입니다.
