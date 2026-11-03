/**
 * DisputePanel.tsx — 打回**讨论线程**视图（##342）：异议线程挂在锚点上（= 真打回边），
 * 不占位置、不产生新历史 —— 于是它与泳道视图是**同一份事件流的两种投影**。
 *
 * 数据来源：`flow thread list`（RPC，`lib/flow-view.ts::fetchThreads`）—— **UI 永不读 `flow/*.json`**。
 * 讨论流是**旁注**（`rule.core-log`）：坏了 / 被删了只亮**错误位**（`data-flow-thread-error`），
 * 不炸页面、也不影响折线与推进。
 *
 * 边界（本轮的定案，见任务回报）：
 *  · 界面只**读**：可见性与留痕是本任务的交付；发言（含 resolved / escalate 两个出口）走 CLI
 *    `diy flow thread post` —— 「谁能发言」的权限语义属 ##325（隐私边界），未定前不钉进 UI；
 *  · 线程只挂在**真打回**上：折线上查无此打回的发言标「折线上查无此打回」（坏数据亮出来，不藏）。
 */
import { For, Show } from "solid-js";
import type { FlowThreadsView, FlowThreadView } from "../../lib/flow-view";
import { POST_TYPE_LABEL, THREAD_STATUS_LABEL } from "../../lib/flow-view";

/** 一条发言（时间线的一行） */
function PostRow(props: { post: FlowThreadView["posts"][number] }) {
    return (
        <li class="rounded border border-base-300 bg-base-100 p-1" data-flow-post={props.post.id}>
            <div class="flex items-center gap-1 text-body opacity-70">
                <span class="badge badge-xs badge-ghost" data-flow-post-type={props.post.type}>
                    {POST_TYPE_LABEL[props.post.type]}
                </span>
                <span class="font-bold" data-flow-post-author>
                    {props.post.author}
                </span>
                <span class="ml-auto font-mono" data-flow-post-at>
                    {props.post.at}
                </span>
            </div>
            <div class="whitespace-pre-wrap break-words" data-flow-post-text>
                {props.post.text}
            </div>
        </li>
    );
}

export function DisputePanel(props: {
    /** `flow thread list` 的载荷（探测失败 ⇒ null，原因在 `probeError`） */
    threads: FlowThreadsView | null;
    /** 「命令不在 / 调用失败」的原因位（`null` = 没出错） */
    probeError: string | null;
    /** 当前选中的线程 id（来自折线选中的打回卡 / 列表点击 / 缺省最后一条） */
    selected: string | null;
    onSelect: (id: string) => void;
}) {
    const current = () => props.threads?.threads.find((t) => t.id === props.selected) ?? null;

    return (
        <div class="flex h-full min-h-0 flex-col gap-1 overflow-auto p-2 text-body" data-flow-dispute="">
            <div class="flex items-center gap-1">
                <span class="font-bold opacity-70">📣 讨论</span>
                <span class="badge badge-xs badge-ghost" data-flow-thread-count={String(props.threads?.threads.length ?? 0)}>
                    {props.threads?.threads.length ?? 0} 个线程
                </span>
                <span class="opacity-50">锚点 = 折线上的真打回边（打回不新建节点）</span>
            </div>

            {/* 错误位（##337 P2-B 的同一立场）：旁注坏了只说一句，不炸页面 */}
            <Show when={props.probeError}>
                {(msg) => (
                    <div class="rounded border border-warning/60 bg-warning/10 p-1" data-flow-thread-error="">
                        讨论流取数失败：{msg()}（旁注坏了不影响折线与推进）
                    </div>
                )}
            </Show>
            <Show when={props.threads?.error ?? null}>
                {(msg) => (
                    <div class="rounded border border-warning/60 bg-warning/10 p-1" data-flow-thread-error="">
                        讨论流读不出：{msg()}（旁注坏了不影响推进 —— 删掉它即可）
                    </div>
                )}
            </Show>
            <Show when={props.threads && props.threads.skipped > 0}>
                <div class="opacity-60" data-flow-thread-skipped={String(props.threads!.skipped)}>
                    讨论流跳过 {props.threads!.skipped} 行（读不出 / 形状不符 —— 旁注可丢）
                </div>
            </Show>

            <Show
                when={props.threads && props.threads.threads.length > 0}
                fallback={<div class="opacity-60" data-flow-thread-none="">还没有打回 ⇒ 没有讨论线程（线程挂在真打回边上，不虚构）</div>}
            >
                <ul class="flex flex-col gap-0.5">
                    <For each={props.threads!.threads}>
                        {(t) => (
                            <li>
                                <button
                                    class="w-full rounded border px-1 py-0.5 text-left"
                                    classList={{
                                        "border-primary ring-1 ring-primary/40": props.selected === t.id,
                                        "border-base-300": props.selected !== t.id,
                                    }}
                                    data-flow-thread={t.id}
                                    data-flow-thread-status={t.status}
                                    data-flow-thread-real={t.real ? "1" : "0"}
                                    data-flow-thread-selected={props.selected === t.id ? "1" : "0"}
                                    onClick={() => props.onSelect(t.id)}
                                >
                                    <div class="flex items-center gap-1">
                                        <span class="font-mono">{t.id}</span>
                                        <span class="badge badge-xs" data-flow-thread-status-badge={t.status}>
                                            {THREAD_STATUS_LABEL[t.status]}
                                        </span>
                                        <span class="ml-auto opacity-60">{t.posts.length} 条</span>
                                    </div>
                                    <div class="opacity-70">
                                        {t.fromName}#{t.fromSeq ?? "?"} 打回 → {t.toName}#{t.anchor.seq}
                                        <Show when={!t.real}>
                                            <span class="ml-1 badge badge-xs badge-error">折线上查无此打回</span>
                                        </Show>
                                    </div>
                                </button>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>

            {/* 选中线程的发言时间线（append-only 的追加次序 = 时间序） */}
            <Show when={current()}>
                {(t) => (
                    <div class="flex min-h-0 flex-col gap-0.5" data-flow-thread-posts={t().id}>
                        <Show
                            when={t().posts.length > 0}
                            fallback={
                                <div class="opacity-60" data-flow-thread-empty="">
                                    这次打回还没有发言（自动打回的意见、`diy flow thread post` 的发言都会落在这里）
                                </div>
                            }
                        >
                            <ol class="flex flex-col gap-0.5">
                                <For each={t().posts}>{(p) => <PostRow post={p} />}</For>
                            </ol>
                        </Show>
                    </div>
                )}
            </Show>
        </div>
    );
}
