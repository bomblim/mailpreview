@echo off
rem MailPreview.exe 빌드 (Windows). 필요: Go 1.22+, Node.js 18+
setlocal
cd /d "%~dp0"
set GOFLAGS=-mod=mod
call npm install --no-audit --no-fund --no-package-lock || exit /b 1
call npm run vendor || exit /b 1
go run ./tools/mkicon app.ico || exit /b 1
go run github.com/akavel/rsrc@v0.10.2 -arch amd64 -ico app.ico -manifest app.manifest -o rsrc_windows_amd64.syso || exit /b 1
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -trimpath -ldflags "-H windowsgui -s -w" -o dist\MailPreview.exe . || exit /b 1
echo OK -^> dist\MailPreview.exe
