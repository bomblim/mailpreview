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

## 소스 코드로 실행 (exe 없이)
보안 정책상 exe 실행이 어려우면 Python 으로 소스를 그대로 실행할 수 있습니다. 화면과 기능은 exe 와 같습니다.

1. Python 3.9+ 설치 ([python.org](https://www.python.org/downloads/), 설치 시 *Add python.exe to PATH* 체크)
2. 이 저장소 받기: GitHub 의 **Code → Download ZIP** 후 압축 해제 (또는 `git clone`)
3. 폴더의 **`run-python.bat`** 더블클릭
   - 처음 한 번 `.venv` 가상환경을 만들고 `pywin32` 를 설치합니다
   - Edge 앱 창으로 에디터가 열립니다 (http://127.0.0.1:8765)

직접 실행: `pip install pywin32` 후 `python python\mailpreview.py`

## 템플릿 + 데이터셋 바인딩 (FreeMarker)
툴바의 **템플릿** 에서 엔진을 고르면 코드 창에 탭이 생깁니다.

| 탭 | 내용 |
|---|---|
| 템플릿 (FTL) | FreeMarker 템플릿 (`.ftl` / `.ftlh` 를 열면 자동 전환) |
| 데이터셋 JSON | 템플릿에 바인딩할 데이터. 최상위는 `{ }` 객체 (`.json` 을 열면 이 탭으로) |
| 결과 HTML | 바인딩된 HTML (읽기 전용). Outlook·웹메일 미리보기, 호환성 검사, 테스트 발송은 모두 이 결과로 동작 |

- 입력하는 즉시 바인딩되어 두 미리보기에 반영됩니다. 오류가 나면 상단 빨간 줄에 **위치(줄:칸)와 원인**이 표시되고, 미리보기는 마지막 정상 결과를 유지합니다.
- 실제 FreeMarker 처럼 엄격합니다: 데이터셋에 없는 값을 쓰면 오류 (`${x!"기본값"}`, `<#if x??>` 로 처리), `<#if>` 에는 boolean 만, boolean 은 `?c` / `?string("예","아니오")` 로 출력.
- **변수 채우기**(데이터셋 탭): 템플릿에서 쓰는 최상위 변수 중 데이터셋에 없는 것을 빈 값으로 추가합니다.
- **이스케이프**: `.ftlh` 처럼 `${}` 출력을 HTML 이스케이프 (`?no_esc` 로 해제).
- 샘플 → **시스템 알림 (FTL+JSON)** 으로 예제를 볼 수 있습니다.

지원 문법 (FreeMarker 2.3.x 기준): `${}`·문자열 안 `${}`, `<#if>/<#elseif>/<#else>`, `<#list>`(`<#else>`, `<#sep>`, `<#items>`, `<#break>`), `<#assign>/<#global>/<#local>`(블록 캡처 포함), `<#switch>/<#case>/<#default>`, `<#macro>/<#nested>/<#return>` + `<@매크로/>`, `<#attempt>/<#recover>`, `<#compress>`, `<#noparse>`, `<#setting>`, 연산자 `! ?? .. == != < > lt gt && || + - * / %`, 주요 내장함수(문자열·숫자·날짜·시퀀스·해시·루프 변수), 공백 제거(white-space stripping).
미지원: `<#include>/<#import>`(템플릿 안에 직접 작성), `<#function>`, 람다(`?filter`, `?map`).

엔진은 `static/engines/` 에 `window.TemplateEngines[id] = { render(tpl, data, opts) }` 형태로 등록되며, Jinja2·Velocity 도 같은 방식으로 추가할 예정입니다. 엔진 테스트: `node tests/freemarker.test.js`

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
1. `npm install && npm run vendor` — CodeMirror 5, pdf.js 를 `static/vendor/` 로 갱신 (exe 에 embed 되어 오프라인 동작)
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
python/             소스 실행판 서버 (mailpreview.py, pywin32)
run-python.bat      소스 실행판 실행기
static/             프론트엔드 (index.html, sample.html, vendor/ = CodeMirror·pdf.js)
static/engines/     템플릿 엔진 (freemarker.js)
static/samples/     템플릿 + 데이터셋 샘플
tests/              엔진 테스트 (node)
tools/mkicon/       아이콘 생성기
scripts/vendor.mjs  서드파티 프론트엔드 라이브러리 복사
.github/workflows/  exe 자동 빌드 (Artifacts / Releases)
```

로그: `%LOCALAPPDATA%\MailPreview\mailpreview.log` · 마지막 렌더 입력/결과: `%LOCALAPPDATA%\MailPreview\debug\last.htm, last.pdf`

## 라이선스 (포함된 서드파티)
CodeMirror 5 (MIT), pdf.js (Apache-2.0), go-webview2 (MIT), go-ole (MIT)
