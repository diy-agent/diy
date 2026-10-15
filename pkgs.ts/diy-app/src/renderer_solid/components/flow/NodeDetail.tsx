/**
 * NodeDetail.tsx — 节点详情：`hint` 原文 / `guard` 数组逐条（标可观测性）/ `actor` / `art` 三段链。
 *
 * **诚实边界**（数据缺口，见 `lib/flow-view.ts` 文件头）：
 *  · `hint` 只有**当前节点**有（`FlowView.node.hint`，已由内核 `renderHint` 插值）；看折线上别的
 *    驻留时只能显示「hint 未下发」——不拿当前节点的 hint 冒充（那是另一种撒谎）。
 *  · `guard` 只有**不可观测**那一半（`next.pending`，形如 `prompt:xxx`）。可观测项（`pred:` / `action:`）
 *    本版宿主没注册插件、内核 `status()` 也不报 ⇒ 界面**只能标出「不可观测」，不能标出「可观测」**。
 *    这正是订正 6 的同一立场：缺的数据不编。
 *  · `art` 三段链来自 `diy flow view`（##337）；未接入时显示占位。
 */
import { For, Show } from "solid-js";
import type { FlowArt, FlowInstanceView, FlowArtifactView, FlowVisitBrief } from "../../lib/flow-view";
import type { ArtifactState } from "./FlowStage";

/** guard 前缀 → 可观测性（内核 `GUARD_PREFIXES` 的两类）：`prompt:` 不可观测，`pred:`/`action:` 可观测 */
function guardKind(raw: string): { observable: boolean; label: string } {
    const prefix = raw.includes(":") ? raw.slice(0, raw.indexOf(":")) : raw;
    if (prefix === "prompt") return { observable: false, label: "不可观测（等人宣布）" };
    if (prefix === "pred" || prefix === "action") return { observable: true, label: "可观测（系统求值）" };
    return { observable: false, label: "未知前缀" };
}

function ArtChain(props: { art: FlowArt | null }) {
    return (
        <Show when={props.art} fallback={<div class="text-body opacity-50">无 art（该节点未声明产物链）</div>}>
            {(art) => (
                <div class="flex flex-col gap-0.5" data-flow-art-chain="">
                    <div class="flex gap-1">
                        <span class="w-12 shrink-0 opacity-50">raw</span>
                        <span class="break-all">{art().raw}</span>
                    </div>
                    <div class="flex gap-1">
                        <span class="w-12 shrink-0 opacity-50">plugin</span>
                        <span class="break-all">{art().plugin ?? "（无：直吃 raw）"}</span>
                    </div>
                    <div class="flex gap-1">
                        <span class="w-12 shrink-0 opacity-50">renderer</span>
                        <span class="badge badge-xs" data-flow-art-renderer={art().renderer}>
                            {art().renderer}
                        </span>
                    </div>
                    <Show when={art().note}>
                        {(n) => (
                            <div class="flex gap-1 opacity-70">
                                <span class="w-12 shrink-0 opacity-50">note</span>
                                <span>{n()}</span>
                            </div>
                        )}
                    </Show>
                </div>
            )}
        </Show>
    );
}

export function NodeDetail(props: {
    view: FlowInstanceView;
    /** 当前选中的驻留（null = 未选，看「当前位置」） */
    visit: FlowVisitBrief | null;
    artifacts: Record<string, ArtifactState>;
    stepKey: string | null;
}) {
    const isCurrent = () => props.visit === null || props.view.position === props.visit?.node;
    const nodeId = () => props.visit?.node ?? props.view.position ?? props.view.entry;
    const artifact = () => (props.stepKey ? props.artifacts[props.stepKey] : undefined);
    const art = (): FlowArt | null => {
        const st = artifact();
        return st && st.kind === "ready" ? st.value.art : null;
    };

    return (
        <div class="flex h-full flex-col gap-2 overflow-auto p-2 text-body" data-flow-detail={nodeId()}>
            <div class="flex items-center gap-2">
                <span class="badge badge-sm" data-flow-detail-node={nodeId()}>
                    {nodeId()}
                </span>
                <span class="opacity-60">{props.view.workflowName}</span>
                <Show when={!isCurrent()}>
                    <span class="badge badge-xs badge-ghost">非当前节点</span>
                </Show>
            </div>

            <section>
                <div class="mb-0.5 font-bold opacity-70">actor</div>
                <div data-flow-detail-actor="">{isCurrent() ? (props.view.node?.actor ?? "—") : "（未下发）"}</div>
            </section>

            <section>
                <div class="mb-0.5 font-bold opacity-70">hint（插值后原文）</div>
                <Show
                    when={isCurrent() && props.view.node}
                    fallback={<div class="text-body opacity-50">hint 未下发（`FlowView` 只给当前节点）</div>}
                >
                    {(n) => (
                        <pre
                            class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-base-300/40 p-2"
                            data-flow-detail-hint=""
                        >
                            {n().hint}
                        </pre>
                    )}
                </Show>
            </section>

            <section>
                <div class="mb-0.5 font-bold opacity-70">guard</div>
                <Show
                    when={isCurrent() && props.view.next.pending.length > 0}
                    fallback={
                        <div class="text-body opacity-50">
                            {isCurrent() ? "当前节点没有待宣布的 guard（已进入终态？）" : "guard 未下发（只报当前节点的 pending）"}
                        </div>
                    }
                >
                    <ul class="flex flex-col gap-0.5" data-flow-detail-guards="">
                        <For each={props.view.next.pending}>
                            {(g) => (
                                <li class="flex items-center gap-1" data-flow-guard={g}>
                                    <span class="badge badge-xs">prompt:</span>
                                    <span class="font-mono">{g}</span>
                                    <span class="badge badge-xs badge-ghost" title={guardKind(g).label}>
                                        {guardKind(g).label}
                                    </span>
                                </li>
                            )}
                        </For>
                    </ul>
                </Show>
                <div class="mt-0.5 opacity-50">
                    `pred:` / `action:`（可观测）本版宿主未注册插件 ⇒ 下发里没有，界面也就不标 —— 缺的数据不编。
                </div>
            </section>

            <section>
                <div class="mb-0.5 font-bold opacity-70">art（raw → plugin → renderer）</div>
                <Show
                    when={artifact()?.kind === "unavailable" ? (artifact() as { reason: string }) : null}
                    fallback={<ArtChain art={art()} />}
                >
                    {(u) => <div class="text-body opacity-60">产物区待接入：{u().reason}</div>}
                </Show>
            </section>

            <section>
                <div class="mb-0.5 font-bold opacity-70">折线</div>
                <ol class="flex flex-col gap-0.5">
                    <For each={props.view.trajectory}>
                        {(v, i) => (
                            <li class="flex items-center gap-1">
                                <span class="font-mono opacity-50">#{i() + 1}</span>
                                <span>{v.node}</span>
                                <Show when={v.kind === "bounce"}>
                                    <span class="badge badge-xs badge-error">打回</span>
                                </Show>
                                <Show when={v.seq > 1}>
                                    <span class="opacity-60">第 {v.seq} 次</span>
                                </Show>
                            </li>
                        )}
                    </For>
                </ol>
                <Show when={props.view.auditSkipped > 0}>
                    <div class="opacity-60">审计流跳过 {props.view.auditSkipped} 行（审计坏了不阻断运行）</div>
                </Show>
            </section>
        </div>
    );
}

/** 供 FlowPage 复用的类型出口（避免组件间互引私有类型） */
export type { FlowArtifactView };
