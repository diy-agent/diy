// parser.ts — 词法 + 语法（自研，**不引入 XML parser 库**）
//
// 为什么不用 XML parser：
//   1. 那些库会规范化实体、属性引号、空白 → 破坏「逐字节保真」（输出要进提示词）；
//   2. 我们只需要识别一种控制节点 `<template …>`，其它标签一律**原样透传**。
//
// 语法（阶段 1）：
//   {{path}}                            插值（.x 读动态作用域，a.b 读 globals，. 读当前循环项）
//   \{{                                 → 输出字面量 {{        （逃生舱 1）
//   <raw>…</raw>                        → 内部原样输出          （逃生舱 2）
//   <template :if="p">…</template>       条件
//   <template :unless="p">…</template>   取反条件
//   <template :for="x of p">…</template> 循环（{{.index}} 内建下标）
//   <template :include="./a.md" task=".task" />   片段调用（非控制属性即参数）
//   <anything …>…</anything>            输出元素：标签与属性原样进提示词
//
// 空白规则：控制节点不产出任何字符；不做 trim、不删行（逐字节可预测）。

import type { AttrNode, AttrPart, Node } from './ast';
import { TemplateError, type Loc, type TemplateErrorCode } from './errors';

/** 已知控制属性；其余以 `:` 开头的属性一律报错（防 :iff 这类拼错静默生效） */
const CONTROL_ATTRS = ['if', 'unless', 'for', 'include', 'omit-empty'] as const;

const PATH_RE = /^\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*$/;
const FOR_RE = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+of\s+(\.?[A-Za-z_$][A-Za-z0-9_$.]*)$/;

export interface ParseOptions {
    /** 模版 relpath（错误信息用） */
    file?: string;
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
}

interface RawTag {
    name: string;
    attrs: RawAttr[];
    selfClosing: boolean;
    /** 属性与 `/>` 之间的原始空白 */
    closeSpace: string;
    loc: Loc;
}

/** 解析模版源 → 节点数组 */
export function parse(source: string, opts: ParseOptions = {}): Node[] {
    return new Parser(source, opts.file).parse();
}

class Parser {
    private pos = 0;
    /** 每行起始偏移，用于 O(log n) 行列换算 */
    private readonly lineStarts: number[] = [0];

    constructor(
        private readonly src: string,
        private readonly file: string | undefined,
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

    private err(code: TemplateErrorCode, msg: string, offset: number, detail?: string): never {
        throw new TemplateError(code, msg, this.locAt(offset), { file: this.file, detail });
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
                out.push({ type: 'text', value: text, loc: this.locAt(textStart) });
                text = '';
            }
        };

        while (this.pos < this.src.length) {
            if (closeName !== undefined && this.startsWith('</')) {
                const m = /^<\/([A-Za-z_][A-Za-z0-9_.-]*)\s*>/.exec(this.src.slice(this.pos));
                if (!m) this.err('syntax', '结束标签格式非法', this.pos);
                if (m![1] !== closeName) {
                    this.err('syntax', `标签未闭合：期望 </${closeName}>，实际遇到 </${m![1]}>`, this.pos);
                }
                flush();
                this.pos += m![0].length;
                return out;
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
                out.push({ type: 'text', value: this.src.slice(this.pos + 5, end), loc: this.locAt(start) });
                this.pos = end + '</raw>'.length;
                textStart = this.pos;
                continue;
            }
            if (this.startsWith('{{')) {
                flush();
                out.push(this.readInterp());
                textStart = this.pos;
                continue;
            }
            if (this.isControlTagStart()) {
                flush();
                out.push(...this.readTemplateTag());
                textStart = this.pos;
                continue;
            }
            if (this.startsWith('</')) {
                const m = /^<\/([A-Za-z_][A-Za-z0-9_.-]*)\s*>/.exec(this.src.slice(this.pos));
                this.err('syntax', `多余的结束标签 </${m?.[1] ?? '?'}>`, this.pos);
            }
            const ch = this.src[this.pos]!;
            const next = this.src[this.pos + 1] ?? '';
            if (ch === '<' && /[A-Za-z_]/.test(next)) {
                flush();
                out.push(this.readOutputElement());
                textStart = this.pos;
                continue;
            }
            text += ch;
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
        return { type: 'interp', path, loc: this.locAt(start) };
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
                return { name, attrs, selfClosing: true, closeSpace: lastWs, loc: this.locAt(start) };
            }
            if (this.startsWith('>')) {
                this.pos += 1;
                return { name, attrs, selfClosing: false, closeSpace: '', loc: this.locAt(start) };
            }
            const attrStart = this.pos;
            const am = /^([A-Za-z_:@#][A-Za-z0-9_:.-]*)/.exec(this.src.slice(this.pos));
            if (!am) this.err('syntax', `标签 <${name}> 的属性名非法`, this.pos);
            const attrName = am![1]!;
            this.pos += am![0].length;
            // 注意：必须显式匹配到 `=`，否则 `/^\s*=\s*/` 会零宽匹配成功，
            // 把无值属性后的字符（如 `/>` 的 `/`）当成它的值吃掉。
            const eq = /^\s*=/.exec(this.src.slice(this.pos));
            if (!eq) {
                attrs.push({ name: attrName, value: '', loc: this.locAt(attrStart), valueOffset: attrStart, hasValue: false });
                continue;
            }
            this.pos += eq[0].length;
            this.pos += /^\s*/.exec(this.src.slice(this.pos))![0].length;
            const q = this.src[this.pos];
            let value: string;
            let valueOffset = this.pos;
            if (q === '"' || q === "'") {
                const close = this.src.indexOf(q, this.pos + 1);
                if (close === -1) this.err('syntax', `属性 ${attrName} 的引号未闭合`, attrStart);
                value = this.src.slice(this.pos + 1, close);
                valueOffset = this.pos + 1;
                this.pos = close + 1;
            } else {
                const vm = /^[^\s>]+/.exec(this.src.slice(this.pos));
                if (!vm) this.err('syntax', `属性 ${attrName} 缺少值`, attrStart);
                value = vm![0];
                this.pos += value.length;
            }
            attrs.push({ name: attrName, value, loc: this.locAt(attrStart), valueOffset, hasValue: true });
        }
    }

    /**
     * 把属性值拆成「字面量 + {{path}}」片段（解析期校验，报错带位置）。
     * 与文本位置一致地支持逃生舱：`\{{` → 字面量 `{{`，`\<` → 字面量 `<`。
     */
    private attrParts(attr: RawAttr): AttrPart[] {
        const parts: AttrPart[] = [];
        const v = attr.value;
        let lit = '';
        let i = 0;
        const flush = (): void => {
            if (lit !== '') {
                parts.push(lit);
                lit = '';
            }
        };
        while (i < v.length) {
            if (v.startsWith('\\{{', i)) {
                lit += '{{';
                i += 3;
                continue;
            }
            if (v.startsWith('\\<', i)) {
                lit += '<';
                i += 2;
                continue;
            }
            if (v.startsWith('{{', i)) {
                const close = v.indexOf('}}', i + 2);
                if (close === -1) {
                    this.err('syntax', `属性 ${attr.name} 里的插值未闭合`, attr.valueOffset + i);
                }
                const rawPath = v.slice(i + 2, close).trim();
                if (rawPath !== '.' && !PATH_RE.test(rawPath)) {
                    this.err(
                        'syntax',
                        `属性 ${attr.name} 的插值只支持路径：{{${rawPath}}}`,
                        attr.valueOffset + i,
                    );
                }
                flush();
                parts.push({ path: rawPath, loc: this.locAt(attr.valueOffset + i) });
                i = close + 2;
                continue;
            }
            lit += v[i];
            i += 1;
        }
        flush();
        return parts;
    }

    // ── 控制节点 <template> ───────────────────────────────────────────

    private readTemplateTag(): Node[] {
        const tag = this.readTag();
        const ctrl = new Map<string, RawAttr>();
        const others: RawAttr[] = [];
        const hasInclude = tag.attrs.some((a) => a.name === ':include');
        for (const a of tag.attrs) {
            if (!a.name.startsWith(':')) {
                others.push(a);
                continue;
            }
            const key = a.name.slice(1);
            if (!(CONTROL_ATTRS as readonly string[]).includes(key)) {
                if (!hasInclude) {
                    this.err('syntax', `未知控制属性 ${a.name}`, a.loc.offset, `已知：${CONTROL_ATTRS.map((c) => ':' + c).join('、')}`);
                }
                // <template :include> 上：未知 `:xxx` 视为参数名（剥掉前导冒号）
                others.push({ ...a, name: key });
                continue;
            }
            if (key === 'omit-empty') {
                this.err('syntax', ':omit-empty 只能用在输出元素上', a.loc.offset);
            }
            if (ctrl.has(key)) this.err('syntax', `重复的控制属性 :${key}`, a.loc.offset);
            ctrl.set(key, a);
        }

        const ifAttr = ctrl.get('if');
        const unlessAttr = ctrl.get('unless');
        const forAttr = ctrl.get('for');
        const includeAttr = ctrl.get('include');
        if (ifAttr && unlessAttr) this.err('syntax', ':if 与 :unless 不能同时出现', ifAttr.loc.offset);

        if (includeAttr) {
            const relpath = includeAttr.value;
            if (!relpath.startsWith('./') || relpath.includes('..')) {
                this.err('include', `include 路径必须是以 ./ 开头且不含 .. 的相对路径：${relpath}`, includeAttr.loc.offset);
            }
            if (!tag.selfClosing) {
                const children = this.readNodes('template');
                if (children.some((c) => c.type !== 'text' || c.value.trim() !== '')) {
                    this.err('syntax', 'include 不能有子节点', tag.loc.offset);
                }
            }
            const args = others.map((a) => {
                // 参数值就是一条路径：裸写（path=".path"）或插值形式（path="{{.path}}"）都接受
                const parts = this.attrParts(a);
                const only = parts.length === 1 ? parts[0] : undefined;
                const raw = typeof only === 'string' ? only.trim() : only ? only.path : undefined;
                if (raw === undefined || (raw !== '.' && !PATH_RE.test(raw))) {
                    this.err(
                        'syntax',
                        `include 参数 ${a.name} 只支持单条路径：${a.value}`,
                        a.loc.offset,
                        '例：<template :include="./_chain.md" path=".path" content=".content" />',
                    );
                }
                return { name: a.name, path: raw!, loc: a.loc };
            });
            const node: Node = { type: 'include', relpath, args, loc: tag.loc };
            const wrapped = this.wrapControl(forAttr, ifAttr, unlessAttr, [node]);
            return wrapped;
        }

        if (others.length > 0) {
            this.err('syntax', `未知控制属性 :${others[0]!.name}`, others[0]!.loc.offset, `已知：${CONTROL_ATTRS.map((c) => ':' + c).join('、')}`);
        }
        const children = tag.selfClosing ? [] : this.readNodes('template');
        return this.wrapControl(forAttr, ifAttr, unlessAttr, children);
    }

    /** 依次包 :for（外）→ :if/:unless（内）；无控制属性则原样返回 children */
    private wrapControl(
        forAttr: RawAttr | undefined,
        ifAttr: RawAttr | undefined,
        unlessAttr: RawAttr | undefined,
        children: Node[],
    ): Node[] {
        let node: Node | undefined;
        if (forAttr) {
            const m = FOR_RE.exec(forAttr.value.trim());
            if (!m) {
                this.err(
                    'syntax',
                    `:for 语法非法：${forAttr.value}`,
                    forAttr.loc.offset,
                    '正确写法：:for="item of 路径"（下标固定为 {{.index}}）',
                );
            }
            node = { type: 'for', item: m![1]!, source: m![2]!, children, loc: forAttr.loc };
        }
        const cond = ifAttr ?? unlessAttr;
        if (cond) {
            const p = cond.value.trim();
            if (p !== '.' && !PATH_RE.test(p)) {
                this.err(
                    'syntax',
                    `:${ifAttr ? 'if' : 'unless'} 只支持路径，阶段 1 不支持表达式：${cond.value}`,
                    cond.loc.offset,
                );
            }
            node = { type: 'if', path: p, negate: Boolean(unlessAttr), children: node ? [node] : children, loc: cond.loc };
        }
        return node ? [node] : children;
    }

    // ── 输出元素 ──────────────────────────────────────────────────────

    private readOutputElement(): Node {
        const tag = this.readTag();
        const ctrl = new Map<string, RawAttr>();
        const attrs: AttrNode[] = [];
        let omitEmpty = false;
        for (const a of tag.attrs) {
            if (a.name.startsWith(':')) {
                const key = a.name.slice(1);
                if (!(CONTROL_ATTRS as readonly string[]).includes(key)) {
                    this.err(
                        'syntax',
                        `未知控制属性 ${a.name}`,
                        a.loc.offset,
                        `已知：${CONTROL_ATTRS.map((c) => ':' + c).join('、')}；输出元素上带冒号的属性一律视为控制属性`,
                    );
                }
                if (key === 'omit-empty') {
                    if (a.value.trim() !== 'true') this.err('syntax', ':omit-empty 只接受 "true"', a.loc.offset);
                    omitEmpty = true;
                    continue;
                }
                if (key === 'include') this.err('syntax', ':include 只能用在 <template> 上', a.loc.offset);
                if (ctrl.has(key)) this.err('syntax', `重复的控制属性 :${key}`, a.loc.offset);
                ctrl.set(key, a);
                continue;
            }
            attrs.push({ name: a.name, parts: this.attrParts(a), loc: a.loc, bare: !a.hasValue });
        }
        const ifAttr = ctrl.get('if');
        const unlessAttr = ctrl.get('unless');
        if (ifAttr && unlessAttr) this.err('syntax', ':if 与 :unless 不能同时出现', ifAttr.loc.offset);

        const children = tag.selfClosing ? [] : this.readNodes(tag.name);
        const element: Node = {
            type: 'element',
            name: tag.name,
            attrs,
            selfClosing: tag.selfClosing,
            closeSpace: tag.closeSpace,
            children,
            loc: tag.loc,
            omitEmpty,
        };
        return this.wrapControl(ctrl.get('for'), ifAttr, unlessAttr, [element])[0]!;
    }
}
