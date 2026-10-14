import { createSignal, createEffect, createMemo, on, For, Show } from "solid-js";
import { load as yamlLoad } from "js-yaml";
import { MarkdownView } from "./MarkdownView";

/** JSON 树形查看：对象/数组逐层折叠，长字符串按真实换行展开。
 *  长字符串可切换预览格式（MD / JSON / YAML）：字符串里塞的往往是 markdown 正文、
 *  被转义的 JSON、或 YAML —— 直接看一堆 `\n` / 转义引号太难认，给几个「猜一猜」的渲染态。
 *  解决 JSON.stringify 一坨转义没法看的问题（请求体 messages[].content 等多行内容）。 */

const LONG_STR = 200;

/** 长字符串可切的预览格式（按内容猜：markdown 正文 / 内嵌 JSON / 内嵌 YAML） */
const FORMATS = [
    { v: "md", label: "MD", tip: "按 Markdown 渲染（猜测性预览）" },
    { v: "json", label: "JSON", tip: "按 JSON 解析后树形展示；解析失败会提示" },
    { v: "yaml", label: "YAML", tip: "按 YAML 解析后树形展示；解析失败会提示" },
] as const;

/** 字符串预览：原文 / Markdown / JSON / YAML 四态（后三者是「猜一猜」的渲染） */
function StringPreview(props: { fmt: "raw" | "md" | "json" | "yaml"; raw: string }) {
    return (
        <Show
            when={props.fmt === "md"}
            fallback={
                <Show when={props.fmt !== "raw"} fallback={<pre class="whitespace-pre-wrap font-mono text-body leading-relaxed">{props.raw}</pre>}>
                    <ParsedPreview raw={props.raw} kind={props.fmt as "json" | "yaml"} />
                </Show>
            }
        >
            <MarkdownView content={props.raw} class="text-body" />
        </Show>
    );
}

/** 把字符串按 JSON / YAML 解析后套进树视图；解析失败给一句人话（不静默退回原文让人误以为空） */
function ParsedPreview(props: { raw: string; kind: "json" | "yaml" }) {
    const res = createMemo(() => {
        try {
            const data = props.kind === "json" ? JSON.parse(props.raw) : yamlLoad(props.raw);
            return { ok: true as const, data };
        } catch (e) {
            return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
    });
    return (
        <Show
            when={res().ok}
            fallback={<div class="text-warning text-caption">不是合法 {props.kind.toUpperCase()}：{(res() as { message: string }).message}</div>}
        >
            <JsonTree data={(res() as { data: unknown }).data} />
        </Show>
    );
}

function JsonNode(props: { k?: string; v: unknown; depth: number; floor: () => number }) {
    const [open, setOpen] = createSignal(props.depth <= props.floor());
    // 长字符串的预览格式：原文 / Markdown / JSON / YAML（猜测性渲染）
    const [fmt, setFmt] = createSignal<"raw" | "md" | "json" | "yaml">("raw");
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
                        <Show when={open()}>
                            <span class="join">
                                <For each={FORMATS}>
                                    {(f) => (
                                        <button
                                            class={`btn btn-xs join-item ${fmt() === f.v ? "btn-active" : "btn-ghost"}`}
                                            title={f.tip}
                                            onClick={() => setFmt((cur) => (cur === f.v ? "raw" : f.v))}
                                        >
                                            {f.label}
                                        </button>
                                    )}
                                </For>
                            </span>
                        </Show>
                    </div>
                    <Show when={open()}>
                        <div class="ml-4 border-l border-base-300 pl-2">
                            <StringPreview fmt={fmt()} raw={s} />
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
                        <span class="opacity-60 text-caption"> {summary()} </span>
                    </Show>
                    <Show when={!open()}>{isArr() ? "]" : "}"}</Show>
                </button>
                <Show when={open() && isArr()}>
                    <span class="opacity-40 text-caption font-mono">{summary()}</span>
                </Show>
            </div>
            <Show when={open()}>
                <div class="ml-4 border-l border-base-300 pl-2">
                    <Show when={isArr()} fallback={<For each={keys()}>{(k) => <JsonNode k={k} v={(v() as Record<string, unknown>)[k]} depth={props.depth + 1} floor={props.floor} />}</For>}>
                        <For each={items()}>
                            {(item, i) => (
                                <div class="flex gap-1">
                                    <span class="opacity-30 font-mono text-caption pt-0.5">{i()}</span>
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
        <div class="font-mono text-body leading-relaxed">
            <div class="flex justify-end pb-1">
                <button class="btn btn-xs btn-ghost" onClick={step}>
                    {floor() >= max() ? `收起 ${max()}/${max()}层` : `展开到 ${floor() + 1}/${max()}层`}
                </button>
            </div>
            <JsonNode v={props.data} depth={0} floor={floor} />
        </div>
    );
}
