import { createSignal, createEffect, on, For, Show } from "solid-js";
import { MarkdownView } from "./MarkdownView";

/** JSON 树形查看：对象/数组逐层折叠，长字符串按真实换行展开（可切 MD 渲染）。
 *  解决 JSON.stringify 一坨转义 `\n` 没法看的问题（请求体 messages[].content 等多行 md）。 */

const LONG_STR = 200;

function looksMarkdown(s: string): boolean {
    return /^#{1,6} |```|\*\*|^\s*[-*] /m.test(s);
}

function JsonNode(props: { k?: string; v: unknown; depth: number; floor: () => number }) {
    const [open, setOpen] = createSignal(props.depth <= props.floor());
    const [md, setMd] = createSignal(false);
    // 全局展开层级变化时同步；手动折叠在两次点击之间保留
    createEffect(on(() => props.floor(), (f) => setOpen(props.depth <= f)));
    const v = () => props.v;
    const isObj = () => v() !== null && typeof v() === "object";
    const isArr = () => Array.isArray(v());
    const keys = () => (isObj() && !isArr() ? Object.keys(v() as Record<string, unknown>) : []);
    const items = () => (isArr() ? (v() as Array<unknown>) : []);

    // 只有数组留计数器，对象的 {N} 去掉（干扰）
    const summary = () => (isArr() ? `Array(${items().length})` : "");
    const keyLabel = () => (props.k !== undefined ? <span class="text-info">"{props.k}"</span> : null);

    // 标量
    if (!isObj()) {
        if (typeof v() === "string") {
            const s = v() as string;
            const lines = s.split("\n");
            const long = lines.length > 1 || s.length > LONG_STR;
            if (!long) {
                return (
                    <div class="py-px">
                        {keyLabel()}
                        {props.k !== undefined && <span class="opacity-40">: </span>}
                        <span class="text-success">"{s}"</span>
                    </div>
                );
            }
            return (
                <div class="py-px">
                    <div class="flex items-center gap-1">
                        <button class="opacity-60 hover:opacity-100" onClick={() => setOpen((o) => !o)}>
                            {open() ? "▾" : "▸"}
                        </button>
                        {keyLabel()}
                        {props.k !== undefined && <span class="opacity-40">: </span>}
                        <Show
                            when={open()}
                            fallback={
                                <button class="text-left opacity-70 hover:opacity-100" onClick={() => setOpen(true)}>
                                    <span class="text-success">"{lines[0]!.slice(0, 80)}{s.length > 80 ? "…" : ""}"</span>
                                    <span class="ml-1 badge badge-xs badge-ghost">
                                        {lines.length > 1 ? `${lines.length}行` : `${s.length}字`}
                                    </span>
                                </button>
                            }
                        >
                            <span class="badge badge-xs badge-ghost">
                                {lines.length}行 · {s.length}字
                            </span>
                        </Show>
                        <Show when={open() && looksMarkdown(s)}>
                            <button
                                class={`btn btn-xs ${md() ? "btn-active" : "btn-ghost"}`}
                                onClick={() => setMd((m) => !m)}
                            >
                                MD
                            </button>
                        </Show>
                    </div>
                    <Show when={open()}>
                        <div class="ml-4 border-l border-base-300 pl-2">
                            <Show
                                when={md()}
                                fallback={
                                    <pre class="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{s}</pre>
                                }
                            >
                                <MarkdownView content={s} class="text-xs" />
                            </Show>
                        </div>
                    </Show>
                </div>
            );
        }
        const color =
            typeof v() === "number" ? "text-warning" : v() === null ? "opacity-50" : "text-secondary";
        return (
            <div class="py-px">
                {keyLabel()}
                {props.k !== undefined && <span class="opacity-40">: </span>}
                <span class={color}>{JSON.stringify(v())}</span>
            </div>
        );
    }

    // 容器
    return (
        <div class="py-px">
            <div class="flex items-center gap-1">
                <button class="opacity-60 hover:opacity-100" onClick={() => setOpen((o) => !o)}>
                    {open() ? "▾" : "▸"}
                </button>
                {keyLabel()}
                {props.k !== undefined && <span class="opacity-40">: </span>}
                <button class="opacity-70 hover:opacity-100 font-mono" onClick={() => setOpen((o) => !o)}>
                    {isArr() ? "[" : "{"}
                    <Show when={!open() && isArr()}>
                        <span class="opacity-60 text-[10px]"> {summary()} </span>
                    </Show>
                    <Show when={!open()}>{isArr() ? "]" : "}"}</Show>
                </button>
                <Show when={open() && isArr()}>
                    <span class="opacity-40 text-[10px] font-mono">{summary()}</span>
                </Show>
            </div>
            <Show when={open()}>
                <div class="ml-4 border-l border-base-300 pl-2">
                    <Show when={isArr()} fallback={<For each={keys()}>{(k) => <JsonNode k={k} v={(v() as Record<string, unknown>)[k]} depth={props.depth + 1} floor={props.floor} />}</For>}>
                        <For each={items()}>
                            {(item, i) => (
                                <div class="flex gap-1">
                                    <span class="opacity-30 font-mono text-[10px] pt-0.5">{i()}</span>
                                    <div class="flex-1 min-w-0">
                                        <JsonNode v={item} depth={props.depth + 1} floor={props.floor} />
                                    </div>
                                </div>
                            )}
                        </For>
                    </Show>
                    <div class="opacity-40 font-mono">{isArr() ? "]" : "}"}</div>
                </div>
            </Show>
        </div>
    );
}

/** 数据最大嵌套深（展开轮转上限） */
function depthOf(v: unknown): number {
    if (v !== null && typeof v === "object") {
        const vs = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
        if (vs.length === 0) return 1;
        return 1 + Math.max(...vs.map(depthOf));
    }
    return 0;
}

export function JsonTree(props: { data: unknown }) {
    // 展开层级：点一次深一层，到顶后回到 1，往复
    const [floor, setFloor] = createSignal(1);
    const max = () => Math.max(1, depthOf(props.data));
    const step = () => setFloor((f) => (f >= max() ? 1 : f + 1));
    return (
        <div class="font-mono text-[11px] leading-relaxed">
            <div class="flex justify-end pb-1">
                <button class="btn btn-xs btn-ghost" onClick={step}>
                    {floor() >= max() ? `收起 ${max()}/${max()}层` : `展开到 ${floor() + 1}/${max()}层`}
                </button>
            </div>
            <JsonNode v={props.data} depth={0} floor={floor} />
        </div>
    );
}
