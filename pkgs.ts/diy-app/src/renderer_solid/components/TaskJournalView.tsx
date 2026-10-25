// components/TaskJournalView.tsx — 任务日志的**只读视图**（##404 演示）
//
// 两个视图：**原 JSONL**（落盘形态，坏行也照原样）+ **渲染**（markdown，按 kind 分组）。
// 为什么原 JSONL 也要给：这套存储最该暴露的故障是"半截写入 / 手改坏行"，而解析后的视图
// 恰恰会把它藏起来（`findJournal` 跳过坏行）。看得见原始字节，才知道日志到底有没有坏。
//
// 为什么不在这里 add：写入要 kind + 一行标题 + 可选正文与 refs，塞进详情页会变成半个编辑器；
// agent 侧 `diy journal add` 已经够用，这里只做**看**。
import { For, Show, createResource, createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { CodeBlock } from "./CodeBlock";
import { MarkdownView } from "./MarkdownView";

type Res<T> = { ok: true; data: T } | { ok: false; err: string };

async function guard<T>(p: Promise<T>): Promise<Res<T>> {
    try {
        return { ok: true, data: await p };
    } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
}

const KIND_LABEL: Record<string, string> = {
    decision: "决策",
    pitfall: "踩坑",
    review: "结论",
    progress: "里程碑",
    learn: "发现",
};

export function TaskJournalView(props: { uri: string }) {
    // 默认给**渲染**（可读的那份）；要看落盘原文按 `<>`。
    const [mode, setMode] = createSignal<"raw" | "rendered">("rendered");
    const [raw, { refetch: refetchRaw }] = createResource(
        () => props.uri,
        (t) => guard(diyService.diy.journal.raw({ task: t })),
    );
    const [view, { refetch: refetchView }] = createResource(
        () => (mode() === "rendered" ? props.uri : null),
        (t) =>
            guard(
                diyService.diy.journal.find({
                    task: t,
                    limit: -1,
                    order: "asc",
                    kind: undefined,
                    since: undefined,
                    until: undefined,
                    grep: undefined,
                }),
            ),
    );

    // 联合类型只窄一次（同 TaskFactsView 的注释）
    // 取值各调一次（TS 不在两次调用之间收窄，见 TaskFactsView 的同类注释）
    const rawData = () => {
        const r = raw();
        return r !== undefined && r.ok ? r.data : null;
    };
    const rawErr = () => {
        const r = raw();
        return r !== undefined && !r.ok ? r.err : null;
    };
    const viewData = () => {
        const r = view();
        return r !== undefined && r.ok ? r.data : null;
    };
    const viewErr = () => {
        const r = view();
        return r !== undefined && !r.ok ? r.err : null;
    };

    const byKind = () => {
        const v = viewData();
        if (v === null) return [] as { kind: string; n: number }[];
        const m = new Map<string, number>();
        for (const r of v.rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
        return [...m.entries()].map(([kind, n]) => ({ kind, n }));
    };

    return (
        <div class="space-y-2 text-body">
            <div class="flex flex-wrap items-center gap-2">
                <span class="badge badge-sm badge-ghost font-mono">journal</span>
                <Show when={rawData()}>
                    <span class="opacity-70">
                        {rawData()!.count} 条 · {(rawData()!.bytes / 1024).toFixed(1)} KB
                    </span>
                </Show>
                <Show when={mode() === "rendered" && viewData() !== null}>
                    <For each={byKind()}>
                        {(k) => (
                            <span class="badge badge-xs badge-outline">
                                {KIND_LABEL[k.kind] ?? k.kind} {k.n}
                            </span>
                        )}
                    </For>
                </Show>
                <button
                    class={`btn btn-xs ml-auto ${mode() === "raw" ? "btn-active" : "btn-ghost"}`}
                    aria-pressed={mode() === "raw"}
                    title={mode() === "raw" ? "回到渲染视图" : "看源文件（journal.jsonl 原文，含坏行）"}
                    onClick={() => setMode(mode() === "raw" ? "rendered" : "raw")}
                >
                    &lt;&gt;
                </button>
                <button
                    class="btn btn-ghost btn-xs opacity-60 hover:opacity-100"
                    title="刷新"
                    onClick={() => void (mode() === "raw" ? refetchRaw() : refetchView())}
                >
                    🔄
                </button>
            </div>

            <Show when={mode() === "raw"}>
                <Show
                    when={rawData()}
                    fallback={
                        <Show when={rawErr()} fallback={<div class="opacity-50">读取中…</div>}>
                            <div class="text-warning whitespace-pre-wrap break-all">{rawErr()}</div>
                        </Show>
                    }
                >
                    {(r) => (
                        <Show
                            when={r().exists}
                            fallback={<div class="opacity-60">还没有日志（<code class="font-mono">{r().path}</code>）—— 第一次 <code class="font-mono">diy journal add</code> 自动创建。</div>}
                        >
                            <div class="space-y-1">
                                <div class="font-mono opacity-60 text-xs break-all">{r().path}</div>
                                <CodeBlock code={r().text} lang="json" />
                                <div class="opacity-50">一行一条 JSON，只追加。坏行会照原样出现在这里（渲染视图会跳过它）。</div>
                            </div>
                        </Show>
                    )}
                </Show>
            </Show>

            <Show when={mode() === "rendered"}>
                <Show
                    when={viewData()}
                    fallback={
                        <Show when={viewErr()} fallback={<div class="opacity-50">读取中…</div>}>
                            <div class="text-warning whitespace-pre-wrap break-all">{viewErr()}</div>
                        </Show>
                    }
                >
                    {(v) => (
                        <div class="space-y-1">
                            <Show when={v().problems.length > 0}>
                                <div class="text-error">
                                    有 {v().problems.length} 条坏行被跳过（原 JSONL 里能看见）
                                </div>
                            </Show>
                            <Show when={v().rows.length > 0} fallback={<div class="opacity-50">无条目</div>}>
                                <MarkdownView content={v().text} />
                            </Show>
                        </div>
                    )}
                </Show>
            </Show>
        </div>
    );
}
