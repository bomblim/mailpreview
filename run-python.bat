@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title MailPreview (Python)

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [오류] Python 3 를 찾을 수 없습니다.
  echo   https://www.python.org/downloads/ 에서 설치하세요 ^(설치 시 "Add python.exe to PATH" 체크^)
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/2] 가상환경 생성 중...
  %PY% -m venv .venv || ( echo 가상환경 생성 실패 & pause & exit /b 1 )
)
".venv\Scripts\python.exe" -c "import win32com.client" >nul 2>nul
if errorlevel 1 (
  echo [2/2] pywin32 설치 중...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r python\requirements.txt || ( echo pywin32 설치 실패 - 사내망이면 pip 프록시 설정이 필요할 수 있습니다 & pause & exit /b 1 )
)

".venv\Scripts\python.exe" python\mailpreview.py
pause
