# -*- coding: utf-8 -*-
"""
MailPreview (Python 소스 실행판) - HTML 이메일 3단 에디터 (Code | Outlook | Webmail)

exe 없이 소스 그대로 실행합니다. 화면(static/)은 Go 판과 동일합니다.
Outlook(클래식 데스크톱)은 HTML 메일을 Word 엔진으로 그리므로, PC 의 Word(없으면 Outlook 의
WordEditor)를 COM 으로 호출해 HTML -> PDF 로 내보내고, 화면에서 pdf.js 로 표시합니다.

필요: Windows, Python 3.9+, pywin32 (pip install pywin32)
실행: 저장소 루트의 run-python.bat  또는  python python\\mailpreview.py
"""
import base64
import json
import mimetypes
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "static")
IS_WIN = sys.platform.startswith("win")

try:
    import pythoncom
    import win32com.client
except Exception:
    pythoncom = None
    win32com = None

wdExportFormatPDF = 17
wdOpenFormatWebPages = 7
msoEncodingUTF8 = 65001
wdDoNotSaveChanges = 0
olMailItem = 0
olDiscard = 1
olFormatHTML = 2


def data_dir():
    d = os.path.join(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir(), "MailPreview")
    os.makedirs(d, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# COM 은 STA 스레드 하나에서만 다룹니다 (단일 워커로 직렬화)
# ---------------------------------------------------------------------------
COM = ThreadPoolExecutor(max_workers=1, initializer=(pythoncom.CoInitialize if pythoncom else None))


class Engines:
    word = None
    print_bg = None  # Word 옵션 원래 값 (종료 시 복구)

    @classmethod
    def get_word(cls):
        if cls.word is not None:
            try:
                _ = cls.word.Version
                return cls.word
            except Exception:
                cls.word = None
        w = win32com.client.DispatchEx("Word.Application")  # 사용 중인 Word 와 분리된 새 인스턴스
        w.Visible = False
        w.DisplayAlerts = 0
        try:
            w.ScreenUpdating = False
        except Exception:
            pass
        try:  # 배경색(body bgcolor)이 PDF 에 나오도록
            cls.print_bg = bool(w.Options.PrintBackgrounds)
            w.Options.PrintBackgrounds = True
        except Exception:
            pass
        cls.word = w
        return w

    @classmethod
    def shutdown(cls):
        if cls.word is not None:
            try:
                if cls.print_bg is not None:
                    cls.word.Options.PrintBackgrounds = cls.print_bg
                cls.word.Quit(wdDoNotSaveChanges)
            except Exception:
                pass
            cls.word = None


def ensure_html_doc(html):
    low = html.lower()
    meta = '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'
    if "charset" in low[:2000]:
        return html
    for tag, wrap in (("<head", False), ("<html", True)):
        i = low.find(tag)
        if i >= 0:
            j = html.find(">", i)
            if j >= 0:
                ins = "<head>" + meta + "</head>" if wrap else meta
                return html[: j + 1] + ins + html[j + 1:]
    return "<html><head>" + meta + "</head><body>" + html + "</body></html>"


def apply_page(doc, width_px):
    ps = doc.PageSetup
    margin = 7.5
    try:
        ps.PageWidth = width_px * 0.75 + margin * 2  # 96dpi px -> pt
        ps.PageHeight = 1584  # Word 최대 22in
        ps.LeftMargin = ps.RightMargin = ps.TopMargin = ps.BottomMargin = margin
    except Exception:
        pass


def export_pdf(doc, pdf_path):
    doc.ExportAsFixedFormat(pdf_path, wdExportFormatPDF, False, 0)


def render_with_word(html_path, pdf_path, width_px):
    word = Engines.get_word()
    # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate,
    #      Revert, WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible)
    doc = word.Documents.Open(html_path, False, True, False, "", "", False, "", "",
                              wdOpenFormatWebPages, msoEncodingUTF8, False)
    try:
        apply_page(doc, width_px)
        export_pdf(doc, pdf_path)
    finally:
        doc.Close(wdDoNotSaveChanges)


def render_with_outlook(html, pdf_path, width_px):
    ol = win32com.client.Dispatch("Outlook.Application")
    mail = ol.CreateItem(olMailItem)
    try:
        mail.BodyFormat = olFormatHTML
        mail.HTMLBody = html
        doc = mail.GetInspector.WordEditor  # 창을 띄우지 않고 Outlook 의 실제 문서 객체 사용
        apply_page(doc, width_px)
        export_pdf(doc, pdf_path)
    finally:
        try:
            mail.Close(olDiscard)
            mail.Delete()
        except Exception:
            pass


def read_complete_pdf(path):
    """Word 가 파일을 완전히 쓸 때까지(%PDF ~ %%EOF) 기다렸다가 읽음."""
    b = b""
    for _ in range(60):
        try:
            with open(path, "rb") as f:
                b = f.read()
            if b.startswith(b"%PDF") and b"%%EOF" in b[-2048:]:
                return b
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError("Word 가 만든 PDF 가 올바르지 않습니다 (%d bytes, head=%r)" % (len(b), b[:16]))


def render_outlook(html, width_px=800, engine="auto"):
    if not IS_WIN or win32com is None:
        raise RuntimeError("Windows + pywin32 환경에서만 Outlook(Word 엔진) 렌더링이 가능합니다.")
    width_px = max(320, min(int(width_px or 800), 1600))
    job = tempfile.mkdtemp(prefix="mailpreview-")
    try:
        html_path = os.path.join(job, "mail.htm")
        pdf_path = os.path.join(job, "mail.pdf")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html)
        order = {"word": ["word"], "outlook": ["outlook"]}.get(engine, ["word", "outlook"])
        errors = []
        for eng in order:
            try:
                if eng == "word":
                    render_with_word(html_path, pdf_path, width_px)
                else:
                    render_with_outlook(html, pdf_path, width_px)
                return read_complete_pdf(pdf_path), eng
            except Exception as e:
                errors.append("%s: %s" % (eng, e))
                if eng == "word":
                    Engines.word = None
        raise RuntimeError("렌더링 실패 - " + " | ".join(errors))
    finally:
        shutil.rmtree(job, ignore_errors=True)


def outlook_mail(html, subject, to="", send=False):
    if not IS_WIN or win32com is None:
        raise RuntimeError("Windows + Outlook 환경에서만 사용할 수 있습니다.")
    ol = win32com.client.Dispatch("Outlook.Application")
    mail = ol.CreateItem(olMailItem)
    mail.BodyFormat = olFormatHTML
    mail.Subject = subject or "MailPreview 테스트"
    if to:
        mail.To = to
    mail.HTMLBody = html
    if send:
        if not to:
            raise RuntimeError("받는 사람 주소가 필요합니다.")
        mail.Send()
    else:
        mail.Display(False)


def status():
    info = {"platform": "win32" if IS_WIN else sys.platform, "com": win32com is not None,
            "word": False, "outlook": False}
    if IS_WIN:
        import winreg
        for key, prog in (("word", "Word.Application"), ("outlook", "Outlook.Application")):
            try:
                winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog + "\\CLSID"))
                info[key] = True
            except OSError:
                pass
    return info


def save_debug(html, pdf, engine, err):
    d = os.path.join(data_dir(), "debug")
    os.makedirs(d, exist_ok=True)
    try:
        with open(os.path.join(d, "last.htm"), "w", encoding="utf-8") as f:
            f.write(html)
        if pdf:
            with open(os.path.join(d, "last.pdf"), "wb") as f:
                f.write(pdf)
    except OSError:
        pass
    print("render engine=%s err=%s pdfBytes=%d head=%r" % (engine, err, len(pdf or b""), (pdf or b"")[:16]))


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json", ".svg": "image/svg+xml", ".bcmap": "application/octet-stream",
        ".pfb": "application/octet-stream", ".ttf": "font/ttf", ".png": "image/png"}


class Handler(BaseHTTPRequestHandler):
    server_version = "MailPreview"

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0].split("#")[0]
        if path == "/api/status":
            return self._json(200, COM.submit(status).result())
        if path.endswith("/"):
            path += "index.html"
        fp = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not fp.startswith(STATIC) or not os.path.isfile(fp):
            self.send_error(404)
            return
        with open(fp, "rb") as f:
            data = f.read()
        ext = os.path.splitext(fp)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext) or mimetypes.guess_type(fp)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        # 다른 웹사이트가 127.0.0.1 로 요청해 Outlook 발송 등을 하지 못하도록 Origin 확인
        origin = self.headers.get("Origin")
        if origin and origin.split("//", 1)[-1] != self.headers.get("Host", ""):
            return self._json(403, {"error": "forbidden origin"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            if self.path == "/api/render/outlook":
                t0 = time.time()
                doc = ensure_html_doc(req.get("html", ""))
                pdf, eng, err = b"", "", None
                try:
                    pdf, eng = COM.submit(render_outlook, doc, req.get("width", 800),
                                          req.get("engine", "auto")).result(timeout=120)
                except Exception as e:
                    err = e
                save_debug(doc, pdf, eng, err)
                if err:
                    raise err
                return self._json(200, {"pdf": base64.b64encode(pdf).decode("ascii"), "engine": eng,
                                        "ms": int((time.time() - t0) * 1000)})
            if self.path in ("/api/outlook/open", "/api/outlook/send"):
                send = self.path.endswith("send")
                COM.submit(outlook_mail, req.get("html", ""), req.get("subject", ""),
                           req.get("to", ""), send).result(timeout=60)
                return self._json(200, {"ok": True, "action": "sent" if send else "displayed"})
            return self._json(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            return self._json(500, {"error": str(e)})


def listen_port():
    for p in list(range(8765, 8785)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return 0


def open_window(url):
    """Edge 앱 모드(주소창 없는 창)로 열고, 실패하면 기본 브라우저."""
    if IS_WIN:
        for exe in (os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
                    os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")):
            if os.path.isfile(exe):
                try:
                    subprocess.Popen([exe, "--app=" + url, "--window-size=1600,950"])
                    return
                except Exception:
                    pass
    webbrowser.open(url)


def main():
    if not os.path.isfile(os.path.join(STATIC, "vendor", "codemirror", "codemirror-bundle.js")):
        print("[경고] static/vendor 가 없습니다. 저장소 전체를 받았는지 확인하세요.")
    port = listen_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:%d/" % port
    print("MailPreview 실행 중: " + url)
    print("종료: 이 창에서 Ctrl+C (또는 창 닫기)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, open_window, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            COM.submit(Engines.shutdown).result(timeout=10)
        except Exception:
            pass
        httpd.server_close()


if __name__ == "__main__":
    main()
