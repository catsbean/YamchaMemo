@echo off
setlocal enabledelayedexpansion

rem === ASCII only above the "chcp" below - do not put Korean here. ===
rem (Why: see the note right after this block.)
if not defined YAMCHA_RELEASE_UTF8 (
  for /f "tokens=2 delims=:" %%c in ('chcp') do set "OLDCP=%%c"
  set YAMCHA_RELEASE_UTF8=1
  chcp 65001 >nul
  cmd /d /c "%~f0"
  chcp !OLDCP! >nul
  exit /b
)

rem 위 블록이 하는 일:
rem 이 파일은 UTF-8로 저장돼 있는데, cmd는 배치 파일을 "열 때의 코드페이지"로
rem 읽는다. 그래서 파일 한가운데서 chcp로 65001로 바꾸면, 그때까지 읽은 위치를
rem 글자 수로 세어 두었다가 바이트로 되돌리면서 어긋나 버린다. 한글 주석
rem 한복판부터 명령으로 해석해 이런 오류가 난다:
rem   '전을'은(는) 내부 또는 외부 명령이 아닙니다
rem 그래서 (1) chcp 앞에는 ASCII만 두어 글자 수와 바이트 수를 같게 맞추고,
rem (2) 코드페이지를 바꾼 뒤 첫 바이트부터 UTF-8로 읽는 새 cmd에게 이 파일을
rem 다시 넘긴다. 재실행 표시 변수는 setlocal 안이라 사용자 창으로 새지 않고,
rem 원래 코드페이지도 끝나고 되돌려 놓는다.

rem 이 배치파일이 하는 일:
rem   1. Rust 툴체인을 최신 stable로 올리고, CI와 같은 검사를 로컬에서 돌리고
rem   2. 버전을 올리고 (package.json / tauri.conf.json / Cargo.toml / Cargo.lock)
rem   3. 커밋 + 태그 생성
rem   4. origin에 push
rem 태그가 push되면 .github/workflows/release.yml이 GitHub Actions에서
rem Windows, Mac 설치 파일을 각각 빌드해 GitHub Release 초안으로 올린다.
rem (Mac 앱은 macOS에서만 빌드 가능하므로 이 배치파일은 로컬에서 Mac 파일을
rem  직접 만들지 않고, CI 빌드를 트리거하는 역할을 한다.)

cd /d "%~dp0.."

echo ================================================
echo   YamchaMemo 릴리스 만들기 (Windows + Mac)
echo ================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [오류] git이 설치되어 있지 않거나 PATH에 없습니다.
  goto :END
)

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] node가 설치되어 있지 않거나 PATH에 없습니다.
  goto :END
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [오류] cargo Rust가 설치되어 있지 않거나 PATH에 없습니다.
  goto :END
)

where rustup >nul 2>nul
if errorlevel 1 (
  echo [오류] rustup이 설치되어 있지 않거나 PATH에 없습니다.
  goto :END
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [오류] pnpm이 설치되어 있지 않거나 PATH에 없습니다.
  goto :END
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b

set DIRTY=
for /f "delims=" %%l in ('git status --porcelain') do set DIRTY=1
if defined DIRTY (
  echo [중단] 커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 정리한 뒤 다시 실행하세요.
  echo.
  git status --short
  goto :END
)

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set CUR_VERSION=%%v
for /f "delims=" %%v in ('node -e "const [a,b,c]=require('./package.json').version.split('.').map(Number);console.log(a+'.'+b+'.'+(c+1))"') do set SUGGESTED=%%v

echo 현재 버전: v!CUR_VERSION!  (브랜치: !BRANCH!)
set /p NEWVER=새 버전 번호를 입력하세요 (엔터=v!SUGGESTED!):
if "!NEWVER!"=="" set NEWVER=!SUGGESTED!

node -e "process.exit(/^\d+\.\d+\.\d+$/.test(process.argv[1]) ? 0 : 1)" "!NEWVER!" <nul
if errorlevel 1 (
  echo [오류] 버전 형식이 올바르지 않습니다. 예: 0.5.2
  goto :END
)

echo.
echo 다음 작업을 수행합니다:
echo   1. Rust 툴체인을 최신 stable로 갱신 (CI와 같은 자리로 맞춘다)
echo   2. CI와 같은 검사를 로컬에서 실행 - 몇 분 걸립니다
echo   3. 버전을 v!CUR_VERSION! -^> v!NEWVER!로 올리고 커밋
echo   4. 태그 v!NEWVER!를 만들고 origin/!BRANCH!와 함께 push
echo   5. GitHub Actions가 Windows, Mac 설치 파일을 빌드해 릴리스 초안으로 올림
echo.
set /p CONFIRM=계속할까요? (y/N):
if /i not "!CONFIRM!"=="y" (
  echo 취소했습니다.
  goto :END
)

rem release.yml은 dtolnay/rust-toolchain@stable로 "그날의 최신 stable"을 받는다.
rem 로컬이 뒤처져 있으면 새로 생긴 clippy 린트를 여기서 못 보고, 태그를 push한
rem 뒤에야 CI에서 처음 터진다. (실제로 1.98.0에 들어온 chunks_exact_to_as_chunks가
rem 그랬다 - 로컬 1.97.1에서는 조용했다.) 그래서 CI와 같은 자리로 먼저 올린다.
echo.
echo [1/7] Rust 툴체인 갱신 중...
call rustup update stable
if errorlevel 1 (
  echo [오류] rustup update에 실패했습니다.
  goto :END
)

rem 올린 툴체인으로 ci.yml의 check 잡과 같은 검사를 같은 순서로 돌린다.
rem 여기서 걸러야 태그가 나간 뒤 CI에서 깨지는 일을 막는다.
echo.
echo [2/7] CI와 같은 검사 실행 중... (몇 분 걸립니다)

call pnpm install --frozen-lockfile
if errorlevel 1 (
  echo [오류] pnpm install 실패 - pnpm-lock.yaml이 package.json과 어긋났을 수 있습니다.
  goto :END
)

call pnpm test
if errorlevel 1 (
  echo [오류] 프런트엔드 테스트가 실패했습니다.
  goto :END
)

rem tsc + vite build. cargo보다 먼저 - tauri-build가 dist/를 찾는다.
call pnpm build
if errorlevel 1 (
  echo [오류] 프런트엔드 빌드 ^(tsc/vite^)가 실패했습니다.
  goto :END
)

call cargo clippy --workspace --all-targets -- -D warnings
if errorlevel 1 (
  echo [오류] clippy가 실패했습니다. 방금 올린 툴체인이 새 린트를 잡았을 수 있습니다.
  goto :END
)

call cargo test --workspace
if errorlevel 1 (
  echo [오류] Rust 테스트가 실패했습니다.
  goto :END
)

echo.
echo [3/7] 버전 파일 수정 중...
call node scripts\bump-version.mjs !NEWVER!
if errorlevel 1 goto :END

echo [4/7] Cargo.lock 갱신 중...
call cargo update -p yamcha-app --precise !NEWVER!
if errorlevel 1 (
  echo [오류] cargo update에 실패했습니다.
  goto :END
)

echo [5/7] 커밋 중...
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml Cargo.lock
git commit -m "release: v!NEWVER!"
if errorlevel 1 goto :END

echo [6/7] 태그 생성 중...
git tag "v!NEWVER!"
if errorlevel 1 goto :END

echo [7/7] push 중...
git push origin !BRANCH!
if errorlevel 1 goto :END
git push origin "v!NEWVER!"
if errorlevel 1 goto :END

echo.
echo ================================================
echo   완료. GitHub Actions가 빌드를 시작했습니다.
echo   진행 상황: https://github.com/catsbean/YamchaMemo/actions
echo   빌드가 끝나면 (약 10~20분) 아래 릴리스 초안에서
echo   설치 파일을 확인하고 공개하세요:
echo   https://github.com/catsbean/YamchaMemo/releases
echo ================================================

:END
echo.
pause
endlocal
