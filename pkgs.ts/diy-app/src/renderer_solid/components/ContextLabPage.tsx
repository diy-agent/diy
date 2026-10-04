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
 *                  改动写进 `$DIY_HOME/context.yaml`（**真源**）：真发读同一份，
 *                  所以页面上看到的划分就是下一轮会用的划分（不存 localStorage —— 那种页面会说谎）。
 *                  另有「变更（真发轮次）」列表：每轮真发落一条投递快照（读文件，不轮询），
 *                  点一条 → 与上一轮比；取消选中 → 当前 vs 最后一轮。
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
import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show, type JSX } from "solid-js";
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
import { DynamicBar } from "./DynamicBar";
import { notificationStore } from "../store/notificationStore";
import type { ContextLab, PlaceCandidate } from "../../shared/context/preview";
import { requestYaml } from "../../shared/context/request";
import { diffSize } from "../../shared/context/steps";
import { fmtAgo, fmtShortTime } from "../../shared/date-format";
import { lineRange, matchRanges, type LineRange } from "../../shared/context/match";
import type { ContextDiff, Stats } from "../../shared/context/schema";
import type { DiffLine } from "../../shared/line-diff";

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
            <div class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-body font-bold tracking-wide">
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
                <div class="min-h-0 flex-1 overflow-auto bg-base-200 text-body">{props.children}</div>
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
                (eff() === "system"
                    ? "当前：system（稳定份，进提示词开头）。点击改为 runtime"
                    : "当前：runtime（易变份，进 user 消息）。点击改为 system") +
                " —— 改动写入 context.yaml，**下一轮真发**生效"
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

/** 变化率（0~1）→ 百分比文本 */
const fmtRate = (rate: number): string => `${Math.round(rate * 100)}%`;

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

export function ContextLabPage(props: { uri: string }) {
    onMount(() => {
        if (taskStore.selectedUri !== props.uri) void taskStore.selectTask(props.uri);
    });

    /** 选中的 path（结构树那一列的选中行；请求预览据此滚动高亮） */
    const [selected, setSelected] = createSignal<string | null>(null);
    /**
     * 划分规则（哪些变量进 system）：**读 main 的真源**（$DIY_HOME/context.yaml），
     * 不存 localStorage —— 存本地的话页面改完预览变了、真发却不理（界面说谎）。
     * 改动经 RPC 写回真源，**下一轮真发生效**（本轮已发的请求不会回溯）。
     */
    const [systemPlaces, setSystemPlaces] = createSignal<string[] | null>(null);

    /**
     * 选中的 step（null = 看"当前 vs 最后一步"）。
     * 数据是真发落盘的投递快照（不是页面自己轮询攒的）—— 对齐真实轮次、关页面不丢。
     */
    const [pickedStep, setPickedStep] = createSignal<number | null>(null);

    const [meta] = createResource(async () => {
        return (await diyService.diy.context.candidates({})) as {
            candidates: PlaceCandidate[];
            defaultSystem: string[];
        };
    });

    /** 划分规则真源（$DIY_HOME/context.yaml）+ 推荐名单；未加载完时先用推荐名单，避免空白 */
    const [config, { refetch: refetchConfig }] = createResource(async () => {
        return (await diyService.diy.context.config({})) as {
            systemPlaces: string[];
            defaults: string[];
            fromFile: boolean;
        };
    });
    /** 页面即时值：用户点过 ⇄ 就先用本地这份（不等 RPC 往返），否则用真源 */
    const effectiveSystem = (): string[] =>
        systemPlaces() ?? config()?.systemPlaces ?? meta()?.defaultSystem ?? [];

    const [lab, { refetch }] = createResource(effectiveSystem, async (sys) => {
        return (await diyService.diy.context.lab({
            project: projectFromUri(props.uri),
            taskUri: props.uri,
            systemPlaces: sys,
            model: undefined,
        })) as ContextLab;
    });

    /**
     * 真发投递快照列表（每轮一条，读文件；没有实时推送，靠顶栏「⟳ 刷新」重拉）。
     * 实时观测机制还没定结构 —— 暂用显式刷新（debug UI 用显式刷新代替事件流，
     * 与提示词页同一取舍；外部改动界面不会自己变，按一下刷新）。
     */
    const [steps, { refetch: refetchSteps }] = createResource(
        () => props.uri,
        async (uri) => {
            return (await diyService.diy.context.steps({ taskUri: uri, limit: undefined, diff: undefined })) as {
                total: number;
                steps: Array<{
                    index: number;
                    ts: string;
                    turnId: string;
                    model: string;
                    bytes: { system: number; runtime: number };
                    changed?: string[];
                    sincePrev: {
                        changed: string[];
                        systemDiffers: boolean;
                        runtimeDiffers: boolean;
                        systemSize: { add: number; del: number };
                        runtimeSize: { add: number; del: number };
                    } | null;
                }>;
            };
        },
    );

    /**
     * 变更统计（**按项目累计**，跨任务）：回答"这个节点用了几天变了几次 / 变化率"。
     * 为什么不按任务：单任务样本太小；长期累计才有"该不该待在 system"的判据价值
     * （逐轮明细已由上面的「变更（真发轮次）」给出；见 shared/context/stats.ts 头注）。
     */
    const [stats, { refetch: refetchStats }] = createResource(
        () => projectFromUri(props.uri),
        async (pid) => {
            if (!pid) return null;
            return (await diyService.diy.context.stats({
                project: pid,
                taskUri: undefined,
                limit: undefined,
            })) as Stats;
        },
    );

    /**
     * 变更详情：选中某步 → 与上一步比；未选中 → 当前变量树 vs 最后一步（都在 main 侧算）。
     * ⚠️ source 用**字符串**：createResource 对非函数 source 按 `===` 比较，传对象字面量的话
     * 每次渲染都是新引用 → 无谓重拉（甚至把它变成一台 RPC 打桩机）。
     */
    const diffKey = (): string =>
        `${props.uri}\u0000${pickedStep() ?? "live"}\u0000${effectiveSystem().join(",")}`;
    const [diff, { refetch: refetchDiff }] = createResource(diffKey, async (k) => {
        const [uri, step, sys] = k.split("\u0000");
        if (!uri) return null;
        return (await diyService.diy.context.diff({
            project: projectFromUri(uri),
            taskUri: uri,
            step: step === "live" ? undefined : Number(step),
            systemPlaces: sys ? sys.split(",") : undefined,
        })) as ContextDiff | null;
    });

    /** 顶栏刷新：重拉五处（当前上下文 / 快照列表 / 变更详情 / 划分规则真源 / 变更统计）——
     *  没有实时推送，只有显式刷新（外部改了 context.yaml 也靠它捡回来） */
    const refresh = (): void => {
        void refetch();
        void refetchSteps();
        void refetchDiff();
        void refetchConfig();
        void refetchStats();
    };

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

    /**
     * 切换容器（点一下开关）。
     * 只维护 system 名单：在名单里 → 移出（回默认 runtime）；不在 → 加入。
     * 新项与已有项互为祖先/后代时，先把重叠的摘掉（places 不许重叠）。
     */
    const toggleUnit = (path: string): void => {
        const cur = effectiveSystem();
        const next = cur.includes(path)
            ? cur.filter((p) => p !== path)
            : [...cur, path].filter((x) => !(path.startsWith(`${x}.`) || x.startsWith(`${path}.`)));
        // 即时反馈（不等 RPC）→ 写回真源；失败则回滚成真源的值并 toast
        setSystemPlaces(next);
        void (async () => {
            try {
                const r = await diyService.diy.context.setConfig({ systemPlaces: next });
                setSystemPlaces(r.systemPlaces); // 服务端净化过的结果（可能与请求不同）
                void refetchConfig();
            } catch (e) {
                setSystemPlaces(null);
                notificationStore.addToast(
                    "error",
                    `划分规则写入失败：${e instanceof Error ? e.message : String(e)}`,
                );
            }
        })();
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

    /**
     * 某个变量路径**归哪个投递单元管**：取覆盖它的最深单元（`chain.0.path` → `chain`）。
     * 没有单元覆盖 → null（投递上等价于默认的 runtime）。
     */
    const ownerOf = (path: string): { place: string; container: "system" | "runtime" } | null => {
        const units = unitMap();
        let best: string | null = null;
        for (const u of units.keys()) {
            if ((path === u || path.startsWith(`${u}.`)) && (best === null || u.length > best.length)) best = u;
        }
        return best === null ? null : { place: best, container: units.get(best)! };
    };

    /**
     * system 全量重建的**原因**：这一步变化的变量里，哪些落在 system 单元上
     * （收拢到单元路径，去重排序）。空 = 不是值变化引起的（投递范围或编码版本变了）。
     */
    const sysCauses = (changed: readonly string[] | undefined): string[] => {
        const out = new Set<string>();
        for (const p of changed ?? []) {
            const o = ownerOf(p);
            if (o?.container === "system") out.add(o.place);
        }
        return [...out].sort();
    };

    const structure = () => buildVarTree(AssembleGlobalsSchema);

    /**
     * 选中结构树一行 → 请求预览里**所有**匹配的位置（一个变量可以出现多处：system 段、runtime 段、
     * 甚至同一段里的多次引用），配 ↑/↓ 在它们之间跳（与提示词页同一套交互）。
     * 行号取自**与文本同源的渲染映射**（`requestYaml` 边产出边收集）—— 内嵌的 system/runtime
     * 子节点用的就是变量路径（`chain.0.path`），与结构树同名，所以无需任何换算；
     * 集合元素走 `[ChainEntry]` → 数字下标段的通配（见 rangesFor）。
     */
    const hlMatches = createMemo<LineRange[]>(() => {
        const view = reqView();
        const p = selected();
        if (!p || !view) return [];
        return matchRanges(view.lines, p);
    });
    /** 焦点下标（换选中行时归零；↑/↓ 在匹配之间走） */
    const [focusIdx, setFocusIdx] = createSignal(0);
    createEffect(on(selected, () => setFocusIdx(0)));

    const hlForRequest = (): HlLines | null => {
        const view = reqView();
        const ms = hlMatches();
        const p = selected();
        if (!p || !view || ms.length === 0) return null;
        const idx = Math.min(Math.max(0, focusIdx()), ms.length - 1);
        const r = ms[idx]!;
        const textLines = view.text.split("\n");
        let pos = 0;
        for (let i = 0; i < r.from - 1 && i < textLines.length; i++) pos += textLines[i]!.length + 1;
        const end = pos + (r.to - r.from === 0 ? (textLines[r.from - 1]?.length ?? 0) : 1);
        return {
            // 浅色 = 全部匹配（每处的整行），深色 = 当前焦点那一处
            lines: ms.flatMap((m) => lineRange(m)),
            focusLines: lineRange(r),
            focusPos: pos,
            focusEnd: end,
            focusKey: `${p}#${idx}`,
        };
    };
    const stepFocus = (d: number): void => {
        const n = hlMatches().length;
        if (n === 0) return;
        setFocusIdx((i) => (i + d + n) % n);
    };

    /**
     * 变更列表 = **真发快照**（每轮一条，读文件）。
     * 点一条 → 选中它（看"它相对上一步改了什么"）；再点一次取消 → 看"当前 vs 最后一步"。
     * 首步没有"上一步"，选中它是给自己看全文（diff 为空，界面会说明）。
     */
    const stepsPane = () => (
        <div class="p-1">
            <div class="mb-1 flex items-center gap-1 px-1 opacity-70">
                <span>{steps()?.total ?? 0} 轮真发</span>
                <span class="ml-auto" title="列表里每行的时间是该轮真发的落盘时刻">
                    {pickedStep() === null ? "看：当前 vs 最后一步" : `看：第 ${pickedStep()} 步 vs 上一步`}
                </span>
            </div>
            <Show
                when={(steps()?.total ?? 0) > 0}
                fallback={
                    <div class="p-2 opacity-60">
                        还没有真发记录。在对话页发一轮，这里就会出现一条（每轮真发落一条投递快照）。
                    </div>
                }
            >
                <ul class="menu menu-xs">
                    <For each={[...(steps()?.steps ?? [])].reverse()}>
                        {(st) => {
                            // system 全量重建的原因：把这一步变化的变量收拢到 system 投递单元
                            // （叶子 `chain.0.path` 归到 `chain`）—— 徽章旁边一眼看到"是谁在打断缓存"。
                            const causes = (): string[] => sysCauses(st.sincePrev?.changed);
                            const causeText = (): string => {
                                const c = causes();
                                if (c.length === 0) return "";
                                return ` ${c.slice(0, 2).join(",")}${c.length > 2 ? ` +${c.length - 2}` : ""}`;
                            };
                            return (
                            <li>
                                <button
                                    class={`flex items-center gap-2 ${rowCls(pickedStep() === st.index)}`}
                                    title="点一下：看这一步相对上一步改了什么；再点取消：看当前 vs 最后一步"
                                    onClick={() => setPickedStep(pickedStep() === st.index ? null : st.index)}
                                >
                                    <span class="badge badge-xs">{st.index}</span>
                                    <span
                                        class="shrink-0 font-mono text-caption opacity-60"
                                        title={`${st.ts}（第 ${st.index} 轮真发）`}
                                    >
                                        {fmtShortTime(st.ts)}
                                    </span>
                                    <span class="truncate font-mono">
                                        {(st.sincePrev?.changed ?? []).slice(0, 2).join(", ") || "baseline"}
                                        {(st.sincePrev?.changed.length ?? 0) > 2
                                            ? ` +${st.sincePrev!.changed.length - 2}`
                                            : ""}
                                    </span>
                                    <span class="ml-auto flex gap-1">
                                        <Show when={st.sincePrev?.systemDiffers}>
                                            <span
                                                class="badge badge-primary badge-xs font-mono"
                                                title={
                                                    "system 全量重建（每轮重发，断前缀缓存）—— " +
                                                    (causes().length > 0
                                                        ? `由这些投递单元变化引起：${causes().join(", ")}`
                                                        : "投递范围或编码版本变了（不是值变化）")
                                                }
                                            >
                                                {`sys${causeText()}`}
                                            </span>
                                        </Show>
                                        <Show when={st.sincePrev?.runtimeDiffers}>
                                            <span class="badge badge-warning badge-xs">run</span>
                                        </Show>
                                    </span>
                                </button>
                            </li>
                            );
                        }}
                    </For>
                </ul>
            </Show>
        </div>
    );

    /** 变更详情（main 侧算好的行级 diff）：选中步 → 步 vs 步；未选中 → 当前 vs 最后一步 */
    const changePane = () => {
        const d = () => diff();
        return (
            <Show when={d()} fallback={<div class="p-2 opacity-60">还没有真发记录，无从比较。</div>}>
                {(dd) => (
                    <div class="space-y-2 p-2">
                        <div class="flex flex-wrap items-center gap-2 text-body">
                            <Show when={dd().base}>
                                {(b) => (
                                    <>
                                        <span class="badge badge-sm" title={b().ts}>
                                            {`第 ${b().index} 步 · ${fmtShortTime(b().ts)}`}
                                        </span>
                                        <span class="opacity-40">→</span>
                                    </>
                                )}
                            </Show>
                            <span class="badge badge-sm badge-primary">
                                <Show
                                    when={dd().target}
                                    fallback={<>当前（未发送）</>}
                                >
                                    {(tg) => <>{`第 ${tg().index} 步 · ${fmtShortTime(tg().ts)}`}</>}
                                </Show>
                            </span>
                            <span class="opacity-60">
                                <Show when={dd().mode === "live"} fallback={<>真发落盘时刻（点上方列表切换）</>}>
                                    {`相对最后一步的改动（最后一步 ${fmtAgo(dd().base!.ts)}）`}
                                </Show>
                            </span>
                            <Show when={dd().incomparable}>
                                <span class="badge badge-warning badge-xs" title="投递编码版本不同，两份不可比">
                                    编码版本不同（不可比）
                                </span>
                            </Show>
                        </div>
                        <div>
                            <div class="mb-1 font-bold opacity-70">{`变化的变量（${dd().changed.length}）`}</div>
                            <Show
                                when={dd().changed.length > 0}
                                fallback={
                                    <div class="opacity-50">
                                        {dd().systemDiffers || dd().runtimeDiffers
                                            ? "无值变化（是投递范围或编码版本变了）"
                                            : "没有变化：当前投递与最后一步一致"}
                                    </div>
                                }
                            >
                                <div class="flex flex-wrap gap-1">
                                    <For each={dd().changed}>
                                        {(p) => <span class="badge badge-xs font-mono">{p}</span>}
                                    </For>
                                </div>
                            </Show>
                        </div>
                        <div class="flex flex-col gap-1 text-body">
                            <div>
                                <span class="badge badge-primary badge-xs badge-outline">system</span>{" "}
                                {dd().systemDiffers ? "重建（全量）" : "未变（可缓存）"}
                            </div>
                            <div>
                                <span class="badge badge-warning badge-xs badge-outline">runtime</span>{" "}
                                {dd().runtimeDiffers ? "增量 patch" : "未变"}
                            </div>
                        </div>
                        <For
                            each={[
                                { name: "system 份变化", diff: dd().systemDiff as DiffLine[] },
                                { name: "runtime 份变化", diff: dd().runtimeDiff as DiffLine[] },
                            ]}
                        >
                            {(x) => (
                                <Show when={x.diff.length > 0}>
                                    <div>
                                        <div class="mb-1 font-bold opacity-70">
                                            {x.name}（+{diffSize(x.diff).add} / -{diffSize(x.diff).del}）
                                        </div>
                                        <pre class="max-h-64 overflow-auto rounded bg-base-100 p-1 font-mono text-body">
                                            {x.diff
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

    /**
     * 变更统计（按项目累计）：每个节点变了几次 / 变化率 —— 判"该不该待在 system"的长期判据。
     * 点一行 → 选中该路径（与结构树选中同一套联动：请求预览滚到并高亮）。
     */
    const statsPane = () => {
        const s = stats();
        if (!s) return <div class="p-2 opacity-60">统计加载中…</div>;
        return (
            <div class="p-1">
                <div class="mb-1 flex items-center gap-1 px-1 opacity-70">
                    <span>{`项目累计 · ${s.turns} 轮`}</span>
                    <Show when={s.since}>
                        <span class="ml-auto" title={`${s.since} ~ ${s.until}`}>
                            {`${fmtShortTime(s.since)} ~ ${fmtShortTime(s.until)}`}
                        </span>
                    </Show>
                </div>
                <Show
                    when={s.paths.length > 0}
                    fallback={
                        <div class="p-2 opacity-60">
                            还没有变化记录。真发几轮后这里会累计每个节点变了多少次。
                        </div>
                    }
                >
                    <table class="table table-xs">
                        <thead>
                            <tr>
                                <th>变量</th>
                                <th class="text-right">变了</th>
                                <th class="text-right">变化率</th>
                                <th>归属</th>
                                <th>最后</th>
                            </tr>
                        </thead>
                        <tbody>
                            <For each={s.paths}>
                                {(p) => {
                                    const o = () => ownerOf(p.path);
                                    return (
                                        <tr
                                            class={`cursor-pointer hover:bg-base-300/60 ${rowCls(selected() === p.path)}`}
                                            title={`变了 ${p.changes} 次 / 共 ${s.turns} 轮；最后变化 ${p.lastChanged ?? "—"}`}
                                            onClick={() => setSelected(p.path)}
                                        >
                                            <td class="font-mono">{p.path}</td>
                                            <td class="text-right font-mono">{p.changes}</td>
                                            <td class="text-right font-mono">{fmtRate(p.rate)}</td>
                                            <td>
                                                <span
                                                    class="badge badge-xs font-mono"
                                                    classList={{
                                                        "badge-primary": o()?.container === "system",
                                                        "badge-ghost": o()?.container !== "system",
                                                    }}
                                                    title={o() ? `投递单元 ${o()!.place}（${o()!.container}）` : "无单元覆盖（默认 runtime）"}
                                                >
                                                    {o()?.place ?? "runtime"}
                                                </span>
                                            </td>
                                            <td class="whitespace-nowrap opacity-60">
                                                {p.lastChanged ? fmtAgo(p.lastChanged) : "—"}
                                            </td>
                                        </tr>
                                    );
                                }}
                            </For>
                        </tbody>
                    </table>
                </Show>
            </div>
        );
    };

    const parts: Record<string, () => JSX.Element> = {
        /** 左：结构树（契约 + 划分操作） */
        "ctxlab.structure": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-body">
                {/* 变更列表：真发快照（每轮一条；点一条看它改了什么） */}
                <Fold k="steps" label="变更（真发轮次）" extra={`${steps()?.total ?? 0} 轮`}>
                    {stepsPane()}
                </Fold>
                {/* 变更统计：按项目累计的长期视角（"用了几天变了几次"），是判断该不该待在 system 的判据 */}
                <Fold k="stats" label="变更统计（项目累计）" extra={`${stats()?.turns ?? 0} 轮`}>
                    {statsPane()}
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
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-body">
                {/* 变更详情：选中某轮 → 与上一轮比；未选中 → 当前 vs 最后一轮（main 侧算好的行级 diff） */}
                <Fold
                    k="change"
                    label="变更详情"
                    extra={
                        pickedStep() === null
                            ? "当前 vs 最后一步"
                            : `第 ${pickedStep()} 步 vs 上一步`
                    }
                >
                    {changePane()}
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
                                <div class="shrink-0 px-2 py-1 text-caption opacity-60">{lab()!.request.note}</div>
                                <Show
                                    when={reqMode() === "yaml"}
                                    fallback={
                                        <div class="min-h-0 flex-1 overflow-auto p-2">
                                            <JsonTree data={b()} />
                                        </div>
                                    }
                                >
                                    {/* 选中结构树一行 → 所有匹配处的导航条（↑/↓ 在它们之间跳；与提示词页同一套交互） */}
                                    <Show when={selected() && hlMatches().length > 0}>
                                        <DynamicBar
                                            label={selected()!}
                                            count={hlMatches().length}
                                            index={Math.min(focusIdx(), Math.max(0, hlMatches().length - 1))}
                                            onPrev={() => stepFocus(-1)}
                                            onNext={() => stepFocus(1)}
                                            onClear={() => setSelected(null)}
                                        />
                                    </Show>
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
            <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-body">
                <span class="badge badge-info badge-sm" title={props.uri}>
                    📌 {props.uri}
                </span>
                <button
                    class="btn btn-xs btn-ghost"
                    title="重新计算：当前上下文 + 真发快照列表 + 变更详情（没有实时推送，改动要按一下）"
                    onClick={refresh}
                >
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
                        parts[viewId]?.() ?? <div class="p-3 text-body opacity-60">未注册的 view: {viewId}</div>
                    }
                />
            </div>
        </div>
    );
}
