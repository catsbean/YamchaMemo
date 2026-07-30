# 배포 가이드

YamchaMemo 새 버전을 내보내는 절차입니다. 데스크톱(Windows·macOS)만 다루며, 모바일과
코드 서명 등은 아래 "추후 체크리스트"로 남겨 둡니다.

## 준비: API 키 (최초 1회)

카카오 REST API 키는 **소스에 두지 않고 빌드할 때 주입**합니다.

- **로컬 빌드**: `src-tauri/.env.example`을 `src-tauri/.env`로 복사하고 `YAMCHA_KAKAO_KEY=`에 키를 채웁니다. `.env`는 git에 올라가지 않습니다.
- **GitHub Actions**: 저장소 Settings → Secrets and variables → Actions에 `YAMCHA_KAKAO_KEY`를 등록합니다.

키가 없어도 빌드는 성공하며, 그 빌드에서는 책 검색·자동 채우기가 교보문고 경로로만 동작합니다.

> ⚠️ 키를 소스에 되돌려 넣지 마세요. 실수로 커밋되면 즉시 재발급해야 합니다.

## 릴리스 3단계

### ① 버전 올리기 (4개 파일을 같은 값으로)

`X.Y.Z`를 새 버전으로 바꿔 아래 네 곳을 모두 맞춥니다.

- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`
- `crates/yamcha-core/Cargo.toml` → `version`
- `package.json` → `"version"`

### ② 태그 push

```bash
git tag vX.Y.Z && git push --tags
```

`v`로 시작하는 태그가 올라가면 `.github/workflows/release.yml`가 자동으로 실행됩니다.

### ③ Release 초안 확인·발행

GitHub Actions가 Windows·macOS 빌드를 끝내면 **Release 초안**이 만들어집니다.
Releases 탭에서 첨부물(설치본)을 확인하고, 문제 없으면 **Publish release**를 눌러 공개합니다.

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
- [ ] **notarization** — macOS 공증(`xcrun notarytool`)으로 Gatekeeper 통과.
- [ ] **자동 업데이트(updater)** — `tauri-plugin-updater` 도입 + 서명 키 + 배포 채널.
- [ ] **모바일 초기화** — `pnpm tauri android init` / `pnpm tauri ios init` 후 별도 빌드 파이프라인.
