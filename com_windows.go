//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
	"golang.org/x/sys/windows/registry"
)

const (
	wdExportFormatPDF    = 17
	wdOpenFormatWebPages = 7
	msoEncodingUTF8      = 65001
	wdDoNotSaveChanges   = 0
	olMailItem           = 0
	olDiscard            = 1
	olFormatHTML         = 2
)

// COM 은 STA 스레드 하나에서만 다룹니다. 모든 작업을 이 고루틴으로 직렬화.
var comJobs = make(chan func(), 16)

var (
	word             *ole.IDispatch
	origPrintBgSaved bool
	origPrintBgValue bool
)

func startCOM() {
	ready := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
			log.Println("CoInitializeEx:", err)
		}
		close(ready)
		for job := range comJobs {
			job()
		}
		ole.CoUninitialize()
	}()
	<-ready
}

func onCOM(f func() error) (err error) {
	done := make(chan error, 1)
	comJobs <- func() {
		defer func() {
			if r := recover(); r != nil {
				done <- fmt.Errorf("COM 오류: %v", r)
			}
		}()
		done <- f()
	}
	return <-done
}

func stopCOM() {
	_ = onCOM(func() error {
		if word != nil {
			if origPrintBgSaved {
				if opt, err := oleutil.GetProperty(word, "Options"); err == nil {
					_, _ = oleutil.PutProperty(opt.ToIDispatch(), "PrintBackgrounds", origPrintBgValue)
					opt.ToIDispatch().Release()
				}
			}
			_, _ = oleutil.CallMethod(word, "Quit", wdDoNotSaveChanges)
			word.Release()
			word = nil
		}
		return nil
	})
}

func createDispatch(progID string) (*ole.IDispatch, error) {
	unk, err := oleutil.CreateObject(progID)
	if err != nil {
		return nil, err
	}
	defer unk.Release()
	return unk.QueryInterface(ole.IID_IDispatch)
}

func getWord() (*ole.IDispatch, error) {
	if word != nil {
		if _, err := oleutil.GetProperty(word, "Version"); err == nil {
			return word, nil
		}
		word.Release()
		word = nil
	}
	w, err := createDispatch("Word.Application") // 사용자가 쓰는 Word 와 분리된 새 인스턴스
	if err != nil {
		return nil, err
	}
	_, _ = oleutil.PutProperty(w, "Visible", false)
	_, _ = oleutil.PutProperty(w, "DisplayAlerts", 0)
	_, _ = oleutil.PutProperty(w, "ScreenUpdating", false)
	// 배경색(body bgcolor)이 PDF 에 나오도록 - 종료 시 원래 값으로 복구
	if opt, err := oleutil.GetProperty(w, "Options"); err == nil {
		od := opt.ToIDispatch()
		if v, err := oleutil.GetProperty(od, "PrintBackgrounds"); err == nil {
			if b, ok := v.Value().(bool); ok {
				origPrintBgValue, origPrintBgSaved = b, true
			}
		}
		_, _ = oleutil.PutProperty(od, "PrintBackgrounds", true)
		od.Release()
	}
	word = w
	return w, nil
}

func applyPage(doc *ole.IDispatch, widthPx int) {
	v, err := oleutil.GetProperty(doc, "PageSetup")
	if err != nil {
		return
	}
	ps := v.ToIDispatch()
	defer ps.Release()
	pt := float64(widthPx) * 0.75 // 96dpi px -> pt
	margin := 7.5
	_, _ = oleutil.PutProperty(ps, "PageWidth", pt+margin*2)
	_, _ = oleutil.PutProperty(ps, "PageHeight", 1584.0) // Word 최대 22in
	for _, k := range []string{"LeftMargin", "RightMargin", "TopMargin", "BottomMargin"} {
		_, _ = oleutil.PutProperty(ps, k, margin)
	}
}

func exportPDF(doc *ole.IDispatch, pdfPath string) error {
	_, err := oleutil.CallMethod(doc, "ExportAsFixedFormat", pdfPath, wdExportFormatPDF, false, 0)
	return err
}

func renderWithWord(htmlPath, pdfPath string, widthPx int) error {
	w, err := getWord()
	if err != nil {
		return err
	}
	dv, err := oleutil.GetProperty(w, "Documents")
	if err != nil {
		word = nil
		return err
	}
	docs := dv.ToIDispatch()
	defer docs.Release()
	// Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate,
	//      Revert, WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible)
	r, err := oleutil.CallMethod(docs, "Open", htmlPath, false, true, false, "", "", false, "", "",
		wdOpenFormatWebPages, msoEncodingUTF8, false)
	if err != nil {
		return err
	}
	doc := r.ToIDispatch()
	defer func() {
		_, _ = oleutil.CallMethod(doc, "Close", wdDoNotSaveChanges)
		doc.Release()
	}()
	applyPage(doc, widthPx)
	return exportPDF(doc, pdfPath)
}

func renderWithOutlook(html, pdfPath string, widthPx int) error {
	ol, err := createDispatch("Outlook.Application")
	if err != nil {
		return err
	}
	defer ol.Release()
	mv, err := oleutil.CallMethod(ol, "CreateItem", olMailItem)
	if err != nil {
		return err
	}
	mail := mv.ToIDispatch()
	defer func() {
		_, _ = oleutil.CallMethod(mail, "Close", olDiscard)
		_, _ = oleutil.CallMethod(mail, "Delete")
		mail.Release()
	}()
	_, _ = oleutil.PutProperty(mail, "BodyFormat", olFormatHTML)
	if _, err := oleutil.PutProperty(mail, "HTMLBody", html); err != nil {
		return err
	}
	iv, err := oleutil.GetProperty(mail, "GetInspector") // 창을 띄우지 않고 Inspector 생성
	if err != nil {
		return err
	}
	insp := iv.ToIDispatch()
	defer insp.Release()
	dv, err := oleutil.GetProperty(insp, "WordEditor")
	if err != nil {
		return err
	}
	doc := dv.ToIDispatch()
	defer doc.Release()
	applyPage(doc, widthPx)
	return exportPDF(doc, pdfPath)
}

func renderOutlook(html string, widthPx int, engine string) ([]byte, string, error) {
	if widthPx < 320 {
		widthPx = 320
	}
	if widthPx > 1600 {
		widthPx = 1600
	}
	dir, err := os.MkdirTemp("", "mailpreview-")
	if err != nil {
		return nil, "", err
	}
	defer os.RemoveAll(dir)
	htmlPath := filepath.Join(dir, "mail.htm")
	pdfPath := filepath.Join(dir, "mail.pdf")
	if err := os.WriteFile(htmlPath, []byte(html), 0o644); err != nil {
		return nil, "", err
	}
	order := []string{"word", "outlook"}
	switch engine {
	case "word":
		order = []string{"word"}
	case "outlook":
		order = []string{"outlook"}
	}
	var errs []string
	used := ""
	for _, eng := range order {
		e := onCOM(func() error {
			if eng == "word" {
				return renderWithWord(htmlPath, pdfPath, widthPx)
			}
			return renderWithOutlook(html, pdfPath, widthPx)
		})
		if e == nil {
			used = eng
			break
		}
		log.Println("render", eng, e)
		errs = append(errs, eng+": "+e.Error())
		if eng == "word" {
			_ = onCOM(func() error { // 다음 요청에서 Word 를 새로 띄우도록
				if word != nil {
					word.Release()
					word = nil
				}
				return nil
			})
		}
	}
	if used == "" {
		return nil, "", errors.New("렌더링 실패 - " + strings.Join(errs, " | "))
	}
	b, err := readCompletePDF(pdfPath)
	return b, used, err
}

// Word 가 파일을 완전히 쓸 때까지(%PDF 헤더 + %%EOF) 잠시 기다렸다가 읽음
func readCompletePDF(p string) ([]byte, error) {
	var b []byte
	var err error
	for i := 0; i < 60; i++ {
		b, err = os.ReadFile(p)
		if err == nil && bytes.HasPrefix(b, []byte("%PDF")) {
			tail := b
			if len(tail) > 2048 {
				tail = tail[len(tail)-2048:]
			}
			if bytes.Contains(tail, []byte("%%EOF")) {
				return b, nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return nil, err
	}
	head := b
	if len(head) > 16 {
		head = head[:16]
	}
	return nil, fmt.Errorf("Word 가 만든 PDF 가 올바르지 않습니다 (%d bytes, head=%q)", len(b), head)
}

func outlookMail(html, subject, to string, send bool) error {
	return onCOM(func() error {
		ol, err := createDispatch("Outlook.Application")
		if err != nil {
			return fmt.Errorf("Outlook 을 시작할 수 없습니다: %w", err)
		}
		defer ol.Release()
		mv, err := oleutil.CallMethod(ol, "CreateItem", olMailItem)
		if err != nil {
			return err
		}
		mail := mv.ToIDispatch()
		defer mail.Release()
		if subject == "" {
			subject = "MailPreview 테스트"
		}
		_, _ = oleutil.PutProperty(mail, "BodyFormat", olFormatHTML)
		_, _ = oleutil.PutProperty(mail, "Subject", subject)
		if to != "" {
			_, _ = oleutil.PutProperty(mail, "To", to)
		}
		if _, err := oleutil.PutProperty(mail, "HTMLBody", html); err != nil {
			return err
		}
		if send {
			_, err = oleutil.CallMethod(mail, "Send")
			return err
		}
		_, err = oleutil.CallMethod(mail, "Display", false)
		return err
	})
}

func progIDExists(progID string) bool {
	k, err := registry.OpenKey(registry.CLASSES_ROOT, progID+`\CLSID`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

func comStatus() map[string]any {
	return map[string]any{
		"platform": "win32",
		"com":      true,
		"word":     progIDExists("Word.Application"),
		"outlook":  progIDExists("Outlook.Application"),
	}
}
