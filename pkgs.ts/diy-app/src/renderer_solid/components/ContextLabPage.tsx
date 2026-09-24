/**
 * ContextLabPage — 上下文树试验场（**独立子页面**，任务 148）。
 *
 * 为什么独立成页、而不是塞进提示词页右栏：
 *   ① 提示词页既有 view 已很多，再挤会互抢空间；
 *   ② 本页是**示范数据**（非当前任务的真实上下文），和真实预览同屏会被误读。
 *
 * 页面按「人怎么理解这件事」组织，六个块：
 *   左栏  · 变量树     —— 一棵树，作为系统上下文的全集（类似旧「变量」view）
 *         · 划分规则   —— ★核心：哪个变量归哪一份，为什么
 *   主栏  · system 份  —— 稳定那份的 render 结果（进提示词开头，可缓存）
 *         · runtime 份 —— 易变那份的 render 结果（进 user 消息）
 *         · 合成消息   —— 两份拼起来的实际形态
 *
 * 数据来自 `diy.context.lab`（纯内存示范场景，不落盘、不发 LLM）。
 */
import { createResource, createSignal, For, onMount, Show, type JSX } from "solid-js";
import { diyService } from "../lib/rpc";
import { taskStore } from "../store/taskStore";
import { ViewGrid } from "./ViewGrid";
import { layoutStore } from "../store/layoutStore";
import { findPage } from "../../shared/view-registry";
import { Caches } from "../lib/ui-state";
import type { ContextLab, LabTreeNode } from "../../shared/context/preview";

const PAGE = "ctxlab";

/** 折叠块展开态（模块级 + 落 Caches：`ui view expand` 可能在页面挂载前就切过来） */
const [fold, setFoldSig] = createSignal<Record<string, boolean>>(Caches.diy_ctxlab_fold.get());
function setFold(key: string, open: boolean): void {
    setFoldSig((v) => {
        const next = { ...v, [key]: open };
        Caches.diy_ctxlab_fold.set(next);
        return next;
    });
}
export function toggleCtxLabFold(key: string): void {
    setFold(key, !fold()[key]);
}
/** 供 `ui view expand`（App.tsx 按 `ctx.` 前缀分派过来） */
export function setCtxLabFold(key: string, open: boolean): void {
    setFold(key.replace(/^ctx\./, ""), open);
}
export const CTXLAB_FOLD_KEYS = ["tree", "rules", "system", "runtime", "message"] as const;

/** 折叠块（与提示词页的 viewHeader 同一形态，只是数据源不同） */
function Fold(props: { k: string; label: string; extra?: string; children: JSX.Element }) {
    return (
        <div
            class="flex min-h-0 flex-col rounded-lg border border-base-300"
            classList={{ "flex-1 min-h-[160px]": !!fold()[props.k] }}
        >
            <button
                class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-[11px] font-bold tracking-wide opacity-80 hover:opacity-100"
                onClick={() => toggleCtxLabFold(props.k)}
            >
                <span>{fold()[props.k] ? "▾" : "▸"}</span>
                <span>{props.label}</span>
                <Show when={props.extra}>
                    <span class="ml-auto font-mono font-normal opacity-70">{props.extra}</span>
                </Show>
            </button>
            <Show when={fold()[props.k]}>
                <div class="min-h-0 flex-1 overflow-auto bg-base-200 text-[11px]">{props.children}</div>
            </Show>
        </div>
    );
}

/** 归属徽标（system / runtime） */
function ContainerBadge(props: { c: "system" | "runtime" | null }) {
    return (
        <Show when={props.c} fallback={<span class="opacity-40">—</span>}>
            <span
                class={`badge badge-sm ${props.c === "system" ? "badge-primary" : "badge-warning"}`}
                classList={{ "badge-outline": true }}
            >
                {props.c}
            </span>
        </Show>
    );
}

/** 树行缩进：按点分段数（顶层 0） */
const indentOf = (path: string): number => path.split(".").length - 1;
const leafName = (path: string): string => path.split(".").slice(-1)[0];

export function ContextLabPage(props: { uri: string }) {
    onMount(() => {
        if (taskStore.selectedUri !== props.uri) void taskStore.selectTask(props.uri);
    });

    const [lab, { refetch }] = createResource(async () => {
        return (await diyService.diy.context.lab({ scenario: "task" })) as ContextLab;
    });

    const treeRows = () => lab()?.tree ?? [];

    /** 左栏：变量树（一棵树作为系统上下文的全集） */
    const varsPane = () => (
        <table class="table table-xs">
            <thead>
                <tr>
                    <th>变量路径</th>
                    <th>渲染</th>
                    <th>值</th>
                    <th>归属</th>
                </tr>
            </thead>
            <tbody>
                <For each={treeRows()}>
                    {(n: LabTreeNode) => (
                        <tr classList={{ "font-semibold": n.isPlace }}>
                            <td class="font-mono whitespace-nowrap">
                                <span style={{ "padding-left": `${indentOf(n.path) * 12}px` }} />
                                <span title={n.path}>{leafName(n.path)}</span>
                                <Show when={n.isPlace}>
                                    <span class="ml-1 badge badge-xs badge-ghost" title="投递单元（place）">
                                        单元
                                    </span>
                                </Show>
                            </td>
                            <td class="opacity-60">{n.renderer}</td>
                            <td class="max-w-xs truncate" title={n.preview}>
                                {n.preview}
                            </td>
                            <td>
                                <ContainerBadge c={n.container} />
                            </td>
                        </tr>
                    )}
                </For>
            </tbody>
        </table>
    );

    /** 左栏：划分规则（★核心 —— 哪些变量归哪份，为什么） */
    const rulesPane = () => (
        <table class="table table-xs">
            <thead>
                <tr>
                    <th>投递单元</th>
                    <th>归哪份</th>
                    <th>含哪些渲染单元</th>
                    <th>为什么</th>
                </tr>
            </thead>
            <tbody>
                <For each={lab()?.rules ?? []}>
                    {(r) => (
                        <tr>
                            <td class="font-mono font-semibold">{r.place}</td>
                            <td>
                                <ContainerBadge c={r.container} />
                            </td>
                            <td class="font-mono opacity-70">{r.renders.join(", ") || "—"}</td>
                            <td class="opacity-70">{r.reason}</td>
                        </tr>
                    )}
                </For>
            </tbody>
        </table>
    );

    /** 主栏：一份投递（单元列表 + render 结果） */
    const deliveryPane = (d: ContextLab["system"] | undefined, empty: string) => (
        <Show when={d} fallback={<div class="p-2 opacity-60">计算中…</div>}>
            <div class="p-2">
                <div class="mb-1 opacity-70">
                    单元：<span class="font-mono">{d!.places.join(", ") || "（无）"}</span>
                </div>
                <pre class="whitespace-pre-wrap rounded bg-base-100 p-2 font-mono leading-relaxed">
                    {d!.text || empty}
                </pre>
            </div>
        </Show>
    );

    const mainPane = () => (
        <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-xs">
            {/* ★核心先露脸：划分规则 */}
            <Fold
                k="rules"
                label="划分规则（核心）"
                extra={`${lab()?.rules.length ?? 0} 个投递单元`}
            >
                {rulesPane()}
            </Fold>
            <Fold
                k="system"
                label="system 份（稳定 → 提示词开头）"
                extra={lab() ? `${lab()!.system.places.length} 单元 · ${(lab()!.system.bytes / 1024).toFixed(1)} KB` : ""}
            >
                {deliveryPane(lab()?.system, "（空）")}
            </Fold>
            <Fold
                k="runtime"
                label="runtime 份（易变 → user 消息）"
                extra={lab() ? `${lab()!.runtime.places.length} 单元 · ${(lab()!.runtime.bytes / 1024).toFixed(1)} KB` : ""}
            >
                {deliveryPane(lab()?.runtime, "（空）")}
            </Fold>
            <Fold k="message" label="合成消息" extra="两份拼起来的实际形态">
                <Show when={lab()?.message} fallback={<div class="p-2 opacity-60">计算中…</div>}>
                    {(m) => (
                        <div class="space-y-2 p-2">
                            <div class="opacity-70">{m().note}</div>
                            <div>
                                <div class="mb-1 font-bold opacity-70">messages[0].system</div>
                                <pre class="whitespace-pre-wrap rounded bg-base-100 p-2 font-mono">
                                    {m().system || "（空）"}
                                </pre>
                            </div>
                            <div>
                                <div class="mb-1 font-bold opacity-70">messages[1].user</div>
                                <pre class="whitespace-pre-wrap rounded bg-base-100 p-2 font-mono">
                                    {m().user || "（空）"}
                                </pre>
                            </div>
                        </div>
                    )}
                </Show>
            </Fold>
        </div>
    );

    const parts: Record<string, () => JSX.Element> = {
        "ctxlab.left": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-xs">
                <Fold k="tree" label="变量树" extra={`${treeRows().length} 个变量`}>
                    {varsPane()}
                </Fold>
            </div>
        ),
        "ctxlab.delivery": mainPane,
    };

    const page = findPage(PAGE)!;

    return (
        <div class="flex h-full flex-col overflow-hidden">
            {/* 页头：任务 + 刷新 + **示范数据**声明（防止被当成当前任务的真实上下文） */}
            <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
                <span class="badge badge-info badge-sm" title={props.uri}>
                    📌 {props.uri}
                </span>
                <button
                    class="btn btn-xs btn-ghost"
                    title="重新计算（示范数据是纯内存的，刷新只是重跑一遍）"
                    onClick={() => void refetch()}
                >
                    ⟳ 刷新
                </button>
                <span class="badge badge-warning badge-sm badge-outline" title={lab()?.note}>
                    示范数据
                </span>
                <span class="opacity-60">{lab()?.title ?? "加载中…"}</span>
                <span class="ml-auto font-mono text-[10px] opacity-50">wire {lab()?.wireVersion ?? "…"}</span>
            </div>

            <div class="min-h-0 flex-1">
                <ViewGrid
                    pageId={PAGE}
                    ctx={props.uri}
                    layout={page.layout}
                    binding={layoutStore.bindingFor(page, props.uri)}
                    renderView={(viewId) =>
                        parts[viewId]?.() ?? <div class="p-3 text-xs opacity-60">未注册的 view: {viewId}</div>
                    }
                />
            </div>
        </div>
    );
}
