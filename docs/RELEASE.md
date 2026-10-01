# 배포 가이드

YamchaMemo 새 버전을 내보내는 절차입니다. 데스크톱(Windows·macOS)만 다루며, 모바일과
코드 서명 등은 아래 "추후 체크리스트"로 남겨 둡니다.

## 준비: API 키 (최초 1회)

카카오 REST API 키는 **소스에 두지 않고 빌드할 때 주입**합니다.

- **로컬 빌드**: `src-tauri/.env.example`을 `src-tauri/.env`로 복사하고 `YAMCHA_KAKAO_KEY=`에 키를 채웁니다. `.env`는 git에 올라가지 않습니다.
- **GitHub Actions**: 저장소 Settings → Secrets and variables → Actions에 `YAMCHA_KAKAO_KEY`를 등록합니다.

키가 없어도 빌드는 성공하며, 그 빌드에서는 책 검색·자동 채우기가 교보문고 경로로만 동작합니다.

> ⚠️ 키를 소스에 되돌려 넣지 마세요. 실수로 커밋되면 즉시 재발급해야 합니다.

## 준비: 업데이트 서명 키 (최초 1회)

앱은 설정 > 버전의 [새 버전 확인]에서 새 판을 **받아 설치하고 다시 켭니다**(`tauri-plugin-updater`).
받은 설치본이 진짜 우리 것인지는 서명으로 확인합니다 — 그래서 릴리스 빌드마다 서명 키가 필요합니다.

1. 키 만들기 (한 번만, 비밀번호를 묻습니다):
   ```powershell
   pnpm tauri signer generate -w "$env:USERPROFILE.tauriyamcha-updater.key"
   ```
   `yamcha-updater.key`(비밀 키)와 `yamcha-updater.key.pub`(공개 키)가 생깁니다.
2. **공개 키**는 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 들어 있습니다(저장소에 올라가도 됩니다).
3. **비밀 키**는 GitHub 저장소 Settings → Secrets and variables → Actions에 둘을 등록합니다:
   - `TAURI_SIGNING_PRIVATE_KEY` — `yamcha-updater.key` 파일 내용 전체
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — 1번에서 정한 비밀번호

   붙여 넣을 때 끝에 빈 줄이 딸려 들어가도 워크플로가 걷어 낸다(0.7.0 첫 빌드가 그것 때문에 서명에서
   `Invalid symbol 10`으로 실패했다). 그래도 키는 한 줄 그대로 넣는 것이 원칙이다.

> ⚠️ **비밀 키를 잃어버리면 이미 설치된 앱은 다시는 자동 업데이트를 받지 못합니다**(새 키로 서명한 판을
> 믿지 않습니다). 키 파일과 비밀번호를 안전한 곳(비밀번호 관리자 등)에 따로 보관하세요. 저장소에 올리지 마세요.

로컬에서 설치본을 만들 때(`pnpm release:win`)도 같은 두 값을 환경 변수로 줘야 합니다 — 없으면
"공개 키는 있는데 비밀 키가 없다"며 빌드가 멈춥니다.
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE.tauriyamcha-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<비밀번호>"
pnpm release:win
```

## 릴리스

### ⓪ `CHANGELOG.md`에 이번 판의 절 쓰기

맨 위에 `## 0.7.1` 같은 절을 쓰고 커밋합니다. **그 절이 그대로 릴리스 설명과 앱의 업데이트 창에
실립니다** — 쓰는 사람이 읽을 말로, 짧은 목록으로. 워크플로가 빌드할 때 이 절을 뽑아 `latest.json`의
`notes`에 넣습니다(`scripts/changelog.mjs`). 절이 없으면 `release.bat`이 태그를 찍기 전에 멈추고,
CI도 멈춥니다.

### ①·② `scripts\release.bat` 실행

버전을 올리고(`package.json`·`src-tauri/tauri.conf.json`·`src-tauri/Cargo.toml`·
`Cargo.lock`) 커밋한 뒤 `vX.Y.Z` 태그를 push하는 것까지 한 번에 합니다. 커밋되지
않은 변경이 있으면 중단하므로, 먼저 정리하고 실행하세요.

`v`로 시작하는 태그가 올라가면 `.github/workflows/release.yml`가 자동으로 실행됩니다.

> `crates/yamcha-core`의 version은 앱 버전과 따로 갑니다(경로 참조 내부 크레이트라
> 설치본 버전에 영향이 없습니다). 스크립트도 건드리지 않습니다.

손으로 할 때는 위 네 곳을 같은 값으로 맞춘 뒤 `git tag vX.Y.Z && git push --tags`.

### ③ Release 초안 확인·발행

GitHub Actions가 Windows·macOS 빌드를 끝내면 **Release 초안**이 만들어집니다.
Releases 탭에서 첨부물(설치본)을 확인하고, 문제 없으면 **Publish release**를 눌러 공개합니다.

첨부물에 `latest.json`과 설치본마다의 `.sig`가 있는지도 봅니다. 앱은
`https://github.com/catsbean/YamchaMemo/releases/latest/download/latest.json`을 보므로
**공개(Publish)한 뒤에야** 설치된 앱이 새 판을 봅니다(초안은 안 보입니다). 업데이트 창의 설명(`latest.json`의 `notes`)은
**빌드할 때** `CHANGELOG.md`의 그 판 절로 정해집니다 — Publish 전에 릴리스 설명을 고쳐도
`latest.json`에는 들어가지 않습니다(0.7.0에서 확인). 고치려면 ⓪부터 다시(새 판으로) 냅니다.

> 자동 업데이트는 **업데이터가 들어간 판(0.7.0)부터** 동작합니다. 그 전 판을 쓰는 사람은 0.7.0을
> 한 번 손으로 설치해야 합니다 — 옛 판의 [새 버전 확인]은 릴리스 페이지 링크만 줍니다.

## 로컬 빌드 (수동)

```bash
pnpm release:win
```

- Windows: 산출물은 `target/release/bundle/nsis/*.exe` (NSIS 설치본).
- macOS 유니버설:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm release:mac
```

> ⚠️ 개발 서버(`pnpm tauri dev`)가 떠 있으면 cargo 빌드 락에 걸립니다. 먼저 종료하세요.
> ⚠️ 릴리스 빌드에는 디스크 여유가 넉넉히 필요합니다(워크스페이스 `target/`이 수십 GB까지
> 자랍니다). 공간이 부족하면 링크 단계에서 `os error 112`로 실패합니다 — `cargo clean` 후 재시도.

## 초경량 빌드 (첨부 문서 검색 없이)

첨부 문서(pdf·hwp·오피스) 본문 검색을 뺀 설치본을 만들려면
`src-tauri/Cargo.toml`의 yamcha-core 의존성에 `default-features = false`를 붙입니다.

```toml
yamcha-core = { path = "../crates/yamcha-core", default-features = false }
```

- 실행파일이 **2.05MB 작아집니다** (실측: 23.41MB → 21.36MB).
- `첨부내용검색` 토글은 남아 있지만 아무 문서도 찾지 못합니다.
- 잰 뒤에는 바이너리에 추출기 문자열(`"OLE 컨테이너"`)이 있는지 확인하세요.
  빌드가 안 끝났는데 낡은 exe를 재는 실수를 그것으로 걸러냅니다.
- 앱 크레이트의 default feature로 두지 않는 이유는 `tauri dev`가 cargo를
  `--no-default-features`로 실행해서 **dev에서만 조용히 꺼지기** 때문입니다.

## 추후 체크리스트 (이번 범위 밖)

- [ ] **코드 서명** — Windows 인증서 / Apple Developer ID로 서명해 "알 수 없는 게시자" 경고 제거.
  **하지 않기로 했다**(2026-10-01, 비용). 경고 넘기기 안내로 대신한다 — `ROADMAP.md` 8단계.
- [ ] **notarization** — macOS 공증(`xcrun notarytool`)으로 Gatekeeper 통과.
  코드 서명과 함께 하지 않는다(Apple Developer 등록이 필요하다).
- [x] **자동 업데이트(updater)** — 0.7.0. 위 "업데이트 서명 키" 참고.
- [ ] **모바일 초기화** — `pnpm tauri android init` / `pnpm tauri ios init` 후 별도 빌드 파이프라인.
