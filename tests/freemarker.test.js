// FreeMarker 엔진 테스트:  node tests/freemarker.test.js
// 기대값은 실제 FreeMarker 2.3.x 동작 기준입니다.
const fm = require("../static/engines/freemarker.js");

let pass = 0, fail = 0;
function eq(name, tpl, data, expected, opts) {
  let got;
  try { got = fm.render(tpl, data || {}, opts); } catch (e) { got = "ERROR: " + e.message + " @" + e.line + ":" + e.col; }
  if (got === expected) pass++;
  else { fail++; console.log("FAIL", name, "\n  tpl:", JSON.stringify(tpl), "\n  want:", JSON.stringify(expected), "\n  got: ", JSON.stringify(got)); }
}
function err(name, tpl, data, re, line) {
  try { const out = fm.render(tpl, data || {}); fail++; console.log("FAIL (no error)", name, JSON.stringify(out)); }
  catch (e) {
    if (re.test(e.message) && (line === undefined || e.line === line)) pass++;
    else { fail++; console.log("FAIL", name, "\n  want error:", re, "line", line, "\n  got:", e.message, "@" + e.line + ":" + e.col); }
  }
}

const d = {
  user: { name: "홍길동", dept: "경영지원팀", age: 33, vip: true, email: null, tags: ["a", "b", "c"] },
  items: [{ name: "사과", price: 1200, qty: 3 }, { name: "배", price: 2500.5, qty: 1 }],
  empty: [], n: 1234567.891, s: "Hello World", map: { x: 1, y: 2 }, zero: 0, html: "<b>&</b>",
  date: "2026-10-26T14:30:05", day: "2026-10-26",
};

// 보간 / 기본값 / 존재
eq("interp", "안녕 ${user.name}님", d, "안녕 홍길동님");
eq("number default fmt", "${n}", d, "1,234,567.891");
eq("number int", "${user.age}", d, "33");
eq("number ?c", "${n?c}", d, "1234567.891");
eq("number fmt", "${items[1].price?string('0.00')}", d, "2500.50");
eq("number fmt grouping", "${n?string('#,##0')}", d, "1,234,568");
eq("number currency", "${items[0].price?string.currency}", d, "₩1,200");
eq("number percent", "${0.256?string.percent}", d, "26%");
eq("half even", "${2.5?string('0')} ${3.5?string('0')}", d, "2 4");
eq("default", "${user.nick!'없음'}", d, "없음");
eq("default empty", "[${user.nick!}]", d, "[]");
eq("default null", "${user.email!'-'}", d, "-");
eq("default paren chain", "${(user.a.b.c)!'x'}", d, "x");
err("default no paren chain", "${user.a.b!'x'}", d, /값이 없습니다: user\.a/);
eq("exists", "${user.name???c} ${user.email???c} ${(no.such)???c}", d, "true false false");
err("missing", "줄1\n${user.nick}", d, /값이 없습니다: user\.nick/, 2);
err("boolean output", "${user.vip}", d, /boolean 값은 바로 출력할 수 없습니다/);
eq("boolean string", "${user.vip?string('예','아니오')} ${user.vip?c}", d, "예 true");
err("hash output", "${user}", d, /해시 은\(는\) 그대로 출력할 수 없습니다/);
eq("string literal interp", "<#assign g = \"${user.name}(${user.dept})\">${g}", d, "홍길동(경영지원팀)");
eq("concat", "${user.name + '님 ' + user.age}", d, "홍길동님 33");
eq("arith", "${items[0].price * items[0].qty} ${7 % 3} ${10 / 4}", d, "3,600 1 2.5");
eq("escape off", "${html}", d, "<b>&</b>");
eq("escape on", "${html} ${html?no_esc}", d, "&lt;b&gt;&amp;&lt;/b&gt; <b>&</b>", { autoEscape: true });
eq("?html", "${html?html}", d, "&lt;b&gt;&amp;&lt;/b&gt;");

// 문자열 내장함수
eq("str bi", "${s?upper_case} ${s?lower_case} ${s?length} ${'abc'?cap_first} ${'hello world'?capitalize}", d, "HELLO WORLD hello world 11 Abc Hello World");
eq("replace/contains", "${s?replace('o','0')} ${s?contains('World')?c} ${s?starts_with('He')?c}", d, "Hell0 W0rld true true");
eq("split/join", "${'a,b,c'?split(',')?join('-')}", d, "a-b-c");
eq("pad", "[${'7'?left_pad(3,'0')}][${'ab'?right_pad(4)}]", d, "[007][ab  ]");
eq("keep", "${'a@b.com'?keep_before('@')} ${'a@b.com'?keep_after('@')}", d, "a b.com");
eq("number parse", "${'12.5'?number + 1}", d, "13.5");
eq("truncate", "${'가나다라마바사'?truncate(5,'…')}", d, "가나다라…");
eq("slice", "${s[0..4]} ${s[6..]}", d, "Hello World");

// 날짜
eq("datetime iso fmt", "${date?datetime.iso?string('yyyy-MM-dd HH:mm')}", d, "2026-10-26 14:30");
eq("date iso default", "${day?date.iso}", d, "2026-10-26");
eq("date pattern", "${'2026/10/26'?date('yyyy/MM/dd')?string('yyyy년 M월 d일 (E)')}", d, "2026년 10월 26일 (월)");
eq("ampm", "${date?datetime.iso?string('a h:mm')}", d, "오후 2:30");
err("date no fmt", "${day?date}", d, /형식을 지정하세요/);

// if
eq("if", "<#if user.age gt 30>A<#elseif user.age gt 20>B<#else>C</#if>", d, "A");
eq("if paren gt", "<#if (user.age > 40)>A<#else>C</#if>", d, "C");
eq("if eq =", "<#if user.dept = '경영지원팀'>Y</#if>", d, "Y");
eq("if &&||!", "<#if user.vip && !(user.age < 10) || false>Y</#if>", d, "Y");
eq("if has_content", "<#if empty?has_content>Y<#else>N</#if><#if user.tags?has_content>Y</#if><#if no.such?has_content>Y<#else>N</#if>", d, "NYN");
err("if non-boolean", "<#if user.name>Y</#if>", d, /boolean\(참\/거짓\) 이 필요한데 'user\.name' 은\(는\) 문자열/);
err("compare types", "<#if user.age == '33'>Y</#if>", d, /비교할 수 없습니다: 숫자 와\(과\) 문자열/);

// list
eq("list", "<#list items as it>${it?counter}.${it.name}<#sep>, </#list>", d, "1.사과, 2.배");
eq("list else", "<#list empty as x>${x}<#else>없음</#list>", d, "없음");
eq("list items", "<#list user.tags><ul><#items as t><li>${t}</li></#items></ul><#else>none</#list>", d, "<ul><li>a</li><li>b</li><li>c</li></ul>");
eq("list loop vars", "<#list user.tags as t>${t?index}${t?is_first?c[0]}${t?has_next?string('+','')}</#list>", d, "0t+1f+2f");
eq("list parity", "<#list user.tags as t>${t?item_parity}<#sep> </#list>", d, "odd even odd");
eq("list cycle", "<#list user.tags as t>${t?item_cycle('#fff','#eee')}<#sep>,</#list>", d, "#fff,#eee,#fff");
eq("list hash kv", "<#list map as k, v>${k}=${v}<#sep>&</#list>", d, "x=1&y=2");
eq("list range", "<#list 1..3 as i>${i}</#list><#list 0..<2 as i>${i}</#list>", d, "12301");
eq("list break", "<#list 1..10 as i><#if i == 3><#break></#if>${i}</#list>", d, "12");
eq("seq bi", "${user.tags?size} ${user.tags?first}${user.tags?last} ${user.tags?reverse?join('')} ${user.tags?seq_contains('b')?c}", d, "3 ac cba true");
eq("sort_by", "<#list items?sort_by('price')?reverse as it>${it.name}</#list>", d, "배사과");
eq("hash keys", "${map?keys?join(',')} ${map?values?join(',')}", d, "x,y 1,2");
err("list hash single var", "<#list map as x>${x}</#list>", d, /as key, value/);
err("list string", "<#list user.name as x></#list>", d, /시퀀스나 해시가 필요한데/);

// assign / switch / macro
eq("assign", "<#assign a = 1 b = a + 1>${a}${b}<#assign b += 10>${b}<#assign a++>${a}", d, "12122");
eq("assign capture", "<#assign box><b>${user.name}</b></#assign>${box}", d, "<b>홍길동</b>");
eq("hash literal + index", "<#assign st = {'DONE':'완료','WAIT':'대기'}>${st['DONE']} ${st.WAIT} ${st['X']!'?'}", d, "완료 대기 ?");
eq("seq literal", "<#list ['x','y'] as v>${v}</#list>", d, "xy");
eq("switch", "<#switch user.dept><#case '인사팀'>H<#break><#case '경영지원팀'>M<#break><#default>D</#switch>", d, "M");
eq("switch fallthrough", "<#switch 1><#case 1>a<#case 2>b<#break><#case 3>c</#switch>", d, "ab");
eq("switch default", "<#switch 9><#case 1>a<#default>z</#switch>", d, "z");
eq("macro", "<#macro btn label href='#' color='#F37321'><a href=\"${href}\" style=\"color:${color}\">${label}</a></#macro><@btn label='확인' href='/x'/>", d, "<a href=\"/x\" style=\"color:#F37321\">확인</a>");
eq("macro nested", "<#macro row label><tr><td>${label}</td><td><#nested></td></tr></#macro><@row label='이름'>${user.name}</@row>", d, "<tr><td>이름</td><td>홍길동</td></tr>");
eq("macro local", "<#macro m><#local x = 5>${x}</#macro><@m/>${x!'none'}", d, "5none");
err("macro missing param", "<#macro m a>${a}</#macro><@m/>", d, /필수 매개변수 'a'/);
err("macro unknown param", "<#macro m a>${a}</#macro><@m a=1 b=2/>", d, /'b' 매개변수가 없습니다/);
err("undefined macro", "<@nope/>", d, /정의되지 않은 매크로/);
eq("macro defined after use", "<@m/><#macro m>M</#macro>", d, "M");
eq("then", "${user.vip?then('VIP','일반')}", d, "VIP");
eq("switch bi", "${'B'?switch('A','에이','B','비','기타')}", d, "비");

// 기타 지시어
eq("comment", "a<#-- 주석 ${x} -->b", d, "ab");
eq("noparse", "<#noparse>${user.name}</#noparse>", d, "${user.name}");
eq("compress", "<#compress>  a  \n\n   b  </#compress>", d, "a\nb");
eq("attempt", "<#attempt>${nope}<#recover>대체</#attempt>", d, "대체");
eq("setting number_format", "<#setting number_format='0.#'>${n}", d, "1234567.9");
eq("setting boolean_format", "<#setting boolean_format='Y,N'>${user.vip}", d, "Y");
eq("ftl ignored", "<#ftl encoding='utf-8'>ok", d, "ok");

// 공백 제거 (FTL 태그만 있는 줄은 사라짐)
eq("ws strip", "<ul>\n  <#list user.tags as t>\n  <li>${t}</li>\n  </#list>\n</ul>", d, "<ul>\n  <li>a</li>\n  <li>b</li>\n  <li>c</li>\n</ul>");
eq("ws strip if", "A\n<#if true>\nB\n</#if>\nC", d, "A\nB\nC");
eq("ws keep content line", "A <#if true>B</#if>\nC", d, "A B\nC");
eq("ws comment line", "A\n  <#-- 주석 -->\nB", d, "A\nB");

// 구문 오류 위치
err("unclosed if", "a\n<#if true>\nb", d, /<#if> 가 닫히지 않았습니다/, 2);
err("mismatched end", "<#list items as i>\n</#if>", d, /<\/#list> 가 와야 할 곳에 <\/#if>/, 2);
err("unknown directive", "\n\n<#foo>", d, /알 수 없는 FreeMarker 지시어: <#foo>/, 3);
err("unclosed interp", "x ${user.name", d, /\$\{ 가 닫히지 않았습니다/, 1);
err("bad expr", "${user.}", d, /'\.' 뒤에 이름이 필요합니다/);
err("unknown builtin", "${s?foo}", d, /알 수 없는 내장함수 \?foo/);
err("bi wrong type", "${user.age?upper_case}", d, /\?upper_case 는 숫자 에는 쓸 수 없습니다/);
err("include", "<#include 'x.ftl'>", d, /<#include> 를 지원하지 않습니다/);
err("else outside", "<#else>", d, /<#else> 는 <#if> 또는 <#list> 안에서만/);
err("loop bi on non-loop", "${s?index}", d, /반복 변수에만/);

// 데이터셋 이름 수집
const names = fm.referencedNames("<#assign a = 1>${user.name} <#list items as it>${it.x}</#list> <#if flag??></#if> <@m x=other/>");
const want = ["user", "items", "flag", "other"];
if (want.every(n => names.includes(n)) && names.length === want.length) pass++; else { fail++; console.log("FAIL referencedNames", names); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
