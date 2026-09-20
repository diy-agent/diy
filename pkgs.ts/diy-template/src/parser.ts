// parser.ts — 词法 + 语法（自研，**不引入 XML parser 库**）
//
// 设计原则（见 SPEC §2.0）：模版**不是 XML 文档**，是"带控制标记的纯文本"。
//   借 XML 的视觉结构（人读得懂、和输出同形），不借它的合规约束：
//     · 输出标签永不解析 —— <diy> / <project_instructions path="{{p}}"> 都是文本，{{}} 照常替换
//     · 只有两个控制标记是语法：<template …> 与 <raw>…</raw>
//     · 不转义、不规范化、不 trim；因此 <pid>、a<b、vector<T>、{ }、& 全部原样
//   唯一必须严格的是**控制标记的识别与报错**（否则会静默出错）。
// 为什么不用 XML parser 库：它们会规范化实体/属性引号/空白，破坏逐字节保真。
//
// 语法（阶段 1）：
//   {{path}}                            插值（.x 读动态作用域：循环信封 / include 参数；a.b 读 globals）
//   \{{                                 → 输出字面量 {{        （逃生舱 1）
//   <raw>…</raw>                        → 内部原样输出          （逃生舱 2）
//   <template :if={{p}}>…</template>         条件
//   <template :if-not={{p}}>…</template>     取反条件
//   <template :for={{p}} :as="x">…</template> 循环：集合写在 :for，名字写在 :as
//   <template :include="./a.md" task={{.task}} />  片段调用（非控制属性即参数）
//   <anything …>…</anything>            输出元素：标签与属性原样进提示词
//
// 属性值只有两种形态（引号只是边界，不改变语义 —— 与正文同一条规则）：
//   · 整值恰好是一个插值（{{x}} / "{{x}}"）→ **表达式**，取值保留原类型（数组仍是数组）
//   · 其余 → 文本（其中的 {{}} 是插值点），结果字符串化
//   例：list={{skills}}（集合）· title="技能清单"（字符串）· title="共 {{n}} 项"（混合）
//
// 空白规则：控制节点不产出任何字符；不做 trim、不删行（逐字节可预测）。

import type { ArgValue, InterpNode, Node } from './ast';
import { TemplateError, type Loc, type TemplateErrorCode } from './errors';

/** 已知控制属性（供 lint 复用；写错会明确报"未知控制属性"+ 已知清单） */
export const CONTROL_ATTRS = ['if', 'if-not', 'for', 'as', 'include'] as const;

const PATH_RE = /^\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*$/;
/** 循环变量名（:as="f"，名字不是表达式） */
const FOR_ITEM_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface ParseOptions {
    /** 模版 relpath（错误信息用） */
    file?: string;
    /** 风格提示回调（不报错的那类提示，由 analyze 收集后进 lint） */
    onStyleHint?: (message: string, loc: Loc) => void;
}

interface RawAttr {
    name: string;
    value: string;
    /** 属性名起始偏移 */
    loc: Loc;
    /** 属性值起始偏移（引号内首字符），用于插值报错定位 */
    valueOffset: number;
    /** 源里是否写了 =（false = 无值属性） */
    hasValue: boolean;
    /** 值是否用引号包起来 */
    quoted: boolean;
    /** 属性结束偏移（值之后的第一个字符），用于"剥掉控制属性、其余原样" */
    endOffset: number;
}

interface RawTag {
    name: string;
    attrs: RawAttr[];
    selfClosing: boolean;
    /** 属性与 `/>` 之间的原始空白 */
    closeSpace: string;
    /** 标签头结束偏移（`>` 或 `/>` 之后） */
    end: number;
    loc: Loc;
}

/** 标签头里的控制属性（判据 C：只有带它的标签才成为节点） */
function controlAttrsOf(tag: RawTag): Record<string, RawAttr | undefined> {
    const out: Record<string, RawAttr | undefined> = {};
    for (const a of tag.attrs) {
        if (!a.name.startsWith(':')) continue;
        const key = a.name.slice(1);
        if ((CONTROL_ATTRS as readonly string[]).includes(key)) out[key] = a;
    }
    return out;
}

/** 解析模版源 → 节点数组 */
export function parse(source: string, opts: ParseOptions = {}): Node[] {
    return new Parser(source, opts).parse();
}

class Parser {
    private pos = 0;
    /** 最近一次匹配到的闭合标签原文（容器原样输出用） */
    private lastCloseText: string | undefined;
    /** 每行起始偏移，用于 O(log n) 行列换算 */
    private readonly lineStarts: number[] = [0];

    constructor(
        private readonly src: string,
        private readonly options: ParseOptions = {},
    ) {
        for (let i = 0; i < src.length; i++) {
            if (src[i] === '\n') this.lineStarts.push(i + 1);
        }
    }

    parse(): Node[] {
        return this.readNodes();
    }

    // ── 位置与报错 ────────────────────────────────────────────────────

    private locAt(offset: number): Loc {
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.lineStarts[mid]! <= offset) lo = mid;
            else hi = mid - 1;
        }
        return { line: lo + 1, col: offset - this.lineStarts[lo]! + 1, offset };
    }

    /** 该标记是否"独占一行"（行内除它以外只有空白） */
    private isStandalone(from: number, to: number): boolean {
        const lineStart = this.src.lastIndexOf('\n', from - 1) + 1;
        if (this.src.slice(lineStart, from).trim() !== '') return false;
        const lineEnd = this.src.indexOf('\n', to);
        const tail = this.src.slice(to, lineEnd === -1 ? this.src.length : lineEnd);
        return tail.trim() === '';
    }

    /** 跳到该行行尾换行之后（\r\n 也正确处理） */
    private skipLineBreak(after: number): void {
        let p = after;
        while (p < this.src.length && (this.src[p] === ' ' || this.src[p] === '\t')) p += 1;
        if (this.src[p] === '\r') p += 1;
        if (this.src[p] === '\n') p += 1;
        this.pos = p;
    }

    /** standalone 处理：返回剥掉行首缩进后的待输出文本 */
    private stripIndent(text: string): string {
        return text.replace(/[ \t]*$/, '');
    }

    private err(code: TemplateErrorCode, msg: string, offset: number, detail?: string): never {
        throw new TemplateError(code, msg, this.locAt(offset), { file: this.options.file, detail });
    }

    private startsWith(prefix: string, at = this.pos): boolean {
        return this.src.startsWith(prefix, at);
    }

    // ── 主循环 ────────────────────────────────────────────────────────

    /** 读节点直到 EOF 或 `</closeName>`；closeName 为空表示根层 */
    private readNodes(closeName?: string): Node[] {
        const out: Node[] = [];
        let text = '';
        let textStart = this.pos;
        const flush = (): void => {
            if (text !== '') {
                // 源码终点 = 当前扫描位置（standalone 被剥掉的行尾空白仍在源码里，区间含它）
                out.push({ type: 'text', value: text, loc: this.locAt(textStart), end: this.pos });
                text = '';
            }
        };

        while (this.pos < this.src.length) {
            // 只有 `</template>` 是控制标记；`</skills>`、`</project_instructions>` 这类都是文本
            if (closeName !== undefined && this.startsWith('</')) {
                const m = /^<\/([A-Za-z_][A-Za-z0-9_.-]*)\s*>/.exec(this.src.slice(this.pos));
                if (m && m[1] === closeName) {
                    const closeEnd = this.pos + m[0].length;
                    // 闭合标记独占一行 → 该行的缩进与换行都不产出（只对不产出字符的 </template>）
                    const standalone = closeName === 'template' && this.isStandalone(this.pos, closeEnd);
                    if (standalone) text = this.stripIndent(text);
                    flush();
                    this.lastCloseText = m[0];
                    this.pos = closeEnd;
                    if (standalone) this.skipLineBreak(this.pos);
                    return out;
                }
            }
            if (this.startsWith('\\{{')) {
                text += '{{';
                this.pos += 3;
                continue;
            }
            if (this.startsWith('\\<')) {
                // 逃生舱：正文里要写字面量 <（如 a<b、<tag>、</tag>）时用 \<
                text += '<';
                this.pos += 2;
                continue;
            }
            if (this.startsWith('<raw>')) {
                flush();
                const start = this.pos;
                const end = this.src.indexOf('</raw>', this.pos + 5);
                if (end === -1) this.err('syntax', '逃生舱 <raw> 未闭合', start);
                const rawEnd = end + '</raw>'.length;
                out.push({ type: 'text', value: this.src.slice(this.pos + 5, end), loc: this.locAt(start), end: rawEnd });
                this.pos = rawEnd;
                textStart = this.pos;
                continue;
            }
            if (this.startsWith('{{/*')) {
                const cStart = this.pos;
                const end = this.src.indexOf('*/}}', this.pos + 4);
                if (end === -1) this.err('syntax', '注释未闭合（缺少 */}} ）', cStart);
                this.pos = end + 4;
                if (this.isStandalone(cStart, this.pos)) {
                    text = this.stripIndent(text);
                    this.skipLineBreak(this.pos);
                }
                continue; // 注释不产出任何字符
            }
            if (this.startsWith('{{')) {
                flush();
                out.push(this.readInterp());
                textStart = this.pos;
                continue;
            }
            if (this.isControlTagStart()) {
                const res = this.readTemplateTag();
                // 开标记独占一行 → 剥掉它前面的行首缩进（行尾换行已在 readTemplateTag 里消费）
                if (res.openStandalone) text = this.stripIndent(text);
                flush();
                out.push(...res.nodes);
                textStart = this.pos;
                continue;
            }
            // Markdown 代码围栏：``` 之间的内容完全原样（讲格式、贴代码样例不用任何转义）
            if (this.startsWith('```') && (this.pos === 0 || this.src[this.pos - 1] === '\n')) {
                const end = this.src.indexOf('\n```', this.pos + 3);
                const stop = end === -1 ? this.src.length : end + 4;
                text += this.src.slice(this.pos, stop);
                this.pos = stop;
                continue;
            }
            // 判据 C：只有**带控制属性**的标签才是节点（<description :if={{…}}>）；
            // 其余一切标签头（<diy>、<pid>、a<b、vector<T>）都是普通文本，零碰撞。
            const ch = this.src[this.pos]!;
            if (ch === '<' && /[A-Za-z_]/.test(this.src[this.pos + 1] ?? '')) {
                const save = this.pos;
                let tag: RawTag | undefined;
                try {
                    tag = this.readTag();
                } catch (e) {
                    // 标签头不完整（正文里的 a<b、vector<T>）；只有看起来带控制属性时才上报
                    const lookahead = this.src.slice(save, save + 300);
                    if (/:[A-Za-z-]+\s*=/.test(lookahead)) throw e;
                    tag = undefined;
                }
                const ctrl = tag ? controlAttrsOf(tag) : {};
                if (tag && (ctrl['if'] || ctrl['unless'] || ctrl['for'])) {
                    flush();
                    out.push(...this.buildTagContainer(tag, ctrl));
                    textStart = this.pos;
                    continue;
                }
                this.pos = save; // 不是控制容器 → 原样当文本继续扫（属性里的 {{}} 仍会替换）
            }
            text += this.src[this.pos]!;
            this.pos += 1;
        }

        flush();
        if (closeName !== undefined) this.err('syntax', `标签未闭合 <${closeName}>`, this.src.length);
        return out;
    }

    /** `<template` 且后面紧跟空白 / `:` / `>` / `/` 才算控制节点（`<templateX>` 是普通输出元素） */
    private isControlTagStart(): boolean {
        if (!this.startsWith('<template')) return false;
        const after = this.src[this.pos + '<template'.length] ?? '>';
        return /[\s:>/]/.test(after);
    }

    // ── 插值 ──────────────────────────────────────────────────────────

    private readInterp(): Node {
        const start = this.pos;
        const end = this.src.indexOf('}}', this.pos + 2);
        if (end === -1) this.err('syntax', '插值未闭合（缺少 }}）', start);
        const raw = this.src.slice(this.pos + 2, end);
        this.pos = end + 2;
        const path = raw.trim();
        if (path !== '.' && !PATH_RE.test(path)) {
            this.err(
                'syntax',
                `插值只支持路径，阶段 1 不支持表达式：{{${raw}}}`,
                start,
                '允许形如 {{diy.cli}} / {{.task.name}} / {{.index}} / {{.}}',
            );
        }
        return { type: 'interp', path, loc: this.locAt(start), end: this.pos };
    }

    // ── 标签头 ────────────────────────────────────────────────────────

    private readTag(): RawTag {
        const start = this.pos;
        const nameMatch = /^<([A-Za-z_][A-Za-z0-9_.-]*)/.exec(this.src.slice(this.pos));
        if (!nameMatch) this.err('syntax', '标签名非法', this.pos);
        const name = nameMatch![1]!;
        this.pos += nameMatch![0].length;
        const attrs: RawAttr[] = [];
        let lastWs = '';
        for (;;) {
            lastWs = ''; // 每轮重置：否则上一轮属性前的空白会串到 `/>` 的 closeSpace 上
            const ws = /^\s+/.exec(this.src.slice(this.pos));
            if (ws) {
                lastWs = ws[0];
                this.pos += ws[0].length;
            }
            if (this.pos >= this.src.length) this.err('syntax', `标签 <${name}> 未闭合`, start);
            if (this.startsWith('/>')) {
                this.pos += 2;
                return { name, attrs, selfClosing: true, closeSpace: lastWs, end: this.pos, loc: this.locAt(start) };
            }
            if (this.startsWith('>')) {
                this.pos += 1;
                return { name, attrs, selfClosing: false, closeSpace: '', end: this.pos, loc: this.locAt(start) };
            }
            const attrStart = this.pos;
            const am = /^([A-Za-z_:@#][A-Za-z0-9_:.-]*)/.exec(this.src.slice(this.pos));
            if (!am) {
                this.err('syntax', `标签 <${name}> 的属性名非法`, this.pos, '值里如果有空格，请用引号包起来，如 title="共 {{n}} 项"');
            }
            const attrName = am![1]!;
            this.pos += am![0].length;
            // 注意：必须显式匹配到 `=`，否则 `/^\s*=\s*/` 会零宽匹配成功，
            // 把无值属性后的字符（如 `/>` 的 `/`）当成它的值吃掉。
            const eq = /^\s*=/.exec(this.src.slice(this.pos));
            if (!eq) {
                attrs.push({
                    name: attrName,
                    value: '',
                    loc: this.locAt(attrStart),
                    valueOffset: attrStart,
                    hasValue: false,
                    quoted: false,
                    endOffset: this.pos,
                });
                continue;
            }
            this.pos += eq[0].length;
            this.pos += /^\s*/.exec(this.src.slice(this.pos))![0].length;
            const q = this.src[this.pos];
            let value: string;
            let valueOffset = this.pos;
            let quoted = false;
            if (q === '"' || q === "'") {
                quoted = true;
                const close = this.src.indexOf(q, this.pos + 1);
                if (close === -1) this.err('syntax', `属性 ${attrName} 的引号未闭合`, attrStart);
                value = this.src.slice(this.pos + 1, close);
                valueOffset = this.pos + 1;
                this.pos = close + 1;
            } else if (this.startsWith('{{', this.pos)) {
                // 裸表达式：按括号扫描（否则 `:if={{x}}/>` 会把 `/>` 当成值的一部分）
                const close = this.src.indexOf('}}', this.pos + 2);
                if (close === -1) this.err('syntax', `属性 ${attrName} 的插值未闭合（缺少 }}）`, attrStart);
                value = this.src.slice(this.pos, close + 2);
                this.pos = close + 2;
                const next = this.src[this.pos];
                if (next !== undefined && !/[\s/>]/.test(next)) {
                    this.err(
                        'syntax',
                        `属性 ${attrName} 的值里插值之后还有内容，请用引号包起来`,
                        this.pos,
                        '例：title="共 {{n}} 项"',
                    );
                }
            } else {
                const vm = /^[^\s>]+/.exec(this.src.slice(this.pos));
                if (!vm) this.err('syntax', `属性 ${attrName} 缺少值`, attrStart);
                value = vm![0];
                this.pos += value.length;
                // 裸值末尾的 `/` 属于自闭合标记（`attr=./x/>`）；值确实以 / 结尾时用引号形式
                if (this.src[this.pos] === '>' && value.endsWith('/')) {
                    value = value.slice(0, -1);
                    this.pos -= 1;
                }
            }
            attrs.push({ name: attrName, value, loc: this.locAt(attrStart), valueOffset, hasValue: true, quoted, endOffset: this.pos });
        }
    }

    /**
     * 属性值统一解析（与正文同一条规则：引号只是边界，`{{}}` 才是求值标记）：
     *   · 整值恰好一个插值 → 表达式（取值保留原类型：数组仍是数组、布尔仍是布尔）
     *   · 否则 → 文本节点序列（可含插值点；注释不产出字符）
     */
    private attrShape(a: RawAttr): ArgValue {
        const raw = a.value;
        const parts: Node[] = [];
        let text = '';
        let textBegin = 0;
        /** 当前文本段在 raw 里的源码终点（转义会吞字符，不能只按拼接后的长度算） */
        let textEnd = 0;
        let haveText = false;
        let interps = 0;
        const pushText = (s: string, at: number, srcEnd = at + s.length): void => {
            if (!haveText) {
                textBegin = at;
                haveText = true;
            }
            text += s;
            textEnd = srcEnd;
        };
        const flush = (): void => {
            if (haveText) {
                parts.push({
                    type: 'text',
                    value: text,
                    loc: this.locAt(a.valueOffset + textBegin),
                    end: a.valueOffset + textEnd,
                });
                text = '';
                haveText = false;
            }
        };
        let i = 0;
        while (i < raw.length) {
            const open = raw.indexOf('{{', i);
            if (open === -1) {
                pushText(raw.slice(i), i);
                break;
            }
            // 逃生：\{{ → 字面 {{（只吞紧随其后的 {{）
            if (open > 0 && raw[open - 1] === '\\') {
                pushText(raw.slice(i, open - 1) + '{{', i, open + 2); // 源码里还包含逃生的 \
                i = open + 2;
                continue;
            }
            if (open > i) pushText(raw.slice(i, open), i);
            const close = raw.indexOf('}}', open + 2);
            if (close === -1) this.err('syntax', `属性 ${a.name} 的插值未闭合（缺少 }}）`, a.valueOffset + open);
            const inner = raw.slice(open + 2, close).trim();
            i = close + 2;
            if (inner.startsWith('/*')) continue; // 注释：不产出字符
            if (inner !== '.' && !PATH_RE.test(inner)) {
                this.err(
                    'syntax',
                    `属性 ${a.name} 的插值只支持路径，阶段 1 不支持表达式：{{${inner}}}`,
                    a.valueOffset + open,
                    '允许形如 {{diy.cli}} / {{.task.name}} / {{.index}} / {{.}}',
                );
            }
            flush();
            parts.push({ type: 'interp', path: inner, loc: this.locAt(a.valueOffset + open), end: a.valueOffset + close + 2 });
            interps += 1;
        }
        flush();
        if (interps === 1 && parts.length === 1) {
            // 风格提示：单插值不必再包引号（引号在读者心里是"字符串"，避免与表达式叠在一起）
            if (a.quoted) {
                this.options.onStyleHint?.(
                    `${a.name}="{{…}}" 的整值就是一个插值，直接写成 ${a.name}={{…}} 更清楚`,
                    this.locAt(a.valueOffset),
                );
            }
            return { kind: 'expr', path: (parts[0] as InterpNode).path };
        }
        return { kind: 'text', nodes: parts };
    }

    /** 把"带控制属性的标签"构造成容器节点：按条件/循环渲染内部，并原样输出自身标签 */
    private buildTagContainer(tag: RawTag, ctrl: Record<string, RawAttr | undefined>): Node[] {
        if (ctrl['include']) {
            this.err('syntax', ':include 只能用在 <template> 上', ctrl['include']!.loc.offset);
        }
        const ifAttr = ctrl['if'];
        const ifNotAttr = ctrl['if-not'];
        const forAttr = ctrl['for'];
        const asAttr = ctrl['as'];
        if (ifAttr && ifNotAttr) this.err('syntax', ':if 与 :if-not 不能同时出现', ifAttr.loc.offset);
        if (asAttr && !forAttr) this.err('syntax', ':as 只能与 :for 一起用', asAttr.loc.offset);

        let children: Node[] = [];
        let headClose = '';
        if (!tag.selfClosing) {
            children = this.readNodes(tag.name);
            // 闭合标签原文（逐字节）；readNodes 找到了才设值
            headClose = this.lastCloseText ?? `</${tag.name}>`;
            this.lastCloseText = undefined;
        }

        // 标签头：剥掉控制属性的字符区间，其余原样（**不重新格式化**，保留引号/空白）
        const cut = [ifAttr, ifNotAttr, forAttr, asAttr, ctrl['include']]
            .filter((a): a is RawAttr => Boolean(a))
            .map((a) => {
                let start = a.loc.offset;
                while (start > tag.loc.offset && /\s/.test(this.src[start - 1]!)) start -= 1;
                return [start, a.endOffset] as [number, number];
            })
            .sort((a, b) => a[0] - b[0]);
        let head = '';
        let cursor = tag.loc.offset;
        for (const [start, end] of cut) {
            head += this.src.slice(cursor, start);
            cursor = end;
        }
        head += this.src.slice(cursor, tag.end);

        const node: Node = { type: 'tag', head, headClose, children, loc: tag.loc, end: this.pos };
        return this.wrapControl(forAttr, asAttr, ifAttr, ifNotAttr, [node], tag.loc.offset);
    }

    // ── 控制节点 <template> ───────────────────────────────────────────

    private readTemplateTag(): { nodes: Node[]; openStandalone: boolean; openEnd: number; closeStart?: number; closeEnd?: number } {
        const tag = this.readTag();
        // 开标签独占一行 → 它那一行的行尾换行不产出（必须在解析 children 之前消费，
        // 否则这个换行会落进子节点文本里）
        const openStandalone = this.isStandalone(tag.loc.offset, tag.end);
        if (openStandalone) this.skipLineBreak(tag.end);
        const ctrl = new Map<string, RawAttr>();
        const others: RawAttr[] = [];
        const hasInclude = tag.attrs.some((a) => a.name === ':include');
        for (const a of tag.attrs) {
            if (!a.name.startsWith(':')) {
                others.push(a);
                continue;
            }
            const key = a.name.slice(1);
            if (key === 'unless') {
                this.err(
                    'syntax',
                    ':unless 已改名为 :if-not',
                    a.loc.offset,
                    '取反条件写法：<template :if-not={{.isFirst}}>…</template>',
                );
            }
            if (key === 'in') {
                this.err(
                    'syntax',
                    ':in 已并入 :for（集合写在 :for，名字写在 :as）',
                    a.loc.offset,
                    '新写法：<template :for={{集合}} :as="item">…</template>',
                );
            }
            if (!(CONTROL_ATTRS as readonly string[]).includes(key)) {
                if (!hasInclude) {
                    this.err('syntax', `未知控制属性 ${a.name}`, a.loc.offset, `已知：${CONTROL_ATTRS.map((c) => ':' + c).join('、')}`);
                }
                // <template :include> 上：未知 `:xxx` 视为参数名（剥掉前导冒号）
                others.push({ ...a, name: key });
                continue;
            }
            if (ctrl.has(key)) this.err('syntax', `重复的控制属性 :${key}`, a.loc.offset);
            ctrl.set(key, a);
        }

        const ifAttr = ctrl.get('if');
        const ifNotAttr = ctrl.get('if-not');
        const forAttr = ctrl.get('for');
        const asAttr = ctrl.get('as');
        const includeAttr = ctrl.get('include');
        if (ifAttr && ifNotAttr) this.err('syntax', ':if 与 :if-not 不能同时出现', ifAttr.loc.offset);

        if (includeAttr) {
            // 路径必须是**字面量**：禁用动态 include（路径要在静态分析里就确定）
            const relpath = includeAttr.value;
            if (relpath.includes('{{')) {
                this.err('syntax', `include 路径必须是字面量，不能是插值：${relpath}`, includeAttr.valueOffset);
            }
            if (!relpath.startsWith('./') || relpath.includes('..')) {
                this.err('include', `include 路径必须是以 ./ 开头且不含 .. 的相对路径：${relpath}`, includeAttr.loc.offset);
            }
            const args = others.map((a) => ({ name: a.name, value: this.attrShape(a), loc: a.loc }));
            const node: Node = { type: 'include', relpath, args, loc: tag.loc, end: tag.selfClosing ? tag.end : this.pos };
            const nodes = this.wrapControl(forAttr, asAttr, ifAttr, ifNotAttr, [node], tag.loc.offset);
            if (tag.selfClosing) return { nodes, openStandalone, openEnd: tag.end };
            const closeStart = this.pos;
            const children = this.readNodes('template');
            if (children.some((c) => c.type !== 'text' || c.value.trim() !== '')) {
                this.err('syntax', 'include 不能有子节点', tag.loc.offset);
            }
            return { nodes, openStandalone, openEnd: tag.end, closeStart, closeEnd: this.pos };
        }

        if (others.length > 0) {
            this.err('syntax', `未知控制属性 :${others[0]!.name}`, others[0]!.loc.offset, `已知：${CONTROL_ATTRS.map((c) => ':' + c).join('、')}`);
        }
        if (tag.selfClosing) return { nodes: [], openStandalone, openEnd: tag.end };
        const closeStart = this.pos;
        const children = this.readNodes('template');
        return {
            nodes: this.wrapControl(forAttr, asAttr, ifAttr, ifNotAttr, children, tag.loc.offset),
            openStandalone,
            openEnd: tag.end,
            closeStart,
            closeEnd: this.pos,
        };
    }

    /** 依次包 :for（外）→ :if/:if-not（内）；无控制属性则原样返回 children */
    private wrapControl(
        forAttr: RawAttr | undefined,
        asAttr: RawAttr | undefined,
        ifAttr: RawAttr | undefined,
        ifNotAttr: RawAttr | undefined,
        children: Node[],
        /** 开标签位置（整段源码起点） */
        from: number,
    ): Node[] {
        let node: Node | undefined;
        if (forAttr || asAttr) {
            const how = ':for={{集合}} :as="item"';
            // 旧写法 "item of 路径" → 直接给出改名提示（比"缺 :as"更指向问题）
            if (forAttr && /^[A-Za-z_$][\w$]*\s+of\s+/.test(forAttr.value.trim())) {
                this.err(
                    'syntax',
                    `:for 不再支持 "item of 路径" 写法：${forAttr.value}`,
                    forAttr.loc.offset,
                    `已改写法：${how}`,
                );
            }
            if (!forAttr) this.err('syntax', ':as 必须与 :for 一起用', asAttr!.loc.offset, `写法：${how}`);
            if (!asAttr) this.err('syntax', ':for 缺少循环变量名 :as', forAttr!.loc.offset, `写法：${how}`);
            const shape = this.attrShape(forAttr!);
            if (shape.kind !== 'expr') {
                this.err(
                    'syntax',
                    `:for 的值必须是单个插值（集合路径），如 :for={{skills}}：${forAttr!.value}`,
                    forAttr!.loc.offset,
                );
            }
            const as = asAttr!.value.trim();
            if (asAttr!.value.includes('{{') || !FOR_ITEM_RE.test(as)) {
                this.err(
                    'syntax',
                    `:as 需要一个变量名（不是表达式）：${asAttr!.value}`,
                    asAttr!.loc.offset,
                    '例：:as="item"；循环内用 {{.item.value}} / {{.item.index}} / {{.item.isFirst}}',
                );
            }
            node = { type: 'for', as, source: shape.path, children, loc: forAttr!.loc, from, end: this.pos };
        }
        const cond = ifAttr ?? ifNotAttr;
        if (cond) {
            const shape = this.attrShape(cond);
            const name = ifAttr ? ':if' : ':if-not';
            if (shape.kind !== 'expr') {
                this.err(
                    'syntax',
                    `${name} 的值必须是单个插值（路径），如 ${name}={{skills}}：${cond.value}`,
                    cond.loc.offset,
                );
            }
            node = {
                type: 'if',
                path: shape.path,
                negate: Boolean(ifNotAttr),
                children: node ? [node] : children,
                loc: cond.loc,
                from,
                end: this.pos,
            };
        }
        return node ? [node] : children;
    }

    // ── 输出元素 ──────────────────────────────────────────────────────

}
