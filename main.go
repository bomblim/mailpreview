// MailPreview - HTML 이메일 3단 에디터 (Code | Outlook | Webmail)
//
// Outlook(클래식 데스크톱)은 HTML 메일을 Word 렌더링 엔진으로 그립니다.
// 이 프로그램은 PC 에 설치된 Word(없으면 Outlook 의 WordEditor)를 COM 으로 호출해
// HTML 을 실제 Word 엔진으로 렌더링 -> PDF 로 내보내고, 화면에서 pdf.js 로 표시합니다.
package main

import (
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed static
var staticFS embed.FS

type renderReq struct {
	HTML    string `json:"html"`
	Width   int    `json:"width"`
	Engine  string `json:"engine"`
	Subject string `json:"subject"`
	To      string `json:"to"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// 다른 웹사이트가 127.0.0.1 로 요청을 보내 Outlook 발송 등을 하지 못하도록 Origin 확인
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	if i := strings.Index(o, "//"); i >= 0 {
		o = o[i+2:]
	}
	return o == r.Host
}

func apiHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/status" {
		writeJSON(w, 200, comStatus())
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "forbidden origin"})
		return
	}
	var req renderReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad request: " + err.Error()})
		return
	}
	switch r.URL.Path {
	case "/api/render/outlook":
		t0 := time.Now()
		if req.Width == 0 {
			req.Width = 800
		}
		doc := ensureHTMLDoc(req.HTML)
		pdf, engine, err := renderOutlook(doc, req.Width, req.Engine)
		saveDebug(doc, pdf, engine, err)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{
			"pdf":    base64.StdEncoding.EncodeToString(pdf),
			"engine": engine,
			"ms":     time.Since(t0).Milliseconds(),
		})
	case "/api/outlook/open":
		if err := outlookMail(req.HTML, req.Subject, req.To, false); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "action": "displayed"})
	case "/api/outlook/send":
		if strings.TrimSpace(req.To) == "" {
			writeJSON(w, 400, map[string]string{"error": "받는 사람 주소가 필요합니다."})
			return
		}
		if err := outlookMail(req.HTML, req.Subject, req.To, true); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "action": "sent"})
	default:
		writeJSON(w, 404, map[string]string{"error": "not found"})
	}
}

// Word 가 UTF-8 로 읽도록 charset meta 보장
func ensureHTMLDoc(html string) string {
	low := strings.ToLower(html)
	meta := `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`
	head := low
	if len(head) > 2000 {
		head = head[:2000]
	}
	if strings.Contains(head, "charset") {
		return html
	}
	if i := strings.Index(low, "<head"); i >= 0 {
		if j := strings.Index(html[i:], ">"); j >= 0 {
			return html[:i+j+1] + meta + html[i+j+1:]
		}
	}
	if i := strings.Index(low, "<html"); i >= 0 {
		if j := strings.Index(html[i:], ">"); j >= 0 {
			return html[:i+j+1] + "<head>" + meta + "</head>" + html[i+j+1:]
		}
	}
	return "<html><head>" + meta + "</head><body>" + html + "</body></html>"
}

// 마지막 렌더 입력/결과를 %LOCALAPPDATA%\MailPreview\debug 에 남겨 문제 진단에 사용
func saveDebug(html string, pdf []byte, engine string, err error) {
	d := filepath.Join(dataDir(), "debug")
	_ = os.MkdirAll(d, 0o755)
	_ = os.WriteFile(filepath.Join(d, "last.htm"), []byte(html), 0o644)
	if len(pdf) > 0 {
		_ = os.WriteFile(filepath.Join(d, "last.pdf"), pdf, 0o644)
	}
	head := pdf
	if len(head) > 16 {
		head = head[:16]
	}
	log.Printf("render engine=%s err=%v pdfBytes=%d head=%q", engine, err, len(pdf), head)
}

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	d := filepath.Join(base, "MailPreview")
	_ = os.MkdirAll(d, 0o755)
	return d
}

func listen() (net.Listener, error) {
	// 고정 포트를 우선 사용 (브라우저 저장소 = 임시저장 원고가 포트별로 분리되므로)
	for p := 8765; p < 8785; p++ {
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			return l, nil
		}
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

func main() {
	if f, err := os.OpenFile(filepath.Join(dataDir(), "mailpreview.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644); err == nil {
		log.SetOutput(f)
		defer f.Close()
	}
	startCOM()
	defer stopCOM()

	// Windows 는 레지스트리의 MIME 설정을 따르므로(.js -> text/plain 인 PC 가 있음) 명시적으로 고정
	for ext, typ := range map[string]string{
		".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
		".json": "application/json", ".bcmap": "application/octet-stream",
		".pfb": "application/octet-stream", ".ttf": "font/ttf", ".svg": "image/svg+xml",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}

	sub, _ := fs.Sub(staticFS, "static")
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", apiHandler)
	files := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})

	l, err := listen()
	if err != nil {
		fatal("로컬 서버를 시작할 수 없습니다: " + err.Error())
		return
	}
	url := "http://" + l.Addr().String() + "/"
	log.Println("listening", url)
	go func() { _ = http.Serve(l, mux) }()

	runUI(url) // 창이 닫히면 반환
}
