/**
 * FlowPage.tsx — 泳道视图页（##320）：**轨迹折线 + 产物 view + 参数表单 + 节点详情**。
 *
 * 页面是**独立子页面**（挂在任务执行页之下，ctx = 任务 URI）—— 与上下文树页同构：
 * 新增页面 + 新增组件文件，不改既有页面（App.tsx 只加一条路由分派、任务执行页只加入口按钮）。
 *
 * 数据（全部走 RPC，见 `lib/flow-view.ts`）：
 *  · `flow show` → 折线 / 当前节点 / 参数 / 终态（##319 已在 main）；
 *  · `flow view` → 产物（##337；未合入时本页显示「产物区待接入」，**不造假数据**）。
 *
 * 三个 view（注册表在 `shared/view-registry.ts`）：
 *  · `flow.stage`      —— center：泳道图（折线 + 每步产物）
 *  · `flow.inspector`  —— right：节点详情 + 参数表单
 */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { layoutStore } from "../store/layoutStore";
import { findPage } from "../../shared/view-registry";
import { ViewGrid } from "./ViewGrid";
import { FlowStage, visitKey, type ArtifactState } from "./flow/FlowStage";
import { NodeDetail } from "./flow/NodeDetail";
import { ParamForm } from "./flow/ParamForm";
import { fetchArtifact, loadFlow, type FlowInstanceView } from "../lib/flow-view";
import { notificationStore } from "../store/notificationStore";

const PAGE = "flow";

export function FlowPage(props: { uri: string }) {
    const [view, setView] = createSignal<FlowInstanceView | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const [artifacts, setArtifacts] = createSignal<Record<string, ArtifactState>>({});
    const [selected, setSelected] = createSignal<number | null>(null);
    const [busy, setBusy] = createSignal(false);
    let alive = true;
    onCleanup(() => (alive = false));

    /** 折线上出现过的节点（去重、保持首次出现序） */
    const nodesOf = (v: FlowInstanceView): string[] => [...new Set(v.trajectory.map((x) => x.node))];

    /**
     * 取产物：**每个节点一次**（`diy flow view <uri> --node <id>`）。
     * 节点级而非驻留级，是命令的粒度（##337 的 `--seq` 可选）—— 返回里的 `seq` 告诉我们
     * 它给的是哪次驻留的产物，按那个 key 落位；取不到就标 `none`，命令不在就标 `unavailable`。
     */
    const loadArtifacts = async (v: FlowInstanceView) => {
        const nodes = nodesOf(v);
        setArtifacts(Object.fromEntries(nodes.map((n) => [n, { kind: "loading" } as ArtifactState])));
        await Promise.all(
            v.trajectory.map(async (visit) => {
                const probe = await fetchArtifact(props.uri, visit.node);
                if (!alive) return;
                setArtifacts((prev) => {
                    const key = visitKey(visit.node, visit.seq);
                    if (!probe.ok) {
                        // 命令不在（##337 未合并）⇒ 同一个原因对每个驻留都说一遍（占位要说得准）
                        return { ...prev, [key]: { kind: "unavailable", reason: probe.reason } };
                    }
                    return { ...prev, [key]: probe.value ? { kind: "ready", value: probe.value } : { kind: "none" } };
                });
            }),
        );
    };

    const load = async () => {
        setBusy(true);
        setError(null);
        try {
            const v = await loadFlow(props.uri);
            if (!alive) return;
            setView(v);
            await loadArtifacts(v);
        } catch (e) {
            if (!alive) return;
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            setView(null);
        } finally {
            if (alive) setBusy(false);
        }
    };

    onMount(() => void load());
    createEffect(
        on(
            () => props.uri,
            () => {
                setSelected(null);
                void load();
            },
        ),
    );

    /**
     * 推进 / 打回：走 RPC 后重载（正路只有 `advance` / `bounce`，UI 不自作主张改状态）。
     *
     * **`to` 必填**：宿主闸门在 `main/services/api-impl.ts`（`flow.advance` / `flow.bounce` 都先查
     * `if (!input.to) throw "缺 --to <节点 id>"`）—— 虽然 api-def 的入参写着 `optional`，
     * 运行期**不给就报错**（实测：`to: undefined` 推进得到「推进失败：缺 --to <节点 id>」）。
     * 所以「进入入口」也得显名给 `entry`，别指望宿主替你补。
     */
    const move = async (kind: "advance" | "bounce", to?: string) => {
        setBusy(true);
        try {
            if (kind === "advance") await diyService.diy.flow.advance({ uri: props.uri, to, ref: undefined, note: undefined });
            else await diyService.diy.flow.bounce({ uri: props.uri, to, ref: undefined, note: undefined });
            await load();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            notificationStore.addToast("error", `${kind === "advance" ? "推进" : "打回"}失败：${msg}`);
        } finally {
            setBusy(false);
        }
    };

    const page = findPage(PAGE)!;

    const viewFor = (viewId: string) => {
        const v = view();
        if (!v) return <div class="p-3 text-body opacity-60">加载中…</div>;
        switch (viewId) {
            case "flow.stage":
                return <FlowStage view={v} artifacts={artifacts()} selected={selected()} onSelect={setSelected} />;
            case "flow.inspector":
                return (
                    <div class="flex h-full flex-col overflow-hidden">
                        <div class="min-h-0 flex-1 overflow-hidden">
                            <NodeDetail
                                view={v}
                                visit={selected() === null ? null : (v.trajectory[selected()!] ?? null)}
                                artifacts={artifacts()}
                                stepKey={
                                    selected() === null
                                        ? v.trajectory.length > 0
                                            ? visitKey(v.trajectory[v.trajectory.length - 1]!.node, v.trajectory[v.trajectory.length - 1]!.seq)
                                            : null
                                        : visitKey(v.trajectory[selected()!]!.node, v.trajectory[selected()!]!.seq)
                                }
                            />
                        </div>
                        <div class="max-h-[45%] shrink-0 overflow-auto border-t">
                            <ParamForm view={v} uri={props.uri} onSaved={(next) => setView(next)} />
                        </div>
                    </div>
                );
            default:
                return <div class="p-3 text-body opacity-60">未注册的 view: {viewId}</div>;
        }
    };

    return (
        <div class="flex h-full flex-col overflow-hidden">
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-body">
                <span class="badge badge-info badge-sm" title={props.uri}>
                    🛤 {props.uri}
                </span>
                <Show when={view()}>
                    {(v) => (
                        <>
                            <span class="opacity-70">{v().workflowName}</span>
                            <span class="badge badge-sm badge-ghost" data-flow-position={v().position ?? "entry"}>
                                {v().position ?? `未进入（入口 ${v().entry}）`}
                            </span>
                            <Show when={v().bounces > 0}>
                                <span class="badge badge-sm badge-error">打回 ×{v().bounces}</span>
                            </Show>
                            <Show when={v().done}>
                                <span class="badge badge-sm badge-success">已收尾</span>
                            </Show>
                            <Show when={v().next.terminal && !v().done}>
                                <span class="badge badge-sm badge-warning">结构终端（可宣布收尾）</span>
                            </Show>
                            {/* 下一步：`next.mode` 本版恒 entry/actor（guard 全是 prompt:）—— 按钮只列真存在的边 */}
                            <span class="flex items-center gap-1" data-flow-next="">
                                <Show when={v().next.mode === "entry"}>
                                    <button
                                        class="btn btn-xs btn-primary"
                                        data-flow-enter=""
                                        disabled={busy()}
                                        onClick={() => void move("advance", v().entry)}
                                    >
                                        进入 {v().entry}
                                    </button>
                                </Show>
                                <Show when={v().next.mode === "actor"}>
                                    <Show when={v().next.edges.length > 0} fallback={<span class="opacity-60">无出边</span>}>
                                        <span class="opacity-60">{v().next.pending.length > 0 ? "等人宣布：" : "走："}</span>
                                        <Show when={v().next.edges.filter((e) => e.kind === "next").length > 0}>
                                            <span class="dropdown dropdown-end">
                                                <div
                                                    tabindex="0"
                                                    role="button"
                                                    class="btn btn-xs btn-primary"
                                                    data-flow-advance=""
                                                >
                                                    推进 ▾
                                                </div>
                                                <ul tabindex="0" class="dropdown-content menu z-10 w-40 rounded-box bg-base-100 p-1 shadow">
                                                    {v()
                                                        .next.edges.filter((e) => e.kind === "next")
                                                        .map((e) => (
                                                            <li>
                                                                <button onClick={() => void move("advance", e.to)}>→ {e.toName}</button>
                                                            </li>
                                                        ))}
                                                </ul>
                                            </span>
                                        </Show>
                                        {/* 打回边逐条一个按钮：目标是**边上的真值**（`to` 必填，见 move 的注释） */}
                                        <For each={v().next.edges.filter((e) => e.kind === "bounce")}>
                                            {(e) => (
                                                <button
                                                    class="btn btn-xs btn-error btn-outline"
                                                    data-flow-bounce={e.to}
                                                    disabled={busy()}
                                                    title={`打回边 → ${e.toName}`}
                                                    onClick={() => void move("bounce", e.to)}
                                                >
                                                    ↺ 打回 {e.toName}
                                                </button>
                                            )}
                                        </For>
                                    </Show>
                                </Show>
                            </span>
                        </>
                    )}
                </Show>
                <div class="flex-1" />
                <Show when={error()}>
                    {(msg) => (
                        <span class="text-error" data-flow-error="">
                            {msg()}
                        </span>
                    )}
                </Show>
                <button
                    class="btn btn-xs btn-ghost"
                    data-flow-refresh=""
                    disabled={busy()}
                    title="重新拉取 flow show + 产物"
                    onClick={() => void load()}
                >
                    ⟳ 刷新
                </button>
            </div>

            <div class="min-h-0 flex-1">
                <Show
                    when={view()}
                    fallback={
                        <div class="p-4 text-body opacity-70" data-flow-empty="">
                            <Show when={error()} fallback={<>加载中…</>}>
                                {(msg) => <>{msg()}</>}
                            </Show>
                        </div>
                    }
                >
                    <ViewGrid
                        pageId={PAGE}
                        ctx={props.uri}
                        layout={page.layout}
                        binding={layoutStore.bindingFor(page, props.uri)}
                        renderView={(viewId) => viewFor(viewId)}
                    />
                </Show>
            </div>
        </div>
    );
}
