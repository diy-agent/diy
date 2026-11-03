// shared/xml-tags.ts — 识别"输出侧伪 XML 节标签"的纯函数（无 node/Electron 依赖，main/renderer 都能用）
//
// 为什么要自动收集、不硬编码：模版里新增一个节标签（如 `<diy-new>`）时，编辑器着色不该"静默不认"。
// 已知标签从**各模版正文**收集（唯一真源 = 模版本身），新增标签零改动即可着色。
//
// 着色判据（两条，覆盖"刚写下还没保存"的场景）：
//   ① 名字在已知集合里 → 着色（正文里提到 `<pid>` 这类不在集合里，天然排除）
//   ② 或者这个标签**独占一行** → 着色（新写的 `<diy-new>` 立刻可见；正文里夹在句子中的 `<pid>` 不着色）
// 输出标签**永不解析**（引擎原则 §2.0：输出侧零转义），这里只是显示层装饰，不改任何文本。

/** 标签名形态：小写字母开头，后跟字母/数字/下划线/点/连字符 */
const TAG_RE = /<\/?([a-z][\w.-]*)((?:\s[^>]*)?)>/g;

/** 该处标签是否**独占一行**（本行除它之外只有空白） */
function isStandaloneAt(text: string, at: number, len: number): boolean {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const nl = text.indexOf("\n", at + len);
    const lineEnd = nl === -1 ? text.length : nl;
    return text.slice(lineStart, at).trim() === "" && text.slice(at + len, lineEnd).trim() === "";
}

/**
 * 收集一组模版正文里出现的节标签（排除控制标记 `<template>`）。
 * **只收独占一行的标签**：节标签按模版排版规则都独占一行，而正文里行内提到的
 * `<pid>`、`<tid>`（如 `` `projects/<pid>/tasks/<tid>` ``）只是举例，不该当成标签。
 */
export function collectTags(bodies: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const body of bodies) {
        for (const m of body.matchAll(TAG_RE)) {
            if (m[1] === "template") continue;
            if (!isStandaloneAt(body, m.index, m[0].length)) continue;
            out.add(m[1]!);
        }
    }
    return out;
}

export interface TagSpan {
    /** 整段 `<name …>` / `</name>` 的区间 */
    from: number;
    to: number;
    /** 标签名本身的区间 */
    nameFrom: number;
    nameTo: number;
    /** 属性区间（无属性时为 undefined） */
    attrFrom?: number;
    attrTo?: number;
}

/**
 * 在 text 里找出应着色的标签区间。返回按 from 升序、互不重叠。
 * `known` 为已知标签集合（见 collectTags）；独占一行的标签额外放行。
 */
export function findTags(text: string, known: ReadonlySet<string>): TagSpan[] {
    const out: TagSpan[] = [];
    for (const m of text.matchAll(TAG_RE)) {
        const name = m[1]!;
        if (name === "template") continue;
        const at = m.index;
        const whole = m[0];
        // 已知标签，或**独占一行**（刚写下的新标签立刻可见）
        if (!known.has(name) && !isStandaloneAt(text, at, whole.length)) continue;
        const nameAt = at + (whole.startsWith("</") ? 2 : 1);
        const closeAt = at + whole.length - 1;
        out.push({
            from: at,
            to: at + whole.length,
            nameFrom: nameAt,
            nameTo: nameAt + name.length,
            ...(m[2] ? { attrFrom: nameAt + name.length, attrTo: closeAt } : {}),
        });
    }
    return out;
}
