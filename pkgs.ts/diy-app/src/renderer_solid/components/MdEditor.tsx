import { onMount, onCleanup, createEffect } from "solid-js";
import {
    EditorView,
    Decoration,
    keymap,
    lineNumbers,
    highlightActiveLine,
    type DecorationSet,
} from "@codemirror/view";
import { EditorState, Compartment, StateEffect, StateField, type Range } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";

/** daisyUI 贴合主题：等宽 12px，行号弱显，纸面用 base-100 */
const labTheme = EditorView.theme(
    {
        "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--color-base-100)" },
        ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--color-primary)" },
        ".cm-gutters": {
            backgroundColor: "transparent",
            borderRight: "1px solid var(--color-base-300)",
            color: "var(--color-base-content)",
            opacity: "0.4",
        },
        ".cm-activeLine": { backgroundColor: "var(--color-base-200)" },
        // 结构树/变量行点中时，模版里对应的那段源码
        ".cm-lab-hl": {
            backgroundColor: "var(--color-warning)",
            opacity: "0.35",
            borderRadius: "2px",
        },
        ".cm-activeLineGutter": { opacity: "0.9" },
    },
    { dark: true },
);

/** 高亮区间（源码字符偏移；来自引擎的 trace/analyze 区间） */
export interface HlSpan {
    from: number;
    to: number;
}

const setHl = StateEffect.define<HlSpan[] | null>();

/** 高亮用 Decoration（多条：点变量行时同一个变量的多处出现一起亮） */
const hlField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        let next = deco.map(tr.changes);
        for (const e of tr.effects) {
            if (!e.is(setHl)) continue;
            const ranges: Range<Decoration>[] = [];
            for (const sp of e.value ?? []) {
                // 空区间不画（Decoration 不允许 from==to）；越界夹回文档
                const from = Math.max(0, Math.min(sp.from, tr.state.doc.length));
                const to = Math.max(0, Math.min(sp.to, tr.state.doc.length));
                if (to > from) ranges.push(Decoration.mark({ class: "cm-lab-hl" }).range(from, to));
            }
            next = Decoration.set(ranges, true);
        }
        return next;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/** Markdown 模板编辑器（CodeMirror 6，受控：value 变化且与文档不一致时才替换）。 */
export function MdEditor(props: {
    value: string;
    editable: boolean;
    onChange: (v: string) => void;
    /** 要高亮的源码区间（结构树/变量行点中时传入；null = 清空） */
    highlight?: HlSpan[] | null;
}) {
    let host: HTMLDivElement | undefined;
    let view: EditorView | undefined;
    const editableCx = new Compartment();
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
                    markdown(),
                    hlField,
                    EditorView.lineWrapping,
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
    // 锁态切换（只读模板）→ 即时生效
    createEffect(() => {
        view?.dispatch({ effects: editableCx.reconfigure(EditorView.editable.of(props.editable)) });
    });
    // 高亮区间变化（点结构树/变量行）→ 重画 decoration 并把视线带过去；
    // 文档替换后也要重放一次（offset 是相对当前文档的）
    createEffect(() => {
        const spans = props.highlight ?? null;
        const v = props.value; // 依赖文档：换文件后按新文档重放
        const vv = view;
        if (!vv) return;
        const effects: StateEffect<unknown>[] = [setHl.of(spans)];
        if (spans && spans.length > 0) effects.push(EditorView.scrollIntoView(spans[0]!.from, { y: "center" }));
        vv.dispatch({ effects: effects as StateEffect<DecorationSet>[] });
    });

    return <div ref={(el) => (host = el)} class="h-full min-h-0 text-left" />;
}
