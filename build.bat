@echo off
chcp 65001 >nul
title 문제풀이도구 - exe 빌드
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js 가 필요합니다. https://nodejs.org 에서 설치하세요.
  echo     ^(빌드할 때만 필요하고, 만들어진 exe 는 Node 없이 돕니다.^)
  pause
  exit /b 1
)

if not exist "node_modules\esbuild" (
  echo 빌드 도구를 설치합니다...
  call npm install
  if errorlevel 1 (
    echo [!] npm install 실패. 인터넷 연결을 확인하세요.
    pause
    exit /b 1
  )
)

node build.js
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo dist 폴더를 엽니다...
explorer "%~dp0dist"
pause
