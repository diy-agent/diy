import { onMount, onCleanup, createEffect } from "solid-js";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
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
        ".cm-activeLineGutter": { opacity: "0.9" },
    },
    { dark: true },
);

/** Markdown 模板编辑器（CodeMirror 6，受控：value 变化且与文档不一致时才替换）。 */
export function MdEditor(props: { value: string; editable: boolean; onChange: (v: string) => void }) {
    let host: HTMLDivElement | undefined;
    let view: EditorView | undefined;
    const editableCx = new Compartment();

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
                    EditorView.lineWrapping,
                    editableCx.of(EditorView.editable.of(props.editable)),
                    labTheme,
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged) props.onChange(u.state.doc.toString());
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
            vv.dispatch({ changes: { from: 0, to: vv.state.doc.length, insert: v } });
        }
    });
    // 锁态切换（只读模板）→ 即时生效
    createEffect(() => {
        view?.dispatch({ effects: editableCx.reconfigure(EditorView.editable.of(props.editable)) });
    });

    return <div ref={(el) => (host = el)} class="h-full min-h-0 text-left" />;
}
