import { onMount, onCleanup, createEffect } from "solid-js";
import {
    EditorView,
    Decoration,
    ViewPlugin,
    keymap,
    lineNumbers,
    highlightActiveLine,
    type DecorationSet,
    type ViewUpdate,
} from "@codemirror/view";
import {
    EditorState,
    EditorSelection,
    Compartment,
    StateEffect,
    StateField,
    type Range,
    type SelectionRange,
} from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { themeSignal } from "../lib/theme";

/**
 * markdown 语法着色 —— 用**标准固定风格**，不再自拼配色：
 *   · 暗色主题：Atom One Dark（`@codemirror/theme-one-dark` 官方包，社区最通用的固定风格）
 *   · 亮色主题：CM 官方 `defaultHighlightStyle`（本来就是给亮底设计的）
 * 自拼配色的问题（实测反馈「看着杂乱」）：我原来把 daisyUI 五个色相都用上
 * （primary/accent/info/secondary/warning），而模版正文多是纯文本 → 满屏彩字。
 * 固定风格只动"确实有语义"的 token，正文保持中性。
 */
const darkHighlight = oneDarkHighlightStyle;

/**
 * 模版 DSL 的"特殊显示"：markdown 语法不认识 `<template …>` / `{{插值}}`，
 * 但这两样才是模版里最该一眼认出来的东西。用正则给可见区域加装饰（只上色，不改文本）。
 */
const dslMark = Decoration.mark({ class: "cm-dsl-interp" });
const dslCtl = Decoration.mark({ class: "cm-dsl-ctl" });
const xmlPunct = Decoration.mark({ class: "cm-xml-punct" });
const xmlName = Decoration.mark({ class: "cm-xml-name" });
const xmlAttr = Decoration.mark({ class: "cm-xml-attr" });
/** 已知的节标签（输出侧伪 XML）：只给这些上色，免得把正文里的 `<pid>`、`a<b` 之类误染 */
const KNOWN_TAGS = new Set([
    "diy",
    "project_context",
    "project_instructions",
    "task",
    "rules",
    "skills",
    "guard",
]);
const dslPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
            this.decorations = this.build(view);
        }
        update(u: ViewUpdate) {
            if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
        }
        build(view: EditorView): DecorationSet {
            const out: Range<Decoration>[] = [];
            for (const { from, to } of view.visibleRanges) {
                const text = view.state.sliceDoc(from, to);
                // {{…}} 插值
                for (const m of text.matchAll(/\{\{[^}]*\}\}/g)) {
                    out.push(dslMark.range(from + m.index, from + m.index + m[0].length));
                }
                // <template …> / </template> 控制标记（含属性）
                for (const m of text.matchAll(/<\/?template\b[^>]*>/g)) {
                    out.push(dslCtl.range(from + m.index, from + m.index + m[0].length));
                }
                // 输出侧伪 XML 标签：`<diy>` / `</task>` / `<project_instructions path="…">`
                // 只认已知节标签；标签名与属性分开着色（属性弱化）
                for (const m of text.matchAll(/<\/?(\w[\w.-]*)((?:\s+[^>]*)?)>/g)) {
                    if (!KNOWN_TAGS.has(m[1]!)) continue;
                    const at = from + m.index;
                    const closeAt = at + m[0].length - 1;
                    const nameAt = at + (m[0].startsWith("</") ? 2 : 1);
                    out.push(xmlPunct.range(at, nameAt));
                    out.push(xmlName.range(nameAt, nameAt + m[1]!.length));
                    out.push(xmlPunct.range(closeAt, closeAt + 1));
                    if (m[2]) out.push(xmlAttr.range(nameAt + m[1]!.length, closeAt));
                }
            }
            return Decoration.set(out, true);
        }
    },
    { decorations: (v) => v.decorations },
);

/** daisyUI 贴合主题：等宽 12px，行号弱显，纸面用 base-100 */
const labTheme = EditorView.theme(
    {
        "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--color-base-100)" },
        ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--color-primary)" },
        // 行号栏（CM 手册：gutters 是 sticky 的，正文横向滚时会滚到它下面）
        //   · **不能**给 .cm-gutters 设 opacity —— 那会把背景一起变透明，正文从底下透出来"压住行号"
        //     （弱化请用 color 的 alpha）
        //   · `&light`/`&dark` 只能用在 `EditorView.baseTheme` 里（`buildTheme` 只给 baseTheme 传 scopes），
        //     在 `EditorView.theme` 里写会抛 `Unsupported selector: &light` —— 而且是模块加载期抛，
        //     整个 renderer 白屏。这里用普通选择器（实测能盖住 CM 基础主题的 gutter 背景）
        ".cm-gutters": {
            backgroundColor: "var(--color-base-100)",
            color: "color-mix(in srgb, var(--color-base-content) 55%, transparent)",
            borderRight: "1px solid var(--color-base-300)",
        },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 4px" },
        ".cm-activeLine": { backgroundColor: "var(--color-base-200)" },
        // 高亮：浅色 = 所有出现处；深色 = 当前焦点（同一色相加浓，暗色主题下更亮）
        // 模版 DSL：插值 = 强调色，控制标记 = 主色（与 markdown 着色区分开，一眼认出模版语法）
        // 只用两个色相（插值 = accent、控制标记/标签名 = primary），属性弱化 —— 不再满屏彩字
        ".cm-dsl-interp": { color: "var(--color-accent)", fontWeight: "bold" },
        ".cm-dsl-ctl": { color: "var(--color-primary)", fontWeight: "bold" },
        ".cm-xml-name": { color: "var(--color-primary)", fontWeight: "bold" },
        ".cm-xml-punct": { color: "var(--color-primary)", opacity: "0.6" },
        ".cm-xml-attr": { color: "color-mix(in srgb, var(--color-base-content) 60%, transparent)" },
        ".cm-lab-hl": { backgroundColor: "color-mix(in srgb, var(--color-warning) 16%, transparent)" },
        ".cm-lab-hl-focus": { backgroundColor: "color-mix(in srgb, var(--color-warning) 48%, transparent)" },
        ".cm-activeLineGutter": {
            backgroundColor: "var(--color-base-200)",
            color: "var(--color-base-content)",
        },
    },
    { dark: true },
);

/**
 * 高亮：**按整行**（行背景覆盖整行，扫读比给 token 上色容易），分两层颜色：
 *   · `lines`      浅色 = 所有标出的"这一段"出现处
 *   · `focusLines` 深色 = 当前焦点的那一处（上/下一个导航的目标）
 */
export interface HlLines {
    lines: number[];
    focusLines?: number[];
    /**
     * 焦点那一段的**字符区间** —— 滚动目标。
     * 不能只滚到行号：不折行时长行会横向溢屏，只到行首的话焦点段仍在屏幕外。
     * 用区间而不是单点：CM 按段的真实几何居中（含 CJK 双宽），横向纵向都到位。
     */
    focusPos?: number;
    focusEnd?: number;
}

const setHl = StateEffect.define<HlLines | null>();

/** 高亮用行装饰（多层：浅色=全部出现处，深色=当前焦点） */
const hlField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        let next = deco.map(tr.changes);
        for (const e of tr.effects) {
            if (!e.is(setHl)) continue;
            const spec = e.value;
            const decos: Range<Decoration>[] = [];
            if (spec) {
                const last = tr.state.doc.lines;
                const at = (n: number): number => tr.state.doc.line(Math.min(Math.max(1, n), last)).from;
                const focus = new Set(spec.focusLines ?? []);
                for (const n of spec.lines) decos.push(Decoration.line({ class: "cm-lab-hl" }).range(at(n)));
                for (const n of focus) decos.push(Decoration.line({ class: "cm-lab-hl-focus" }).range(at(n)));
            }
            next = Decoration.set(decos, true);
        }
        return next;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/**
 * 模版编辑器 / 只读预览（CodeMirror 6，受控：value 变化且与文档不一致时才替换）。
 *
 * 两块**同一实现同一外观**（行号 + 等宽 + **不自动折行**，长了就横向滚）：
 *   · 模版编辑器：`editable` 随锁定状态
 *   · 系统提示词预览：同一个 view，只把 `editable` 关掉（两块完全同构：同着色、同行号、同不折行）
 */
export function MdEditor(props: {
    value: string;
    editable: boolean;
    onChange: (v: string) => void;
    /** 要高亮的行（模版结构树/变量定义行点中时传入；null = 清空） */
    highlight?: HlLines | null;
}) {
    let host: HTMLDivElement | undefined;
    let view: EditorView | undefined;
    const editableCx = new Compartment();
    const hlStyleCx = new Compartment();
    // 程序化换文档（切文件/保存/恢复）不回调 onChange：
    // 否则切一份文件就等于「改了一次」，drafts 多一条脏值 → 头部错报「1 未保存」（脏点却是空的）
    let silent = false;

    onMount(() => {
        view = new EditorView({
            parent: host,
            state: EditorState.create({
                doc: props.value,
                extensions: [
                    lineNumbers(),
                    highlightActiveLine(),
                    highlightSelectionMatches(),
                    history(),
                    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
                    // 不自动折行：与预览一致，长了横向滚（折行会让"第几行"对不上行号）
                    markdown(),
                    // 固定风格随主题切换：暗色 One Dark / 亮色 CM 官方默认
                    hlStyleCx.of(syntaxHighlighting(themeSignal() === "dark" ? darkHighlight : defaultHighlightStyle)),
                    dslPlugin,
                    hlField,
                    editableCx.of(EditorView.editable.of(props.editable)),
                    labTheme,
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged && !silent) props.onChange(u.state.doc.toString());
                    }),
                ],
            }),
        });
    });
    onCleanup(() => view?.destroy());

    // 外部变化（切文件/保存/恢复）→ 替换文档；击键回流的值与文档一致，跳过（不动光标）
    createEffect(() => {
        const v = props.value;
        const vv = view;
        if (!vv) return;
        if (vv.state.doc.toString() !== v) {
            silent = true;
            try {
                vv.dispatch({ changes: { from: 0, to: vv.state.doc.length, insert: v } });
            } finally {
                silent = false;
            }
        }
    });
    // 主题切换（设置页）→ 换高亮风格
    createEffect(() => {
        view?.dispatch({
            effects: hlStyleCx.reconfigure(
                syntaxHighlighting(themeSignal() === "dark" ? darkHighlight : defaultHighlightStyle),
            ),
        });
    });
    // 锁态切换（只读模板）→ 即时生效
    createEffect(() => {
        view?.dispatch({ effects: editableCx.reconfigure(EditorView.editable.of(props.editable)) });
    });
    // 高亮区间变化（点模版结构树/变量行）→ 重画 decoration 并把视线带过去；
    // 文档替换后也要重放一次（offset 是相对当前文档的）
    createEffect(() => {
        const spec = props.highlight ?? null;
        const v = props.value; // 依赖文档：换文件后按新文档重放
        const vv = view;
        if (!vv) return;
        const effects: StateEffect<unknown>[] = [setHl.of(spec)];
        // 滚动目标优先用焦点段的字符位置（横向也要到位）；没有就退回焦点行行首
        const focusLine = spec?.focusLines?.[0] ?? spec?.lines?.[0];
        const docLen = vv.state.doc.length;
        const pos =
            spec?.focusPos !== undefined
                ? Math.min(Math.max(0, spec.focusPos), docLen)
                : focusLine !== undefined
                  ? vv.state.doc.line(Math.min(Math.max(1, focusLine), vv.state.doc.lines)).from
                  : undefined;
        if (pos !== undefined) {
            const to = spec?.focusEnd !== undefined ? Math.min(Math.max(pos, spec.focusEnd), docLen) : pos;
            const target: number | SelectionRange = to > pos ? EditorSelection.range(pos, to) : pos;
            effects.push(EditorView.scrollIntoView(target, { y: "center", x: "center" }));
        }
        vv.dispatch({ effects });
    });

    return <div ref={(el) => (host = el)} class="h-full min-h-0 text-left" />;
}
