//go:build windows

package main

import (
	"log"
	"os/exec"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

var (
	user32           = windows.NewLazySystemDLL("user32.dll")
	getSystemMetrics = user32.NewProc("GetSystemMetrics")
	messageBoxW      = user32.NewProc("MessageBoxW")
	showWindow       = user32.NewProc("ShowWindow")
)

func screenSize() (int, int) {
	w, _, _ := getSystemMetrics.Call(16) // SM_CXFULLSCREEN (작업 영역)
	h, _, _ := getSystemMetrics.Call(17)
	return int(w), int(h)
}

func msgBox(text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString("MailPreview")
	r, _, _ := messageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
	return int(r)
}

func fatal(text string) { msgBox(text, 0x10) } // MB_ICONERROR

func runUI(url string) {
	sw, sh := screenSize()
	w, h := 1600, 960
	if sw > 0 && w > sw {
		w = sw
	}
	if sh > 0 && h > sh {
		h = sh
	}
	wv := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     true, // 우클릭 메뉴(복사/붙여넣기)와 F12 개발자도구 사용
		AutoFocus: true,
		DataPath:  dataDir(),
		WindowOptions: webview2.WindowOptions{
			Title:  "MailPreview - HTML 메일 에디터 (Outlook / 웹메일)",
			Width:  uint(w),
			Height: uint(h),
			IconId: 2, // rsrc: manifest=1, icon group=2
			Center: true,
		},
	})
	if wv == nil {
		// WebView2 런타임이 없는 경우: 기본 브라우저로 열고 대화상자를 닫을 때까지 서버 유지
		log.Println("WebView2 unavailable, falling back to browser")
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		msgBox("Microsoft Edge WebView2 런타임을 찾을 수 없어 기본 브라우저에서 열었습니다.\n\n"+
			"주소: "+url+"\n\n이 창의 [확인]을 누르면 MailPreview 가 종료됩니다.", 0x40)
		return
	}
	defer wv.Destroy()
	if sw > 0 && sh > 0 && (sw < 1700 || sh < 1000) {
		showWindow.Call(uintptr(wv.Window()), 3) // 작은 화면이면 최대화
	}
	wv.Navigate(url)
	wv.Run()
}
