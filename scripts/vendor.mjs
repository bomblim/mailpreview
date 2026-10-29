// node_modules 의 CodeMirror 5 / pdf.js 를 static/vendor 로 복사 (exe 에 embed 되어 오프라인 동작)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const nm = (...p) => path.join(root, "node_modules", ...p);
const out = (...p) => path.join(root, "static", "vendor", ...p);

fs.rmSync(out(), { recursive: true, force: true });
fs.mkdirSync(out("codemirror"), { recursive: true });
fs.mkdirSync(out("pdfjs"), { recursive: true });

// CodeMirror: 필요한 모드/애드온을 하나로 합침
const cm = (p) => fs.readFileSync(nm("codemirror", p), "utf8");
const bundle = [
  "lib/codemirror.js", "mode/xml/xml.js", "mode/css/css.js", "mode/javascript/javascript.js",
  "mode/htmlmixed/htmlmixed.js", "addon/edit/closetag.js", "addon/fold/xml-fold.js",
  "addon/edit/matchtags.js", "addon/search/searchcursor.js", "addon/search/search.js", "addon/dialog/dialog.js",
  "addon/mode/overlay.js",
].map(cm).join("\n");
fs.writeFileSync(out("codemirror", "codemirror-bundle.js"), bundle);
for (const [src, dst] of [["lib/codemirror.css", "codemirror.css"], ["theme/material-darker.css", "material-darker.css"],
                          ["addon/dialog/dialog.css", "dialog.css"], ["LICENSE", "LICENSE"]]) {
  fs.copyFileSync(nm("codemirror", src), out("codemirror", dst));
}

// pdf.js
for (const f of ["build/pdf.min.js", "build/pdf.worker.min.js", "LICENSE"]) {
  fs.copyFileSync(nm("pdfjs-dist", f), out("pdfjs", path.basename(f)));
}
fs.cpSync(nm("pdfjs-dist", "cmaps"), out("pdfjs", "cmaps"), { recursive: true });
fs.cpSync(nm("pdfjs-dist", "standard_fonts"), out("pdfjs", "standard_fonts"), { recursive: true });

console.log("vendor ->", out());
