// scripts/lib/source-scan.mjs —— 手写 TS 扫描的**共用底层**（注释/字符串/正则掩码 + 括号配对）。
//
// 为什么单独一处：`check-atomic-write.mjs`（##383）与 `check-error-code.mjs`（##394）都要在
// 「只留真代码」的文本上找调用点。各抄一份 lexer 就是两份会**各自腐坏**的判据（其中一份忘补
// 正则字面量识别 ⇒ 那一路静默失明，假阴性比不扫更糟）。故实现只此一份。
//
// 用法：`maskNonCode(src)` 拿到与原文**等长、等换行、等偏移**的掩码文本，再用正则去扫；
// 需要跨行实参时用 `matchingParen` 在掩码文本上配对（天然跳过字符串里的括号）。

/** `/` 前一个非空白字符是这些 ⇒ 后面是**正则字面量**起点，不是除号 */
const REGEX_PREFIX_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "<", ">", "~", "^", "}"]);
/** `/` 前一个单词是这些 ⇒ 后面是正则起点（`return /x/`、`typeof /x/`） */
const REGEX_PREFIX_WORDS = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "instanceof", "new", "do", "else", "yield", "await"]);

/** 判 `/` 是除号还是正则起点（按前一个可见 token 判，ECMAScript 语法的经典近似） */
function regexAllowedBefore(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j < 0) return true;
  const ch = src[j];
  if (/[A-Za-z0-9_$]/.test(ch)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k -= 1;
    return REGEX_PREFIX_WORDS.has(src.slice(k + 1, j + 1));
  }
  if (ch === ")" || ch === "]") return false; // `f(x) / 2`、`a[i] / 2`
  return REGEX_PREFIX_PUNCT.has(ch) || ch === "/";
}

/** 把注释 / 字符串 / 模板字面量 / **正则字面量**替换成空格（保留换行与偏移），只留真代码。
 *  模板里的 `${…}` 仍按代码扫描（里面可以有真实调用）。
 *  正则字面量必须识别：`const re = /\/\//; writeFileSync(p, x)` 里的 `//` 若被当成行注释，
 *  该行后续会整段失明（假阴性）。 */
export function maskNonCode(src) {
  const out = src.split("");
  const stack = []; // "template" | "code"
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); i += 1; continue; }
      if (c === "$" && src[i + 1] === "{") { stack.push("code"); i += 2; continue; }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    // code 模式
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = src.length;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j < 0 ? src.length : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && regexAllowedBefore(src, i)) {
      // 正则字面量：跳过转义、字符类，直到收尾的 `/`，再吃掉 flags
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") { j += 1; break; } // 未闭合：别吞掉后续行
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { j += 1; break; }
        j += 1;
      }
      while (j < src.length && /[a-z]/.test(src[j])) j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === q) { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "`") { stack.push("template"); i += 1; continue; }
    if (top === "code" && c === "}") { stack.pop(); i += 1; continue; }
    i += 1;
  }
  return out.join("");
}

/** 从 `(` 起找配对的 `)`（在掩码后的代码上走，天然跳过字符串/注释） */
export function matchingParen(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i += 1) {
    if (masked[i] === "(") depth += 1;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}


