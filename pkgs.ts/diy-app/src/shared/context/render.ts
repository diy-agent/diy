// src/shared/context/render.ts
// 🎯 把 Context Tree 渲染成 YAML 投递文本（纯函数）。
//
// 为什么整份就是 YAML、不再套自创的 XML 外壳：Context Tree **本身是一棵树**，
// YAML 的嵌套结构天然表达了「谁是父、谁是子、值是什么」；再加一层
// `<context path="x.y">` 只是把同一件事说两遍（重复 path、多一层标签、多耗 token）。
// 144 的原话是「YAML 用于变量节点渲染」—— 那层标签是实现时自己加的，现按原设计撤回。
//
// 三类节点落法：
//   · 值节点      → YAML 标量 / 嵌套映射 / 序列
//   · 模板节点    → 渲染后文本，作为 **YAML 块标量**（`|`）落在该 path 上
//   · 容器（对象）→ 只输出结构，不重复输出「整棵子树摘要」（父层级不显示值）
//
// YAML 自己实现而不引 js-yaml：输出必须**逐字节可预测**（golden 测试拿它当基准），
// 且 shared/ 要能进 renderer 包（零 node 依赖）。

import { render as renderTemplate } from "@diy/template";
import { getValue, hasValue, isPlainObject } from "./tree";
import type { ContextPath, ContextTreeState } from "./types";

const YAML_RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~", ""]);

/** 前导空格数（块缩进判定用） */
function leadingSpaces(s: string): number {
    return s.length - s.replace(/^ +/, "").length;
}

/** 尾部换行数（决定块标量 chomping） */
function trailingNewlines(s: string): number {
    const m = /(\n+)$/.exec(s);
    return m ? m[1]!.length : 0;
}

/**
 * 多行文本 → YAML 块标量的**头标记 + 内容行**（空行不加缩进，避免尾随空格）。
 *
 * 两个实测踩坑（都会让整份 YAML 解析失败 / 悄悄改内容）：
 *
 * ① **缩进指示符**：内容行自身可能带前导空格（工具输出右对齐的行号、整段缩进的代码等）。
 *   YAML 默认按"首个非空行"自动判定块缩进 —— 于是两种翻车（都在真实历史里踩到）：
 *   · 首行缩进比后面的行深 → 后面的行掉出块，整份 YAML 解析报错
 *     （`wc -l` 的 `   352 …` + `38556 …`，338 条历史的请求预览崩在 509 行）
 *   · 整段有**公共缩进** → 那段缩进被当成块缩进削掉，回读丢内容（源码类工具输出）
 *   两者都靠**首行有前导空格就给 `|2`** 解决（2 = 内容相对父级缩进 2 格，与本函数 `+1`
 *   级一致；对象字段 / 序列项 / 顶层三种落位都验证过）。
 *
 * ② **chomping**：`|` 是 clip（回读必补一个尾换行）。原值尾换行为 0 时必须写 `|-`（strip），
 *   否则回读值凭空多一个 `\n` —— 「解析的就是那段原文」就不成立了。≥2 个尾换行交回调用方
 *   退回转义标量（罕见，且 `|+` 的构造易错）。
 *
 * 只在需要时才写指示符：常规文本仍是 `|`，与旧输出逐字节一致（golden 不受影响）。
 */
function blockScalarOf(text: string, indent: number): { marker: string; lines: string[] } {
    const blk = "  ".repeat(indent + 1);
    const k = trailingNewlines(text);
    const chomp = k === 0 ? "-" : "";
    const body = k >= 1 ? text.slice(0, -1) : text;
    const lines = body.split("\n").map((l) => (l.length > 0 ? blk + l : ""));
    const nonEmpty = lines.filter((l) => l.length > 0);
    // 注意：判的是**内容自身**的前导空格（减掉统一加的 blk），不是渲染后的行缩进
    const first = nonEmpty.length > 0 ? leadingSpaces(nonEmpty[0]!) - blk.length : 0;
    // 首行**有**前导空格 → 必须 `|2`：自动判定会把「首行缩进」当成块缩进，
    // 于是内容的公共缩进被悄悄削掉（整段代码缩进消失），或后续浅行直接掉出块。
    const indicator = first === 0 ? "" : "2";
    return { marker: `|${indicator}${chomp}`, lines };
}

/**
 * 块标量**表达不了**的字符：YAML 只允许可打印字符（+ tab / 换行）。
 * 终端 ANSI 色码（ESC）、\r、C0/C1 控制字符都只有双引号转义风格能承载。
 */
const BLOCK_UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/**
 * 多行文本 → YAML 落法（三种落位共用）：
 *   · 常规 → 块标量（`|` / `|2`，见 blockScalarOf）
 *   · 含控制字符 → **双引号转义标量**（JSON.stringify 的转义是 YAML 双引号转义的子集）
 *     —— 实测：工具输出里的 ANSI 色码会让整份 YAML 解析报「non-printable characters」。
 *   · 尾换行 ≥2 个 → 同样退回转义标量（块标量的 `|+` 构造易错，而这两种都罕见）
 *     保真优先：仍是那段原文，只是转义写出来（想看可读形态切「原文」）。
 * 返回值：`marker` 直接接在 `key: ` / `- ` / 裸位置之后；`lines` 是块标量的内容行。
 */
function multilineIn(text: string, indent: number): { marker: string; lines: string[] } {
    if (BLOCK_UNSAFE.test(text)) return { marker: JSON.stringify(text), lines: [] };
    if (trailingNewlines(text) >= 2) return { marker: JSON.stringify(text), lines: [] };
    return blockScalarOf(text, indent);
}

/** 多行字符串 = 需要用块标量输出 */
function isMultiline(v: unknown): v is string {
    return typeof v === "string" && v.includes("\n");
}

/** 单行标量 → YAML 字面量（该加引号就加，保证可回读） */
function scalarYaml(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v !== "string") return JSON.stringify(v);
    const plain = /^[A-Za-z0-9_/][A-Za-z0-9_./@ :\-]*$/.test(v) && !YAML_RESERVED.has(v);
    return plain ? v : JSON.stringify(v);
}

/**
 * 内嵌 YAML 块（请求预览用，见 request.ts）：产出时遇到**与它逐字相等**的字符串，
 * 就把它展开为解析结果。说明头（原样行）按注释输出 —— 它是"yaml 上面的解释文字"、不是数据，
 * 注释是它在 YAML 里唯一合法的位置（内容不丢、整份仍是合法 YAML）。
 */
export interface EmbedSpec {
    /** 说明头：逐行输出为注释（空行输出空行；`#` 开头的行原样，不叠成 `# #`） */
    guide?: string[];
    /** 解析后的结构（对象/数组） */
    value: unknown;
}

/** 行式产出器：YAML 的唯一实现（`toYaml` 也走它），可选收集每个 path 的行号区间 */
interface EmitSink {
    lines: string[];
    /** path → 行号区间（1 基闭区间） */
    spans: Map<ContextPath, { from: number; to: number }>;
    /** 内嵌文本表（请求预览专用；缺省不启用） */
    embeds?: ReadonlyMap<string, EmbedSpec>;
}

/** 内嵌块 → 若干行：说明头按注释、数据递归产出（行号映射随产出直接收集，与文本同源） */
function emitEmbed(emb: EmbedSpec, indent: number, path: ContextPath, sink: EmitSink): void {
    const pad = "  ".repeat(indent);
    const start = sink.lines.length + 1;
    for (const line of emb.guide ?? []) {
        sink.lines.push(line.length === 0 ? "" : line.startsWith("#") ? `${pad}${line}` : `${pad}# ${line}`);
    }
    emitValue(emb.value, indent, "", sink);
    if (path) sink.spans.set(path, { from: start, to: sink.lines.length });
}

/**
 * 值 → 若干行 YAML。
 * `path` 非空时把「这个 path 产出的行」记进 spans（**含它的 key 行** —— 高亮时
 * 连 `diy.cli:` 一起亮比只亮值更好认）。
 */
function emitValue(v: unknown, indent: number, path: ContextPath, sink: EmitSink): void {
    const pad = "  ".repeat(indent);
    const mark = (fromLine: number): void => {
        if (path) sink.spans.set(path, { from: fromLine + 1, to: sink.lines.length });
    };
    // 内嵌 YAML 文本（请求预览）：就地展开为子节点 —— 解析的就是这段原文本身
    const emb = typeof v === "string" ? sink.embeds?.get(v) : undefined;
    if (emb) {
        emitEmbed(emb, indent, path, sink);
        return;
    }
    // 多行字符串（模版产出）→ 块标量
    if (isMultiline(v)) {
        const from = sink.lines.length;
        const { marker, lines } = multilineIn(v, indent);
        sink.lines.push(`${pad}${marker}`);
        sink.lines.push(...lines);
        mark(from);
        return;
    }
    if (Array.isArray(v)) {
        const from = sink.lines.length;
        if (v.length === 0) sink.lines.push(`${pad}[]`);
        else {
            v.forEach((item, idx) => {
                // 元素用**下标段**寻址（`chain.0`），与 getValue/JSONPath 的口径一致
                const childPath = path ? `${path}.${idx}` : String(idx);
                const before = sink.lines.length;
                const markItem = (): void => {
                    sink.spans.set(childPath, { from: before + 1, to: sink.lines.length });
                };
                const emb = typeof item === "string" ? sink.embeds?.get(item) : undefined;
                if (emb) {
                    // 序列元素是内嵌块：`-` 单独一行，块（注释 + 数据）缩进对齐
                    sink.lines.push(`${pad}-`);
                    emitEmbed(emb, indent + 1, "", sink);
                    markItem();
                } else if (isMultiline(item)) {
                    const { marker, lines } = multilineIn(item, indent);
                    sink.lines.push(`${pad}- ${marker}`);
                    sink.lines.push(...lines);
                    markItem();
                } else if (isPlainObject(item) || (Array.isArray(item) && item.length > 0)) {
                    // 对象/序列项：首行并到 `- ` 之后，其余行缩进对齐（YAML 惯例写法）
                    const inner: EmitSink = { lines: [], spans: new Map(), embeds: sink.embeds };
                    emitValue(item, indent + 1, childPath, inner);
                    const head = inner.lines[0]!.slice((indent + 1) * 2);
                    sink.lines.push(`${pad}- ${head}`);
                    // 续行的自身缩进已是 (indent+1)*2（与 `- ` 后的首行对齐），原样保留
                    for (const l of inner.lines.slice(1)) sink.lines.push(l);
                    // 临时 sink 的行号平移回全局：它第 1 行落在 before+1
                    for (const [p, sp] of inner.spans) {
                        sink.spans.set(p, { from: sp.from + before, to: sp.to + before });
                    }
                    markItem();
                } else {
                    sink.lines.push(`${pad}- ${scalarYaml(item)}`);
                    markItem();
                }
            });
        }
        mark(from);
        return;
    }
    if (isPlainObject(v)) {
        const from = sink.lines.length;
        const keys = Object.keys(v);
        if (keys.length === 0) sink.lines.push(`${pad}{}`);
        else {
            for (const k of keys) {
                const val = v[k];
                const childPath = path ? `${path}.${k}` : k;
                const childFrom = sink.lines.length;
                const emb = typeof val === "string" ? sink.embeds?.get(val) : undefined;
                if (emb) {
                    // 内嵌块：key 独立一行，块内容（注释 + 解析结果）缩进一级
                    sink.lines.push(`${pad}${k}:`);
                    emitEmbed(emb, indent + 1, "", sink);
                    sink.spans.set(childPath, { from: childFrom + 1, to: sink.lines.length });
                    continue;
                }
                if (isMultiline(val)) {
                    const { marker, lines } = multilineIn(val, indent);
                    sink.lines.push(`${pad}${k}: ${marker}`);
                    sink.lines.push(...lines);
                    sink.spans.set(childPath, { from: childFrom + 1, to: sink.lines.length });
                    continue;
                }
                const nested = isPlainObject(val) || (Array.isArray(val) && val.length > 0);
                if (nested && Object.keys(val as object).length > 0) {
                    sink.lines.push(`${pad}${k}:`);
                    // 子层用「继承的 path」递归，好让 spans 里的 key 与变量树一致
                    emitValue(val, indent + 1, childPath, sink);
                } else {
                    sink.lines.push(`${pad}${k}: ${scalarYaml(val)}`);
                    sink.spans.set(childPath, { from: childFrom + 1, to: sink.lines.length });
                }
            }
        }
        mark(from);
        return;
    }
    const from = sink.lines.length;
    sink.lines.push(`${pad}${scalarYaml(v)}`);
    mark(from);
}

/** 值 → YAML 文本（缩进 2 空格；空对象/空数组输出 `{}` / `[]`，与「该 path 没有值」区分） */
export function toYaml(v: unknown, indent = 0): string {
    const sink: EmitSink = { lines: [], spans: new Map() };
    emitValue(v, indent, "", sink);
    return sink.lines.join("\n");
}

/** 通用产出：值 → YAML 文本 + 行号映射（请求预览用；`embeds` 见 request.ts） */
export function emitYamlTraced(v: unknown, embeds?: ReadonlyMap<string, EmbedSpec>): RenderedYaml {
    const sink: EmitSink = { lines: [], spans: new Map(), embeds };
    emitValue(v, 0, "", sink);
    return { text: sink.lines.join("\n"), lines: Object.fromEntries(sink.spans) };
}

/**
 * 值树里某个子树的所有叶子 path（相对根的完整 path）。
 * `present` = 该 path 在值树里**确实有值**（undefined 视为无）——「没有值」与「值是 null /
 * 空对象」是两回事：前者不产出渲染单元（模板节点就是这种），后者要渲染成 `null` / `{}`。
 */
export function leafPaths(values: unknown, base = "", present = true): ContextPath[] {
    if (!isPlainObject(values) || Object.keys(values).length === 0) {
        return present && base ? [base] : [];
    }
    const out: ContextPath[] = [];
    for (const [k, v] of Object.entries(values)) {
        const path = base ? `${base}.${k}` : k;
        if (isPlainObject(v) && Object.keys(v).length > 0) out.push(...leafPaths(v, path, true));
        else out.push(path);
    }
    return out;
}

/** 取子树（path 处的值） */
function subtreeAt(values: Record<string, unknown>, path: ContextPath): unknown {
    let cur: unknown = values;
    for (const seg of path.split(".")) {
        if (!isPlainObject(cur)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/**
 * 组装「投递视图」：递归值树，把模板声明处换成**渲染后的文本**，
 * 并补上「只有模板声明、值树里没有值」的 path（模板节点就是这种）。
 */
function buildView(state: ContextTreeState, node: unknown, path: string): unknown {
    const spec = state.renderers[path];
    if (spec?.renderer === "template") {
        return renderTemplate(spec.source, { globals: state.values });
    }
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
        out[k] = buildView(state, v, path ? `${path}.${k}` : k);
    }
    // 补：子树里「只有模板声明」的 path（值树里没有对应节点）
    const prefix = path ? `${path}.` : "";
    for (const p of Object.keys(state.renderers)) {
        if (!p.startsWith(prefix) || p === path) continue;
        const segs = (path ? p.slice(prefix.length) : p).split(".");
        let cur = out;
        for (const s of segs.slice(0, -1)) {
            if (!isPlainObject(cur[s])) cur[s] = {};
            cur = cur[s] as Record<string, unknown>;
        }
        const leaf = segs[segs.length - 1];
        if (!(leaf in cur)) cur[leaf] = buildView(state, undefined, p);
    }
    return out;
}

/** 一个 place 的渲染单元（叶子 path ∪ 模板声明 path，字典序 —— golden 稳定） */
export function renderUnitsOf(state: ContextTreeState, place: ContextPath): ContextPath[] {
    const sub = subtreeAt(state.values, place);
    const leaves = leafPaths(sub, place, hasValue(state, place));
    const templates = Object.keys(state.renderers).filter(
        (p) => state.renderers[p].renderer === "template" && (p === place || p.startsWith(`${place}.`)),
    );
    return [...new Set([...leaves, ...templates])].sort();
}

/** 从视图里裁出某个 place 的子树 */
function pick(view: unknown, path: ContextPath): unknown {
    let cur: unknown = view;
    for (const s of path.split(".")) {
        if (!isPlainObject(cur) || !(s in cur)) return undefined;
        cur = cur[s];
    }
    return cur;
}

/** 深合并（对象递归合并，其余后者覆盖前者） */
function merge(a: unknown, b: unknown): unknown {
    if (isPlainObject(a) && isPlainObject(b)) {
        const out: Record<string, unknown> = { ...a };
        for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
        return out;
    }
    return b;
}

/** 把值挂到点分段路径上：`env.os` + v → `{env:{os:v}}` */
function nest(path: ContextPath, value: unknown): unknown {
    const segs = path.split(".");
    let out: unknown = value;
    for (let i = segs.length - 1; i >= 0; i--) out = { [segs[i]]: out };
    return out;
}

/** 把一组 path 的子树拼成一个对象（多个 place 共享祖先时自动合并） */
function composeSubset(state: ContextTreeState, paths: readonly ContextPath[]): unknown {
    const view = buildView(state, state.values, "");
    let out: unknown = {};
    for (const p of paths) {
        const sub = pick(view, p);
        if (sub === undefined) continue;
        out = merge(out, nest(p, sub));
    }
    return out;
}

/** 渲染一组 path → YAML 文本（空则空串；path 先排序保证输出稳定） */
export function renderPaths(state: ContextTreeState, paths: readonly ContextPath[]): string {
    if (paths.length === 0) return "";
    return toYaml(composeSubset(state, [...paths].sort()));
}

/**
 * 渲染一组 path，同时给出**每个 path 在文本里的行号区间**。
 *
 * 为什么要它：选中结构树/变量树的一行时，要能把预览滚到对应位置并高亮那几行 ——
 * 这要求「path → 文本区间」的映射与渲染**出自同一份代码**，否则两边一旦不同步，
 * 高亮就会指错行（这比不高亮更糟）。
 *
 * 行号 1 基，闭区间。
 */
export interface RenderedYaml {
    text: string;
    /** path → 行号区间（仅包含确实产出文本的 path） */
    lines: Record<ContextPath, { from: number; to: number }>;
}

export function renderPathsTraced(
    state: ContextTreeState,
    paths: readonly ContextPath[],
    /** 拼在最前面的纯文本说明（结构 / 解读规则）。见 guide.ts */
    preamble?: string,
): RenderedYaml {
    if (paths.length === 0 && !preamble) return { text: "", lines: {} };
    const sink: EmitSink = { lines: [], spans: new Map() };

    // 说明头先占位。**不需要额外偏移**：emitValue 记的行号本来就以 sink.lines 为准
    // （它读的就是「此刻已推入多少行」），所以 preamble 已被自然计入。
    if (preamble) {
        sink.lines.push(...preamble.replace(/\n$/, "").split("\n"));
        sink.lines.push("");
    }
    emitValue(composeSubset(state, [...paths].sort()), 0, "", sink);
    return { text: sink.lines.join("\n"), lines: Object.fromEntries(sink.spans) };
}

/** 渲染一个 place → YAML 文本 */
export function renderPlace(state: ContextTreeState, place: ContextPath): string {
    return renderPaths(state, [place]);
}

/** 渲染一组 place → 投递文本 */
export function renderPlaces(state: ContextTreeState, places: readonly ContextPath[]): string {
    return renderPaths(state, places);
}

/** 单节点预览（表格列用；多行折成单行） */
export function previewOf(state: ContextTreeState, path: ContextPath, max = 72): string {
    const spec = state.renderers[path];
    if (spec?.renderer === "template") {
        return oneLine(renderTemplate(spec.source, { globals: state.values }), max);
    }
    const value = getValue(state, path);
    if (value === undefined) return "";
    return oneLine(isPlainObject(value) || Array.isArray(value) ? toYaml(value) : String(value), max);
}

/** 单行化（换行折成 ⏎，超长截断） */
function oneLine(text: string, max: number): string {
    const flat = text.replace(/\n/g, " ⏎ ");
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 单个 place 的 renderedHash 来源文本 */
export function placeText(state: ContextTreeState, place: ContextPath): string {
    return renderPlace(state, place);
}
