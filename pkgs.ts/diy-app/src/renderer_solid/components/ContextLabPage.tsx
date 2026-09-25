/**
 * ContextLabPage — 上下文树页（**独立子页面**，任务 148）。
 *
 * 一句话：系统上下文 = **一棵变量树**，按稳定性划成两份 ——
 * 稳定的进 system 提示词开头（可缓存），易变的进 user 消息。
 *
 * 三列（左=输入，中=产出，右=当前真实值）：
 *   · 左「结构树」 变量契约（zod），含类型/描述与无值变量。
 *                  **划分操作就在这做**：点节点上的 ⇄ 换容器（system ⇄ runtime），
 *                  不必再维护一张独立的"规则表"—— 契约本身就是那张表的骨架。
 *   · 中「预览」   system 份 / runtime 份（YAML，带语法高亮）
 *                  / 请求预览（**整份请求的大 YAML**：内嵌 system/runtime 文本就地解析展开；
 *                    可切"原文"看真发 JSON —— wire 不变）
 *   · 右「变量」   当前任务的真实变量树（归属在结构树上点开关切换）
 *
 * 选中联动：点结构树或变量树的一行 → 中间预览滚到并高亮**那一段**（行号映射与
 * 渲染同源，见 shared/context/render.ts 的 renderPathsTraced），右侧对应行也高亮。
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
import type { ContextLab, LabTreeNode, PlaceCandidate } from "../../shared/context/preview";
import { requestYaml } from "../../shared/context/request";
import {
    emptyHistory,
    record,
    diffStat,
    type ContextHistory,
    type ContextStep,
} from "../../shared/context/history";

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

function ContainerBadge(props: { c: "system" | "runtime" | null }) {
    return (
        <Show when={props.c} fallback={<span class="opacity-40">—</span>}>
            <span
                class="badge badge-sm badge-outline"
                classList={{
                    "badge-primary": props.c === "system",
                    "badge-warning": props.c === "runtime",
                }}
            >
                {props.c}
            </span>
        </Show>
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

const indentOf = (path: string): number => path.split(".").length - 1;
const leafName = (path: string): string => path.split(".").slice(-1)[0];

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
    /** 选中的 step（null = 看当前） */
    const [pickedStep, setPickedStep] = createSignal<number | null>(null);
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

    // 有变化时自动选中**最新一步**（否则用户要先在列表里点一下才看得到内容）。
    // 只在"当前没选中"时自动跳 —— 用户点了某一步就不打扰他。
    createEffect(() => {
        const steps = history().steps;
        if (steps.length > 0 && pickedStep() === null) setPickedStep(steps[steps.length - 1]!.index);
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
     * 选中 path → 某份文本里的整行高亮。
     * 行号取自与文本同源的渲染映射；滚动目标用**焦点段的字符区间**（不是行首）：
     * 不折行时长行会横向溢屏，只到行首的话焦点段仍在屏幕外。
     */
    const hlOf = (
        text: string | undefined,
        lines: Record<string, { from: number; to: number }> | undefined,
        p: string | null,
    ): HlLines | null => {
        if (!p || !text || !lines) return null;
        const r = rangesFor(lines, p);
        if (!r) return null;
        const textLines = text.split("\n");
        let pos = 0;
        for (let i = 0; i < r.from - 1 && i < textLines.length; i++) pos += textLines[i]!.length + 1;
        const end = pos + (r.to - r.from === 0 ? (textLines[r.from - 1]?.length ?? 0) : 1);
        return { lines: [r.from, r.to], focusLines: [r.from], focusPos: pos, focusEnd: end };
    };

    /** 预览：选中 path 落在哪一份（决定给哪个编辑器发高亮） */
    const hlFor = (which: "system" | "runtime"): HlLines | null =>
        hlOf(lab()?.[which].text, lab()?.[which].lines, selected());
    /** 请求预览（YAML 形态）：内嵌块的行号就在同一份映射里，无需换算 */
    const hlForRequest = (): HlLines | null => hlOf(reqView()?.text, reqView()?.lines, selected());

    /** 变量树：选中该行时把它滚进视野 */
    const rowRef = (el: HTMLTableRowElement, path: string): void => {
        if (selected() === path) el.scrollIntoView({ block: "center" });
    };

    const deliveryPane = (which: "system" | "runtime") => {
        const d = () => lab()?.[which];
        return (
            <Show when={d()} fallback={<div class="p-2 opacity-60">计算中…</div>}>
                <MdEditor
                    value={d()!.text || ""}
                    editable={false}
                    onChange={() => {}}
                    lang="yaml"
                    highlight={hlFor(which)}
                />
            </Show>
        );
    };

    /** 变更详情：选中某步 → 看它改了什么（值变化 + 两份 diff） */
    const changePane = () => {
        const step = () => (lab()?.snapshot ? history().steps.find((x) => x.index === pickedStep()) : null);
        return (
            <Show
                when={step()}
                fallback={<div class="p-2 opacity-60">选一个变化的 step 看它改了什么</div>}
            >
                {(st: () => ContextStep) => (
                    <div class="space-y-2 p-2">
                        <div class="flex items-center gap-2">
                            <span class="badge badge-sm">step {st().index}</span>
                            <span class="opacity-60">{new Date(st().at).toLocaleTimeString()}</span>
                        </div>
                        <div>
                            <div class="mb-1 font-bold opacity-70">变化的变量（{st().changed.length}）</div>
                            <Show when={st().changed.length > 0} fallback={<div class="opacity-50">无（投递范围变了）</div>}>
                                <div class="flex flex-wrap gap-1">
                                    <For each={st().changed}>{(p) => <span class="badge badge-xs font-mono">{p}</span>}</For>
                                </div>
                            </Show>
                        </div>
                        <div>
                            <div class="mb-1 font-bold opacity-70">落在哪一份</div>
                            <div class="flex flex-col gap-1">
                                <div>
                                    <span class="badge badge-primary badge-xs badge-outline">system</span>{" "}
                                    {st().systemDiffers ? "重建（全量）" : "未变"} · 涉及{" "}
                                    <span class="font-mono">{st().systemTouched.join(", ") || "—"}</span>
                                </div>
                                <div>
                                    <span class="badge badge-warning badge-xs badge-outline">runtime</span>{" "}
                                    {st().runtimeDiffers ? "增量 patch" : "未变"} · 涉及{" "}
                                    <span class="font-mono">{st().runtimeTouched.join(", ") || "—"}</span>
                                </div>
                            </div>
                        </div>
                        <For each={[
                            { name: "system 份变化内容", diff: st().systemDiff },
                            { name: "runtime 份变化内容", diff: st().runtimeDiff },
                        ]}>
                            {(d) => (
                                <Show when={d.diff.length > 0}>
                                    <div>
                                        <div class="mb-1 font-bold opacity-70">
                                            {d.name}（+{diffStat(d.diff).add} / -{diffStat(d.diff).del}）
                                        </div>
                                        <pre class="max-h-64 overflow-auto rounded bg-base-100 p-1 font-mono">
                                            {d.diff
                                                .filter((l) => l.t !== " ")
                                                .map((l) => `${l.t} ${l.s}`)
                                                .join("\n") || "（无实质变化）"}
                                        </pre>
                                    </div>
                                </Show>
                            )}
                        </For>
                    </div>
                )}
            </Show>
        );
    };

    /** 变更列表（只列**有变化**的 step） */
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
                            <li>
                                <button
                                    class={`flex items-center gap-2 ${rowCls(pickedStep() === st.index)}`}
                                    onClick={() => setPickedStep(pickedStep() === st.index ? null : st.index)}
                                >
                                    <span class="badge badge-xs">{st.index}</span>
                                    <span class="truncate font-mono">
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
                                </button>
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

        /** 中：预览（两份 YAML + step 变更详情 + 请求体 JSON） */
        "ctxlab.delivery": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-xs">
                <Fold
                    k="change"
                    label="变更详情"
                    extra={pickedStep() !== null ? `step ${pickedStep()}` : "未选中"}
                >
                    {changePane()}
                </Fold>
                <Fold
                    k="system"
                    label="system 份（稳定 → 提示词开头）"
                    extra={lab() ? `${lab()!.system.places.length} 单元 · ${(lab()!.system.bytes / 1024).toFixed(1)} KB` : ""}
                >
                    {deliveryPane("system")}
                </Fold>
                <Fold
                    k="runtime"
                    label="runtime 份（易变 → user 消息）"
                    extra={lab() ? `${lab()!.runtime.places.length} 单元 · ${(lab()!.runtime.bytes / 1024).toFixed(1)} KB` : ""}
                >
                    {deliveryPane("runtime")}
                </Fold>
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

        /** 右：变量树（真实值；归属在结构树上点开关改） */
        "ctxlab.vars": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-xs">
                <Fold k="tree" label="变量树" extra={`${lab()?.tree.length ?? 0} 个变量`}>
                    <table class="table table-xs">
                        <thead>
                            <tr>
                                <th>变量</th>
                                <th>值</th>
                                <th>归属</th>
                            </tr>
                        </thead>
                        <tbody>
                            <For each={lab()?.tree ?? []}>
                                {(n: LabTreeNode) => (
                                    <tr
                                        ref={(el) => rowRef(el, n.path)}
                                        class={`cursor-pointer hover:bg-base-300/60 ${rowCls(selected() === n.path)}`}
                                        onClick={() => setSelected(n.path)}
                                    >
                                        <td class="whitespace-nowrap font-mono">
                                            <span style={{ "padding-left": `${indentOf(n.path) * 10}px` }} />
                                            <span title={n.path}>{leafName(n.path)}</span>
                                        </td>
                                        {/* 父层级只表态：值在下面几行里，重复输出没有信息量 */}
                                        <td class="max-w-[12rem] truncate" title={n.preview}>
                                            <Show when={n.preview} fallback={<span class="opacity-30">—</span>}>
                                                {n.preview}
                                            </Show>
                                        </td>
                                        <td>
                                            <ContainerBadge c={n.container} />
                                        </td>
                                    </tr>
                                )}
                            </For>
                        </tbody>
                    </table>
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
