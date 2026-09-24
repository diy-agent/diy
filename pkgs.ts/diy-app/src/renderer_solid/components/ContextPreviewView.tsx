/**
 * ContextPreviewView — 试验场右栏「系统上下文」view（任务 148 的预览入口）。
 *
 * 定位：**只读的可视化**，与 `_system.md` / `请求预览` 两个既有 view 并列，互不干扰
 * （原能力一行未改，切 tab 即可回去）。数据来自 `diy.context.preview`，跑的是
 * shared/context 里的**纯内存场景** —— 不落盘、不发 LLM、不影响真实会话。
 *
 * 三块：
 *   ① 场景选择（basic / template / boundary）
 *   ② 树：每个 path 的渲染方式、值预览、valueHash
 *   ③ 逐步投递：这一步实际变了哪些 path、投递动作是什么（snapshot/patch/none/clear）
 *      + system 与 runtime 的最终文本
 */
import { createResource, createSignal, For, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import type { ContextPreview } from "../../shared/context/preview";

const SCENARIOS = [
    { name: "basic", title: "基础投递" },
    { name: "template", title: "模板与 renderedHash" },
    { name: "boundary", title: "迁移与 rebaseline" },
];

export function ContextPreviewView() {
    const [name, setName] = createSignal("basic");
    const [data] = createResource(name, async (n) => {
        return (await diyService.diy.context.preview({ scenario: n })) as ContextPreview;
    });

    return (
        <div class="flex h-full min-h-0 flex-col text-xs">
            <div class="flex items-center gap-1 border-b px-3 py-1.5 shrink-0">
                <For each={SCENARIOS}>
                    {(s) => (
                        <button
                            class={`btn btn-xs ${name() === s.name ? "btn-active" : "btn-ghost"}`}
                            aria-pressed={name() === s.name}
                            onClick={() => setName(s.name)}
                        >
                            {s.title}
                        </button>
                    )}
                </For>
                <span class="ml-auto font-mono text-[10px] opacity-60">
                    wire {data()?.wireVersion ?? "…"}
                </span>
            </div>

            <Show when={data()} fallback={<div class="p-3 opacity-60">计算中…</div>}>
                {(d) => (
                    <div class="flex-1 min-h-0 overflow-auto p-3 space-y-4">
                        {/* ① places */}
                        <section>
                            <div class="mb-1 font-bold tracking-widest opacity-70">PLACES（割点集合）</div>
                            <div class="flex flex-wrap gap-1">
                                <For each={d().places}>
                                    {(p) => (
                                        <span class="badge badge-sm badge-outline font-mono">
                                            {p.path}
                                            <span class="ml-1 opacity-60">{p.container}</span>
                                        </span>
                                    )}
                                </For>
                            </div>
                        </section>

                        {/* ② 树 */}
                        <section>
                            <div class="mb-1 font-bold tracking-widest opacity-70">
                                TREE（{d().nodes.length} 个节点）
                            </div>
                            <table class="table table-xs">
                                <thead>
                                    <tr>
                                        <th>path</th>
                                        <th>renderer</th>
                                        <th>值 / 源码</th>
                                        <th>valueHash</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={d().nodes}>
                                        {(n) => (
                                            <tr>
                                                <td class="font-mono">{n.path}</td>
                                                <td class="opacity-70">{n.renderer}</td>
                                                <td class="max-w-md truncate" title={n.preview}>
                                                    {n.preview}
                                                </td>
                                                <td class="font-mono opacity-60">{n.valueHash.slice(0, 12)}</td>
                                            </tr>
                                        )}
                                    </For>
                                </tbody>
                            </table>
                        </section>

                        {/* ③ 逐步投递 */}
                        <section>
                            <div class="mb-1 font-bold tracking-widest opacity-70">STEP 投递</div>
                            <ol class="space-y-1">
                                <For each={d().steps}>
                                    {(s, i) => (
                                        <li class="flex items-start gap-2">
                                            <span class="opacity-50">{i() + 1}.</span>
                                            <span class="flex-1">{s.note}</span>
                                            <span class="badge badge-sm badge-ghost font-mono">{s.delivery}</span>
                                            <Show when={s.needRebaseline}>
                                                <span class="badge badge-sm badge-warning">rebaseline</span>
                                            </Show>
                                            <Show when={s.changed.length > 0}>
                                                <span class="font-mono opacity-50">
                                                    Δ {s.changed.join(", ")}
                                                </span>
                                            </Show>
                                        </li>
                                    )}
                                </For>
                            </ol>
                        </section>

                        {/* ④ 投影文本 */}
                        <section>
                            <div class="mb-1 font-bold tracking-widest opacity-70">SYSTEM（全量重建）</div>
                            <pre class="whitespace-pre-wrap rounded bg-base-200 p-2 font-mono">
                                {d().system || "（空）"}
                            </pre>
                        </section>
                        <section>
                            <div class="mb-1 font-bold tracking-widest opacity-70">RUNTIME（增量投递内容）</div>
                            <pre class="whitespace-pre-wrap rounded bg-base-200 p-2 font-mono">
                                {d().runtimeText || "（空）"}
                            </pre>
                        </section>
                    </div>
                )}
            </Show>
        </div>
    );
}
