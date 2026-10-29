/*
 * MailPreview - FreeMarker(FTL) 템플릿 엔진 (브라우저용 경량 구현)
 *
 * 메일 템플릿에서 주로 쓰는 FreeMarker 2.3.x 문법을 실제 엔진과 같은 규칙으로 처리합니다.
 *  - ${expr}, 문자열 안의 ${...}, 주석 <#-- -->, <#noparse>
 *  - <#if>/<#elseif>/<#else>, <#list ... as x>(<#else>, <#sep>, <#items>), <#break>
 *  - <#assign>/<#global>/<#local> (=, +=, -=, ++, --, 블록 캡처), <#switch>/<#case>/<#default>
 *  - <#macro>/<#nested>/<#return> + <@name a=1/> 호출, <#attempt>/<#recover>, <#compress>
 *  - <#setting number_format|boolean_format|date_format|datetime_format|time_format>
 *  - 연산자: ! (기본값)  ?? (존재)  ..  ==  !=  <  >  <=  >=  gt gte lt lte  &&  ||  + - * / %
 *  - 내장함수(?builtin): 문자열/숫자/불리언/시퀀스/해시/날짜/루프 변수 주요 함수
 *  - 공백 제거(white-space stripping): FTL 태그만 있는 줄은 출력에서 제거
 *  - 엄격 모드: 없는 값 사용, if 에 boolean 이 아닌 값 등은 실제 FreeMarker 처럼 오류
 *
 * 사용: TemplateEngines.freemarker.render(templateText, dataObject, { autoEscape:false })
 *       -> 문자열 (오류 시 Error{ line, col, message } throw)
 */
(function (global) {
  "use strict";

  // ------------------------------------------------------------------ 오류
  class FtlError extends Error {
    constructor(message, pos) { super(message); this.pos = pos; this.ftl = true; }
  }
  class MissingError extends FtlError {}
  class BreakSignal { }
  class ReturnSignal { }

  function lineCol(src, pos) {
    let line = 1, col = 1;
    for (let i = 0; i < pos && i < src.length; i++) {
      if (src.charCodeAt(i) === 10) { line++; col = 1; } else col++;
    }
    return { line, col };
  }

  // ------------------------------------------------------------------ 특수 값
  const EMPTY = Object.freeze({ __ftlEmpty: true });        // 'x!' 처럼 기본값 없이 쓴 경우 (빈 문자열/시퀀스/해시)
  const isEmptyDefault = v => v === EMPTY;
  class Markup { constructor(s) { this.s = s; } }           // ?no_esc 결과
  class FDate { constructor(d, kind) { this.d = d; this.kind = kind; } } // kind: date|datetime|time
  class Range { constructor(a, b) { this.a = a; this.b = b; } }          // 길이 고정 범위
  const isHash = v => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof FDate) && !(v instanceof Markup) && !(v instanceof Range) && v !== EMPTY;
  const norm = v => (v === null ? undefined : v);

  function typeName(v) {
    if (v === undefined) return "값 없음(missing)";
    if (v === EMPTY) return "빈 기본값";
    if (typeof v === "string" || v instanceof Markup) return "문자열";
    if (typeof v === "number") return "숫자";
    if (typeof v === "boolean") return "boolean";
    if (Array.isArray(v) || v instanceof Range) return "시퀀스";
    if (v instanceof FDate) return v.kind === "date" ? "날짜" : v.kind === "time" ? "시간" : "날짜시간";
    if (typeof v === "function") return "메서드";
    return "해시";
  }

  // ------------------------------------------------------------------ 템플릿 스캐너
  // 문자열/괄호를 고려해 닫는 문자 위치를 찾음
  function skipString(src, i) {
    const q = src[i];
    let j = i + 1;
    const raw = i > 0 && src[i - 1] === "r" && !/[\w$@]/.test(src[i - 2] || "");
    while (j < src.length) {
      const c = src[j];
      if (!raw && c === "\\") { j += 2; continue; }
      if (c === q) return j + 1;
      j++;
    }
    throw new FtlError("문자열이 닫히지 않았습니다 (" + q + ")", i);
  }
  function scanInterpEnd(src, i, openPos) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'") { i = skipString(src, i); continue; }
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "}") { if (depth === 0) return i; depth--; }
      i++;
    }
    throw new FtlError("${ 가 닫히지 않았습니다 (}).", openPos);
  }
  function scanTagEnd(src, i, openPos) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'") { i = skipString(src, i); continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth <= 0) {
        if (c === ">") return { end: i, self: false };
        if (c === "/" && src[i + 1] === ">") return { end: i, self: true };
      }
      i++;
    }
    throw new FtlError("태그가 닫히지 않았습니다 (>).", openPos);
  }

  function scanTemplate(src) {
    const toks = [];
    const n = src.length;
    let i = 0, textStart = 0;
    const pushText = (a, b) => { if (b > a) toks.push({ t: "text", s: a, e: b }); };
    while (i < n) {
      const c = src[i];
      if (c === "$" && src[i + 1] === "{") {
        pushText(textStart, i);
        const end = scanInterpEnd(src, i + 2, i);
        toks.push({ t: "interp", s: i, e: end + 1, ps: i + 2, pe: end });
        i = end + 1; textStart = i; continue;
      }
      if (c === "<") {
        if (src.startsWith("<#--", i)) {
          const e = src.indexOf("-->", i + 4);
          if (e < 0) throw new FtlError("FTL 주석이 닫히지 않았습니다 (-->).", i);
          pushText(textStart, i);
          toks.push({ t: "comment", s: i, e: e + 3 });
          i = e + 3; textStart = i; continue;
        }
        let m;
        if ((m = /^<#([a-zA-Z_]+)/.exec(src.slice(i, i + 40)))) {
          pushText(textStart, i);
          const name = m[1];
          if (name === "noparse") {
            const open = scanTagEnd(src, i + m[0].length, i);
            const close = src.indexOf("</#noparse>", open.end + 1);
            if (close < 0) throw new FtlError("<#noparse> 가 닫히지 않았습니다.", i);
            toks.push({ t: "raw", s: i, e: close + 11, text: src.slice(open.end + 1, close) });
            i = close + 11; textStart = i; continue;
          }
          const ps = i + m[0].length;
          const r = scanTagEnd(src, ps, i);
          toks.push({ t: "dir", name, s: i, e: r.end + (r.self ? 2 : 1), ps, pe: r.end, self: r.self });
          i = r.end + (r.self ? 2 : 1); textStart = i; continue;
        }
        if ((m = /^<\/#([a-zA-Z_]+)\s*>/.exec(src.slice(i, i + 40)))) {
          pushText(textStart, i);
          toks.push({ t: "end", name: m[1], s: i, e: i + m[0].length });
          i += m[0].length; textStart = i; continue;
        }
        if ((m = /^<@([a-zA-Z_][\w.]*)/.exec(src.slice(i, i + 80)))) {
          pushText(textStart, i);
          const ps = i + m[0].length;
          const r = scanTagEnd(src, ps, i);
          toks.push({ t: "call", name: m[1], s: i, e: r.end + (r.self ? 2 : 1), ps, pe: r.end, self: r.self });
          i = r.end + (r.self ? 2 : 1); textStart = i; continue;
        }
        if ((m = /^<\/@([a-zA-Z_][\w.]*)?\s*>/.exec(src.slice(i, i + 80)))) {
          pushText(textStart, i);
          toks.push({ t: "endcall", name: m[1] || "", s: i, e: i + m[0].length });
          i += m[0].length; textStart = i; continue;
        }
      }
      i++;
    }
    pushText(textStart, n);
    return toks;
  }

  // FTL 태그만 있는 줄의 들여쓰기/줄바꿈 제거 (FreeMarker 기본 white-space stripping)
  const TAG_TOKENS = { dir: 1, end: 1, comment: 1, call: 1, endcall: 1 };
  function stripWhitespace(src, toks) {
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const lineOf = pos => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= pos) lo = m; else hi = m - 1; } return lo; };
    const L = lineStarts.length;
    const hasTag = new Uint8Array(L), hasContent = new Uint8Array(L);
    for (const t of toks) {
      if (TAG_TOKENS[t.t]) { const a = lineOf(t.s), b = lineOf(t.e - 1); for (let l = a; l <= b; l++) hasTag[l] = 1; }
      else if (t.t === "interp" || t.t === "raw") { const a = lineOf(t.s), b = lineOf(Math.max(t.s, t.e - 1)); for (let l = a; l <= b; l++) hasContent[l] = 1; }
      else if (t.t === "text") {
        for (let p = t.s; p < t.e; p++) { const ch = src.charCodeAt(p); if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13) hasContent[lineOf(p)] = 1; }
      }
    }
    for (const t of toks) {
      if (t.t !== "text") continue;
      let out = "", l = lineOf(t.s), nextStart = lineStarts[l + 1] ?? Infinity;
      for (let p = t.s; p < t.e; p++) {
        while (p >= nextStart) { l++; nextStart = lineStarts[l + 1] ?? Infinity; }
        if (!(hasTag[l] && !hasContent[l])) out += src[p];
      }
      t.text = out;
    }
  }

  // ------------------------------------------------------------------ 식(expression) 렉서
  const PUNCT = ["..<", "..!", "..*", "??", "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "++", "--", "->", "..",
    "(", ")", "[", "]", "{", "}", ",", ".", "?", "!", "=", "<", ">", "+", "-", "*", "/", "%", ":", ";"];

  function lexExpr(src, s, e) {
    const toks = [];
    let i = s;
    while (i < e) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '"' || c === "'" || ((c === "r") && (src[i + 1] === '"' || src[i + 1] === "'"))) {
        const raw = c === "r";
        const qpos = raw ? i + 1 : i;
        const end = skipString(src, qpos);
        const body = src.slice(qpos + 1, end - 1);
        toks.push({ k: "str", v: raw ? body : unescapeStr(body, qpos + 1), raw, s: i, e: end, bodyStart: qpos + 1 });
        i = end; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i; while (j < e && /[0-9]/.test(src[j])) j++;
        if (src[j] === "." && /[0-9]/.test(src[j + 1] || "")) { j++; while (j < e && /[0-9]/.test(src[j])) j++; }
        toks.push({ k: "num", v: Number(src.slice(i, j)), s: i, e: j });
        i = j; continue;
      }
      if (/[A-Za-z_$@]/.test(c)) {
        let j = i; while (j < e && /[\w$@]/.test(src[j])) j++;
        toks.push({ k: "id", v: src.slice(i, j), s: i, e: j });
        i = j; continue;
      }
      let p = null;
      for (const op of PUNCT) if (src.startsWith(op, i)) { p = op; break; }
      if (!p) throw new FtlError("식에서 알 수 없는 문자: " + c, i);
      toks.push({ k: "op", v: p, s: i, e: i + p.length });
      i += p.length;
    }
    toks.push({ k: "eof", v: null, s: e, e });
    return toks;
  }
  function unescapeStr(s, pos) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,4}|.)/g, (m, g) => {
      switch (g[0]) {
        case "n": return "\n"; case "t": return "\t"; case "r": return "\r"; case "b": return "\b"; case "f": return "\f";
        case "l": return "<"; case "g": return ">"; case "a": return "&";
        case "u": return String.fromCharCode(parseInt(g.slice(1), 16));
        case "x": return String.fromCharCode(parseInt(g.slice(1), 16));
        default: return g; // \" \' \\ \$ \{ 등
      }
    });
  }

  // ------------------------------------------------------------------ 식 파서 (Pratt)
  const BINPREC = {
    "||": 1, "&&": 2,
    "==": 3, "!=": 3, "=": 3,
    "<": 4, ">": 4, "<=": 4, ">=": 4, "lt": 4, "lte": 4, "gt": 4, "gte": 4,
    "..": 5, "..<": 5, "..!": 5, "..*": 5,
    "+": 6, "-": 6,
    "*": 7, "/": 7, "%": 7,
  };
  const WORD_OPS = { lt: "<", lte: "<=", gt: ">", gte: ">=" };
  const NOT_PRIMARY_IDS = { lt: 1, lte: 1, gt: 1, gte: 1, as: 1, using: 1, in: 1 };

  class ExprParser {
    constructor(src, s, e, opts) {
      this.src = src; this.toks = lexExpr(src, s, e); this.i = 0; this.end = e;
      this.noAssignEq = opts && opts.noAssignEq; // '=' 를 비교 연산자로 쓰지 않음 (assign/macro 인자 파싱)
    }
    peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
    next() { return this.toks[this.i++]; }
    atEnd() { return this.peek().k === "eof"; }
    isOp(v, o = 0) { const t = this.peek(o); return t.k === "op" && t.v === v; }
    expectOp(v) { const t = this.next(); if (t.k !== "op" || t.v !== v) throw new FtlError("'" + v + "' 가 필요합니다" + (t.k === "eof" ? "" : " ('" + this.src.slice(t.s, t.e) + "' 대신)"), t.s); return t; }
    ident() { const t = this.next(); if (t.k !== "id") throw new FtlError("이름이 필요합니다", t.s); return t; }
    expectEnd(what) { const t = this.peek(); if (t.k !== "eof") throw new FtlError((what || "식") + " 뒤에 예상하지 못한 내용: '" + this.src.slice(t.s, this.end).trim().slice(0, 30) + "'", t.s); }

    parseExpr(minPrec = 0) {
      let left = this.parseUnary();
      for (;;) {
        const t = this.peek();
        let op = null;
        if (t.k === "op" && BINPREC[t.v] !== undefined) op = t.v;
        else if (t.k === "id" && WORD_OPS[t.v]) op = t.v;
        if (!op) break;
        if (op === "=" && this.noAssignEq) break;
        const prec = BINPREC[op];
        if (prec < minPrec) break;
        this.next();
        if (op.startsWith("..")) {
          // 범위: 오른쪽 생략 가능 (1..)
          const nt = this.peek();
          const canStart = this.canStartPrimary(nt) || (nt.k === "op" && (nt.v === "-" || nt.v === "("));
          const right = canStart ? this.parseExpr(prec + 1) : null;
          left = { type: "range", op, left, right, s: left.s, e: right ? right.e : t.e };
          continue;
        }
        const right = this.parseExpr(prec + 1);
        const nop = WORD_OPS[op] || (op === "=" ? "==" : op);
        left = { type: "bin", op: nop, left, right, s: left.s, e: right.e };
      }
      return left;
    }
    parseUnary() {
      const t = this.peek();
      if (t.k === "op" && (t.v === "!" || t.v === "-" || t.v === "+")) {
        this.next();
        const arg = this.parseUnary();
        return { type: t.v === "!" ? "not" : t.v === "-" ? "neg" : "pos", arg, s: t.s, e: arg.e };
      }
      return this.parsePostfix(this.parsePrimary());
    }
    canStartPrimary(t) {
      if (t.k === "num" || t.k === "str") return true;
      if (t.k === "id") return !NOT_PRIMARY_IDS[t.v];
      if (t.k === "op") return t.v === "(" || t.v === "[" || t.v === "{" || t.v === ".";
      return false;
    }
    parsePrimary() {
      const t = this.next();
      if (t.k === "num") return { type: "lit", v: t.v, s: t.s, e: t.e };
      if (t.k === "str") {
        if (!t.raw && t.v.includes("${")) return { type: "strtpl", parts: this.parseStrTemplate(t), s: t.s, e: t.e };
        return { type: "lit", v: t.v, s: t.s, e: t.e };
      }
      if (t.k === "id") {
        if (t.v === "true") return { type: "lit", v: true, s: t.s, e: t.e };
        if (t.v === "false") return { type: "lit", v: false, s: t.s, e: t.e };
        return { type: "var", name: t.v, s: t.s, e: t.e };
      }
      if (t.k === "op") {
        if (t.v === "(") {
          const inner = this.parseExpr();
          const c = this.expectOp(")");
          return { type: "paren", inner, s: t.s, e: c.e };
        }
        if (t.v === "[") {
          const items = [];
          if (!this.isOp("]")) { do { items.push(this.parseExpr()); } while (this.isOp(",") && this.next()); }
          const c = this.expectOp("]");
          return { type: "seq", items, s: t.s, e: c.e };
        }
        if (t.v === "{") {
          const pairs = [];
          if (!this.isOp("}")) {
            do {
              const k = this.parseExpr();
              this.expectOp(":");
              pairs.push([k, this.parseExpr()]);
            } while (this.isOp(",") && this.next());
          }
          const c = this.expectOp("}");
          return { type: "hash", pairs, s: t.s, e: c.e };
        }
        if (t.v === ".") {
          const id = this.ident();
          return { type: "special", name: id.v, s: t.s, e: id.e };
        }
      }
      if (t.k === "eof") throw new FtlError("식이 필요합니다", t.s);
      throw new FtlError("예상하지 못한 '" + this.src.slice(t.s, t.e) + "'", t.s);
    }
    parsePostfix(node) {
      for (;;) {
        const t = this.peek();
        if (t.k !== "op") break;
        if (t.v === ".") {
          this.next();
          const id = this.next();
          if (id.k !== "id" && id.k !== "num") throw new FtlError("'.' 뒤에 이름이 필요합니다", id.s);
          node = { type: "member", obj: node, name: String(id.v), s: node.s, e: id.e };
        } else if (t.v === "[") {
          this.next();
          const idx = this.parseExpr();
          const c = this.expectOp("]");
          node = { type: "index", obj: node, idx, s: node.s, e: c.e };
        } else if (t.v === "?") {
          this.next();
          const id = this.ident();
          let name = id.v, e = id.e;
          while (this.isOp(".") && this.peek(1).k === "id" && /^(iso|xs|iso_utc|iso_local|xs_nz|iso_nz|currency|percent|number|computer)$/.test(this.peek(1).v)) {
            this.next(); const sub = this.next(); name += "." + sub.v; e = sub.e;
          }
          let args = null;
          if (this.isOp("(")) {
            this.next(); args = [];
            if (!this.isOp(")")) { do { args.push(this.parseExpr()); } while (this.isOp(",") && this.next()); }
            e = this.expectOp(")").e;
          }
          node = { type: "bi", target: node, name, args, s: node.s, e, nameS: id.s };
        } else if (t.v === "??") {
          this.next();
          node = { type: "exists", target: node, s: node.s, e: t.e };
        } else if (t.v === "!" && !(this.peek(1).k === "op" && this.peek(1).v === "=")) {
          this.next();
          const nt = this.peek();
          let def = null;
          if (this.canStartPrimary(nt) && !(nt.k === "op" && nt.v === ".")) def = this.parsePostfix(this.parsePrimary());
          else if (nt.k === "op" && nt.v === "-" && (this.peek(1).k === "num")) { this.next(); const num = this.next(); def = { type: "lit", v: -num.v, s: nt.s, e: num.e }; }
          node = { type: "default", target: node, def, s: node.s, e: def ? def.e : t.e };
        } else break;
      }
      return node;
    }
    // "Hello ${name}!" 형태 문자열 리터럴
    parseStrTemplate(tok) {
      const raw = this.src.slice(tok.bodyStart, tok.e - 1);
      const parts = [];
      let i = 0;
      while (i < raw.length) {
        const k = raw.indexOf("${", i);
        if (k < 0) { parts.push(unescapeStr(raw.slice(i), 0)); break; }
        if (k > 0 && raw[k - 1] === "\\") { parts.push(unescapeStr(raw.slice(i, k - 1), 0) + "${"); i = k + 2; continue; }
        if (k > i) parts.push(unescapeStr(raw.slice(i, k), 0));
        const absStart = tok.bodyStart + k + 2;
        const absEnd = scanInterpEnd(this.src, absStart, tok.bodyStart + k);
        const p = new ExprParser(this.src, absStart, absEnd);
        const ex = p.parseExpr(); p.expectEnd();
        parts.push(ex);
        i = absEnd - tok.bodyStart + 1;
      }
      return parts;
    }
  }
  function parseExpression(src, s, e) {
    const p = new ExprParser(src, s, e);
    if (p.atEnd()) throw new FtlError("식이 비어 있습니다", s);
    const ex = p.parseExpr(); p.expectEnd();
    return ex;
  }

  // ------------------------------------------------------------------ 트리 빌더
  const IGNORED = { ftl: 1, flush: 1, t: 1, lt: 1, rt: 1, nt: 1 };
  const UNSUPPORTED = {
    include: "미리보기에서는 <#include> 를 지원하지 않습니다. 포함할 내용을 템플릿에 직접 넣어 주세요.",
    import: "미리보기에서는 <#import> 를 지원하지 않습니다. 매크로를 템플릿 안에 정의해 주세요.",
    function: "<#function> 은 아직 지원하지 않습니다. <#macro> 를 사용해 주세요.",
    visit: "<#visit> 는 지원하지 않습니다.", recurse: "<#recurse> 는 지원하지 않습니다.",
  };

  function buildTree(src) {
    const toks = scanTemplate(src);
    stripWhitespace(src, toks);
    const root = { type: "root", body: [], macros: {} };
    const stack = [{ name: "#root", node: root, body: root.body, pos: 0 }];
    const top = () => stack[stack.length - 1];
    const push = n => top().body.push(n);
    const popImplicitSep = () => { while (top().implicit) stack.pop(); };
    const open = (name, node, body, tok, extra) => stack.push(Object.assign({ name, node, body, pos: tok.s }, extra || {}));
    const paramParser = (tok, opts) => new ExprParser(src, tok.ps, tok.pe, opts);
    const needNoParams = tok => { if (src.slice(tok.ps, tok.pe).trim()) throw new FtlError("<#" + tok.name + "> 에는 인자가 없습니다", tok.ps); };

    for (const tok of toks) {
      switch (tok.t) {
        case "text": if (tok.text) push({ type: "text", text: tok.text }); break;
        case "raw": push({ type: "text", text: tok.text }); break;
        case "comment": break;
        case "interp": push({ type: "interp", expr: parseExpression(src, tok.ps, tok.pe), s: tok.s, e: tok.e }); break;
        case "dir": handleDir(tok); break;
        case "end": handleEnd(tok); break;
        case "call": {
          const p = paramParser(tok, { noAssignEq: true });
          const args = {}; const positional = [];
          while (!p.atEnd()) {
            if (p.peek().k === "id" && p.isOp("=", 1)) {
              const id = p.next(); p.next();
              args[id.v] = p.parseExpr();
            } else positional.push(p.parseExpr());
            if (p.isOp(",")) p.next();
          }
          const node = { type: "call", name: tok.name, args, positional, body: tok.self ? null : [], s: tok.s, e: tok.e };
          push(node);
          if (!tok.self) open("@" + tok.name, node, node.body, tok);
          break;
        }
        case "endcall": {
          popImplicitSep();
          const t = top();
          if (!t.name.startsWith("@") || (tok.name && t.name !== "@" + tok.name))
            throw new FtlError("</@" + tok.name + "> 와 짝이 맞는 <@" + tok.name + "> 가 없습니다" + openHint(t), tok.s);
          stack.pop();
          break;
        }
      }
    }
    popImplicitSep();
    if (stack.length > 1) {
      const t = top();
      throw new FtlError("<" + (t.name.startsWith("@") ? "" : "#") + t.name + "> 가 닫히지 않았습니다 (</" + (t.name.startsWith("@") ? t.name : "#" + t.name) + "> 필요)", t.pos);
    }
    return root;

    function openHint(t) {
      if (t.name === "#root") return "";
      const lc = lineCol(src, t.pos);
      return " (현재 열린 블록: <" + (t.name.startsWith("@") ? "" : "#") + t.name + "> " + lc.line + "번째 줄)";
    }

    function handleDir(tok) {
      const name = tok.name;
      if (IGNORED[name]) return;
      if (UNSUPPORTED[name]) throw new FtlError(UNSUPPORTED[name], tok.s);
      switch (name) {
        case "if": {
          const node = { type: "if", branches: [{ cond: parseExpression(src, tok.ps, tok.pe), body: [] }], elseBody: null, s: tok.s };
          push(node); open("if", node, node.branches[0].body, tok); return;
        }
        case "elseif": {
          popImplicitSep();
          const t = top();
          if (t.name !== "if" || t.node.elseBody) throw new FtlError("<#elseif> 는 <#if> 안에서만 쓸 수 있습니다" + openHint(t), tok.s);
          const br = { cond: parseExpression(src, tok.ps, tok.pe), body: [] };
          t.node.branches.push(br); t.body = br.body; return;
        }
        case "else": {
          needNoParams(tok);
          popImplicitSep();
          const t = top();
          if ((t.name === "if" || t.name === "list") && !t.node.elseBody) { t.node.elseBody = []; t.body = t.node.elseBody; t.inElse = true; return; }
          throw new FtlError("<#else> 는 <#if> 또는 <#list> 안에서만 쓸 수 있습니다" + openHint(t), tok.s);
        }
        case "list": {
          const p = paramParser(tok);
          const expr = p.parseExpr();
          let vars = null;
          if (!p.atEnd()) {
            const as = p.next();
            if (as.k !== "id" || as.v !== "as") throw new FtlError("<#list 시퀀스 as 변수> 형식이어야 합니다", as.s);
            vars = [p.ident().v];
            if (p.isOp(",")) { p.next(); vars.push(p.ident().v); }
            p.expectEnd("<#list>");
          }
          const node = { type: "list", expr, vars, body: [], elseBody: null, s: tok.s };
          push(node); open("list", node, node.body, tok); return;
        }
        case "items": {
          const t = top();
          if (t.name !== "list" || t.node.vars || t.inElse) throw new FtlError("<#items> 는 'as' 없는 <#list 시퀀스> 안에서만 쓸 수 있습니다", tok.s);
          const p = paramParser(tok);
          const as = p.next();
          if (as.k !== "id" || as.v !== "as") throw new FtlError("<#items as 변수> 형식이어야 합니다", as.s);
          const vars = [p.ident().v];
          if (p.isOp(",")) { p.next(); vars.push(p.ident().v); }
          const node = { type: "items", vars, body: [], s: tok.s };
          push(node); open("items", node, node.body, tok); return;
        }
        case "sep": {
          needNoParams(tok);
          const node = { type: "sep", body: [], s: tok.s };
          push(node);
          if (!tok.self) open("sep", node, node.body, tok, { implicit: true });
          return;
        }
        case "break": push({ type: "break", s: tok.s }); return;
        case "return": push({ type: "return", s: tok.s }); return;
        case "assign": case "global": case "local": {
          const p = paramParser(tok, { noAssignEq: true });
          const first = p.peek();
          if (first.k === "id" && (p.peek(1).k === "eof") && !tok.self) {
            // 블록 캡처: <#assign x>...</#assign>
            const node = { type: "capture", scope: name, name: first.v, body: [], s: tok.s };
            push(node); open(name, node, node.body, tok); return;
          }
          const ops = [];
          while (!p.atEnd()) {
            const id = p.next();
            if (id.k !== "id" && id.k !== "str") throw new FtlError("변수 이름이 필요합니다", id.s);
            const t = p.next();
            if (t.k === "op" && (t.v === "=" || t.v === "+=" || t.v === "-=")) ops.push({ name: id.v, op: t.v, expr: p.parseExpr(), s: id.s });
            else if (t.k === "op" && (t.v === "++" || t.v === "--")) ops.push({ name: id.v, op: t.v, s: id.s });
            else throw new FtlError("'=' 가 필요합니다", t.s);
            if (p.isOp(",")) p.next();
          }
          if (!ops.length) throw new FtlError("<#" + name + "> 에 할당할 내용이 없습니다", tok.s);
          push({ type: "assign", scope: name, ops, s: tok.s });
          return;
        }
        case "switch": {
          const node = { type: "switch", expr: parseExpression(src, tok.ps, tok.pe), cases: [], pre: [], s: tok.s };
          push(node); open("switch", node, node.pre, tok); return;
        }
        case "case": case "on": case "default": {
          popImplicitSep();
          const t = top();
          if (t.name !== "switch") throw new FtlError("<#" + name + "> 는 <#switch> 안에서만 쓸 수 있습니다", tok.s);
          let values = null;
          if (name !== "default") {
            const p = paramParser(tok); values = [];
            do { values.push(p.parseExpr()); } while (p.isOp(",") && p.next());
            p.expectEnd();
          }
          const c = { values, body: [], on: name === "on" };
          t.node.cases.push(c); t.body = c.body; return;
        }
        case "macro": {
          const p = paramParser(tok, { noAssignEq: true });
          const nm = p.next();
          if (nm.k !== "id" && nm.k !== "str") throw new FtlError("매크로 이름이 필요합니다", nm.s);
          const params = [];
          if (p.isOp("(")) p.next();
          while (!p.atEnd() && !p.isOp(")")) {
            const id = p.ident();
            let def;
            if (p.isOp("=")) { p.next(); def = p.parseExpr(); }
            params.push({ name: id.v, def });
            if (p.isOp(",")) p.next();
          }
          const node = { type: "macro", name: nm.v, params, body: [], s: tok.s };
          root.macros[nm.v] = node;
          open("macro", node, node.body, tok); return;
        }
        case "nested": {
          const p = paramParser(tok); const args = [];
          while (!p.atEnd()) { args.push(p.parseExpr()); if (p.isOp(",")) p.next(); }
          push({ type: "nested", args, s: tok.s }); return;
        }
        case "compress": case "noautoesc": case "autoesc": case "outputformat": case "escape": case "noescape": {
          const node = { type: name === "compress" ? "compress" : name === "noautoesc" || name === "noescape" ? "noautoesc" : name === "autoesc" ? "autoesc" : "block", body: [], s: tok.s };
          push(node); open(name, node, node.body, tok); return;
        }
        case "attempt": {
          const node = { type: "attempt", body: [], recover: [], s: tok.s };
          push(node); open("attempt", node, node.body, tok); return;
        }
        case "recover": {
          const t = top();
          if (t.name !== "attempt") throw new FtlError("<#recover> 는 <#attempt> 안에서만 쓸 수 있습니다", tok.s);
          t.body = t.node.recover; return;
        }
        case "setting": {
          const p = paramParser(tok, { noAssignEq: true });
          const id = p.ident(); p.expectOp("=");
          push({ type: "setting", name: id.v, expr: p.parseExpr(), s: tok.s }); return;
        }
        case "stop": {
          push({ type: "stop", expr: src.slice(tok.ps, tok.pe).trim() ? parseExpression(src, tok.ps, tok.pe) : null, s: tok.s }); return;
        }
      }
      throw new FtlError("알 수 없는 FreeMarker 지시어: <#" + name + ">", tok.s);
    }

    function handleEnd(tok) {
      const name = tok.name === "elseif" ? "if" : tok.name;
      if (name !== "sep") popImplicitSep();
      const t = top();
      const want = t.name;
      const alias = { global: "global", local: "local", assign: "assign" };
      if (want !== name && !(alias[want] && alias[name])) {
        if (t.name === "#root") throw new FtlError("</#" + tok.name + "> 와 짝이 맞는 <#" + tok.name + "> 가 없습니다", tok.s);
        throw new FtlError("</#" + want.replace(/^@/, "") + "> 가 와야 할 곳에 </#" + tok.name + "> 가 있습니다" + openHint(t), tok.s);
      }
      stack.pop();
    }
  }

  // ------------------------------------------------------------------ 숫자/날짜 형식
  function roundHalfEven(n, d) {
    const f = Math.pow(10, d);
    const x = n * f;
    const r = Math.round(x);
    const diff = Math.abs(x - Math.trunc(x));
    if (Math.abs(diff - 0.5) < 1e-9) { const fl = Math.floor(x); return (fl % 2 === 0 ? fl : fl + 1) / f; }
    return r / f;
  }
  function groupInt(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function formatPattern(n, pattern) {
    // DecimalFormat 의 주요 부분: 접두/접미 문자, 그룹(,), 최소 정수자리(0), 소수 0/# 자리, %
    const m = /^([^#0,.]*)([#0,]*)(?:\.([0#]*))?(.*)$/.exec(pattern);
    if (!m) return String(n);
    let [, prefix, intPart, frac = "", suffix] = m;
    let v = n;
    if (suffix.includes("%") || prefix.includes("%")) v = v * 100;
    const minInt = (intPart.match(/0/g) || []).length;
    const grouping = intPart.includes(",");
    const minFrac = (frac.match(/0/g) || []).length;
    const maxFrac = frac.length;
    const neg = v < 0; v = Math.abs(v);
    v = roundHalfEven(v, maxFrac);
    let [ip, fp = ""] = v.toFixed(maxFrac).split(".");
    while (fp.length > minFrac && fp.endsWith("0")) fp = fp.slice(0, -1);
    if (ip === "0" && minInt === 0 && fp) ip = "";
    while (ip.length < minInt) ip = "0" + ip;
    if (grouping) ip = groupInt(ip);
    return (neg ? "-" : "") + prefix.replace(/'/g, "") + ip + (fp ? "." + fp : "") + suffix.replace(/'/g, "");
  }
  function cNumber(n) {
    if (Number.isInteger(n)) return String(n);
    if (!isFinite(n)) return n > 0 ? "INF" : n < 0 ? "-INF" : "NaN";
    let s = String(Number(n.toPrecision(16)));
    if (s.includes("e")) s = n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }
  function formatNumber(n, fmt) {
    if (fmt == null || fmt === "" || fmt === "number") {
      // FreeMarker 기본 number_format("number"): 천 단위 구분 + 소수 최대 3자리
      const [ip, fp] = String(roundHalfEven(Math.abs(n), 3)).split(".");
      return (n < 0 ? "-" : "") + groupInt(ip) + (fp ? "." + fp : "");
    }
    if (fmt === "computer" || fmt === "c") return cNumber(n);
    if (fmt === "currency") return (n < 0 ? "-" : "") + "₩" + groupInt(String(Math.round(Math.abs(n))));
    if (fmt === "percent") return formatPattern(n, "#,##0%");
    return formatPattern(n, fmt);
  }

  const DOW_LONG = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
  const DOW_SHORT = ["일", "월", "화", "수", "목", "금", "토"];
  const pad = (n, w) => String(n).padStart(w, "0");
  function formatDate(fd, pattern) {
    const d = fd.d;
    if (pattern === "iso" || pattern === "xs") {
      const date = d.getFullYear() + "-" + pad(d.getMonth() + 1, 2) + "-" + pad(d.getDate(), 2);
      const time = pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2);
      return fd.kind === "date" ? date : fd.kind === "time" ? time : date + "T" + time;
    }
    const map = {
      yyyy: () => pad(d.getFullYear(), 4), yy: () => pad(d.getFullYear() % 100, 2), y: () => String(d.getFullYear()),
      MMMM: () => (d.getMonth() + 1) + "월", MMM: () => (d.getMonth() + 1) + "월", MM: () => pad(d.getMonth() + 1, 2), M: () => String(d.getMonth() + 1),
      dd: () => pad(d.getDate(), 2), d: () => String(d.getDate()),
      HH: () => pad(d.getHours(), 2), H: () => String(d.getHours()),
      hh: () => pad(d.getHours() % 12 || 12, 2), h: () => String(d.getHours() % 12 || 12),
      mm: () => pad(d.getMinutes(), 2), m: () => String(d.getMinutes()),
      ss: () => pad(d.getSeconds(), 2), s: () => String(d.getSeconds()),
      SSS: () => pad(d.getMilliseconds(), 3),
      a: () => (d.getHours() < 12 ? "오전" : "오후"),
      EEEE: () => DOW_LONG[d.getDay()], EEE: () => DOW_SHORT[d.getDay()], EE: () => DOW_SHORT[d.getDay()], E: () => DOW_SHORT[d.getDay()],
    };
    let out = "", i = 0;
    while (i < pattern.length) {
      const c = pattern[i];
      if (c === "'") {
        const j = pattern.indexOf("'", i + 1);
        if (j === i + 1) { out += "'"; i += 2; continue; }
        out += pattern.slice(i + 1, j < 0 ? undefined : j); i = j < 0 ? pattern.length : j + 1; continue;
      }
      if (/[A-Za-z]/.test(c)) {
        let j = i; while (pattern[j] === c) j++;
        let run = pattern.slice(i, j);
        while (run && !map[run]) run = run.slice(0, -1);
        if (run) { out += map[run](); i += run.length; continue; }
        out += c; i++; continue;
      }
      out += c; i++;
    }
    return out;
  }
  function parseISO(s, kind, pos) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
    const mt = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
    if (kind === "time" && mt) return new FDate(new Date(1970, 0, 1, +mt[1], +mt[2], +(mt[3] || 0)), "time");
    if (!m) throw new FtlError("ISO 8601 날짜 형식이 아닙니다: \"" + s + "\" (예: 2026-10-26T14:30:00)", pos);
    let d;
    if (m[8]) d = new Date(s.trim().replace(" ", "T"));
    else d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? +("0." + m[7]) * 1000 : 0);
    return new FDate(d, kind);
  }
  function parseByPattern(s, pattern, kind, pos) {
    const fields = [];
    let re = "";
    let i = 0;
    while (i < pattern.length) {
      const c = pattern[i];
      if (/[A-Za-z]/.test(c)) {
        let j = i; while (pattern[j] === c) j++;
        const run = pattern.slice(i, j);
        if ("yMdHhmsSa".includes(c)) { fields.push(c === "a" ? "a" : c); re += c === "a" ? "(오전|오후|AM|PM|am|pm)" : "(\\d{1," + Math.max(run.length, c === "y" ? 4 : 2) + "})"; }
        else if (c === "E") re += "\\S+";
        else re += run;
        i = j; continue;
      }
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i++;
    }
    const m = new RegExp("^" + re + "$").exec(s.trim());
    if (!m) throw new FtlError("\"" + s + "\" 를 날짜 형식 \"" + pattern + "\" 으로 해석할 수 없습니다", pos);
    let y = 1970, M = 1, d = 1, H = 0, mi = 0, se = 0, ms = 0, pm = null;
    fields.forEach((f, k) => {
      const v = m[k + 1];
      switch (f) { case "y": y = +v < 100 ? 2000 + +v : +v; break; case "M": M = +v; break; case "d": d = +v; break; case "H": H = +v; break; case "h": H = +v % 12; break; case "m": mi = +v; break; case "s": se = +v; break; case "S": ms = +v; break; case "a": pm = /오후|PM|pm/.test(v); break; }
    });
    if (pm) H += 12;
    return new FDate(new Date(y, M - 1, d, H, mi, se, ms), kind);
  }

  const escHTML = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------------ 실행 환경
  class Env {
    constructor(root, data, opts) {
      this.root = root; this.data = data || {}; this.opts = opts || {};
      this.globals = Object.create(null);
      this.scopes = [];           // { vars, loops, macro:boolean }
      this.loopStack = [];        // 현재 실행 중인 반복 정보 (sep 용)
      this.callStack = [];        // 매크로 호출 (nested 용)
      this.out = [];
      this.safe = 0;              // (a.b.c)! 처럼 괄호 기본값 안에서는 중간 단계 누락을 허용
      this.autoEsc = !!this.opts.autoEscape;
      this.settings = { number_format: "number", boolean_format: null, date_format: "yyyy-MM-dd", datetime_format: "yyyy-MM-dd HH:mm:ss", time_format: "HH:mm:ss" };
      this.src = opts.src;
      this.steps = 0;
    }
    lookup(name) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const sc = this.scopes[i];
        if (name in sc.vars) return norm(sc.vars[name]);
        if (sc.macro) break; // 매크로 안에서는 호출한 쪽의 지역 변수를 보지 않음
      }
      if (name in this.globals) return norm(this.globals[name]);
      if (this.data && Object.prototype.hasOwnProperty.call(this.data, name)) return norm(this.data[name]);
      return undefined;
    }
    loopMeta(name) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const sc = this.scopes[i];
        if (sc.loops && name in sc.loops) return sc.loops[name];
        if (sc.vars && name in sc.vars) return null;
        if (sc.macro) break;
      }
      return null;
    }
    text(node) { return this.src.slice(node.s, node.e); }
    missing(node) {
      const t = this.text(node);
      return new MissingError("값이 없습니다: " + t + "  — 데이터셋에 해당 값이 있는지 확인하거나 기본값을 지정하세요 (예: ${" + t + "!\"\"} 또는 <#if " + t + "??>)", node.s);
    }
    need(v, node) { if (v === undefined) throw this.missing(node); return v; }
  }

  // ------------------------------------------------------------------ 식 평가
  function evaluate(node, env) {
    switch (node.type) {
      case "lit": return node.v;
      case "strtpl": return node.parts.map(p => (typeof p === "string" ? p : toText(env.need(evaluate(p, env), p), env, p, true))).join("");
      case "var": return env.lookup(node.name);
      case "special": {
        if (node.name === "now") return new FDate(new Date(), "datetime");
        if (node.name === "data_model") return env.data;
        if (node.name === "globals") return env.globals;
        if (node.name === "lang" || node.name === "locale") return "ko_KR";
        if (node.name === "template_name" || node.name === "current_template_name" || node.name === "main_template_name") return "template.ftl";
        if (node.name === "version") return "2.3.32 (MailPreview)";
        throw new FtlError("지원하지 않는 특수 변수: ." + node.name, node.s);
      }
      case "paren": return evaluate(node.inner, env);
      case "seq": return node.items.map(it => env.need(evaluate(it, env), it));
      case "hash": {
        const h = {};
        for (const [k, v] of node.pairs) {
          const key = k.type === "var" ? k.name : env.need(evaluate(k, env), k);
          if (typeof key !== "string") throw new FtlError("해시 키는 문자열이어야 합니다", k.s);
          h[key] = env.need(evaluate(v, env), v);
        }
        return h;
      }
      case "member": {
        const obj = evaluate(node.obj, env);
        if (obj === undefined || obj === EMPTY) { if (env.safe || obj === EMPTY) return undefined; throw env.missing(node.obj); }
        if (isHash(obj)) return Object.prototype.hasOwnProperty.call(obj, node.name) ? norm(obj[node.name]) : undefined;
        if (Array.isArray(obj) && /^\d+$/.test(node.name)) return norm(obj[+node.name]);
        throw new FtlError("'" + env.text(node.obj) + "' 은(는) " + typeName(obj) + " 이므로 ." + node.name + " 를 쓸 수 없습니다", node.s);
      }
      case "index": {
        const obj = evaluate(node.obj, env);
        if (obj === undefined) { if (env.safe) return undefined; throw env.missing(node.obj); }
        const idx = env.need(evaluate(node.idx, env), node.idx);
        if (idx instanceof Range || (Array.isArray(idx) && node.idx.type === "range")) {
          const r = rangeBounds(idx, node.idx);
          const seq = typeof obj === "string" ? obj : toSeq(obj, env, node.obj);
          const end = r.b === null ? seq.length : r.b;
          if (r.a < 0 || end > seq.length || r.a > end) throw new FtlError("범위 [" + r.a + ".." + end + "] 가 길이 " + seq.length + " 을 벗어났습니다", node.idx.s);
          return seq.slice(r.a, end);
        }
        if (typeof idx === "number") {
          if (Array.isArray(obj)) return idx >= 0 && idx < obj.length ? norm(obj[idx]) : undefined;
          if (typeof obj === "string") { if (idx < 0 || idx >= obj.length) throw new FtlError("문자열 인덱스 " + idx + " 가 범위를 벗어났습니다", node.idx.s); return obj[idx]; }
          throw new FtlError(typeName(obj) + " 에 숫자 인덱스를 쓸 수 없습니다", node.s);
        }
        if (typeof idx === "string") {
          if (isHash(obj)) return Object.prototype.hasOwnProperty.call(obj, idx) ? norm(obj[idx]) : undefined;
          throw new FtlError(typeName(obj) + " 에 문자열 키를 쓸 수 없습니다", node.s);
        }
        throw new FtlError("인덱스는 숫자나 문자열이어야 합니다", node.idx.s);
      }
      case "default": {
        let v;
        try {
          if (node.target.type === "paren") { env.safe++; try { v = evaluate(node.target.inner, env); } finally { env.safe--; } }
          else v = evaluate(node.target, env);
        } catch (e) { if (e instanceof MissingError && node.target.type === "paren") v = undefined; else throw e; }
        if (v !== undefined) return v;
        return node.def ? evaluate(node.def, env) : EMPTY;
      }
      case "exists": {
        let v;
        try {
          if (node.target.type === "paren") { env.safe++; try { v = evaluate(node.target.inner, env); } finally { env.safe--; } }
          else v = evaluate(node.target, env);
        } catch (e) { if (e instanceof MissingError && node.target.type === "paren") v = undefined; else throw e; }
        return v !== undefined;
      }
      case "not": return !needBool(evaluate(node.arg, env), node.arg, env);
      case "neg": return -needNum(evaluate(node.arg, env), node.arg, env);
      case "pos": return needNum(evaluate(node.arg, env), node.arg, env);
      case "range": {
        const a = needNum(evaluate(node.left, env), node.left, env);
        if (!node.right) return new Range(a, null);
        let b = needNum(evaluate(node.right, env), node.right, env);
        if (node.op === "..*") b = a + b - 1;
        else if (node.op === "..<" || node.op === "..!") b = b - 1;
        if (node.op !== ".." && b < a) return [];
        const out = [];
        if (a <= b) for (let i = a; i <= b; i++) out.push(i); else for (let i = a; i >= b; i--) out.push(i);
        return out;
      }
      case "bin": return evalBin(node, env);
      case "bi": return evalBuiltin(node, env);
    }
    throw new FtlError("평가할 수 없는 식", node.s);
  }
  function rangeBounds(v, node) {
    if (v instanceof Range) return { a: v.a, b: null };
    if (!v.length) return { a: 0, b: 0 };
    const a = v[0], b = v[v.length - 1];
    if (b < a) throw new FtlError("역순 범위로는 자를 수 없습니다", node.s);
    return { a, b: b + 1 };
  }
  function needBool(v, node, env) {
    if (v === undefined) throw env.missing(node);
    if (typeof v !== "boolean") throw new FtlError("boolean(참/거짓) 이 필요한데 '" + env.text(node) + "' 은(는) " + typeName(v) + " 입니다. 예: <#if " + env.text(node) + "?has_content> 또는 <#if " + env.text(node) + " == \"...\">", node.s);
    return v;
  }
  function needNum(v, node, env) {
    if (v === undefined) throw env.missing(node);
    if (typeof v !== "number") throw new FtlError("숫자가 필요한데 '" + env.text(node) + "' 은(는) " + typeName(v) + " 입니다" + (typeof v === "string" ? " (문자열이면 ?number 로 변환)" : ""), node.s);
    return v;
  }
  function needStr(v, node, env) {
    if (v === undefined) throw env.missing(node);
    if (v === EMPTY) return "";
    if (v instanceof Markup) return v.s;
    if (typeof v !== "string") throw new FtlError("문자열이 필요한데 '" + env.text(node) + "' 은(는) " + typeName(v) + " 입니다", node.s);
    return v;
  }
  function toSeq(v, env, node) {
    if (v === EMPTY) return [];
    if (Array.isArray(v)) return v;
    throw new FtlError("시퀀스(배열)가 필요한데 '" + env.text(node) + "' 은(는) " + typeName(v) + " 입니다", node.s);
  }
  function valEq(a, b, node, env) {
    if (a === EMPTY) a = ""; if (b === EMPTY) b = "";
    if (a instanceof Markup) a = a.s; if (b instanceof Markup) b = b.s;
    if (a instanceof FDate && b instanceof FDate) return a.d.getTime() === b.d.getTime();
    const ta = typeof a, tb = typeof b;
    if (ta !== tb || (ta === "object")) throw new FtlError("비교할 수 없습니다: " + typeName(a) + " 와(과) " + typeName(b) + " (" + env.text(node) + ")", node.s);
    return a === b;
  }
  function evalBin(node, env) {
    const op = node.op;
    if (op === "&&") return needBool(evaluate(node.left, env), node.left, env) && needBool(evaluate(node.right, env), node.right, env);
    if (op === "||") return needBool(evaluate(node.left, env), node.left, env) || needBool(evaluate(node.right, env), node.right, env);
    const a = env.need(evaluate(node.left, env), node.left);
    const b = env.need(evaluate(node.right, env), node.right);
    switch (op) {
      case "==": return valEq(a, b, node, env);
      case "!=": return !valEq(a, b, node, env);
      case "<": case ">": case "<=": case ">=": {
        let x = a, y = b;
        if (x instanceof FDate && y instanceof FDate) { x = x.d.getTime(); y = y.d.getTime(); }
        else if (typeof x === "string" && typeof y === "string") throw new FtlError("문자열은 <, > 로 비교할 수 없습니다 (FreeMarker 규칙)", node.s);
        else { x = needNum(x, node.left, env); y = needNum(y, node.right, env); }
        return op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
      }
      case "+": {
        if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
        if (isHash(a) && isHash(b)) return Object.assign({}, a, b);
        if (typeof a === "number" && typeof b === "number") return a + b;
        if (a === EMPTY && Array.isArray(b)) return b; if (b === EMPTY && Array.isArray(a)) return a;
        if (a === EMPTY && isHash(b)) return b; if (b === EMPTY && isHash(a)) return a;
        return toText(a, env, node.left, true) + toText(b, env, node.right, true);
      }
      case "-": return needNum(a, node.left, env) - needNum(b, node.right, env);
      case "*": return needNum(a, node.left, env) * needNum(b, node.right, env);
      case "/": return needNum(a, node.left, env) / needNum(b, node.right, env);
      case "%": return needNum(a, node.left, env) % needNum(b, node.right, env);
    }
    throw new FtlError("알 수 없는 연산자 " + op, node.s);
  }

  // 값을 출력용 문자열로 (${...} 및 문자열 결합)
  function toText(v, env, node, inConcat) {
    if (v === undefined) throw env.missing(node);
    if (v === EMPTY) return "";
    if (typeof v === "string") return v;
    if (v instanceof Markup) return v.s;
    if (typeof v === "number") return formatNumber(v, env.settings.number_format);
    if (typeof v === "boolean") {
      const bf = env.settings.boolean_format;
      if (bf && bf !== "true,false") { const [t, f] = bf.split(","); return v ? t : f; }
      if (bf === "c" || bf === "true,false") return String(v);
      throw new FtlError("boolean 값은 바로 출력할 수 없습니다: " + env.text(node) + "  → ${" + env.text(node) + "?c} 또는 ${" + env.text(node) + "?string(\"예\", \"아니오\")} 를 사용하세요", node.s);
    }
    if (v instanceof FDate) return formatDate(v, v.kind === "date" ? env.settings.date_format : v.kind === "time" ? env.settings.time_format : env.settings.datetime_format);
    throw new FtlError(typeName(v) + " 은(는) 그대로 출력할 수 없습니다: " + env.text(node) + (Array.isArray(v) ? "  → <#list> 또는 ?join(\", \") 사용" : "  → 하위 값(." + "이름)을 출력하세요"), node.s);
  }

  // ------------------------------------------------------------------ 내장함수
  const LOOP_BI = {
    index: m => m.index, counter: m => m.index + 1, has_next: m => m.index < m.size - 1,
    is_first: m => m.index === 0, is_last: m => m.index === m.size - 1,
    item_parity: m => (m.index % 2 === 0 ? "odd" : "even"), item_parity_cap: m => (m.index % 2 === 0 ? "Odd" : "Even"),
    is_odd_item: m => m.index % 2 === 0, is_even_item: m => m.index % 2 === 1,
  };

  function evalBuiltin(node, env) {
    const name = node.name;
    const argv = () => (node.args || []).map(a => env.need(evaluate(a, env), a));
    const nargs = (min, max) => {
      const n = node.args ? node.args.length : 0;
      if (n < min || n > max) throw new FtlError("?" + name + " 의 인자 개수가 맞지 않습니다 (" + (min === max ? min : min + "~" + max) + "개 필요)", node.nameS);
    };

    // 루프 변수 내장함수
    if (node.target.type === "var") {
      const meta = env.loopMeta(node.target.name);
      if (meta) {
        if (LOOP_BI[name]) return LOOP_BI[name](meta);
        if (name === "item_cycle") { const a = argv(); return a[meta.index % a.length]; }
      } else if (LOOP_BI[name] || name === "item_cycle") {
        throw new FtlError("?" + name + " 는 <#list> 의 반복 변수에만 쓸 수 있습니다 ('" + node.target.name + "' 은(는) 반복 변수가 아님)", node.nameS);
      }
    }

    // 누락 허용 내장함수
    if (name === "has_content") {
      let v; env.safe++; try { v = evaluate(node.target, env); } catch (e) { if (!(e instanceof MissingError)) throw e; v = undefined; } finally { env.safe--; }
      if (v === undefined || v === EMPTY) return false;
      if (typeof v === "string") return v.length > 0;
      if (v instanceof Markup) return v.s.length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (isHash(v)) return Object.keys(v).length > 0;
      return true;
    }
    if (name === "if_exists") { let v = evaluate(node.target, env); return v === undefined ? EMPTY : v; }
    if (name === "default") { let v = evaluate(node.target, env); return v === undefined ? argv()[0] : v; }

    let v = env.need(evaluate(node.target, env), node.target);
    const tn = () => env.text(node.target);
    const wrongType = want => new FtlError("?" + name + " 는 " + want + " 에 쓰는 내장함수인데 '" + tn() + "' 은(는) " + typeName(v) + " 입니다", node.nameS);
    if (v instanceof Markup && name !== "no_esc") v = v.s;
    if (v === EMPTY) v = "";

    // ---- 모든 타입
    switch (name) {
      case "is_string": return typeof v === "string";
      case "is_number": return typeof v === "number";
      case "is_boolean": return typeof v === "boolean";
      case "is_sequence": case "is_enumerable": case "is_collection": return Array.isArray(v);
      case "is_hash": case "is_hash_ex": return isHash(v);
      case "is_date": case "is_date_like": return v instanceof FDate;
      case "is_date_only": return v instanceof FDate && v.kind === "date";
      case "is_datetime": return v instanceof FDate && v.kind === "datetime";
      case "is_time": return v instanceof FDate && v.kind === "time";
      case "is_macro": case "is_directive": case "is_method": return false;
      case "no_esc": return new Markup(typeof v === "string" ? v : toText(v, env, node.target));
      case "esc": return escHTML(typeof v === "string" ? v : toText(v, env, node.target));
      case "then": {
        nargs(2, 2);
        const b = needBool(v, node.target, env);
        const arg = node.args[b ? 0 : 1];
        return env.need(evaluate(arg, env), arg);
      }
      case "switch": {
        const a = node.args || [];
        for (let i = 0; i + 1 < a.length; i += 2) if (valEq(v, env.need(evaluate(a[i], env), a[i]), node, env)) return env.need(evaluate(a[i + 1], env), a[i + 1]);
        if (a.length % 2 === 1) return env.need(evaluate(a[a.length - 1], env), a[a.length - 1]);
        throw new FtlError("?switch 에 일치하는 값이 없습니다 (마지막에 기본값 추가)", node.nameS);
      }
    }

    // ---- 문자열
    if (typeof v === "string") {
      const s = v;
      switch (name) {
        case "upper_case": return s.toUpperCase();
        case "lower_case": return s.toLowerCase();
        case "cap_first": return s.replace(/^(\s*)(\S)/, (m, w, c) => w + c.toUpperCase());
        case "uncap_first": return s.replace(/^(\s*)(\S)/, (m, w, c) => w + c.toLowerCase());
        case "capitalize": return s.replace(/(^|\s)(\S)(\S*)/g, (m, w, c, r) => w + c.toUpperCase() + r.toLowerCase());
        case "trim": return s.trim();
        case "length": return s.length;
        case "size": throw wrongType("시퀀스/해시");
        case "html": case "xhtml": case "xml": return escHTML(s);
        case "url": case "url_path": return name === "url" ? encodeURIComponent(s) : encodeURI(s);
        case "js_string": return s.replace(/[\\'"\n\r\t<>]/g, c => ({ "\\": "\\\\", "'": "\\'", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", "<": "\\x3C", ">": "\\x3E" }[c]));
        case "json_string": case "j_string": return JSON.stringify(s).slice(1, -1);
        case "c": case "string": if (!node.args) return s; break;
        case "cn": return s;
        case "replace": { nargs(2, 3); const [a, b, f = ""] = argv(); if (String(f).includes("r")) return s.replace(new RegExp(a, String(f).includes("f") ? (String(f).includes("i") ? "i" : "") : "g" + (String(f).includes("i") ? "i" : "")), b); return String(f).includes("f") ? s.replace(a, b) : s.split(a).join(b); }
        case "contains": nargs(1, 1); return s.includes(needStr(argv()[0], node.args[0], env));
        case "starts_with": nargs(1, 1); return s.startsWith(argv()[0]);
        case "ends_with": nargs(1, 1); return s.endsWith(argv()[0]);
        case "index_of": { nargs(1, 2); const a = argv(); return s.indexOf(a[0], a[1] || 0); }
        case "last_index_of": { nargs(1, 2); const a = argv(); return a.length > 1 ? s.lastIndexOf(a[0], a[1]) : s.lastIndexOf(a[0]); }
        case "split": { nargs(1, 2); const [sep, f = ""] = argv(); return String(f).includes("r") ? s.split(new RegExp(sep)) : s.split(sep); }
        case "left_pad": { nargs(1, 2); const [n, c = " "] = argv(); return s.padStart(n, c); }
        case "right_pad": { nargs(1, 2); const [n, c = " "] = argv(); return s.padEnd(n, c); }
        case "keep_before": { const a = argv()[0]; const i = s.indexOf(a); return i < 0 ? s : s.slice(0, i); }
        case "keep_after": { const a = argv()[0]; const i = s.indexOf(a); return i < 0 ? "" : s.slice(i + a.length); }
        case "keep_before_last": { const a = argv()[0]; const i = s.lastIndexOf(a); return i < 0 ? s : s.slice(0, i); }
        case "keep_after_last": { const a = argv()[0]; const i = s.lastIndexOf(a); return i < 0 ? "" : s.slice(i + a.length); }
        case "remove_beginning": { const a = argv()[0]; return s.startsWith(a) ? s.slice(a.length) : s; }
        case "remove_ending": { const a = argv()[0]; return s.endsWith(a) ? s.slice(0, s.length - a.length) : s; }
        case "ensure_starts_with": { const a = argv()[0]; return s.startsWith(a) ? s : a + s; }
        case "ensure_ends_with": { const a = argv()[0]; return s.endsWith(a) ? s : s + a; }
        case "chop_linebreak": return s.replace(/\r?\n$/, "");
        case "word_list": return s.trim().split(/\s+/).filter(Boolean);
        case "substring": { const a = argv(); return s.substring(a[0], a.length > 1 ? a[1] : undefined); }
        case "truncate": case "truncate_w": case "truncate_c": { nargs(1, 2); const [n, term = "[...]"] = argv(); if (s.length <= n) return s; return s.slice(0, Math.max(0, n - term.length)).replace(/\s+$/, "") + term; }
        case "number": { const t = s.trim(); if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new FtlError("\"" + s + "\" 는 숫자로 변환할 수 없습니다", node.target.s); return Number(t); }
        case "boolean": if (s === "true") return true; if (s === "false") return false; throw new FtlError("\"" + s + "\" 는 boolean 으로 변환할 수 없습니다 (true/false)", node.target.s);
        case "date": case "datetime": case "time": {
          if (!node.args) throw new FtlError("문자열을 날짜로 바꾸려면 형식을 지정하세요: ?" + name + "(\"yyyy-MM-dd\") 또는 ?" + name + ".iso", node.nameS);
          return parseByPattern(s, argv()[0], name, node.target.s);
        }
        case "date.iso": case "date.xs": return parseISO(s, "date", node.target.s);
        case "datetime.iso": case "datetime.xs": return parseISO(s, "datetime", node.target.s);
        case "time.iso": case "time.xs": return parseISO(s, "time", node.target.s);
        case "eval": case "eval_json": try { return JSON.parse(s); } catch (e) { throw new FtlError("?" + name + ": 해석할 수 없는 값", node.target.s); }
        case "interpret": throw new FtlError("?interpret 는 지원하지 않습니다", node.nameS);
        case "groups": case "matches": { const m = new RegExp("^(?:" + argv()[0] + ")$").exec(s); return name === "matches" ? !!m : (m ? Array.from(m) : []); }
      }
      if (name !== "string" && name !== "c") throw unknownOrWrong(name, v, node, env);
    }

    // ---- 숫자
    if (typeof v === "number") {
      switch (name) {
        case "c": case "cn": return cNumber(v);
        case "string": {
          if (!node.args) return formatNumber(v, env.settings.number_format);
          return formatNumber(v, argv()[0]);
        }
        case "string.currency": return formatNumber(v, "currency");
        case "string.percent": return formatNumber(v, "percent");
        case "string.number": return formatNumber(v, "number");
        case "string.computer": return cNumber(v);
        case "round": return Math.floor(v + 0.5);
        case "floor": return Math.floor(v);
        case "ceiling": return Math.ceil(v);
        case "abs": return Math.abs(v);
        case "int": case "long": case "short": case "byte": return Math.trunc(v);
        case "float": case "double": return v;
        case "is_infinite": return !isFinite(v) && !isNaN(v);
        case "is_nan": return isNaN(v);
        case "lower_abc": case "upper_abc": { let n = v, out = ""; while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); } return name === "upper_abc" ? out.toUpperCase() : out; }
        case "number_to_date": return new FDate(new Date(v), "date");
        case "number_to_datetime": return new FDate(new Date(v), "datetime");
        case "number_to_time": return new FDate(new Date(v), "time");
      }
      throw unknownOrWrong(name, v, node, env);
    }

    // ---- boolean
    if (typeof v === "boolean") {
      switch (name) {
        case "c": case "cn": return String(v);
        case "string": {
          if (!node.args) { const bf = env.settings.boolean_format; if (bf && bf !== "c") { const [t, f] = bf.split(","); return v ? t : f; } return String(v); }
          nargs(2, 2); const [t, f] = argv(); return v ? t : f;
        }
      }
      throw unknownOrWrong(name, v, node, env);
    }

    // ---- 날짜
    if (v instanceof FDate) {
      switch (name) {
        case "string": {
          if (!node.args) return toText(v, env, node.target);
          return formatDate(v, argv()[0]);
        }
        case "date": return new FDate(v.d, "date");
        case "time": return new FDate(v.d, "time");
        case "datetime": return new FDate(v.d, "datetime");
        case "long": return v.d.getTime();
        case "iso_local": case "iso": return formatDate(v, "iso");
        case "c": return formatDate(v, "iso");
      }
      throw unknownOrWrong(name, v, node, env);
    }

    // ---- 시퀀스
    if (Array.isArray(v)) {
      switch (name) {
        case "size": return v.length;
        case "first": return v.length ? norm(v[0]) : undefined;
        case "last": return v.length ? norm(v[v.length - 1]) : undefined;
        case "reverse": return v.slice().reverse();
        case "join": {
          nargs(1, 3);
          const [sep, empty = "", end = ""] = argv();
          const items = v.filter(x => x != null).map(x => toText(x, env, node.target, true));
          return items.length ? items.join(sep) + end : empty;
        }
        case "seq_contains": { const a = argv()[0]; return v.some(x => { try { return valEq(x, a, node, env); } catch (e) { return false; } }); }
        case "seq_index_of": { const a = argv()[0]; return v.findIndex(x => { try { return valEq(x, a, node, env); } catch (e) { return false; } }); }
        case "seq_last_index_of": { const a = argv()[0]; for (let i = v.length - 1; i >= 0; i--) { try { if (valEq(v[i], a, node, env)) return i; } catch (e) {} } return -1; }
        case "sort": return sortSeq(v.slice(), null, node, env);
        case "sort_by": { const k = argv()[0]; return sortSeq(v.slice(), Array.isArray(k) ? k : [k], node, env); }
        case "chunk": { nargs(1, 2); const [n, fill] = argv(); const out = []; for (let i = 0; i < v.length; i += n) { const c = v.slice(i, i + n); if (fill !== undefined) while (c.length < n) c.push(fill); out.push(c); } return out; }
        case "min": case "max": { const nums = v.filter(x => x != null); if (!nums.length) return undefined; return nums.reduce((a, b) => (name === "min" ? (b < a ? b : a) : (b > a ? b : a))); }
        case "filter": case "map": case "take_while": case "drop_while":
          throw new FtlError("?" + name + "(람다) 는 아직 지원하지 않습니다. <#list> 와 <#if> 로 작성해 주세요", node.nameS);
      }
      throw unknownOrWrong(name, v, node, env);
    }
    if (v instanceof Range) {
      if (name === "size") throw new FtlError("끝이 없는 범위의 크기는 구할 수 없습니다", node.nameS);
      throw unknownOrWrong(name, v, node, env);
    }

    // ---- 해시
    if (isHash(v)) {
      switch (name) {
        case "keys": return Object.keys(v);
        case "values": return Object.values(v).map(norm);
        case "size": throw new FtlError("해시에는 ?size 를 쓸 수 없습니다 → ?keys?size 를 사용하세요", node.nameS);
      }
      throw unknownOrWrong(name, v, node, env);
    }
    throw unknownOrWrong(name, v, node, env);
  }
  const KNOWN_BI = "upper_case lower_case cap_first uncap_first capitalize trim length size html xhtml xml url url_path js_string json_string j_string c cn string replace contains starts_with ends_with index_of last_index_of split left_pad right_pad keep_before keep_after keep_before_last keep_after_last remove_beginning remove_ending ensure_starts_with ensure_ends_with chop_linebreak word_list substring truncate number boolean date datetime time round floor ceiling abs int long lower_abc upper_abc first last reverse join seq_contains seq_index_of sort sort_by chunk min max keys values then switch has_content no_esc esc is_string is_number is_boolean is_sequence is_hash is_date index counter has_next is_first is_last item_parity item_cycle".split(" ");
  function unknownOrWrong(name, v, node, env) {
    const base = name.split(".")[0];
    if (KNOWN_BI.includes(base)) return new FtlError("?" + name + " 는 " + typeName(v) + " 에는 쓸 수 없습니다 ('" + env.text(node.target) + "')", node.nameS);
    return new FtlError("알 수 없는 내장함수 ?" + name, node.nameS);
  }
  function sortSeq(arr, keys, node, env) {
    const get = x => { let y = x; if (keys) for (const k of keys) { if (!isHash(y)) throw new FtlError("?sort_by: 항목이 해시가 아닙니다", node.nameS); y = norm(y[k]); } return y; };
    const vals = arr.map(get);
    if (vals.some(x => x === undefined)) throw new FtlError("?" + node.name + ": 정렬 기준 값이 없는 항목이 있습니다", node.nameS);
    const t = typeof vals[0];
    if (!vals.every(x => typeof x === t)) throw new FtlError("?" + node.name + ": 정렬 기준 값의 타입이 섞여 있습니다", node.nameS);
    const idx = arr.map((x, i) => i);
    idx.sort((i, j) => {
      let a = vals[i], b = vals[j];
      if (a instanceof FDate) { a = a.d.getTime(); b = b.d.getTime(); }
      if (typeof a === "string") return a.localeCompare(b, "ko");
      if (typeof a === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
      return a - b;
    });
    return idx.map(i => arr[i]);
  }

  // ------------------------------------------------------------------ 실행
  function execBody(nodes, env) {
    for (const node of nodes) execNode(node, env);
  }
  function capture(env, fn) {
    const saved = env.out; env.out = [];
    try { fn(); return env.out.join(""); } finally { env.out = saved; }
  }
  function execNode(node, env) {
    if (++env.steps > 2e6) throw new FtlError("실행 단계가 너무 많습니다 (무한 반복?)", node.s || 0);
    switch (node.type) {
      case "text": env.out.push(node.text); return;
      case "interp": {
        const v = evaluate(node.expr, env);
        const s = toText(v, env, node.expr);
        env.out.push(v instanceof Markup || !env.autoEsc ? s : escHTML(s));
        return;
      }
      case "if": {
        for (const br of node.branches) {
          if (needBool(evaluate(br.cond, env), br.cond, env)) { execBody(br.body, env); return; }
        }
        if (node.elseBody) execBody(node.elseBody, env);
        return;
      }
      case "list": return execList(node, env);
      case "items": {
        const ctx = env.itemsCtx && env.itemsCtx[env.itemsCtx.length - 1];
        if (!ctx) throw new FtlError("<#items> 위치가 올바르지 않습니다", node.s);
        iterate(ctx.value, node.vars, node.body, env, ctx.node);
        return;
      }
      case "sep": {
        const lp = env.loopStack[env.loopStack.length - 1];
        if (!lp) throw new FtlError("<#sep> 는 <#list> 안에서만 쓸 수 있습니다", node.s);
        if (lp.index < lp.size - 1) execBody(node.body, env);
        return;
      }
      case "break": throw new BreakSignal();
      case "return": throw new ReturnSignal();
      case "stop": throw new FtlError("<#stop>" + (node.expr ? ": " + toText(evaluate(node.expr, env), env, node.expr) : ""), node.s);
      case "assign": {
        for (const op of node.ops) {
          let val;
          if (op.op === "=") val = env.need(evaluate(op.expr, env), op.expr);
          else {
            const cur = lookupForAssign(env, node.scope, op.name);
            if (cur === undefined) throw new FtlError("'" + op.name + "' 값이 없어 " + op.op + " 를 할 수 없습니다", op.s);
            if (op.op === "++" || op.op === "--") val = needNum(cur, { s: op.s, e: op.s + op.name.length }, env) + (op.op === "++" ? 1 : -1);
            else if (op.op === "+=") { const r = env.need(evaluate(op.expr, env), op.expr); val = evalBin({ type: "bin", op: "+", left: { type: "lit", v: cur, s: op.s, e: op.s }, right: { type: "lit", v: r, s: op.expr.s, e: op.expr.e }, s: op.s, e: op.expr.e }, env); }
            else val = needNum(cur, { s: op.s, e: op.s }, env) - needNum(env.need(evaluate(op.expr, env), op.expr), op.expr, env);
          }
          setVar(env, node.scope, op.name, val, op.s);
        }
        return;
      }
      case "capture": {
        const s = capture(env, () => execBody(node.body, env));
        setVar(env, node.scope, node.name, new Markup(s), node.s);
        return;
      }
      case "switch": {
        const v = env.need(evaluate(node.expr, env), node.expr);
        execBody(node.pre, env);
        let start = -1;
        for (let i = 0; i < node.cases.length && start < 0; i++) {
          const c = node.cases[i];
          if (c.values && c.values.some(x => valEq(v, env.need(evaluate(x, env), x), x, env))) start = i;
        }
        if (start < 0) start = node.cases.findIndex(c => !c.values);
        if (start < 0) return;
        try {
          for (let i = start; i < node.cases.length; i++) {
            execBody(node.cases[i].body, env);
            if (node.cases[i].on) break; // <#on> 은 fall-through 없음
          }
        } catch (e) { if (!(e instanceof BreakSignal)) throw e; }
        return;
      }
      case "call": return execCall(node, env);
      case "nested": {
        const call = env.callStack[env.callStack.length - 1];
        if (!call) throw new FtlError("<#nested> 는 매크로 안에서만 쓸 수 있습니다", node.s);
        if (!call.body) return;
        const savedScopes = env.scopes;
        env.scopes = call.callerScopes;
        env.callStack.pop();
        try { execBody(call.body, env); } finally { env.callStack.push(call); env.scopes = savedScopes; }
        return;
      }
      case "compress": {
        const s = capture(env, () => execBody(node.body, env));
        env.out.push(s.replace(/[ \t]*\r?\n[\s]*/g, "\n").replace(/[ \t]+/g, " ").replace(/^\s+|\s+$/g, ""));
        return;
      }
      case "noautoesc": case "autoesc": {
        const saved = env.autoEsc; env.autoEsc = node.type === "autoesc";
        try { execBody(node.body, env); } finally { env.autoEsc = saved; }
        return;
      }
      case "block": execBody(node.body, env); return;
      case "attempt": {
        const saved = env.out; env.out = [];
        try { execBody(node.body, env); const s = env.out.join(""); env.out = saved; env.out.push(s); }
        catch (e) { env.out = saved; if (e instanceof BreakSignal || e instanceof ReturnSignal) throw e; execBody(node.recover, env); }
        return;
      }
      case "setting": {
        const v = env.need(evaluate(node.expr, env), node.expr);
        if (!(node.name in env.settings) && !/^(locale|time_zone|url_escaping_charset|output_encoding|classic_compatible|sql_date_and_time_time_zone)$/.test(node.name))
          throw new FtlError("지원하지 않는 설정: " + node.name, node.s);
        if (node.name === "boolean_format" && String(v) === "c") env.settings.boolean_format = "c";
        else if (node.name in env.settings) env.settings[node.name] = String(v);
        return;
      }
    }
    throw new FtlError("실행할 수 없는 노드: " + node.type, node.s || 0);
  }
  function lookupForAssign(env, scope, name) {
    if (scope === "local") { const sc = macroScope(env); return sc ? norm(sc.vars[name]) : undefined; }
    if (scope === "global") return name in env.globals ? norm(env.globals[name]) : env.lookup(name);
    return env.lookup(name);
  }
  function macroScope(env) { for (let i = env.scopes.length - 1; i >= 0; i--) if (env.scopes[i].macro) return env.scopes[i]; return null; }
  function setVar(env, scope, name, val, pos) {
    if (scope === "local") {
      const sc = macroScope(env);
      if (!sc) throw new FtlError("<#local> 은 매크로 안에서만 쓸 수 있습니다", pos);
      sc.vars[name] = val; return;
    }
    env.globals[name] = val;
  }
  function execList(node, env) {
    const raw = env.need(evaluate(node.expr, env), node.expr);
    let value = raw;
    if (raw === EMPTY) value = [];
    if (raw instanceof Range) throw new FtlError("끝이 없는 범위는 반복할 수 없습니다", node.expr.s);
    const isH = isHash(value);
    if (!Array.isArray(value) && !isH) throw new FtlError("<#list> 에는 시퀀스나 해시가 필요한데 '" + env.text(node.expr) + "' 은(는) " + typeName(value) + " 입니다", node.expr.s);
    if (isH && node.vars && node.vars.length === 1) throw new FtlError("해시를 반복하려면 <#list " + env.text(node.expr) + " as key, value> 형식을 쓰세요", node.expr.s);
    const size = isH ? Object.keys(value).length : value.length;
    if (size === 0) { if (node.elseBody) execBody(node.elseBody, env); return; }
    if (node.vars) { iterate(value, node.vars, node.body, env, node); return; }
    // <#list xs> ... <#items as x> ... </#items> ... </#list>
    env.itemsCtx = env.itemsCtx || [];
    env.itemsCtx.push({ value, node });
    try { execBody(node.body, env); } finally { env.itemsCtx.pop(); }
  }
  function iterate(value, vars, body, env, listNode) {
    const isH = isHash(value);
    const keys = isH ? Object.keys(value) : null;
    const size = isH ? keys.length : value.length;
    try {
      for (let i = 0; i < size; i++) {
        const scope = { vars: {}, loops: {} };
        const meta = { index: i, size };
        if (isH) {
          scope.vars[vars[0]] = keys[i];
          scope.loops[vars[0]] = meta;
          if (vars[1]) { scope.vars[vars[1]] = norm(value[keys[i]]); scope.loops[vars[1]] = meta; }
        } else {
          if (vars.length > 1) throw new FtlError("시퀀스는 <#list xs as x> 형식으로 반복합니다 (key, value 는 해시에만)", listNode.s);
          scope.vars[vars[0]] = norm(value[i]);
          scope.loops[vars[0]] = meta;
        }
        env.scopes.push(scope);
        env.loopStack.push(meta);
        try { execBody(body, env); } finally { env.scopes.pop(); env.loopStack.pop(); }
      }
    } catch (e) { if (!(e instanceof BreakSignal)) throw e; }
  }
  function execCall(node, env) {
    const m = env.root.macros[node.name];
    if (!m) {
      const v = env.lookup(node.name);
      throw new FtlError(v === undefined ? "정의되지 않은 매크로: <@" + node.name + ">" : "'" + node.name + "' 은(는) 매크로가 아닙니다", node.s);
    }
    const scope = { vars: {}, loops: {}, macro: true };
    const given = Object.assign({}, node.args);
    m.params.forEach((p, i) => { if (node.positional[i]) given[p.name] = node.positional[i]; });
    for (const k of Object.keys(given)) if (!m.params.some(p => p.name === k)) throw new FtlError("매크로 <@" + node.name + "> 에 '" + k + "' 매개변수가 없습니다 (사용 가능: " + (m.params.map(p => p.name).join(", ") || "없음") + ")", given[k].s);
    // 인자는 호출한 쪽 범위에서 평가
    for (const p of m.params) if (given[p.name]) scope.vars[p.name] = env.need(evaluate(given[p.name], env), given[p.name]);
    const callerScopes = env.scopes;
    env.scopes = [scope];
    try {
      for (const p of m.params) {
        if (p.name in scope.vars) continue;
        if (!p.def) throw new FtlError("매크로 <@" + node.name + "> 의 필수 매개변수 '" + p.name + "' 가 없습니다", node.s);
        scope.vars[p.name] = env.need(evaluate(p.def, env), p.def);
      }
      env.callStack.push({ body: node.body, callerScopes });
      try { execBody(m.body, env); }
      catch (e) { if (!(e instanceof ReturnSignal)) throw e; }
      finally { env.callStack.pop(); }
    } finally { env.scopes = callerScopes; }
  }

  // ------------------------------------------------------------------ 공개 API
  function decorate(err, src) {
    if (err && err.ftl) {
      const lc = lineCol(src, err.pos || 0);
      const e = new Error(err.message);
      e.line = lc.line; e.col = lc.col; e.engine = "freemarker"; e.kind = err instanceof MissingError ? "missing" : "template";
      return e;
    }
    if (err instanceof BreakSignal) { const e = new Error("<#break> 는 <#list> 또는 <#switch> 안에서만 쓸 수 있습니다"); e.line = 1; e.col = 1; return e; }
    return err;
  }
  const cache = { src: null, tree: null };
  const FreeMarker = {
    id: "freemarker",
    label: "FreeMarker",
    extensions: [".ftl", ".ftlh", ".html"],
    parse(src) {
      try { if (cache.src !== src) { cache.tree = buildTree(src); cache.src = src; } return cache.tree; }
      catch (e) { throw decorate(e, src); }
    },
    render(src, data, opts) {
      const tree = this.parse(src);
      const env = new Env(tree, data, Object.assign({}, opts, { src }));
      try { execBody(tree.body, env); }
      catch (e) { throw decorate(e, src); }
      return env.out.join("");
    },
    // 데이터셋 뼈대 만들기용: 템플릿에서 최상위 변수 이름 수집
    referencedNames(src) {
      const names = new Set(), local = new Set();
      let tree;
      try { tree = this.parse(src); collect(tree.body); Object.values(tree.macros).forEach(m => { m.params.forEach(p => { local.add(p.name); walkExpr(p.def); }); collect(m.body); }); } catch (e) { return []; }
      return [...names].filter(n => !local.has(n));
      function walkExpr(x) {
        if (!x || typeof x !== "object") return;
        if (x.type === "var") names.add(x.name);
        for (const k of ["obj", "idx", "target", "def", "arg", "left", "right", "inner", "expr", "cond"]) if (x[k]) walkExpr(x[k]);
        if (x.items) x.items.forEach(walkExpr);
        if (x.pairs) x.pairs.forEach(p => { walkExpr(p[0]); walkExpr(p[1]); });
        if (x.args && Array.isArray(x.args)) x.args.forEach(walkExpr);
        if (x.parts) x.parts.forEach(p => typeof p === "object" && walkExpr(p));
      }
      function collect(nodes) {
        for (const n of nodes || []) {
          if (n.vars) n.vars.forEach(v => local.add(v));
          if (n.ops) n.ops.forEach(o => local.add(o.name));
          if (n.type === "capture") local.add(n.name);
          if (n.expr) walkExpr(n.expr);
          if (n.branches) n.branches.forEach(b => { walkExpr(b.cond); collect(b.body); });
          if (n.ops) n.ops.forEach(o => walkExpr(o.expr));
          if (n.args && !Array.isArray(n.args)) Object.values(n.args).forEach(walkExpr);
          if (n.positional) n.positional.forEach(walkExpr);
          ["body", "elseBody", "pre", "recover"].forEach(k => n[k] && collect(n[k]));
          if (n.cases) n.cases.forEach(c => { (c.values || []).forEach(walkExpr); collect(c.body); });
        }
      }
    },
  };

  global.TemplateEngines = global.TemplateEngines || {};
  global.TemplateEngines.freemarker = FreeMarker;
  if (typeof module !== "undefined" && module.exports) module.exports = FreeMarker;
})(typeof window !== "undefined" ? window : globalThis);
