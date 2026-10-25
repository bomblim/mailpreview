#!/usr/bin/env sh
# MailPreview.exe 빌드 (Linux / macOS / Git Bash). 필요: Go 1.22+, Node.js 18+
set -e
cd "$(dirname "$0")"
export GOFLAGS=-mod=mod  # go.sum 에 없는 체크섬은 sum.golang.org 로 검증 후 추가
npm install --no-audit --no-fund --no-package-lock
npm run vendor
go run ./tools/mkicon app.ico
go run github.com/akavel/rsrc@v0.10.2 -arch amd64 -ico app.ico -manifest app.manifest -o rsrc_windows_amd64.syso
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o dist/MailPreview.exe .
echo "OK -> dist/MailPreview.exe"
