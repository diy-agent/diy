/**
 * ContextLabPage — 上下文树页（**独立子页面**，任务 148 / ##310）。
 *
 * 一句话：模型 wire = **一个 YAML 信封**（`help` 结构说明 + `system` / `runtime` / `runtimeDiff` / `user`
 * 值段，见 shared/context/envelope.ts），本页把「它到底长什么样、哪一步变了」摆出来。
 *
 * 两列（左=输入，中=产出）；每块右上角都有 `<>`：**就地切成该块背后的原始数据**（原样，
 * 不经任何加工）—— 视图一旦和真实数据对不上，人只能靠猜；原文摆出来就无从撒谎。
 *
 *   · 左「结构树」 变量契约（zod），含类型/描述与无值变量。
 *                  **划分操作就在这做**：点节点上的 ⇄ 换容器（system ⇄ runtime），
 *                  改动写进 `$DIY_HOME/context.yaml`（**真源**，真发读同一份）。
 *   · 左「变更历史」= **表格**：`轮次 | 步 | 实际请求`（只到"步"这一层，不列变了哪些字段）。
 *                  「实际请求」是超链接 → 弹**流量抽屉**（与对话页报错后那个「查看实际请求」同一个）。
 *                  点一行 = 选中该步（驱动中栏两块）。数据读会话目录下的 `changelog.jsonl`（##379；不轮询）。
 *   · 左「变更统计」= 按项目累计的长期视角（"这个节点变了几次"）—— 判断该不该待在 system 的判据。
 *   · 中「变量树变更」整棵变量树 + 把**生效那条记录**的变更标在命中节点上（步级 · 变量级）。
 *   · 中「system / runtime diff」两份全文各自一块（轮级 · 文本级，行号 + hunk 折叠）。
 *                  runtime 那块 `<>` 给的是**该步实际发出去的末条 user 消息**（runtime 变更告知原文）。
 *   · 中「该步实际请求」这一步真发出去的那条 HTTP 请求（流量日志 = 地面真相）+ 一键跳流量页定位。
 *
 * 已删（##310 六轮）：**「请求预览（实际发送格式）」**（那是*仿真*请求体，真发形态看上面那块）
 * 与**「变更详情」**（与「变量树变更」是两把尺且与左栏点击错位 —— 现由两侧 diff 块承担）。
 *
 * 数据是**当前任务的真实上下文**（与真发同一条 assembleGlobals 链），不是编造的。
 */
import { createResource, createSignal, For, onMount, Show, type JSX } from "solid-js";
import { diyService } from "../lib/rpc";
import { taskStore } from "../store/taskStore";
import { ViewGrid } from "./ViewGrid";
import { layoutStore } from "../store/layoutStore";
import { findPage } from "../../shared/view-registry";
import { Caches } from "../lib/ui-state";
import { projectFromUri } from "../../shared/task-uri";
import { buildVarTree, type VarNode } from "../../shared/var-tree";
import { AssembleGlobalsSchema } from "../../shared/prompt-schema";
import { notificationStore } from "../store/notificationStore";
import type { ContextLab, PlaceCandidate } from "../../shared/context/preview";
import { diffSize } from "../../shared/context/steps";
import { foldCounts, foldDiff, numberDiff, type DiffRow } from "../../shared/context/diff-view";
import { attributionOf, foldStatRows, sysCauses, unitsFromRules, type Attribution } from "../../shared/context/attribution";
import { fmtAgo, fmtShortTime } from "../../shared/date-format";
import type { ContextDiff, CtxLog, HistoryEntryView, Stats } from "../../shared/context/schema";
import type { DiffLine } from "../../shared/line-diff";
import { changeForNode } from "../../shared/context/changelog";
import { dateOfLogFile, pickStepTraffic, type TrafficStepRecord } from "../../shared/context/traffic-step";
import { trafficStore } from "../store/trafficStore";
import { TrafficDrawer } from "./TrafficDrawer";
import { getRendererActions } from "../lib/renderer-actions";

const PAGE = "ctxlab";

/** 人类可读字节数（1024 进制；与流量页同口径） */
function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
    }
    return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

/** 一条 ModelMessage 的 content → 可读文本（字符串原样；分片数组按类型摊平） */
function msgText(c: unknown): string {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
        return c
            .map((p) => {
                const o = p as { type?: unknown; text?: unknown; toolName?: unknown; input?: unknown; output?: unknown };
                if (typeof o?.text === "string") return o.text;
                if (o?.type === "tool-call") return `[tool-call ${String(o.toolName)}] ${JSON.stringify(o.input ?? {})}`;
                if (o?.type === "tool-result") return `[tool-result] ${JSON.stringify(o.output ?? {})}`;
                return JSON.stringify(p);
            })
            .join("\n");
    }
    return c === undefined || c === null ? "" : JSON.stringify(c);
}

/** 流量记录里我们渲染时用到的字段（traffic.query 返回值是其超集） */
interface TrafficRec extends TrafficStepRecord {
    id?: number;
    traceId?: string | null;
    reqBytes?: number;
    resBytes?: number;
    ms?: number;
    reqBody?: { head?: string; tail?: string; truncated?: boolean; totalBytes?: number } | null;
}

/**
 * 请求体（首尾法保留的正文）→ 会话消息。
 * 默认**只留首尾一段**（`truncated`），这时 JSON 解不开 —— 如实说"被截断"并给出开关提示，
 * 不把半截 JSON 当正文渲染（那会让人以为请求就是这么发的）。
 */
function parseBodyMessages(rec: TrafficRec): { msgs: Array<{ role: string; text: string }> | null; note: string } {
    const rb = rec.reqBody ?? null;
    if (!rb || typeof rb.head !== "string" || rb.head === "") return { msgs: null, note: "这条记录没有请求正文。" };
    try {
        const json = JSON.parse(rb.head) as { messages?: unknown };
        if (!Array.isArray(json.messages)) return { msgs: null, note: "请求体里没有 messages 数组。" };
        const msgs = (json.messages as Array<{ role?: unknown; content?: unknown }>).map((m) => ({
            role: String(m?.role ?? "?"),
            text: msgText(m?.content),
        }));
        return { msgs, note: "" };
    } catch {
        return {
            msgs: null,
            note: rb.truncated
                ? `请求正文被截断（共 ${rb.totalBytes ?? 0} 字节，默认只留首尾）—— 在流量页打开「记录完整请求内容」后重发一轮即可见全文。`
                : "请求正文不是合法 JSON。",
        };
    }
}

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
     * 变更历史（每轮一条事件流，读会话目录下的 `changelog.jsonl`；##379 分层，路径由 main 算 —— UI 不拼；没有实时推送，靠顶栏「⟳ 刷新」重拉）。
     * 轮序与真发投递快照同序（两份日志同点写）—— 所以这里的 `index` 就是"第几步"，
     * 点一行即可驱动中栏「变更详情」的 diff。老任务没有这份日志时 main 会从投递快照折算
     * （`source: "derived"`，只有变化路径、没有值预览）。
     */
    const [history, { refetch: refetchHistory }] = createResource(
        () => props.uri,
        async (uri) => {
            return (await diyService.diy.context.changelog({ taskUri: uri, limit: undefined })) as CtxLog;
        },
    );

    /**
     * 选中的变更**记录**（seq）。
     *
     * 为什么不能只用 `pickedStep`（steps.jsonl 的**轮**序）驱动新 view：变更日志是**逐步**写的，
     * 而投递快照是**逐轮**写的 —— 只在"两份日志等长"时才勉强对得上，老任务升级后
     * （日志从中间开始）按轮序去取就会指到别的轮（##310 review 意见 1，用户实测"点击 ↔ 详情对不上"）。
     * 新 view 直接拿**被点的那条记录**：由构造保证与左栏一致，不再有间接映射。
     */
    const [pickedSeq, setPickedSeq] = createSignal<number | null>(null);

    /**
     * 文本 diff 里**被展开的空隙**（`gap id` 集合）。
     * 折叠态是默认（一份 system 二十几 KB 全摊开 = 找不着重点），展开由人点。
     */
    const [openGaps, setOpenGaps] = createSignal<Set<string>>(new Set());
    const toggleGap = (id: string): void => {
        const next = new Set(openGaps());
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setOpenGaps(next);
    };

    /** 文本 diff 一次最多渲染多少行（真发全文可能几千行；上限兜住渲染量，超了给 truncated 行） */
    const DIFF_MAX_LINES = 800;

    /** 生效的变更记录：选中的那条；没选 = 最后一条**有变**的（页面一打开就有东西看，不必先点） */
    const effectiveEntry = (): HistoryEntryView | null => {
        const es = history()?.entries ?? [];
        const s = pickedSeq();
        if (s !== null) return es.find((e) => e.seq === s) ?? null;
        for (let i = es.length - 1; i >= 0; i--) if (es[i]!.changes.length > 0) return es[i]!;
        return null;
    };

    /**
     * 该步真发的**那条 HTTP 请求**（流量日志，按 turnId 找）。
     *
     * 为什么从流量日志找而不是本页重算：这是"实际效果"的**地面真相** —— 页面重算只能证明
     * "我以为会发什么"，流量日志证明"确实发了什么"。找不到 = `null`（日志被清 / 该轮没真发过）
     * → UI 出声，不编。
     */
    const [stepTraffic, { refetch: refetchStepTraffic }] = createResource(
        () => {
            const e = effectiveEntry();
            return e ? `${e.ref.turnId}\u0000${e.ref.step}` : null;
        },
        async (key) => {
            const [turnId, step] = key.split("\u0000");
            const res = await diyService.diy.traffic.query({
                text: turnId,
                status: "all",
                method: "all",
                date: "all",
                limit: 500,
            });
            // 时刻从"被点的那条记录"来（不只是 key 里的 turnId/step）—— pickStepTraffic 用它挑出该步那条
            const e = effectiveEntry();
            return pickStepTraffic<TrafficRec>(
                (res.records ?? []) as unknown as TrafficRec[],
                { turnId: turnId!, step: Number(step) },
                props.uri,
                e?.ts ?? null,
            );
        },
    );

    /**
     * 变更统计（**按项目累计**，跨任务）：回答"这个节点用了几天变了几次 / 变化率"。
     * 为什么不按任务：单任务样本太小；长期累计才有"该不该待在 system"的判据价值
     * （逐轮明细已由上面的「变更历史（真发轮次）」给出；见 shared/context/stats.ts 头注）。
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

    /** 顶栏刷新：重拉六处（当前上下文 / 变更历史 / 变更详情 / 划分规则真源 / 变更统计）——
     *  没有实时推送，只有显式刷新（外部改了 context.yaml 也靠它捡回来） */
    const refresh = (): void => {
        void refetch();
        void refetchHistory();
        void refetchDiff();
        void refetchConfig();
        void refetchStats();
        void refetchStepTraffic();
    };

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

    /** 当前投递单元（path → 容器）。纯函数在 shared/context/attribution.ts（RV-10）。 */
    const unitMap = (): Map<string, "system" | "runtime"> => unitsFromRules(lab()?.rules ?? []);
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
     * 归属（三态）与归因（system 重建原因）的**纯函数已提到 `shared/context/attribution.ts`**
     * （review RV-10：一份实现 + 可单测）。这里只负责把**页面当前划分**（`unitMap()`）喂进去。
     * ⚠️ 注意两处口径**有意不同**（review RV-09）：
     *   · 本页「变更统计」表的归属列与中间容器折叠、结构树的 ⇄ 开关 = **当前**划分（用户眼前这把刀，改划分即重算）；
     *   · 「变更历史（真发轮次）」的 sys 徽章 = **该轮快照**的划分（`sysCauses(changed, st.systemPlaces)`，
     *     历史不该被当前划分改写 —— RV-02）。
     */
    const attrOf = (path: string): Attribution => attributionOf(unitMap(), path);

    const structure = () => buildVarTree(AssembleGlobalsSchema);

    /** 变更次数（基线的 add 不算"变更" —— 它只是起点） */
    const changeCount = (): number =>
        (history()?.entries ?? []).reduce((a, t) => a + (t.type === "baseline" ? 0 : t.changes.length), 0);

    /**
     * 每个 view 背后的**原始数据**（用户 2026-10-15：「如果可以的话每个 view 背后的原始数据
     * 都可以通过 `<>` 提供出来」）—— 点 `<>` 就地切成原文，再点切回。
     *
     * 为什么值得有：这一页的每个块都是**加工过的视图**（表格/折行/配色/摘要）。一旦视图和
     * 真实数据对不上，人只能靠猜。原文摆出来就无从撒谎 —— 而且它同时也是"发出去的到底是什么"
     * 的证据链（system / runtime 两份全文、流量日志那条请求）。
     */
    const [rawOf, setRawOf] = createSignal<string | null>(null);
    const rawBtn = (k: string, label: string): JSX.Element => (
        <button
            class="btn btn-xs px-1 font-mono"
            classList={{ "btn-active": rawOf() === k, "btn-ghost": rawOf() !== k }}
            title={`看「${label}」这个 view 背后的原始数据（原样，不经任何加工）；再点一下切回视图`}
            onClick={(e) => {
                e.stopPropagation();
                setRawOf(rawOf() === k ? null : k);
            }}
        >
            {"<>"}
        </button>
    );
    /** 折叠块 + `<>`（每个 view 统一带原始数据出口） */
    const View = (p: {
        k: string;
        label: string;
        extra?: string;
        raw: () => string;
        /**
         * `<>` 原始数据的**说明** —— 贴 view 顶的 info block（用户 2026-10-15：「上面这一段不要出现，
         * 不要人误会这也是发出去的，这个可以用 info bar 说明」）。
         * **不进** `raw()` 正文：那里是"原样子节"，掺一行注释就等于往证据里塞话 —— 看着像发出去的内容。
         */
        rawInfo?: string;
        right?: JSX.Element;
        children: JSX.Element;
    }): JSX.Element => (
        <Fold
            k={p.k}
            label={p.label}
            extra={p.extra}
            right={
                <span class="flex items-center gap-1">
                    {p.right}
                    {rawBtn(p.k, p.label)}
                </span>
            }
        >
            <Show
                when={rawOf() === p.k}
                fallback={p.children}
            >
                <div class="flex flex-col gap-1">
                    <Show when={p.rawInfo}>
                        {(info) => (
                            <div class="rounded border border-info/40 bg-info/10 px-2 py-1 text-caption leading-snug">
                                {info()}
                            </div>
                        )}
                    </Show>
                    <pre class="max-h-[70vh] overflow-auto whitespace-pre-wrap break-all rounded bg-base-100 p-1 font-mono text-caption">
                        {p.raw()}
                    </pre>
                </div>
            </Show>
        </Fold>
    );

    /**
     * 「实际请求」超链接 → 弹**流量抽屉**，定位到该步真发出去的那条。
     *
     * 与对话页报错后「查看实际请求 / 响应」是**同一个抽屉**（`trafficStore.openWith`）——
     * 用户已认得那个形态，不必再造一种。
     * 为什么要先查一次再开：抽屉靠 `reqId`/`traceId` 精确定位；只给关键词会退化成
     * "最近一次失败"，看着像点错了。查不到就明说（不编）。
     */
    const openRequestDrawer = async (t: HistoryEntryView): Promise<void> => {
        try {
            const res = await diyService.diy.traffic.query({
                text: t.ref.turnId,
                status: "all",
                method: "all",
                date: "all",
                limit: 500,
            });
            const hit = pickStepTraffic<TrafficRec>(
                (res.records ?? []) as unknown as TrafficRec[],
                { turnId: t.ref.turnId, step: t.ref.step },
                props.uri,
                t.ts ?? null,
            );
            if (!hit) {
                notificationStore.addToast(
                    "error",
                    `未找到这一步的实际请求（${t.ref.turnId} · 第 ${t.ref.step} 步）：可能没真发过 / 流量日志被清。`,
                );
                return;
            }
            trafficStore.openWith({
                reqId: hit.record.id ?? null,
                traceId: hit.record.traceId ?? null,
                text: t.ref.turnId,
                date: dateOfLogFile(hit.record.log?.file ?? null) ?? "all",
            });
        } catch (e) {
            notificationStore.addToast("error", `查流量日志失败：${e instanceof Error ? e.message : String(e)}`);
        }
    };

    /** 变更种类的记号与配色（add / update / remove 三态） */
    const kindGlyph = (k: "add" | "update" | "remove"): string => (k === "add" ? "+" : k === "remove" ? "−" : "~");
    const kindCls = (k: "add" | "update" | "remove"): string =>
        k === "add" ? "badge-success" : k === "remove" ? "badge-error" : "badge-warning";

    /**
     * 变更历史 = **表格**（用户 2026-10-15 拍板：「轮次和步分两列，只显示序号/id，不显示中文 xx步，
     * 减少页面占用。不需要树形结构，不显示具体变化的字段，只有显示步这一层次」）。
     *
     * 三列：`轮次 | 步 | 实际请求`。
     *   · 轮次 = `#M`（投递快照里的第几轮；取不到就不编 —— 老任务/演示数据 join 不上）
     *   · 步   = 该轮内第几次真发请求（`ref.step`，纯序号）
     *   · 实际请求 = 超链接 → 弹**流量抽屉**（与对话页报错后「查看实际请求 / 响应」同一个抽屉）
     * 点行 = 选中该步（驱动「变量树变更」「该步实际请求」两块）；每步改了哪些字段**不在这里列**
     * （那是「变量树变更」块的事 —— 本块只回答"哪一步"）。
     */
    const historyPane = () => {
        const h = history();
        const total = h?.total ?? 0;
        return (
            <div class="p-1">
                <div class="mb-1 flex items-center gap-1 px-1 text-caption opacity-70">
                    <span>{`${total} 条记录 · ${changeCount()} 次变更`}</span>
                    <span class="ml-auto">点一行 = 选中该步</span>
                </div>
                <Show
                    when={total > 0}
                    fallback={
                        <div class="p-2 opacity-60">
                            还没有变更记录。在对话页发一轮，这里先落 baseline（起点），之后每步**有变**才落一行。
                        </div>
                    }
                >
                    <Show when={h?.source === "derived"}>
                        <div class="mb-1 px-1 text-caption opacity-50">
                            这份历史是降级视图（老格式日志回放，或从投递快照的值 hash 折算）：只有变化路径，没有值预览
                        </div>
                    </Show>
                    <table class="table table-xs">
                        <thead>
                            <tr>
                                <th>轮次</th>
                                <th>步</th>
                                <th>实际请求</th>
                            </tr>
                        </thead>
                        <tbody>
                            <For each={[...(h?.entries ?? [])].reverse()}>
                                {(t) => {
                                    // system 全量重建的原因：把该步变化的变量收拢到**该步快照的** system 单元
                                    // （⚠️ 用 `t.systemPlaces` 当轮快照，不用页面当前划分 —— 改划分不该改写历史，RV-02）
                                    const causes = (): string[] =>
                                        t.incomparable === true ? [] : sysCauses(t.changes.map((c) => c.path), t.systemPlaces);
                                    const tip = (): string => {
                                        const bits = [`${t.ts}`, `${t.ref.turnId} · 第 ${t.ref.step} 步`];
                                        bits.push(
                                            t.type === "baseline"
                                                ? "baseline（起点）"
                                                : t.changes.length === 0
                                                  ? "本步无变化"
                                                  : `本步 ${t.changes.length} 处变化：${t.changes.map((c) => c.path).join(", ")}`,
                                        );
                                        if (t.systemDiffers) {
                                            bits.push(
                                                t.incomparable
                                                    ? "system 重建（编码版本变化，不可比）"
                                                    : causes().length > 0
                                                      ? `system 重建，由 ${causes().join(", ")} 引起`
                                                      : "system 重建（非值变化引起）",
                                            );
                                        }
                                        if (t.cacheHitRate !== null) bits.push(`缓存命中 ${Math.round(t.cacheHitRate * 100)}%`);
                                        if (t.cost !== null) bits.push(`$${t.cost.toFixed(4)}`);
                                        return bits.join(" · ");
                                    };
                                    return (
                                        <tr
                                            class={`cursor-pointer hover:bg-base-300/60 ${rowCls(pickedSeq() === t.seq)}`}
                                            title={tip()}
                                            onClick={() => {
                                                if (pickedSeq() === t.seq) {
                                                    setPickedSeq(null);
                                                    setPickedStep(null);
                                                    return;
                                                }
                                                setPickedSeq(t.seq);
                                                setPickedStep(t.turnIndex);
                                            }}
                                        >
                                            <td class="whitespace-nowrap font-mono">
                                                {t.turnIndex !== null ? `#${t.turnIndex}` : "—"}
                                                {/* 轮内元信息（步骤级）：system 是否全量重建 + 由谁引起、runtime 是否变。
                                                    放这一格而不另开列 —— 表格只到"步"这一层，细节在行的 title 里。 */}
                                                <Show when={t.systemDiffers}>
                                                    <span class="badge badge-primary badge-xs ml-1 font-mono">
                                                        {(() => {
                                                            const c = causes();
                                                            return c.length === 0 ? "sys" : `sys ${c.slice(0, 2).join(",")}${c.length > 2 ? ` +${c.length - 2}` : ""}`;
                                                        })()}
                                                    </span>
                                                </Show>
                                                <Show when={t.runtimeDiffers}>
                                                    <span class="badge badge-warning badge-xs ml-1">run</span>
                                                </Show>
                                            </td>
                                            <td class="font-mono">{t.ref.step}</td>
                                            <td>
                                                <button
                                                    class="link link-primary text-caption"
                                                    onClick={(ev) => {
                                                        ev.stopPropagation();
                                                        setPickedSeq(t.seq);
                                                        setPickedStep(t.turnIndex);
                                                        void openRequestDrawer(t);
                                                    }}
                                                >
                                                    查看实际请求 →
                                                </button>
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

    /** 变更种类 → 行配色（vscode diff 的观感：增绿 / 删红 / 改黄） */
    const diffRowCls = (kind: "add" | "update" | "remove" | null): string =>
        kind === "add"
            ? "bg-success/10"
            : kind === "remove"
              ? "bg-error/10"
              : kind === "update"
                ? "bg-warning/10"
                : "";

    /**
     * 变量树变更（##310）—— 整棵 context 变量树 + 把**这一步**的变更标在命中节点上。
     *
     * 与「变更详情」的分工（两把不同的尺，都要）：
     *   · 本块 = **步级 · 变量级**：读 changelog 的原子单元（`chain` 整体一条），点哪条记录标哪条
     *     → 不会与左栏错位（左栏点击直接喂这一块，没有"轮序→步序"的间接映射）；
     *   · 「变更详情」= **轮级 · 文本级**：system/runtime 两份全文逐行比，看"发出去的字节差在哪"。
     *
     * 树用 `lab().tree`（与真发同一条 assembleGlobals 链的**当前值树**）；标注用变更记录的
     * before/after 摘要 —— 所以"当前值"列永远是此刻的真值，"变更"列是本步的旧→新（可能截断）。
     */
    const varDiffPane = () => {
        const e = effectiveEntry();
        if (!e) {
            return (
                <div class="p-2 opacity-60">
                    还没有带变化的记录可标注。在对话页真发一轮（改了变量），左栏「变更历史」出现一行后这里就有内容。
                </div>
            );
        }
        const changes = e.changes;
        return (
            <div class="p-1">
                <div class="mb-1 flex flex-wrap items-center gap-1 px-1 text-caption opacity-70">
                    <span class="badge badge-xs">{`第 ${e.ref.step} 步`}</span>
                    <span>{`${fmtShortTime(e.ts)} · 本步 ${changes.length} 处变更`}</span>
                    <Show when={pickedSeq() === null}>
                        <span>（未选中：显示最后一条有变的记录；点左栏「变更历史」任意一行切换）</span>
                    </Show>
                    <Show when={e.incomparable === true}>
                        <span class="badge badge-warning badge-xs">编码版本不同（不可比）</span>
                    </Show>
                </div>
                <table class="table table-xs">
                    <thead>
                        <tr>
                            <th>变量（整棵树）</th>
                            <th>当前值</th>
                            <th>本步变更（旧 → 新）</th>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={lab()?.tree ?? []}>
                            {(n) => {
                                const c = changeForNode(n.path, changes);
                                const own = c && c.path === n.path ? c : null;
                                return (
                                    <tr
                                        class={`cursor-pointer hover:bg-base-300/60 ${diffRowCls(c ? c.kind : null)} ${rowCls(selected() === n.path)}`}
                                        title={c ? `${c.path}：本步 ${c.kind}` : "本步未变"}
                                        onClick={() => setSelected(n.path)}
                                    >
                                        <td class="whitespace-nowrap font-mono">
                                            <span style={{ "padding-left": `${(n.path.split(".").length - 1) * 12}px` }} />
                                            <span class={c ? "font-bold" : ""}>{n.path}</span>
                                            <Show when={c}>
                                                <span class={`ml-1 badge badge-xs font-mono ${kindCls(c!.kind)}`}>
                                                    {kindGlyph(c!.kind)}
                                                </span>
                                            </Show>
                                        </td>
                                        <td class="max-w-[22rem] truncate opacity-70" title={n.preview}>
                                            {n.hasValue ? n.preview || "（容器）" : "（无值）"}
                                        </td>
                                        <td class="max-w-[26rem]">
                                            <Show
                                                when={own}
                                                fallback={
                                                    <Show when={c}>
                                                        <span class="opacity-50">{`（随 ${c!.path} 变）`}</span>
                                                    </Show>
                                                }
                                            >
                                                {(o) => (
                                                    <span class="flex items-center gap-1">
                                                        <span class="truncate text-error line-through" title={o().before ?? ""}>
                                                            {o().before ?? "∅"}
                                                        </span>
                                                        <span class="opacity-40">→</span>
                                                        <span class="truncate text-success" title={o().after ?? ""}>
                                                            {o().after ?? "∅"}
                                                        </span>
                                                    </span>
                                                )}
                                            </Show>
                                        </td>
                                    </tr>
                                );
                            }}
                        </For>
                    </tbody>
                </table>
            </div>
        );
    };

    /**
     * 跳到「流量」页并定位到这条请求。
     * 先把筛选条件置成这条记录的 turnId + 它所在的日期（列表默认只查当天）——
     * 否则目标那条不在结果里，流量页的定位会退化成"最近一次失败"，看着像点错了。
     */
    const openInTraffic = (e: HistoryEntryView, rec: TrafficRec): void => {
        trafficStore.focusWith({
            text: e.ref.turnId,
            date: dateOfLogFile(rec.log?.file ?? null) ?? "all",
            traceId: rec.traceId ?? null,
        });
        getRendererActions().navigate?.("traffic");
    };

    /**
     * 文本 diff（逐行 · 真发全文），**system / runtime 各一个 view**（用户 2026-10-15：
     * 「diff view 的系统和 runtime 拆成 2 个 view」——两份全文各自有正文、混在一个块里
     * 只会互相挤，展开态也没法各记各的）。
     *
     * 与前两块的**分工**（三把尺，各回答一个问题）：
     *   · 变量树变更 = **变量级**（哪几个变量变了，值旧→新，**压缩摘要**）；
     *   · 本块       = **文本级**（发出去的字节逐行差在哪，改动的整段上下文都在）—— vscode 观感；
     *   · 该步实际请求 = **地面真相**（磁盘上那条请求原文，证明确实发了这个）。
     *
     * 数据源 = `steps.jsonl` 的 `systemText` / `runtimeText`（每轮**真发全文**，落盘事实）→
     * 所以本块是**轮级**（该轮 vs 上一轮），不是步级：changelog 那份是压缩摘要，做不了行级 diff。
     *
     * `<>` 给出这一侧的**全文本身**：
     *   · system  → 该步的 system 上下文本体（= 变量树 + `help` 段，真发参数原样）
     *   · runtime → 该步**实际发出去的末条 user 消息**（流量日志里那条；找不到才退回组装产物）
     */
    const diffPane = (which: "system" | "runtime") => {
        const d = () => diff();
        const raw = (): DiffLine[] => (which === "system" ? (d()?.systemDiff ?? []) : (d()?.runtimeDiff ?? []));
        const differs = (): boolean => (which === "system" ? (d()?.systemDiffers ?? false) : (d()?.runtimeDiffers ?? false));
        const rows = (): DiffRow[] => {
            const all = raw();
            const folded = foldDiff(all, { context: 3, maxLines: DIFF_MAX_LINES });
            const open = openGaps();
            if (open.size === 0) return folded;
            const numbered = numberDiff(all);
            const out: DiffRow[] = [];
            for (const r of folded) {
                if (r.kind === "line" || !open.has(r.id)) {
                    out.push(r);
                    continue;
                }
                for (let i = r.fromIdx; i <= r.toIdx; i++) {
                    const line = numbered[i];
                    if (line) out.push({ kind: "line", line });
                }
            }
            return out;
        };
        const counts = () => foldCounts(foldDiff(raw(), { context: 3, maxLines: DIFF_MAX_LINES }));
        return (
            <Show when={d()} fallback={<div class="p-2 opacity-60">还没有真发记录，无从比较（真发一轮后再来）。</div>}>
                {(dd) => (
                    <div class="flex flex-col gap-1 p-1">
                        <div class="flex flex-wrap items-center gap-2 px-1 text-caption opacity-70">
                            <Show when={dd().base}>
                                {(b) => (
                                    <>
                                        <span class="badge badge-xs" title={b().ts}>{`第 ${b().index} 轮 · ${b().turnId}`}</span>
                                        <span class="opacity-40">→</span>
                                    </>
                                )}
                            </Show>
                            <span class="badge badge-xs badge-primary">
                                <Show when={dd().target} fallback={<>当前（未发送）</>}>
                                    {(tg) => <>{`第 ${tg().index} 轮 · ${tg().turnId}`}</>}
                                </Show>
                            </span>
                            <span>
                                {dd().mode === "live"
                                    ? "数据源：当前组装 vs 最后一步（steps.jsonl 全文）"
                                    : "数据源：steps.jsonl 的两轮真发全文（轮级）"}
                            </span>
                            <span class={differs() ? "text-error" : "opacity-50"}>
                                {differs() ? `-${counts().del}` : "与上一轮逐字相同（可缓存）"}
                            </span>
                            <Show when={differs()}>
                                <span class="text-success">{`+${counts().add}`}</span>
                                <span class="opacity-50">{`已渲染 ${counts().del + counts().add} 行改动 · 折叠 ${counts().gapLines} 行原文`}</span>
                            </Show>
                            <Show when={dd().incomparable}>
                                <span class="badge badge-warning badge-xs">编码版本不同（不可比）</span>
                            </Show>
                            <button
                                class="btn btn-xs btn-ghost ml-auto"
                                title="全部重新折叠"
                                onClick={() => setOpenGaps(new Set())}
                            >
                                折叠全部
                            </button>
                        </div>
                        <div class="px-1 text-caption opacity-70">
                            绿 = 新增行，红 = 删除行；行号：左=旧 / 右=新；「⋯」行可点开。
                        </div>
                        <Show
                            when={differs()}
                            fallback={
                                <div class="rounded border border-base-300 bg-base-100 p-1 font-mono text-caption opacity-50">
                                    （本份未变 —— system 每轮全量重发；runtime 只在易变项变了才不同）
                                </div>
                            }
                        >
                            <div class="max-h-96 overflow-auto rounded border border-base-300 bg-base-100">
                                <For each={rows()}>
                                    {(r) => (
                                        <Show
                                            when={r.kind === "line"}
                                            fallback={
                                                <button
                                                    class="flex w-full cursor-pointer items-center gap-1 bg-base-200/70 px-1 text-left font-mono text-caption opacity-70 hover:opacity-100"
                                                    title="点击展开这段未变的原文"
                                                    onClick={() => toggleGap((r as { id: string }).id)}
                                                >
                                                    <span class="w-20 shrink-0" />
                                                    <span>
                                                        {(r as { truncated?: boolean }).truncated
                                                            ? "… 超出渲染上限（点右上 <> 看原文，或折起这段）"
                                                            : `⋯ 展开 ${(r as { count: number }).count} 行未变`}
                                                    </span>
                                                </button>
                                            }
                                        >
                                            {(() => {
                                                const l = (r as Extract<DiffRow, { kind: "line" }>).line;
                                                return (
                                                    <div
                                                        class={`flex items-start font-mono text-caption ${
                                                            l.t === "+" ? "bg-success/15" : l.t === "-" ? "bg-error/15" : ""
                                                        }`}
                                                    >
                                                        <span class="w-10 shrink-0 select-none border-r border-base-300 px-1 text-right opacity-40">
                                                            {l.oldNo ?? ""}
                                                        </span>
                                                        <span class="w-10 shrink-0 select-none border-r border-base-300 px-1 text-right opacity-40">
                                                            {l.newNo ?? ""}
                                                        </span>
                                                        <span class="w-4 shrink-0 select-none text-center opacity-70">{l.t === " " ? "" : l.t}</span>
                                                        <span class="whitespace-pre-wrap break-all pr-1">{l.s === "" ? " " : l.s}</span>
                                                    </div>
                                                );
                                            })()}
                                        </Show>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </div>
                )}
            </Show>
        );
    };

    /** system 侧的原始数据 = 该步真发的 system 全文（steps.jsonl 的 systemText）——正文只放真发字节 */
    const rawSystem = (): string => diff()?.systemText ?? "（没有真发记录）";
    /** 上面那份 raw 的说明（贴 view 顶的 info block；不掺进正文，免得被当成"发出去的内容"） */
    const rawSystemInfo = (): string => {
        const d = diff();
        if (!d) return "没有真发记录 —— 下面无内容。";
        const side = d.mode === "live" ? "当前组装" : `第 ${d.target?.index ?? "?"} 轮 ${d.target?.turnId ?? ""}`;
        return `该步真发的 system 参数全文（steps.jsonl 的 systemText，逐字）。侧：${side}。结构：help 段（zod 派生的结构说明）+ system 段（变量树）。`;
    };

    /**
     * runtime 侧的原始数据 = **该步真发出去的末条 user 消息**（用户原话：「里面切换为实际组装成
     * user message 的实际内容，即当前步骤真的发出去的那个通知 llm runtime 变量变了的内容」）。
     * 流量日志是地面真相；查不到（没真发过 / 日志被清 / 正文被截断）才退回 steps.jsonl 的
     * **组装产物**，并如实标注是退回的那份。
     */
    const rawRuntime = (): string => {
        const t = stepTraffic();
        if (t) {
            const parsed = parseBodyMessages(t.record);
            const users = (parsed.msgs ?? []).filter((m) => m.role === "user");
            const last = users[users.length - 1];
            if (last) return last.text;
        }
        return diff()?.runtimeText ?? "（没有真发记录）";
    };
    /** 上面那份 raw 的说明（贴 view 顶的 info block；不掺进正文） */
    const rawRuntimeInfo = (): string => {
        const t = stepTraffic();
        if (t) {
            const parsed = parseBodyMessages(t.record);
            const users = (parsed.msgs ?? []).filter((m) => m.role === "user");
            if (users[users.length - 1]) {
                const loc = `${t.record.log?.abs ?? "?"}:${t.record.log?.line ?? "?"}`;
                return `该步**实际发出去**的末条 user 消息（流量日志 ${loc}）—— 就是**模型真正看到的那段**（runtime / runtimeDiff 信封 + 本轮用户输入）。${parsed.note ? `⚠️ ${parsed.note}` : ""}`;
            }
        }
        return "流量日志里找不到该步的请求 → 下面是 steps.jsonl 的**组装产物**（runtimeText）：它是「我们组装了什么」，不是「线上真发了什么」（后者见「该步实际请求」view）。";
    };

    /**
     * 该步实际请求（真发 · 流量）—— 回答"这一步**实际**发出去的是什么"。
     *
     * 为什么要有它：变量树只说明"变得对不对"，不能证明"真发的是不是这个"（构造链跑在 main 里）。
     * 流量日志是地面真相：同一个 turnId 的请求按 ts 排序就是各步，取第 `ref.step` 条。
     * 数据源是**磁盘日志**（跨进程、跨天都在），所以能回看历史步。
     */
    const stepSessionPane = () => {
        const e = effectiveEntry();
        if (!e) return <div class="p-2 opacity-60">先在上方选中一条变更记录。</div>;
        const t = stepTraffic();
        if (t === undefined) return <div class="p-2 opacity-60">正在查该步的实际请求…</div>;
        if (t === null) {
            return (
                <div class="p-2 text-body">
                    <div class="mb-1">{`未找到该步的实际请求（轮 ${e.ref.turnId} · 第 ${e.ref.step} 步）。`}</div>
                    <div class="opacity-60">
                        可能的原因：① 这条记录是手写/演示数据，没真发过；② 流量日志被清（log 等同 cache，可随时清理）；
                        ③ 该轮不是本机发出的。真发一轮后再回来看即可对上。
                    </div>
                </div>
            );
        }
        const rec = t.record;
        const parsed = parseBodyMessages(rec);
        return (
            <div class="flex flex-col gap-1 p-1">
                <div class="flex flex-wrap items-center gap-2 px-1 text-body">
                    <span class="badge badge-xs font-mono">{fmtShortTime(new Date(rec.ts).toISOString())}</span>
                    <span
                        class="badge badge-xs"
                        classList={{
                            "badge-success": rec.status !== null && rec.status < 400,
                            "badge-error": rec.status === null || rec.status >= 400,
                        }}
                    >
                        {rec.status === null ? "无响应" : String(rec.status)}
                    </span>
                    <span class="font-mono opacity-70">{rec.model}</span>
                    <span class="opacity-60">{fmtBytes((rec.reqBytes ?? 0) + (rec.resBytes ?? 0))}</span>
                    <span class="opacity-60" title="同一个轮（turnId）在流量日志里的全部请求条数（含重试）">
                        {`该轮共 ${t.turnRecords} 条请求`}
                    </span>
                    <button class="btn btn-xs btn-primary ml-auto" onClick={() => openInTraffic(e, rec)}>
                        在流量页打开
                    </button>
                </div>
                <Show when={rec.log}>
                    <div class="rounded border border-base-300 bg-base-100 px-1 py-0.5">
                        <div class="flex items-center gap-1">
                            <span class="badge badge-xs badge-outline">落在</span>
                            <span class="select-all font-mono text-caption">{`${rec.log!.abs}:${rec.log!.line}`}</span>
                        </div>
                        <div class="text-caption opacity-60">
                            {`查找规则：目录 log/network/（相对 $DIY_HOME，按天切分，一天一个 YYYY-MM-DD.jsonl）；` +
                                `本任务是 grep '"taskUri":"${rec.taskUri ?? ""}"' 该文件，行号 = 文件内第几行；` +
                                `一轮多步 = 同一 turnId 多行（按 ts 升序 = 第 1/2/… 步），attempt 是「重试」序号、不是步序。` +
                                `变量树里的 reqlog 节点给模型的就是这套（自查用）。`}
                        </div>
                    </div>
                </Show>
                <Show when={parsed.note}>
                    <div class="px-1 text-caption text-warning">{parsed.note}</div>
                </Show>
                <Show when={parsed.msgs}>
                    {(list) => (
                        <div class="flex flex-col gap-1">
                            <For each={list()}>
                                {(m, i) => (
                                    <details class="rounded border border-base-300 bg-base-100" open={i() === 0}>
                                        <summary class="cursor-pointer px-2 py-1 text-body font-bold">
                                            {`${i() + 1}. ${m.role} · ${m.text.length} 字`}
                                        </summary>
                                        <pre class="max-h-72 overflow-auto whitespace-pre-wrap px-2 pb-1 font-mono text-body">
                                            {m.text}
                                        </pre>
                                    </details>
                                )}
                            </For>
                        </div>
                    )}
                </Show>
            </div>
        );
    };

    /** 归属徽章：按 attributionOf 的三态分别渲染（单元 / 跨单元容器 / 未投递） */
    const attrBadge = (path: string): JSX.Element => {
        // 划分还没加载完（`lab()` 未就绪）→ 既不能折行也不能算归属，先给个中间态，
        // 别用"空划分"算出的 `none` 谎报"未投递"（review RV-13 的同类闪烁）。
        if (unitMap().size === 0) {
            return (
                <span class="badge badge-xs badge-ghost opacity-40" title="划分加载中…">
                    …
                </span>
            );
        }
        const a = attrOf(path);
        if (a.kind === "unit") {
            return (
                <span
                    class="badge badge-xs font-mono"
                    classList={{
                        "badge-primary": a.container === "system",
                        "badge-ghost": a.container !== "system",
                    }}
                    title={`投递单元 ${a.place}（${a.container}）`}
                >
                    {a.place}
                </span>
            );
        }
        if (a.kind === "container") {
            // ⚠️ 统计表里此分支当前**不可达**：`foldStatRows` 已把"有后代上榜且自身非投递单元"的
            // 容器行折掉，而凡上榜的容器必有后代上榜（父 hash = 子树 hash）→ 走不到这里。
            // 保留作语义守卫：折叠规则一旦放宽（如允许保留高变化容器）它立即生效。
            return (
                <span
                    class="badge badge-xs badge-neutral"
                    title={`容器行：子字段分属 ${a.units.length} 个投递单元 —— ${a.units
                        .map((u) => `${u.place}(${u.container})`)
                        .join(", ")}`}
                >
                    {`跨 ${a.units.length} 单元`}
                </span>
            );
        }
        return (
            <span
                class="badge badge-xs badge-ghost opacity-60"
                title="未投递（不在 PLACE_CANDIDATES，也不是某个单元的祖先）"
            >
                未投递
            </span>
        );
    };

    /**
     * 变更统计（按项目累计）：每个节点变了几次 / 变化率 —— 判"该不该待在 system"的长期判据。
     * 点一行 → 选中该路径（与结构树选中同一套联动：请求预览滚到并高亮）。
     */
    const statsPane = () => {
        // RV-08：解析不出项目 → 明确空态，别永久停在"加载中…"
        const pid = projectFromUri(props.uri);
        if (!pid) return <div class="p-2 opacity-60">无法从任务 URI 解析出项目，统计不可用。</div>;
        const s = stats();
        if (!s) return <div class="p-2 opacity-60">统计加载中…</div>;
        // 行粒度（RV-03）：中间容器（有后代同时上榜）且自身**不是投递单元** → 折叠。
        // 容器的变化恒由后代解释（父 hash = 子树 hash），单列只会稀释"该不该待在 system"的判据。
        // 纯函数在 shared/context/attribution.ts（可与 UI 分开单测）。
        const { rows: keptPaths, collapsed } = foldStatRows(s.paths.map((x) => x.path), unitMap());
        const kept = new Set(keptPaths);
        const rows = s.paths.filter((x) => kept.has(x.path));
        return (
            <div class="p-1">
                <div class="mb-1 flex items-center gap-1 px-1 opacity-70">
                    <span>{`项目累计 · ${s.turns} 轮 · ${s.taskCount} 个任务`}</span>
                    <Show when={s.since}>
                        <span class="ml-auto" title={`${s.since} ~ ${s.until}`}>
                            {`${fmtShortTime(s.since)} ~ ${fmtShortTime(s.until)}`}
                        </span>
                    </Show>
                </div>
                {/* RV-09：归属列按**页面当前划分**（统计是"今天这把刀切哪"的操作视角），
                    与上面 sys 徽章"按当轮快照"的口径**有意不同** → 必须写出来，否则用户当成一套。 */}
                <div class="mb-1 px-1 text-caption opacity-50">
                    归属列与折叠均按当前划分（改划分即重算；历史轮次的原因看「变更历史（真发轮次）」的 sys 徽章，按当轮快照）
                </div>
                <Show when={collapsed > 0}>
                    <div class="mb-1 px-1 text-caption opacity-50">
                        {`已折叠 ${collapsed} 个中间容器（变化恒由后代解释；只留叶子与投递单元）`}
                    </div>
                </Show>
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
                            <For each={rows}>
                                {(p) => {
                                    return (
                                        <tr
                                            class={`cursor-pointer hover:bg-base-300/60 ${rowCls(selected() === p.path)}`}
                                            title={`变了 ${p.changes} 次 / 共 ${s.turns} 轮；最后变化 ${p.lastChanged ?? "—"}`}
                                            onClick={() => setSelected(p.path)}
                                        >
                                            <td class="font-mono">{p.path}</td>
                                            <td class="text-right font-mono">{p.changes}</td>
                                            <td class="text-right font-mono">{fmtRate(p.rate)}</td>
                                            <td>{attrBadge(p.path)}</td>
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
                {/* 变更历史：**表格**（轮次 | 步 | 实际请求），点一行选中该步 */}
                <View
                    k="history"
                    label="变更历史（真发轮次）"
                    extra={`本任务 · ${history()?.total ?? 0} 条记录 · ${changeCount()} 次变更`}
                    raw={() => JSON.stringify(history() ?? null, null, 2)}
                >
                    {historyPane()}
                </View>
                {/* 变更统计：按项目累计的长期视角（"用了几天变了几次"），是判断该不该待在 system 的判据 */}
                <View
                    k="stats"
                    label="变更统计（项目累计）"
                    extra={`项目累计 · ${stats()?.turns ?? 0} 轮 · ${stats()?.taskCount ?? 0} 个任务`}
                    raw={() => JSON.stringify(stats() ?? null, null, 2)}
                >
                    {statsPane()}
                </View>
                <View
                    k="structure"
                    label="结构树（变量契约）"
                    extra="含无值变量 · 类型与描述"
                    raw={() => JSON.stringify(structure(), null, 2)}
                >
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
                </View>
            </div>
        ),

        /**
         * 中：**真发投递的视角**（步级变量级 + 两侧全文行级 diff + 该步真发的那条请求）。
         * 「请求预览（实际发送格式）」已删（用户 2026-10-15：「现在有真实请求了，假的不要了」）——
         * 那份是**仿真**请求体；要真的看「该步实际请求」（流量日志）那一块。
         */
        "ctxlab.delivery": () => (
            <div class="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1 text-body">
                {/* 变量树变更：整棵变量树 + 把选中那条记录的变更标在命中节点上（步级 · 变量级） */}
                <View
                    k="vardiff"
                    label="变量树变更（整棵树 + 标注）"
                    extra={(() => {
                        const e = effectiveEntry();
                        return e ? `第 ${e.ref.step} 步 · ${e.changes.length} 处变更` : "没有带变化的记录";
                    })()}
                    raw={() =>
                        JSON.stringify({ 记录: effectiveEntry(), 当前变量树: lab()?.tree ?? null }, null, 2)
                    }
                >
                    {varDiffPane()}
                </View>
                {/* system 全文 diff（轮级 · 文本级）—— `<>` = 该步真发的 system 参数原文 */}
                <View
                    k="sysdiff"
                    label="system diff（逐行 · 真发全文）"
                    extra={(() => {
                        const d = diff();
                        if (!d) return "无真发记录";
                        const n = diffSize(d.systemDiff);
                        return n.add + n.del === 0 ? "无差异" : `+${n.add} / -${n.del} 行`;
                    })()}
                    raw={rawSystem}
                    rawInfo={rawSystemInfo()}
                >
                    {diffPane("system")}
                </View>
                {/* runtime 全文 diff —— `<>` = 该步**实际发出去的末条 user 消息**（runtime 变更告知原文） */}
                <View
                    k="rtdiff"
                    label="runtime diff（逐行 · 真发全文）"
                    extra={(() => {
                        const d = diff();
                        if (!d) return "无真发记录";
                        const n = diffSize(d.runtimeDiff);
                        return n.add + n.del === 0 ? "无差异" : `+${n.add} / -${n.del} 行`;
                    })()}
                    raw={rawRuntime}
                    rawInfo={rawRuntimeInfo()}
                >
                    {diffPane("runtime")}
                </View>
                {/* 该步实际请求：真发的那条 HTTP 请求（流量日志 = 地面真相）+ 一键跳流量页定位 */}
                <View
                    k="stepsess"
                    label="该步实际请求（真发 · 流量）"
                    extra={(() => {
                        const t = stepTraffic();
                        if (t === undefined) return "查询中…";
                        if (t === null) return "未找到";
                        return `${t.record.status ?? "无响应"} · 该轮 ${t.turnRecords} 条`;
                    })()}
                    raw={() => JSON.stringify(stepTraffic() ?? null, null, 2)}
                >
                    {stepSessionPane()}
                </View>
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
                    title="重新计算：当前上下文 + 变更历史 + 变更日志 diff + 变更统计（没有实时推送，改动要按一下）"
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
            {/* 流量抽屉：本页「变更历史」表格里的「查看实际请求」超链接弹它（与对话页报错后
                「查看实际请求 / 响应」是同一个抽屉、同一套定位语义） */}
            <TrafficDrawer />
        </div>
    );
}
