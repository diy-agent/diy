/**
 * ContextLabPage — 上下文树页（**独立子页面**，任务 148）。
 *
 * 一句话：系统上下文 = **一棵变量树**，按稳定性划成两份 ——
 * 稳定的进 system 提示词开头（可缓存），易变的进 user 消息。
 *
 * 两列（左=输入，中=产出）：
 *   · 左「结构树」 变量契约（zod），含类型/描述与无值变量。
 *                  **划分操作就在这做**：点节点上的 ⇄ 换容器（system ⇄ runtime），
 *                  不必再维护一张独立的"规则表"—— 契约本身就是那张表的骨架。
 *                  另有「变更（step）」列表：只列有变化的步骤。当前是**重算对比**打出来的观察
 *                  （见 shared/context/history.ts），只展示不选中 —— 要做"步 vs 步"的 diff，
 *                  缺的是**每轮真发的投递快照**（下一件事，不依赖事件协议）。
 *   · 中「请求预览」 **整份请求的大 YAML**：内嵌 system/runtime 文本就地解析展开；
 *                  可切"原文"看真发 JSON —— wire 不变。
 *                  （system 份 / runtime 份两个单独 view 已删：它们的价值全部包含在
 *                    请求预览里 —— 同一份文本的展开形态就在树里，不必看两遍）
 *
 * 选中联动：点结构树的一行 → 请求预览滚到并高亮**那一段**（行号映射与渲染同源，
 * 见 shared/context/render.ts 的 renderPathsTraced / request.ts）。
 *
 * 数据是**当前任务的真实上下文**（与真发同一条 assembleGlobals 链），不是编造的。
 */
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { diyService } from "../lib/rpc";
import { taskStore } from "../store/taskStore";
import { ViewGrid } from "./ViewGrid";
import { layoutStore } from "../store/layoutStore";
import { findPage } from "../../shared/view-registry";
import { Caches } from "../lib/ui-state";
import { projectFromUri } from "../../shared/task-uri";
import { buildVarTree, type VarNode } from "../../shared/var-tree";
import { AssembleGlobalsSchema } from "../../shared/prompt-schema";
import { MdEditor, type HlLines } from "./MdEditor";
import { JsonTree } from "./JsonTree";
import type { ContextLab, PlaceCandidate } from "../../shared/context/preview";
import { requestYaml } from "../../shared/context/request";
import { emptyHistory, record, type ContextHistory } from "../../shared/context/history";

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
/** 供 `ui view expand`（App.tsx 按 `ctx.` 前缀分派过来） */
export function setCtxLabFold(key: string, open: boolean): void {
    setFold(key.replace(/^ctx\./, ""), open);
}

/** 折叠块 */
function Fold(props: { k: string; label: string; extra?: string; right?: JSX.Element; children: JSX.Element }) {
    return (
        <div
            class="flex min-h-0 flex-col rounded-lg border border-base-300"
            classList={{ "flex-1 min-h-[140px]": !!fold()[props.k] }}
        >
            <div class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-[11px] font-bold tracking-wide">
                <button class="flex items-center gap-1 opacity-80 hover:opacity-100" onClick={() => setFold(props.k, !fold()[props.k])}>
                    <span>{fold()[props.k] ? "▾" : "▸"}</span>
                    <span>{props.label}</span>
                </button>
                <span class="ml-auto flex items-center gap-1 font-mono font-normal opacity-70">
                    {props.extra}
                    {props.right}
                </span>
            </div>
            <Show when={fold()[props.k]}>
                <div class="min-h-0 flex-1 overflow-auto bg-base-200 text-[11px]">{props.children}</div>
            </Show>
        </div>
    );
}

/** 可点击的容器开关（结构树用）：显示当前归属，点一下在 system ⇄ runtime 间切 */
function ContainerToggle(props: { c: "system" | "runtime" | null; onToggle: () => void }) {
    const eff = (): "system" | "runtime" => props.c ?? "runtime";
    return (
        <button
            class="btn btn-xs"
            classList={{
                "btn-primary": eff() === "system",
                "btn-ghost opacity-60": eff() === "runtime",
            }}
            title={
                eff() === "system"
                    ? "当前：system（稳定份，进提示词开头）。点击改为 runtime"
                    : "当前：runtime（易变份，进 user 消息）。点击改为 system"
            }
            onClick={(e) => {
                e.stopPropagation();
                props.onToggle();
            }}
        >
            {eff()}
        </button>
    );
}

/** 结构树一行的高亮态（选中 + 容器色条） */
const rowCls = (selected: boolean): string =>
    selected ? "bg-primary/20 ring-1 ring-primary/60" : "";

/** 结构树节点：契约（类型/描述）+ 容器标记 + 换容器的 ⇄ */
function StructureRows(props: {
    nodes: VarNode[];
    depth?: number;
    prefix: string;
    containerOf: (path: string) => "system" | "runtime" | null;
    /** 该节点当前是否可切换容器（规则见 showSwap 的注释） */
    canSwap: (path: string) => boolean;
    selected: string | null;
    onPick: (path: string) => void;
    onSwap: (path: string) => void;
}) {
    return (
        <For each={props.nodes}>
            {(n) => {
                const path = () => (props.prefix ? `${props.prefix}.${n.name}` : n.name);
                const c = () => props.containerOf(path());
                return (
                    <>
                        <tr
                            class={`cursor-pointer hover:bg-base-300/60 ${rowCls(props.selected === path())}`}
                            onClick={() => props.onPick(path())}
                        >
                            <td class="whitespace-nowrap font-mono">
                                <span style={{ "padding-left": `${(props.depth ?? 0) * 12}px` }} />
                                <span class={n.optional ? "opacity-70" : ""}>{n.name}</span>
                                <span class="ml-1 opacity-50">{n.type}</span>
                                <Show when={n.optional}>
                                    <span class="opacity-40">?</span>
                                </Show>
                            </td>
                            <td class="opacity-60">{n.desc ?? ""}</td>
                            <td class="whitespace-nowrap text-right">
                                {/* 容器开关：显示当前归属，**点一下切换**（system ⇄ runtime）。
                                    未成为单元时显示默认的 runtime —— 点它就划进 system，
                                    因为"没声明"与"声明为 runtime"在投递上等价，不必区分。
                                    只在"能成为单元"的节点上出现（见 canSwap），否则满树按钮没法看。 */}
                                <Show when={props.canSwap(path())}>
                                    <ContainerToggle c={c()} onToggle={() => props.onSwap(path())} />
                                </Show>
                            </td>
                        </tr>
                        <Show when={n.children && n.children.length > 0}>
                            <StructureRows
                                nodes={n.children!}
                                depth={(props.depth ?? 0) + 1}
                                prefix={path()}
                                containerOf={props.containerOf}
                                canSwap={props.canSwap}
                                selected={props.selected}
                                onPick={props.onPick}
                                onSwap={props.onSwap}
                            />
                        </Show>
                    </>
                );
            }}
        </For>
    );
}

/** path → 该 path 在文本里的行区间（渲染时收集；这里做一次前缀包含判断） */
function rangesFor(
    lines: Record<string, { from: number; to: number }>,
    path: string,
): { from: number; to: number } | null {
    if (lines[path]) return lines[path];
    // 该 path 只在渲染单元里出现（模板节点 / 中间容器）→ 合并它所有后代的区间
    const hits = Object.entries(lines)
        .filter(([k]) => k.startsWith(`${path}.`))
        .map(([, v]) => v);
    if (hits.length === 0) return null;
    return {
        from: Math.min(...hits.map((h) => h.from)),
        to: Math.max(...hits.map((h) => h.to)),
    };
}

export function ContextLabPage(props: { uri: string }) {
    onMount(() => {
        if (taskStore.selectedUri !== props.uri) void taskStore.selectTask(props.uri);
    });

    /** 选中的 path（结构树/变量树共用；中间预览据此滚动高亮） */
    const [selected, setSelected] = createSignal<string | null>(null);
    const [systemPlaces, setSystemPlaces] = createSignal<string[]>(Caches.diy_ctxlab_system.get());
    const persist = (next: string[]): void => {
        setSystemPlaces(next);
        Caches.diy_ctxlab_system.set(next);
    };

    /** 变更历史：每次重算都记一次，内容没变就不新增（144 的"内容未变不发"） */
    const [history, setHistory] = createSignal<ContextHistory>(emptyHistory());
    /** 自动观察：默认开 —— 用户改任务正文/外部改动都能落到 step 列表，
     *  不必先想起来点「刷新」。
     *  老事件流没有 context 事件推送，所以是轮询；108 接上订阅后只换这几行。 */
    const [watching, setWatching] = createSignal(true);

    const [meta] = createResource(async () => {
        return (await diyService.diy.context.candidates({})) as {
            candidates: PlaceCandidate[];
            defaultSystem: string[];
        };
    });
    const effectiveSystem = () => (systemPlaces().length > 0 ? systemPlaces() : (meta()?.defaultSystem ?? []));

    const [lab, { refetch }] = createResource(effectiveSystem, async (sys) => {
        return (await diyService.diy.context.lab({
            project: projectFromUri(props.uri),
            taskUri: props.uri,
            systemPlaces: sys,
            model: undefined,
        })) as ContextLab;
    });

    /** 请求预览的形态：YAML（默认；内嵌 system/runtime 文本就地解析展开）/ 原文（真发 JSON） */
    const [reqMode, setReqMode] = createSignal<"yaml" | "json">("yaml");
    /**
     * 请求预览的 YAML 文本 + 行号映射：由**真实请求体**现算（纯函数，见 shared/context/request）。
     * 内嵌块由"与 system/runtime 两份文本逐字相等"判定 —— 解析的就是 body 里那段原文。
     */
    const reqView = createMemo(() => {
        const l = lab();
        const body = l?.request.body;
        if (!body) return null;
        return requestYaml(body, [l!.system.text, l!.runtime.text]);
    });

    // 每次重算结果到手 → 记一次 step（纯函数，内容没变不新增）
    createEffect(() => {
        const l = lab();
        if (!l) return;
        setHistory((h) => record(h, l.snapshot, new Date().toISOString()));
    });

    // 自动观察：开着时按间隔重算（真实数据变了就会多出 step）。
    // 老事件流还没有 context 事件推送，所以这里用轮询；108 之后换成订阅即可。
    createEffect(() => {
        if (!watching()) return;
        const t = setInterval(() => void refetch(), 2000);
        onCleanup(() => clearInterval(t));
    });

    /**
     * 切换容器（点一下开关）。
     * 只维护 system 名单：在名单里 → 移出（回默认 runtime）；不在 → 加入。
     * 新项与已有项互为祖先/后代时，先把重叠的摘掉（places 不许重叠）。
     */
    const toggleUnit = (path: string): void => {
        const cur = effectiveSystem();
        if (cur.includes(path)) {
            persist(cur.filter((p) => p !== path));
            return;
        }
        persist([...cur, path].filter((x) => !(path.startsWith(`${x}.`) || x.startsWith(`${path}.`))));
    };

    /** 当前投递单元（path → 容器） */
    const unitMap = (): Map<string, "system" | "runtime"> =>
        new Map((lab()?.rules ?? []).map((r) => [r.place, r.container]));
    const containerOf = (path: string): "system" | "runtime" | null => unitMap().get(path) ?? null;

    /** 该节点能否切换容器（开关按钮的显示规则）：
     *  已是单元 → 能；否则祖先与后代都不能是单元 → 能（任意粒度）。
     *  已有单元覆盖的子孙不显示 —— 要么跟着父走，要么先撤父。 */
    const canSwap = (path: string): boolean => {
        const units = unitMap();
        if (units.has(path)) return true;
        for (const u of units.keys()) {
            if (path.startsWith(`${u}.`)) return false;
            if (u.startsWith(`${path}.`)) return false;
        }
        return true;
    };

    const structure = () => buildVarTree(AssembleGlobalsSchema);

    /**
     * 选中结构树一行 → 请求预览里对应那几行的整行高亮（点它才高亮，再点别的行就跟着换）。
     * 行号取自**与文本同源的渲染映射**（`requestYaml` 边产出边收集）—— 内嵌的 system/runtime
     * 子节点用的就是变量路径（`chain.0.path`），与结构树同名，所以无需任何换算。
     * 滚动目标用**焦点段的字符区间**（不是行首）：不折行时长行会横向溢屏，只到行首的话焦点段仍在屏幕外。
     */
    const hlForRequest = (): HlLines | null => {
        const view = reqView();
        const p = selected();
        if (!p || !view) return null;
        const r = rangesFor(view.lines, p);
        if (!r) return null;
        const textLines = view.text.split("\n");
        let pos = 0;
        for (let i = 0; i < r.from - 1 && i < textLines.length; i++) pos += textLines[i]!.length + 1;
        const end = pos + (r.to - r.from === 0 ? (textLines[r.from - 1]?.length ?? 0) : 1);
        return { lines: [r.from, r.to], focusLines: [r.from], focusPos: pos, focusEnd: end };
    };

    /**
     * 变更列表（只列**有变化**的 step）。
     * 当前是"重算对比"打出来的观察列表（2 秒轮询 + 值 hash 对比）：没有因果、关页面就丢、
     * 也不对齐真实轮次，所以只做**展示**不做选中。选中→diff 需要"每轮真发的投递快照"
     * （system/runtime 两份文本 + 值 hash 表 + 版本），那是下一步；有了它两处自然成立：
     *   · 选中第 N 步 → 与第 N-1 步快照 diff
     *   · 取消选中 → 当前变量树与最后一步快照 diff
     */
    const stepsPane = () => (
        <div class="p-1">
            <div class="mb-1 flex items-center gap-1 px-1 opacity-70">
                <span>{history().steps.length} 个变化 step</span>
                <label class="ml-auto flex cursor-pointer items-center gap-1" title="每 2 秒重算一次；关掉则只在你点「⟳ 刷新」时记录">
                    <input
                        type="checkbox"
                        class="checkbox checkbox-xs"
                        checked={watching()}
                        onChange={(e) => setWatching(e.currentTarget.checked)}
                    />
                    观察
                </label>
            </div>
            <Show
                when={history().steps.length > 0}
                fallback={<div class="p-2 opacity-60">还没有变化。改一下任务正文/标题，或在别处改动后会自己出现。</div>}
            >
                <ul class="menu menu-xs">
                    <For each={[...history().steps].reverse()}>
                        {(st) => (
                            <li class="flex items-center gap-2 px-2 py-0.5">
                                <span class="badge badge-xs">{st.index}</span>
                                <span class="truncate font-mono" title={st.changed.join(", ")}>
                                    {st.changed.slice(0, 2).join(", ") || "投递范围变化"}
                                    {st.changed.length > 2 ? ` +${st.changed.length - 2}` : ""}
                                </span>
                                <span class="ml-auto flex gap-1">
                                    <Show when={st.systemDiffers}>
                                        <span class="badge badge-primary badge-xs">sys</span>
                                    </Show>
                                    <Show when={st.runtimeDiffers}>
                                        <span class="badge badge-warning badge-xs">run</span>
                                    </Show>
                                </span>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
        </div>
    );

    const parts: Record<string, () => JSX.Element> = {
        /** 左：结构树（契约 + 划分操作） */
        "ctxlab.structure": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-[11px]">
                {/* 变更列表：只列**有变化**的 step（真实数据；开「观察」就持续记录） */}
                <Fold k="steps" label="变更（step）" extra={`${history().steps.length} 个`}>
                    {stepsPane()}
                </Fold>
                <Fold k="structure" label="结构树（变量契约）" extra="含无值变量 · 类型与描述">
                <table class="table table-xs">
                    <thead>
                        <tr>
                            <th>变量（契约）</th>
                            <th>说明</th>
                            <th class="text-right">归属</th>
                        </tr>
                    </thead>
                    <tbody>
                        <StructureRows
                            nodes={structure()}
                            prefix=""
                            containerOf={containerOf}
                            canSwap={canSwap}
                            selected={selected()}
                            onPick={setSelected}
                            onSwap={toggleUnit}
                        />
                    </tbody>
                </table>
                </Fold>
            </div>
        ),

        /** 中：请求预览（整份请求 = 一份大 YAML；可切原文 JSON） */
        "ctxlab.delivery": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 p-1 text-xs">
                <Fold
                    k="request"
                    label="请求预览（实际发送格式）"
                    extra={lab()?.request.model ?? ""}
                    right={
                        <span class="join join-horizontal">
                            <button
                                class={`btn btn-xs join-item ${reqMode() === "yaml" ? "btn-active" : "btn-ghost"}`}
                                title="整份请求渲染为 YAML：内嵌的 system/runtime 文本就地解析展开（解析的就是请求体里那段原文）"
                                onClick={() => setReqMode("yaml")}
                            >
                                YAML
                            </button>
                            <button
                                class={`btn btn-xs join-item ${reqMode() === "json" ? "btn-active" : "btn-ghost"}`}
                                title="请求体的原始 JSON（真发格式，一字不改）"
                                onClick={() => setReqMode("json")}
                            >
                                原文
                            </button>
                        </span>
                    }
                >
                    <Show
                        when={lab()?.request.body}
                        fallback={<div class="p-2 opacity-60">{lab()?.request.note ?? "构造中…"}</div>}
                    >
                        {(b) => (
                            <div class="flex h-full min-h-0 flex-col">
                                <div class="shrink-0 px-2 py-1 text-[10px] opacity-60">{lab()!.request.note}</div>
                                <Show
                                    when={reqMode() === "yaml"}
                                    fallback={
                                        <div class="min-h-0 flex-1 overflow-auto p-2">
                                            <JsonTree data={b()} />
                                        </div>
                                    }
                                >
                                    <div class="min-h-0 flex-1">
                                        <MdEditor
                                            value={reqView()?.text ?? ""}
                                            editable={false}
                                            onChange={() => {}}
                                            lang="yaml"
                                            highlight={hlForRequest()}
                                        />
                                    </div>
                                </Show>
                            </div>
                        )}
                    </Show>
                </Fold>
            </div>
        ),
    };

    const page = findPage(PAGE)!;

    return (
        <div class="flex h-full flex-col overflow-hidden">
            <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
                <span class="badge badge-info badge-sm" title={props.uri}>
                    📌 {props.uri}
                </span>
                <button class="btn btn-xs btn-ghost" title="重新计算（重跑真实数据组装链）" onClick={() => void refetch()}>
                    ⟳ 刷新
                </button>
                <span class="opacity-60">{lab()?.source ?? "加载中…"}</span>
                <Show when={selected()}>
                    <span class="ml-auto flex items-center gap-1">
                        <span class="opacity-60">选中</span>
                        <span class="badge badge-sm font-mono">{selected()}</span>
                        <button class="btn btn-ghost btn-xs px-1" title="取消选中" onClick={() => setSelected(null)}>
                            ✕
                        </button>
                    </span>
                </Show>
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
