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

## 추후 체크리스트 (이번 범위 밖)

- [ ] **코드 서명** — Windows 인증서 / Apple Developer ID로 서명해 "알 수 없는 게시자" 경고 제거.
- [ ] **notarization** — macOS 공증(`xcrun notarytool`)으로 Gatekeeper 통과.
- [ ] **자동 업데이트(updater)** — `tauri-plugin-updater` 도입 + 서명 키 + 배포 채널.
- [ ] **모바일 초기화** — `pnpm tauri android init` / `pnpm tauri ios init` 후 별도 빌드 파이프라인.
