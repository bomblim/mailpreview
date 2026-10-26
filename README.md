# MailPreview — HTML 메일 3단 에디터

HTML 메일 코드를 **Outlook(데스크톱)** 과 **웹메일** 에서 어떻게 보이는지 나란히 확인하는 Windows용 에디터입니다.

```
┌──────────────┬──────────────────┬──────────────────┐
│  HTML 코드    │  Outlook 미리보기 │  웹메일 미리보기   │
│ (CodeMirror) │  (실제 Word 엔진)  │ (Gmail 등 근사)   │
└──────────────┴──────────────────┴──────────────────┘
```

## 사용
`MailPreview.exe` 더블클릭 (설치 불필요). 필요 조건: Windows 10/11, Word 또는 클래식 Outlook, Edge WebView2 런타임(Windows 기본 포함).

## 동작 원리
- **Outlook 패널**: Outlook 데스크톱은 HTML 메일을 Word 렌더링 엔진으로 그립니다. 숨겨진 별도 Word 인스턴스를 COM 으로 호출해 HTML → PDF 로 내보내고, pdf.js 로 표시합니다. Word 가 없으면 Outlook 메일 초안의 `WordEditor` 로 렌더합니다. `<!--[if mso]>` 조건부 주석과 VML 도 실제처럼 처리됩니다.
- **웹메일 패널**: Gmail / Outlook.com / 엄격(인라인 CSS만) / 브라우저 원본 모드로 필터링을 근사합니다. 데스크톱·모바일(390px) 전환.
- **호환성 검사**: Outlook 미지원 CSS 와 웹메일 제거 대상을 줄 번호와 함께 표시.
- **Outlook에서 열기 / 테스트 발송**: 클래식 Outlook 으로 새 메일 창 열기 또는 실제 발송.
- 기타: 제목 영역 표시 토글, 분할선 드래그, 자동 임시저장, `Ctrl+S` 원본 파일 저장, EUC-KR 파일 열기.

> "새 Outlook for Windows" 는 COM 자동화를 지원하지 않습니다. Word 가 설치되어 있으면 미리보기는 동작하지만, 열기·발송에는 클래식 Outlook 이 필요합니다.

## 다운로드
[Actions](../../actions) 탭의 최신 `build` 실행 → Artifacts 의 **MailPreview** 에서 exe 를 받을 수 있습니다.
[Releases](../../releases) 에서 버전별 exe 를 받을 수 있습니다.

### 새 버전 릴리스
`VERSION` 파일의 버전을 올려 main 에 push 하면, Actions 가 빌드 후 `v<버전>` 태그와 Release 를 만들고 exe 를 첨부합니다. (`v*` 태그를 직접 push 해도 됩니다.)

## 빌드
필요: Go 1.22+, Node.js 18+ (CGO 불필요 · Linux/macOS 에서 Windows exe 크로스 빌드 가능)

```sh
sh build.sh        # Windows 에서는 build.cmd
# -> dist/MailPreview.exe
```

빌드 스크립트가 하는 일:
1. `npm install && npm run vendor` — CodeMirror 5, pdf.js 를 `static/vendor/` 로 복사 (exe 에 embed 되어 오프라인 동작)
2. `go run ./tools/mkicon` — 아이콘(`app.ico`) 생성
3. `rsrc` — 아이콘 + DPI 인식 매니페스트를 `rsrc_windows_amd64.syso` 로
4. `go build -ldflags "-H windowsgui"` — 단일 exe

개발 모드 (Windows 외 환경, 서버만 실행): `npm install && npm run vendor && go run .` → http://127.0.0.1:8765
`MAILPREVIEW_MOCK=1` 이면 LibreOffice(soffice)로 Outlook 패널 흐름을 시험할 수 있습니다.

## 구성
```
main.go             로컬 HTTP 서버 + API
com_windows.go      Word / Outlook COM 렌더러 (go-ole)
ui_windows.go       WebView2 창 (go-webview2)
stub_other.go       비 Windows 개발용 스텁
static/             프론트엔드 (index.html, sample.html; vendor/ 는 빌드 시 생성)
tools/mkicon/       아이콘 생성기
scripts/vendor.mjs  서드파티 프론트엔드 라이브러리 복사
.github/workflows/  exe 자동 빌드 (Artifacts / Releases)
```

로그: `%LOCALAPPDATA%\MailPreview\mailpreview.log`

## 라이선스 (포함된 서드파티)
CodeMirror 5 (MIT), pdf.js (Apache-2.0), go-webview2 (MIT), go-ole (MIT)
