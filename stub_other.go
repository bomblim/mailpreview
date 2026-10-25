//go:build !windows

// Windows 가 아닌 환경(개발/테스트용): 서버만 실행.
// MAILPREVIEW_MOCK=1 이면 LibreOffice 로 PDF 를 만들어 UI 흐름을 시험할 수 있습니다.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func startCOM() {}
func stopCOM()  {}

func fatal(text string) { fmt.Fprintln(os.Stderr, text) }

func runUI(url string) {
	fmt.Println("MailPreview (dev) :", url)
	select {}
}

func comStatus() map[string]any {
	mock := os.Getenv("MAILPREVIEW_MOCK") == "1"
	p := runtime.GOOS
	if mock {
		p = "win32-mock"
	}
	return map[string]any{"platform": p, "com": mock, "word": mock, "outlook": false}
}

func renderOutlook(html string, widthPx int, engine string) ([]byte, string, error) {
	if os.Getenv("MAILPREVIEW_MOCK") != "1" {
		return nil, "", errors.New("Windows 에서만 지원됩니다")
	}
	dir, _ := os.MkdirTemp("", "mp-")
	defer os.RemoveAll(dir)
	in := filepath.Join(dir, "mail.html")
	_ = os.WriteFile(in, []byte(html), 0o644)
	out, err := exec.Command("soffice", "--headless", "--convert-to", "pdf", "--outdir", dir, in).CombinedOutput()
	if err != nil {
		return nil, "", fmt.Errorf("%v %s", err, out)
	}
	b, err := os.ReadFile(filepath.Join(dir, "mail.pdf"))
	return b, "word", err
}

func outlookMail(html, subject, to string, send bool) error {
	return errors.New("Windows 에서만 지원됩니다")
}
