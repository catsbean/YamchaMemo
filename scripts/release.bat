@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem 이 배치파일이 하는 일:
rem   1. 버전을 올리고 (package.json / tauri.conf.json / Cargo.toml / Cargo.lock)
rem   2. 커밋 + 태그 생성
rem   3. origin에 push
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
echo   1. 버전을 v!CUR_VERSION! -^> v!NEWVER!로 올리고 커밋
echo   2. 태그 v!NEWVER!를 만들고 origin/!BRANCH!와 함께 push
echo   3. GitHub Actions가 Windows, Mac 설치 파일을 빌드해 릴리스 초안으로 올림
echo.
set /p CONFIRM=계속할까요? (y/N):
if /i not "!CONFIRM!"=="y" (
  echo 취소했습니다.
  goto :END
)

echo.
echo [1/5] 버전 파일 수정 중...
call node scripts\bump-version.mjs !NEWVER!
if errorlevel 1 goto :END

echo [2/5] Cargo.lock 갱신 중...
call cargo update -p yamcha-app --precise !NEWVER!
if errorlevel 1 (
  echo [오류] cargo update에 실패했습니다.
  goto :END
)

echo [3/5] 커밋 중...
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml Cargo.lock
git commit -m "release: v!NEWVER!"
if errorlevel 1 goto :END

echo [4/5] 태그 생성 중...
git tag "v!NEWVER!"
if errorlevel 1 goto :END

echo [5/5] push 중...
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
