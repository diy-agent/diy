/**
 * CompactSessionPanel — 压缩会话上下文的**面板**（控制器 + 可嵌入内容）
 *
 * ⚠️ 语义：压缩 **≠** 清除。
 *   · 压缩：只改「发给模型的上下文」—— 按 `history.limit.limitTokens`（**token 上限**）保留历史 + 可选裁工具结果；
 *     **不删任何历史**，旧内容仍在会话日志里、可查、可撤销。
 *   · 清除（⋯ 菜单）：物理删除所有会话日志，不可恢复 —— 两回事，别混。
 *
 * 【M1】本文件**不再自带抽屉外壳**：`useCompactPanel(uri)` 管状态与副作用，
 *   `CompactPanelContent` 是可嵌入的纯内容（左参数 + 右预览），嵌进「窗口构成页」第一 tab；
 *   顶栏 / 执行按钮 / 关闭都归外层 drawer。`CompactHistoryPanel` 是独立的压缩历史弹窗。
 *
 * 内容布局：**左参数 + 右预览**，一眼对照。
 *   · 左栏 = 上限区（历史上限 token + 摘要开关 + 自动压缩口径）+ 费用对比图形
 *   · base = **未压缩**的全量投递（compactPreview 现算），mod = 按当前上限压完的投递
 *   · 右栏把两者渲染成 YAML 行、做行级 diff（增删变色、可折叠、可只看差异、可并排）
 */

import { createSignal, createResource, createEffect, on, For, Show, createMemo, type JSX } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import type { AutoCompactIssue } from "@diy/compact/compact-config";
import {
    DEFAULT_TOOL_RESULT_POLICY,
    flatPolicyOf,
    normalizePolicy,
    toolResultOf,
    type CompactPolicy,
    type FlatCompactPolicy,
    type ToolResultMode,
    type ToolResultPolicy,
} from "@diy/compact/compaction";
/** 触发理由的短文案（表里空间小；完整版在 TRIGGER_TEXT_FULL，提示条上用） */
function triggerText(t: string | undefined): string {
    switch (t) {
        case "systemContextChanged":
            return "系统上下文变";
        case "cacheExpired":
            return "缓存过期";
        case "contextWindowOver":
            return "窗口超限";
        default:
            return "手动";
    }
}

import {
    collapsedAtLevel,
    diffValues,
    foldLevelCount,
    subtreeChanges,
    visibleDiffRows,
    type YamlDiffRow,
} from "../../shared/yaml-lines";
import { clipForPreview, requestViewYaml, type LayerRow, type PreviewClipStats, type RequestView } from "../../shared/context/request-view";
import { DrawerMaxButton } from "@diy/ui-kit";
import { notificationStore } from "../store/notificationStore";
import {
    autoCompactSentence,
    compactResultSentence,
    compactWhenRows,
    fmtTokens,
    windowRatio,
    type CompactWhenInput,
} from "@diy/compact/compact-when";
import { EXAMPLE_MESSAGES, buildCompactExample, bytesToTokens, type ExampleRow } from "@diy/compact/compact-example";
import { normalizeHistoryLimit } from "@diy/compact/history-limit";

const INDENT = "  ";

/** 该折叠行子树内是否含变更（add/del/change 任意） */
const hasOwnChange = (c?: { add: number; del: number }): boolean => !!c && (c.add > 0 || c.del > 0);

/** 折叠框（VSCode 式：标题条整条可点，▾/▸ 指示）—— 与 TaskDetailContent 的 Block 同形 */
function Block(props: { title: string; children: JSX.Element; defaultOpen?: boolean; extra?: string }) {
    const [open, setOpen] = createSignal(props.defaultOpen !== false);
    return (
        <section class="border border-base-300 rounded-lg overflow-hidden min-w-0">
            <button
                class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-body font-bold tracking-wide opacity-80 hover:opacity-100"
                aria-expanded={open()}
                onClick={() => setOpen((v) => !v)}
            >
                <span>{open() ? "▾" : "▸"}</span>
                <span>{props.title}</span>
                <Show when={props.extra}>
                    <span class="ml-auto font-mono font-normal opacity-70">{props.extra}</span>
                </Show>
            </button>
            <Show when={open()}>
                <div class="p-2 min-w-0">{props.children}</div>
            </Show>
        </section>
    );
}

/**
 * 「压缩后估算」一行：压缩前 / 压缩后 / 预估节省。
 * 用层级符号（├/└，与「会话用量（累计）」同一套）表达「各行之和 = 合计」——
 * 合计行不加「（= 各层之和）」这类注释，层级关系用符号自明。
 */
/**
 * 费用对比（图形）：**当前 vs 压缩后**两条横条（宽度按 token 比例），
 * 下面一行「省 $X（−Y%）」。用 total 行（合计）—— 直观看省多少，不列各层明细。
 */
function CostCompare(props: { facts: LayerRow[] }) {
    const total = createMemo(() => props.facts.find((r) => r.key === "total"));
    const maxTok = () => Math.max(1, total()?.oldTokens ?? 0);
    const width = (t: number) => `${Math.max(0, Math.min(100, (t / maxTok()) * 100)).toFixed(1)}%`;
    const saved = () => {
        const t = total();
        return t ? t.oldCost - t.newCost : 0;
    };
    const savedPct = () => {
        const t = total();
        return t && t.oldTokens > 0 ? Math.round((1 - t.newTokens / t.oldTokens) * 100) : 0;
    };
    const money = (v: number) => `$${v.toFixed(4)}`;
    return (
        <Show when={total()} fallback={<div class="text-caption opacity-50">…</div>}>
            {(t) => (
                <div class="space-y-2 text-caption">
                    <div>
                        <div class="flex justify-between">
                            <span>当前</span>
                            <span class="tabular-nums opacity-80">
                                {t().oldTokens.toLocaleString()} tok · {money(t().oldCost)}
                            </span>
                        </div>
                        <div class="mt-0.5 h-3 rounded bg-base-200 overflow-hidden">
                            <div data-cost-bar class="h-full bg-base-content/35" style={{ width: width(t().oldTokens) }} />
                        </div>
                    </div>
                    <div>
                        <div class="flex justify-between">
                            <span>压缩后</span>
                            <span class="tabular-nums opacity-80">
                                {t().newTokens.toLocaleString()} tok · {money(t().newCost)}
                            </span>
                        </div>
                        <div class="mt-0.5 h-3 rounded bg-base-200 overflow-hidden">
                            <div data-cost-bar class="h-full bg-primary" style={{ width: width(t().newTokens) }} />
                        </div>
                    </div>
                    <div class="pt-1.5 border-t border-base-300">
                        <Show
                            when={saved() > 1e-9}
                            fallback={<span data-cost-saved class="opacity-60">无节省（上限未顶到 / 历史本来就不多）</span>}
                        >
                            <span data-cost-saved class="text-success font-semibold">
                                省 {money(saved())}（−{savedPct()}%）
                            </span>
                        </Show>
                    </div>
                </div>
            )}
        </Show>
    );
}
// ─── 面板控制器（状态与副作用；供抽屉 tab 栏与内容区共享）──────────────
//
// 【M1】原 CompactSessionPanel 自带抽屉外壳 + 遮罩 + 底栏；现移植进「窗口构成页」第一 tab，
// 外壳（标题 / 最大化 / 关闭 / 执行按钮）归外层 drawer ⇒ 这里只留**状态与预览逻辑**，
// 渲染交 `CompactPanelContent`。内容拆「预算区 / 参数区 / 预览区 / 费用图」四块
// （用户 2026-10-07 同意；参数区在 M3 补齐）。

/** 压缩预览模型（主进程 compactPreview 返回；base = 未压缩，mod = 当前预算） */
export interface CompactPreviewModel {
    before: { bytes: number };
    after: { bytes: number };
    keptTurns: number;
    droppedTurns: number;
    facts: LayerRow[];
    modRequest: RequestView;
    baseRequest: RequestView;
}

export interface CompactPanelCtl {
    /** 本面板服务哪个任务（统计 / 事件账要自己去取） */
    uri: () => string;
    auto: () => {
        config: {
            policy: unknown;
            history?: {
                /** ##442：只剩摘要模式（保留量固定 W×0.16，触发线零旋钮） */
                limit?: { summary?: { mode: "model" | "self" } };
            };
        };
        /**
         * 判定用的事实（实测）：`windowTokens` = 该会话最后一步实测 total；
         * `retainedTokens` = 上次投递出去的历史 ≈ token；`boundary` = 已落盘的压缩边界（null = 没压过）。
         */
        facts?: {
            windowTokens: number | null;
            windowLimitTokens?: number | null;
            retainedTokens?: number | null;
            boundary?: { at: string; dropped: number; limitTokens: number } | null;
            /** 本会话写过的压缩事件条数（turns.jsonl 的 compaction entry） */
            compactionCount?: number;
        };
        raw?: { path: string; text: string };
        /** 读配置的出声条目（##370）：非空 = 有键缺失/非法，已逐键回落缺省 */
        warnings?: AutoCompactIssue[];
    } | undefined;
    autoBusy: () => boolean;
    patchAuto: (patch: Record<string, unknown>) => Promise<void>;
    autoPolicy: () => CompactPolicy;
    /** ##442：保留量 = 窗口 × 0.16（只读展示；不再可调） */
    limitTokens: () => number;
    /** 兼容旧控件：保留量固定，写回无效 */
    commitLimitTokens: (n: number) => Promise<void>;
    /** `history.limit.summary.mode === "model"`（旧布尔控件的兼容读法） */
    limitSummary: () => boolean;
    /** 旧布尔控件：true ⇒ mode=model，false ⇒ mode=self */
    setLimitSummary: (v: boolean) => Promise<void>;
    /** ##442：摘要模式（model / self） */
    summaryMode: () => "model" | "self";
    setSummaryMode: (v: "model" | "self") => Promise<void>;
    pv: () => CompactPreviewModel | undefined;
    /** 预览在算（抽屉刚打开、大会话需数秒）—— 界面据此出 loading，而不是把空值当"零差异" */
    pvLoading: () => boolean;
    busy: () => boolean;
    err: () => string | null;
    /** 立即压缩：按当前预算压一次（历史保留、可撤销）。成功 toast。 */
    apply: () => Promise<void>;
    // ─── M3：策略参数读写（层级展示用）───
    /** `modeData.toolResult.render`（工具结果呈现） */
    render: () => ToolResultMode;
    setRender: (r: ToolResultMode) => void;
    /** headtail 私有参数（`renderData`）；非 headtail 时给当前/缺省值 */
    renderData: () => { head: number; tail: number; maxLineChars: number; maxKeepBytes: number };
    setRenderData: (patch: Partial<{ head: number; tail: number; maxLineChars: number; maxKeepBytes: number }>) => void;
    /** 与 mode 同级的 `summary`（预留字段） */
    summaryEnabled: () => boolean;
    setSummary: (v: boolean) => void;
    /** 配置真源 `auto-compact.yaml` 原始全文（只读视图用） */
    rawText: () => string;
    rawPath: () => string;
    // ─── ##370：读配置的出声（键缺/非法 ⇒ 已逐键回落缺省）───
    /** 出声条目（空 = 干净读入）。UI 必须显示「为什么」——否则用户只看到"我的配置没生效" */
    warnings: () => AutoCompactIssue[];
}

/**
 * 压缩面板控制器 —— 自动压缩配置（真源 `$DIY_HOME/auto-compact.yaml` 的 policy）+ 预览 + 执行。
 * 自动与手动**同一套策略**（用户 2026-10-07：「所有压缩都改为自动压缩策略……提供手工压缩执行的按钮」）。
 *
 * ⚠️ `visible` 是**成本闸门**（##321）：控制器由常挂组件（`WindowRing` → `ContextPartsDrawer`）持有，
 *   不设门槛时「打开任何会话页」都会立刻对整份 `ops.jsonl` 算一次压缩预案 —— 成本 ∝ 会话字节数
 *   （实测 78MB 会话 8~16s）、与「屏幕上显示多少」无关，且 main 单线程 ⇒ 期间所有 RPC 排队。
 *   真实语义：**只有「窗口构成」抽屉真的打开**才需要这份数据。
 */
export function useCompactPanel(uri: () => string, visible: () => boolean = () => true): CompactPanelCtl {
    const [auto, { refetch: refetchAuto }] = createResource(
        // 抽屉关着 → 连配置都不查（与预览同门槛：这份数据只服务抽屉）
        () => (visible() ? uri() : null),
        async (u) => {
            if (!u) return undefined;
            return (await localChatStore.autoCompactStatus(u)) as NonNullable<ReturnType<CompactPanelCtl["auto"]>>;
        },
    );
    const [autoBusy, setAutoBusy] = createSignal(false);
    const patchAuto = async (patch: Record<string, unknown>) => {
        setAutoBusy(true);
        try {
            await localChatStore.autoCompactSetConfig(patch, uri());
            await refetchAuto();
        } finally {
            setAutoBusy(false);
        }
    };

    const autoPolicy = (): CompactPolicy => normalizePolicy(auto()?.config.policy);
    // ─── ##442：保留量固定（窗口 × 0.16），配置只剩摘要模式 ───
    const historyLimit = () => normalizeHistoryLimit(auto()?.config.history?.limit);
    const summaryMode = (): "model" | "self" => historyLimit().summary.mode;
    const limitTokens = (): number => {
        const w = auto()?.facts?.windowLimitTokens;
        return typeof w === "number" && w > 0 ? Math.floor(w * 0.16) : 0;
    };
    const writeSummaryMode = async (mode: "model" | "self"): Promise<void> => {
        const hist = auto()?.config.history;
        await patchAuto({ history: { ...hist, limit: { summary: { mode } } } });
    };
    const commitLimitTokens = (_n: number): Promise<void> => Promise.resolve();
    const limitSummary = (): boolean => summaryMode() === "model";
    const setLimitSummary = (v: boolean): Promise<void> => writeSummaryMode(v ? "model" : "self");
    const setSummaryMode = (v: "model" | "self"): Promise<void> => writeSummaryMode(v);
    const patchAutoPolicy = (next: CompactPolicy) => patchAuto({ policy: next });
    const currentToolResult = () => toolResultOf(autoPolicy()) ?? DEFAULT_TOOL_RESULT_POLICY;
    /** headtail 私有参数（无 headtail 时回落到缺省 —— 切到 headtail 时用它初始化） */
    const headtailData = () => {
        const tr = currentToolResult();
        if (tr.render === "headtail") return tr.renderData;
        const d = DEFAULT_TOOL_RESULT_POLICY.render === "headtail" ? DEFAULT_TOOL_RESULT_POLICY.renderData : undefined;
        return d ?? { head: 3, tail: 3, maxLineChars: 300, maxKeepBytes: 8192 };
    };
    /** 写整个 toolResult 支（保住 summary） */
    const patchToolResult = (next: ToolResultPolicy) =>
        patchAutoPolicy({
            mode: "budget",
            modeData: { toolResult: next },
            summary: autoPolicy().summary,
        });
    const render = (): ToolResultMode => currentToolResult().render;
    const setRender = (r: ToolResultMode) =>
        patchToolResult(r === "headtail" ? { render: "headtail", renderData: headtailData() } : { render: r });
    const setRenderData = (patch: Partial<{ head: number; tail: number; maxLineChars: number; maxKeepBytes: number }>) =>
        patchToolResult({ render: "headtail", renderData: { ...headtailData(), ...patch } });
    const summaryEnabled = (): boolean => autoPolicy().summary;
    const setSummary = (v: boolean) => patchAutoPolicy({ ...autoPolicy(), summary: v });
    const rawText = (): string => auto()?.raw?.text ?? "";
    const rawPath = (): string => auto()?.raw?.path ?? "";
    /** 读配置的出声条目（##370）：**配置没生效时「为什么」就在这里**（不再只在应用日志里） */
    const warnings = (): AutoCompactIssue[] => auto()?.warnings ?? [];

    const [busy, setBusy] = createSignal(false);
    const [err, setErr] = createSignal<string | null>(null);

    /** 预览（只算不写）：预算变化即重算。base = 未压缩（compactPreview 现算），mod = 当前预算。
     *  闸门两道（##321）：
     *   ① `visible()` —— 抽屉关着就不算（这是「切页卡 main」的根因：本控制器由常挂组件持有）。
     *   ② `auto` 未落定 —— 等配置回来再算。否则会先按**缺省策略**白算一遍、等 auto 到了再按真策略
     *      算第二遍，同一份文件读两趟（大会话 = 2×8s；开抽屉的卡点反而翻倍）。
     *  source 返回**字符串键**（而非对象字面量）：`createResource` 的 source 是按值比较的 memo，
     *  只要返回新对象，依赖被重复求值（`auto.state` 与 `auto()` 分两拍更新）就会同键重算一遍。 */
    const pvKey = (): string | null => {
        if (!visible()) return null;
        if (auto.loading || auto.state === "unresolved") return null; // 配置未落定：别用缺省策略白算
        const u = uri();
        if (!u) return null;
        // ⚠️ 必须带上 `limitTokens`（##432 刀 2 的唯一旋钮）：预览算的是「按当前上限压完长什么样」，
        // 漏了它就会出现「改上限、预览纹丝不动」—— 正是 review 第 3 条要修的那个假象。
        // 编码：`<uri>\0<JSON>`，JSON 里同时装 policy / keep / limit —— **只能有一个分隔符**，
        // 多个分隔符会让下面的 `JSON.parse(第一个 \0 之后)` 撞上"JSON 后面还有内容"（实测红灯）。
        return u + "\u0000" + JSON.stringify({ policy: flatPolicyOf(autoPolicy()), limit: limitTokens() });
    };
    const [pv] = createResource(pvKey, (k) => {
        const i = k.indexOf("\u0000");
        const { policy } = JSON.parse(k.slice(i + 1)) as { policy: FlatCompactPolicy };
        return localChatStore.compactPreview(k.slice(0, i), policy) as Promise<CompactPreviewModel>;
    });

    /** 预览是否在算（见 CompactPanelCtl.pvLoading） */
    const pvLoading = (): boolean => pv.loading;

    /** 立即压缩：按当前上限压一次（历史保留、可撤销） */
    const apply = async () => {
        const u = uri();
        if (!u) return;
        setBusy(true);
        setErr(null);
        try {
            const rec = await localChatStore.compact(u, flatPolicyOf(autoPolicy()));
            if (rec?.noop) notificationStore.addToastLegacy("info", "无需压缩（历史已在上限内）");
            else notificationStore.addToastLegacy("success", "已压缩（历史保留、可撤销）");
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    };

    return {
        uri,
        auto, autoBusy, patchAuto, autoPolicy, limitTokens, commitLimitTokens, limitSummary, setLimitSummary, summaryMode, setSummaryMode,
        pv, pvLoading, busy, err, apply,
        render, setRender, renderData: headtailData, setRenderData, summaryEnabled, setSummary, rawText, rawPath,
        warnings,
    };
}

/**
 * 压缩面板内容（**可嵌入**）—— 左参数 + 右预览，一眼对照。
 *   · 左栏 = 预算区 + 费用图（费用对比图形：当前 vs 压缩后）
 *   · 右栏 = 预览区（请求结构 YAML 行级 diff：增删变色、可折叠、可只看差异、可并排）
 * 外壳（顶栏 / 底栏 / 遮罩）由外层「窗口构成页」提供；执行按钮在 tab 栏。
 */
/**
 * 分段按钮组（daisyUI `filter`）—— ##423 块 3：
 * 下拉/勾选框全换成**一次摊开**的按钮，每项 `title` 给一句人话解释（用户 2026-10-25：
 * 「不要做选豫框了，做成类似 daisyui filter 这样的选择按钮式，一次性显示出来，每个选项 hover 给出解释」）。
 *
 * 为什么是 radio 而不是 button + 自己管选中：`filter` 原生就是 radio 组（键盘方向键可切、
 * 屏幕阅读器读得出「N 选 1」）；写成 button 就得自己补一整套无障碍语义。
 * `data-filter-value` 是给测试与自检用的稳定钩子（与视觉无关）。
 */
function FilterGroup<T extends string>(props: {
    ariaLabel: string;
    name: string;
    value: T;
    options: readonly { value: T; label: string; hint: string }[];
    disabled?: boolean;
    /** 组容器的 data 钩子（意图测试按行取控件用：`[data-keep-type-select]` 等） */
    dataAttr?: string;
    onChange: (v: T) => void;
}) {
    return (
        <div class="filter flex-wrap" role="radiogroup" aria-label={props.ariaLabel} data-filter-group={props.dataAttr}>
            <For each={props.options}>
                {(o) => (
                    <input
                        type="radio"
                        class="btn btn-xs"
                        name={props.name}
                        aria-label={o.label}
                        title={`${o.label} —— ${o.hint}`}
                        data-filter-value={o.value}
                        disabled={props.disabled}
                        checked={props.value === o.value}
                        onChange={() => props.onChange(o.value)}
                    />
                )}
            </For>
        </div>
    );
}

/** 「取法」四选一（顺序 = 文本里给人的理解顺序，不是优先级） */
/**
 * 「**什么时候会压**」—— ##423 块 2。
 *
 * 用户原话（2026-10-25）：「我觉得我们缺少对什么时候会压缩…的 ui 呈现，我已经完全被搞懵了。」
 * 所以这里不摆旋钮，而是**把判据翻译成人话**：一判据一行 —— 开关状态 + 判据 + 当前实际值，
 * 句子全部来自 `shared/context/compact-when.ts`（可单测），组件只负责排版。
 *
 * ##432 刀 2 后判据换了（用户 2026-10-25 复查拍板）：**不是三触发器看旧预算，而是事件制** ——
 *   首次全量超上限 → 算一次并写压缩事件；之后只当**保留段自己**重新顶过上限才再压；
 *   其余每步按已落盘边界切、不重算；手动随时可压。
 * 旧三触发器已删（##442 零旋钮）；块尾只保留「到点就压」一句。
 */
function WhenCompactBlock(props: { ctl: CompactPanelCtl; windowLimit: number | null }) {
    const input = createMemo<CompactWhenInput>(() => {
        const cfg = props.ctl.auto()?.config;
        const facts = props.ctl.auto()?.facts;
        return {
            limitTokens: props.ctl.limitTokens(),
            boundary: facts?.boundary ?? null,
            retainedTokens: typeof facts?.retainedTokens === "number" ? facts.retainedTokens : null,
            lastStepTokens: facts?.windowTokens ?? null,
            windowLimit: props.windowLimit,
        };
    });
    const ratio = () => windowRatio(input().lastStepTokens, input().windowLimit);
    return (
        <Block title="什么时候会压" extra="自动压缩：到点就压">
            <div class="space-y-1 text-caption" data-when-compact>
                <For each={compactWhenRows(input())}>
                    {(r) => (
                        <div class="flex items-start gap-1" data-when-row={r.key}>
                            <span
                                class={`badge badge-xs shrink-0 ${r.state === "on" ? "badge-success" : r.state === "off" ? "badge-ghost opacity-50" : "badge-info"}`}
                            >
                                {r.state === "on" ? "开" : r.state === "off" ? "关" : "手动"}
                            </span>
                            <span class="w-24 shrink-0 tabular-nums" title={r.hint}>
                                {r.label}
                            </span>
                            <span class="min-w-0 break-words opacity-80" title={r.hint}>
                                {r.text}
                            </span>
                        </div>
                    )}
                </For>
                <div class="border-t border-base-300 pt-1 opacity-70" data-when-result title={compactResultSentence(input().limitTokens)}>
                    <span class="font-semibold">压成什么样：</span> {compactResultSentence(input().limitTokens)}
                </div>
                {/* 自动压缩与投递的关系：划清界线 */}
                <div class="opacity-45" data-when-audit title={autoCompactSentence()}>
                    {autoCompactSentence()}
                </div>
                <div class="opacity-45">
                    每一行 hover 看判据。窗口占用{ratio() == null ? "需有实测用量与模型窗口上限" : ` = ${ratio()}%`}
                    （本会话最后一步 {input().lastStepTokens == null ? "无实测" : fmtTokens(input().lastStepTokens!)}，
                    与保留量 {fmtTokens(input().limitTokens)}（窗口 × 0.16）**不是同一个数**）。
                </div>
            </div>
        </Block>
    );
}

/** 一条消息的角色色点（左灰 = 原始，右绿 = 压缩后保留） */
const KIND_TONE: Record<ExampleRow["kind"], string> = {
    user: "text-secondary",
    text: "text-base-content",
    call: "text-info",
    result: "text-warning",
};

/**
 * 「压缩后长什么样」—— ##423 块 3 的**范例预览**。
 *
 * 用户原话：「能否用一些可视化的手段表达清晰，人类可理解，比如生成一个范例消息，
 * 标注其模拟的 token size，然后达到压缩后，右边呈现出压缩的新消息 history 形态。」
 *
 * 左 = 原始投递（每条带**模拟** token 尺寸），右 = 按**当前上限**压完的实际形态（丢掉的整条不在）。
 * 样例固定（`shared/context/compact-example.ts`），改上限 → 两边对比立刻变 —— 这就是「看得懂」。
 * 尺寸口径：`shared/context/compact-example.ts::bytesToTokens`（3 字节 ≈ 1 token —— 样例正文是中文，
 * 与压缩走的 `estimateTokensOf` 同口径；不是精确 meter）。
 */
function ExamplePreviewBlock(props: { limitTokens: number }) {
    const ex = createMemo(() => buildCompactExample(props.limitTokens));
    const beforeTok = () => bytesToTokens(ex().beforeBytes);
    const afterTok = () => bytesToTokens(ex().keptBytes);
    const savedPct = () =>
        ex().beforeBytes === 0 ? 0 : Math.round(((ex().beforeBytes - ex().keptBytes) / ex().beforeBytes) * 100);
    const row = (r: ExampleRow, kept: boolean) => (
        <div
            class={`flex items-start gap-1 ${kept ? "" : "opacity-40"}`}
            data-example-msg={r.id}
            data-example-kept={kept ? "1" : "0"}
            title={r.why}
        >
            <span class="w-6 shrink-0 font-mono text-caption opacity-60">{r.turn}</span>
            <span class={`w-10 shrink-0 text-caption ${KIND_TONE[r.kind]} ${kept ? "" : "line-through"}`}>{r.kind}</span>
            <span class={`min-w-0 flex-1 truncate text-caption ${kept ? "" : "line-through"}`}>{r.label}</span>
            <span class="w-14 shrink-0 text-right text-caption tabular-nums opacity-70">{r.tokens} tok</span>
        </div>
    );
    return (
        <Block title="范例预览（合成样例）" extra={`${EXAMPLE_MESSAGES.length} 条 · ${beforeTok()} tok`}>
            <div class="space-y-1" data-example>
                <div class="text-caption opacity-60">
                    固定样例（每条标的是**模拟** token 尺寸，3 字节 ≈ 1 token —— 样例正文是中文，与真压的
                    CJK 粗估同口径）；按当前上限 {props.limitTokens} token 推演：
                    右侧出现的才会进本次请求，被划掉的仍在历史里（可查可撤销）。
                </div>
                <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <div class="rounded border border-base-300 p-1" data-example-before>
                        <div class="mb-1 text-caption font-semibold opacity-70">原始投递（{beforeTok()} tok）</div>
                        <For each={ex().rows}>{(r) => row(r, true)}</For>
                    </div>
                    <div class="rounded border border-base-300 p-1" data-example-after>
                        <div class="mb-1 text-caption font-semibold opacity-70">
                            压缩后 history（{afterTok()} tok / 减 {savedPct()}% / 丢 {ex().dropped} 条）
                        </div>
                        <For each={ex().rows.filter((r) => r.kept)}>{(r) => row(r, false)}</For>
                        <div class="mt-1 border-t border-base-300 pt-1 text-caption opacity-60">
                            保头 = 硬编码 600 tok（首个 user / 任务目标，永不丢）
                            {ex().biggestDrop ? ` · 最大一块被丢的是 ${ex().biggestDrop!.kind}（${ex().biggestDrop!.tokens} tok）` : ""}
                        </div>
                    </div>
                </div>
            </div>
        </Block>
    );
}

export function CompactPanelContent(props: { ctl: CompactPanelCtl }) {
    const ctl = props.ctl;

    /** 左栏视图：UI 表单 ⇄ 原始 YAML（同 VSCode settings 的 UI/JSON 切换；用户 2026-10-07） */
    const [panelView, setPanelView] = createSignal<"form" | "yaml">("form");
    /** ##406：预览裁剪阈值（单条字符串 / 数组元素）—— 只影响展示副本 */
    const PREVIEW_CLIP = { maxChars: 4000, maxItems: 200 } as const;

    // ─── ##423 块 2：本会话的**计数**（此前哪里都看不到）───
    // 投递次数 = 步数（每步一次请求）；压缩次数 = 账本里 compact 事件的条数（measure/undo 不算）。
    // 账本与「历史」弹窗/用量分表同源（`compact.events`），不另存一份。
    const [compactEvts] = createResource(
        () => ctl.uri(),
        // 账本接口是**分页形态**（`{ events, truncated, size, from }`），这里只要事件数组
        async (u) => (u ? ((await localChatStore.compactEvents(u)).events as CompactEventRow[]) : []),
    );
    const compactRows = () => (compactEvts() ?? []).filter((e) => e.kind === "compact");
    const deliveries = () => localChatStore.usage.length;
    const turnCount = () => new Set(localChatStore.usage.map((r) => r.turnId)).size;
    /**
     * **压缩事件次数**（真源 = `turns.jsonl` 的 compaction entry，由 main 数）——
     * ##432 后它才是「压过几次」；`compact.jsonl`（`compactRows()`）降为**纯审计**，两数分开叫。
     */
    const compactionCount = (): number => ctl.auto()?.facts?.compactionCount ?? 0;
    /** 已落盘边界（最近一次压缩事件） */
    const boundary = () => ctl.auto()?.facts?.boundary ?? null;
    /** 窗口上限：取**最后一条**用量记录里的 `contextLimit`（用户要知道「上限 Y」是多少） */
    const windowLimit = (): number | null => {
        const u = localChatStore.usage;
        const last = u[u.length - 1];
        return typeof last?.contextLimit === "number" && last.contextLimit > 0 ? last.contextLimit : null;
    };

    /** headtail 私有参数的字段表（渲染顺序 + 文案一处定义） */
    const RENDER_DATA_FIELDS: { key: "head" | "tail" | "maxLineChars" | "maxKeepBytes"; hint: string }[] = [
        { key: "head", hint: "保留头部行数" },
        { key: "tail", hint: "保留尾部行数" },
        { key: "maxLineChars", hint: "单行超长截断阈值（字符）" },
        { key: "maxKeepBytes", hint: "保留总量兜底（字节）" },
    ];

    // 右栏视图控制
    /** diff 闸（##406）：**缺省关闭**。
     *  用户原话：「直接把里面的 diff 页面禁用掉，它的加载机理有问题，导致进不去，暂时不修了，就禁用掉」
     *  —— 裁剪 + 缺省 2 层已经把「进不去」修好了（本 PR 刀 1），但那是**推出来**的边界；
     *  先让人能进页面、按需再开，比「赌它够小」稳。开了才计算、才渲染。 */
    const [diffEnabled, setDiffEnabled] = createSignal(false);
    const [sideBySide, setSideBySide] = createSignal(false);
    const [onlyDiff, setOnlyDiff] = createSignal(true);
    /** 展开层级：0 = 只露根行；N = 全展开。
     *  **缺省 2**（##406）：原来是 `MAX_SAFE_INTEGER`（全展开）—— 对一次 4.95 MB 的请求
     *  等于把数万行一次性铺成 DOM，渲染进程直接卡死（用户报「一进去就卡住」）。
     *  2 层足够看清「哪个键变了」，要看细节点「展开」。 */
    const [expandLevel, setExpandLevel] = createSignal(2);

    /** 展示预算（##406）：裁剪只做一次，diff 与「已裁剪多少」都读它 ——
     *  否则同一份 4.95 MB 请求会被递归走两遍（纯浪费时间）。 */
    const previewPair = createMemo(() => {
        if (!diffEnabled()) return null;
        const m = ctl.pv();
        if (!m) return null;
        const base = clipForPreview(requestViewYaml(m.baseRequest), PREVIEW_CLIP);
        const mod = clipForPreview(requestViewYaml(m.modRequest), PREVIEW_CLIP);
        return { base, mod };
    });

    // 两级 diff：以两个请求**对象**做节点级对齐（base = 未压缩，mod = 当前预算）
    const rows = createMemo<YamlDiffRow[]>(() => {
        const p = previewPair();
        if (!p) return [];
        // diff 与渲染都必须在**有界**的副本上做 —— 否则大会话（>MB 级）会把
        // 「数万行 diff + 数万个 DOM 节点」一次性压上来，页面卡死。真发内容不受影响。
        return diffValues(p.base.value, p.mod.value);
    });

    /** 预览裁剪统计（顶部报「已裁剪多少」，让人知道看不到的部分存在） */
    const clipStats = createMemo<PreviewClipStats>(() => {
        const p = previewPair();
        if (!p) return { droppedChars: 0, droppedItems: 0 };
        return {
            droppedChars: p.base.stats.droppedChars + p.mod.stats.droppedChars,
            droppedItems: p.base.stats.droppedItems + p.mod.stats.droppedItems,
        };
    });

    const foldLevels = createMemo(() => foldLevelCount(rows()));
    const curLevel = createMemo(() => Math.min(expandLevel(), foldLevels()));
    const nextLevel = () => {
        const n = foldLevels();
        setExpandLevel((v) => (Math.min(v, n) >= n ? 0 : Math.min(v, n) + 1));
    };

    /** 手动折叠覆盖 */
    const [manual, setManual] = createSignal<{ level: number; collapsed: Set<number> }>({ level: -1, collapsed: new Set() });
    const toggleFold = (i: number) => {
        const cur = new Set(collapsed());
        if (cur.has(i)) cur.delete(i);
        else cur.add(i);
        setManual({ level: curLevel(), collapsed: cur });
    };
    createEffect(on(curLevel, () => setManual({ level: -1, collapsed: new Set() }), { defer: true }));

    const collapsed = createMemo<Set<number>>(() => {
        const lv = curLevel();
        const m = manual();
        return m.level === lv ? m.collapsed : collapsedAtLevel(rows(), lv);
    });
    const changes = createMemo(() => subtreeChanges(rows()));
    const shownIndexes = createMemo(() => visibleDiffRows(rows(), collapsed()));
    const rowCache = new Map<number, { i: number; row: YamlDiffRow }>();
    const CONTEXT_LINES = 3;
    const renderRows = createMemo(() => {
        const idx = shownIndexes();
        const all = rows();
        const ch = changes();
        const keep = new Set<number>();
        if (onlyDiff()) {
            idx.forEach((ri, pos) => {
                const row = all[ri]!;
                if (row.t !== "same" || (row.foldable && hasOwnChange(ch.get(ri)))) keep.add(pos);
            });
            idx.forEach((ri, pos) => {
                if (all[ri]!.t === "same") return;
                for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) {
                    const q = pos + d;
                    if (q >= 0 && q < idx.length) keep.add(q);
                }
            });
        }
        return idx
            .map((i, pos) => ({ i, pos }))
            .filter(({ pos }) => !onlyDiff() || keep.has(pos))
            .map(({ i }) => {
                const row = all[i]!;
                const cached = rowCache.get(i);
                if (cached && cached.row === row) return cached;
                const obj = { i, row };
                rowCache.set(i, obj);
                return obj;
            });
    });

    /**
     * 字节 → token：**用 `bytesToTokens`（3 字节 ≈ 1 token）**，不要在这里写 `bytes / 4`。
     * 旧口径（÷4）把中文低估约 1/3 —— 面板说「压缩后 8k tok」、真发却是 12k，正是用户被搞懵的原因之一。
     */
    const estTok = (bytes: number) => bytesToTokens(bytes);
    /** 历史上限人读（token —— 唯一旋钮） */
    const limitLabel = (): string => `${ctl.limitTokens().toLocaleString()} token`;
    /**
     * 压缩后**整份请求**的规模（token）—— 含固定开支（system + 工具定义 + runtime）+ 上限内历史。
     * 用费用表 total 行的 token（= 各层之和，含 system / tools），**不再转回 KB**：
     * 历史口径是 token，给人看的数也得是 token，否则两个数域摆在一起又要换算。
     */
    const afterTokens = (): string => {
        const t = (ctl.pv()?.facts ?? []).find((r) => r.key === "total");
        return `${Math.round(t?.newTokens ?? 0).toLocaleString()} tok`;
    };
    const ratio = () => {
        const b = ctl.pv()?.before.bytes ?? 0;
        const a = ctl.pv()?.after.bytes ?? 0;
        return b > 0 ? Math.round((1 - a / b) * 100) : 0;
    };
    const diffCounts = createMemo(() => {
        let add = 0;
        let del = 0;
        for (const r of rows()) {
            if (r.t === "add") add++;
            else if (r.t === "del") del++;
            else if (r.t === "change") {
                add++;
                del++;
            }
        }
        return { add, del };
    });

    return (
        <div class="flex h-full min-h-0 w-full">
            {/* ── 左栏：视图切换（参数 / 原始 YAML）+ 参数区 + 费用图 ── */}
            <div class="w-[340px] shrink-0 overflow-auto border-r p-2 space-y-2">
                <div class="join w-full" role="group" aria-label="压缩配置视图">
                    <button
                        class={"btn btn-xs join-item flex-1 " + (panelView() === "form" ? "btn-active" : "btn-ghost")}
                        aria-pressed={panelView() === "form"}
                        onClick={() => setPanelView("form")}
                    >
                        参数
                    </button>
                    <button
                        class={"btn btn-xs join-item flex-1 " + (panelView() === "yaml" ? "btn-active" : "btn-ghost")}
                        aria-pressed={panelView() === "yaml"}
                        onClick={() => setPanelView("yaml")}
                    >
                        原始 YAML
                    </button>
                </div>

                {/* ##370 出声：配置里有键缺失/非法 ⇒ 已逐键回落缺省。
                    没有这一块，用户只看到「我的配置没生效」，而原因只在应用日志里。 */}
                <Show when={ctl.warnings().length > 0}>
                    <div data-compact-warnings class="rounded-lg border border-warning/60 bg-warning/10 p-2 text-caption space-y-1">
                        <div class="font-semibold">⚠ 配置有 {ctl.warnings().length} 处出声（已逐键回落缺省）</div>
                        <ul class="m-0 list-disc pl-4 space-y-0.5">
                            <For each={ctl.warnings()}>{(w) => <li>{w.message}</li>}</For>
                        </ul>
                    </div>
                </Show>

                <Show
                    when={panelView() === "form"}
                    fallback={
                        <div class="rounded-lg border border-base-300">
                            <div class="border-b border-base-300 px-2 py-1 text-caption opacity-60 break-all" title={ctl.rawPath()}>
                                真源 {ctl.rawPath() || "auto-compact.yaml"}（只读）
                            </div>
                            <pre
                                data-compact-raw
                                class="m-0 max-h-[70vh] overflow-auto p-2 text-caption font-mono leading-[1.5] whitespace-pre-wrap break-all"
                            >{ctl.rawText() || "（尚未生成；改动参数后即落盘）"}</pre>
                        </div>
                    }
                >
                    {/* 预算区：##442 删了 off/notify/auto 三态 —— 自动压缩**到点就压**，
                        这里只说明口径，不再摆模式开关。 */}
                    <div class="rounded-lg border border-base-300 p-3 space-y-2">
                        <div class="space-y-1" data-compact-mode>
                            <span class="text-body font-semibold">自动压缩</span>
                            <div class="text-caption opacity-70">
                                到点就压（窗口占用 ≥ 窗口 − max(10%, 16k)），不再有 off / notify / auto 三态；
                                旧触发器（系统上下文变 / 缓存过期）已删。
                            </div>
                        </div>
                        <div class="text-caption opacity-70">
                            <Show when={!ctl.pvLoading()} fallback={<span class="opacity-60">正在计算预览…</span>}>
                                当前 {estTok(ctl.pv()?.before.bytes ?? 0).toLocaleString()} tok → 压缩后{" "}
                                {estTok(ctl.pv()?.after.bytes ?? 0).toLocaleString()} tok{" "}
                                <span class="text-success">(-{ratio()}%)</span>
                                <span class="opacity-60">　删 {diffCounts().del} / 增 {diffCounts().add} 行</span>
                            </Show>
                        </div>
                        <div class="text-caption opacity-70">
                            历史上限 <b>{limitLabel()}</b> · 整份请求 ≈ <b>{afterTokens()}</b>
                        </div>
                        {/* ##423 块 2：本会话计数 + 最近一次压缩的前后对比（此前哪里都看不到这两个数） */}
                        <div class="text-caption opacity-70" data-compact-stats>
                            本会话：<b class="tabular-nums">{deliveries()}</b> 次投递（= 步数）· <b class="tabular-nums">{turnCount()}</b> 轮 ·
                            压缩<b class="tabular-nums">{compactionCount()}</b> 次（事件，写边界）
                            <span class="opacity-60">
                                　另有审计 {compactRows().length} 条（手动/自动各次的 compact.jsonl 记录）
                            </span>
                            <Show when={boundary()}>
                                {(b) => (
                                    <span class="block opacity-80" data-compact-last>
                                        最近一次事件：{new Date(b().at).toLocaleString()} · 丢 {b().dropped} 条 · 当时上限{" "}
                                        {fmtTokens(b().limitTokens)}（现在 {fmtTokens(ctl.limitTokens())}）
                                    </span>
                                )}
                            </Show>
                            <Show when={compactRows().at(-1)}>
                                {(e) => (
                                    <span class="block opacity-60" data-compact-last-audit>
                                        最近一条审计：轮 {e().size?.before?.turns ?? "—"} → {e().size?.after?.turns ?? "—"} · 条{" "}
                                        {e().size?.before?.messages ?? "—"} → {e().size?.after?.messages ?? "—"} · 字节{" "}
                                        {fmtBytes(e().size?.before?.bytes)} → {fmtBytes(e().size?.after?.bytes)}
                                    </span>
                                )}
                            </Show>
                        </div>
                        <div class="text-caption opacity-45">
                            历史只按一条上限切：从最后一步往前累加装到上限的一半为止，保头 600 token 硬编码、切点 tool 配对平衡；
                            边界只在压缩事件时算一次（之后每步只追加不重算）。
                        </div>
                        <Show when={ctl.err()}>
                            <div class="text-caption text-error">{ctl.err()}</div>
                        </Show>
                    </div>

                    {/* ##423 块 2：什么时候会压（判据 + 当前值）；块 3：压缩后长什么样（范例预览） */}
                    <WhenCompactBlock ctl={ctl} windowLimit={windowLimit()} />
                    {/* 纯展示：保留量取真实窗口 × 0.16，但不超过样例总量的一半（否则总是「一条不丢」） */}
                    <ExamplePreviewBlock limitTokens={Math.min(12_000, ctl.limitTokens() || 12_000)} />

                    {/* ##432 刀 2：**历史投递的唯一旋钮** —— 一条 token 上限。
                        旧 `budgetBytes` / `history.keep[]` 已不决定投递（review 第 1 条：不许并列两个旋钮） */}
                    <Block title="历史保留" extra="固定 W × 0.16（不可调）">
                        <div class="space-y-2 text-caption" data-history-limit>
                            <div class="flex items-center gap-2">
                                <span class="font-mono opacity-50">保留量</span>
                                <span class="font-semibold">{ctl.limitTokens().toLocaleString()} token</span>
                                <span class="opacity-60">= 窗口 × 0.16（窗口未知 ⇒ 0）</span>
                            </div>
                            <div class="opacity-50">
                                触发线 = 窗口 − max(10% 窗口, 16k)；窗口未知 ⇒ 不压。从最后一条往前累加装够保留量，
                                切点往前挪到最近的 <b>user 消息</b>（call/result 因此永不拆开）；压完仍超触发线 ⇒ 不压。
                                没有保头、没有事后配平、没有绝对 token 上限；边界只在压缩事件时算一次并落盘。
                            </div>
                            <label class="flex items-center gap-2 opacity-80">
                                <span class="font-mono">summary.mode</span>
                                <select
                                    class="select select-xs"
                                    value={ctl.summaryMode()}
                                    disabled={ctl.autoBusy()}
                                    onChange={(e) => void ctl.setSummaryMode(e.currentTarget.value as "model" | "self")}
                                >
                                    <option value="model">model（压缩时生成摘要）</option>
                                    <option value="self">self（只给 source，让模型自己查）</option>
                                </select>
                            </label>
                            <div class="border-t border-base-300 pt-2 opacity-70" data-mode-off-note>
                                <span class="font-semibold">手动压缩无限制：</span>
                                点「压缩」无视触发线与内容大小，至少丢一步；用来测试压缩链路。
                            </div>
                        </div>
                    </Block>

                    {/* 策略参数：**只剩工具结果呈现**（历史上限在上面的块里） */}
                    <Block title="工具结果呈现" extra="策略真源（仍生效）">
                        <div class="space-y-2 text-caption">
                            <div class="space-y-2 border-l-2 border-base-300 pl-2">
                                <div class="font-mono opacity-50">modeData</div>
                                <div class="space-y-2 border-l-2 border-base-300 pl-2">
                                    <div class="font-mono opacity-50">toolResult（全局裁法）</div>
                                    <div class="flex flex-wrap items-center gap-2">
                                        <span class="font-mono opacity-70">render</span>
                                        <div data-render-select>
                                            <FilterGroup
                                                ariaLabel="工具结果呈现"
                                                name="tool-render"
                                                value={ctl.render()}
                                                options={[
                                                    { value: "asis", label: "原样", hint: "工具结果一字不改（最完整，也最占历史上限）" },
                                                    { value: "headtail", label: "头尾裁剪", hint: "保留头几行 + 尾几行，中间省略；单行超长另按字符阈裁" },
                                                    { value: "callpath", label: "只留调用", hint: "只留「调了什么」+ 原文落盘路径，不正文 —— 大输出最省" },
                                                ]}
                                                disabled={ctl.autoBusy()}
                                                onChange={(v) => ctl.setRender(v)}
                                            />
                                        </div>
                                    </div>
                                    <Show when={ctl.render() === "headtail"}>
                                        <div class="space-y-1 border-l-2 border-base-300 pl-2">
                                            <div class="font-mono opacity-50">renderData</div>
                                            <For each={RENDER_DATA_FIELDS}>
                                                {(f) => (
                                                    <div class="flex items-center gap-2">
                                                        <span class="w-28 shrink-0 truncate font-mono opacity-70" title={f.hint}>
                                                            {f.key}
                                                        </span>
                                                        <input
                                                            type="number"
                                                            class="input input-xs w-20"
                                                            aria-label={f.key}
                                                            min="0"
                                                            value={ctl.renderData()[f.key]}
                                                            disabled={ctl.autoBusy()}
                                                            onChange={(e) => ctl.setRenderData({ [f.key]: Number(e.currentTarget.value) })}
                                                        />
                                                        <span class="truncate opacity-40" title={f.hint}>{f.hint}</span>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </div>
                            </div>
                            <div class="flex flex-wrap items-center gap-2 border-t border-base-300 pt-2">
                                <span class="font-mono opacity-60">summary</span>
                                <div data-summary-select>
                                    <FilterGroup
                                        ariaLabel="历史摘要"
                                        name="tool-summary"
                                        value={ctl.summaryEnabled() ? "on" : "off"}
                                        options={[
                                            { value: "off", label: "关", hint: "不额外计算历史摘要（缺省）" },
                                            { value: "on", label: "开", hint: "额外算一份历史摘要（预留字段，当前未启用）" },
                                        ]}
                                        disabled={ctl.autoBusy()}
                                        onChange={(v) => ctl.setSummary(v === "on")}
                                    />
                                </div>
                                <span class="opacity-45">额外算历史摘要（预留，暂未启用）</span>
                            </div>
                        </div>
                    </Block>
                    <Block title="费用对比">
                        <CostCompare facts={ctl.pv()?.facts ?? []} />
                        <div class="mt-2 text-caption opacity-60">
                            金额 = token ÷ 1M × 当前模型非缓存单价；token 按字节 / 4 估算（仅为对比，不进计费）。
                        </div>
                    </Block>
                </Show>
            </div>

            {/* ── 右栏：预览区（请求 YAML diff）─────────────── */}
            <div class="grow flex flex-col overflow-hidden">
                <Show
                    when={diffEnabled()}
                    fallback={
                        <div class="p-6 flex flex-col gap-3 text-caption">
                            <div class="opacity-70">
                                差异视图缺省关闭（##406）：大请求的 diff 计算与渲染曾把页面卡死。先保证页面能进，再按需开。
                            </div>
                            <button class="btn btn-xs btn-outline self-start" onClick={() => setDiffEnabled(true)}>
                                计算并显示 diff（大会话可能要等数秒）
                            </button>
                        </div>
                    }
                >
                <div class="px-3 py-1.5 border-b flex items-center gap-3 shrink-0 text-caption">
                    <div class="join">
                        <button
                            class={"btn btn-xs join-item " + (!sideBySide() ? "btn-active" : "btn-ghost")}
                            onClick={() => setSideBySide(false)}
                        >
                            统一 diff
                        </button>
                        <button
                            class={"btn btn-xs join-item " + (sideBySide() ? "btn-active" : "btn-ghost")}
                            onClick={() => setSideBySide(true)}
                        >
                            并排
                        </button>
                    </div>
                    <label class="flex items-center gap-1 cursor-pointer">
                        <input
                            type="checkbox"
                            class="toggle toggle-xs"
                            aria-label="只看差异"
                            checked={onlyDiff()}
                            onChange={(e) => setOnlyDiff(e.currentTarget.checked)}
                        />
                        只看差异
                    </label>
                    <button class="btn btn-ghost btn-xs" aria-label="逐级展开" onClick={nextLevel}>
                        展开 {curLevel()}/{foldLevels()}
                    </button>
                    {/* ##406：预览是有界的副本 —— 裁掉了多少必须说出来，否则「看不到」会被误当成「没有」 */}
                    <Show when={clipStats().droppedChars > 0 || clipStats().droppedItems > 0}>
                        <span
                            class="badge badge-ghost badge-xs"
                            title="长文本 / 大数组在预览里只留头尾（真发内容不受影响）。要看原文请到流量日志。"
                        >
                            预览已裁剪 {clipStats().droppedChars.toLocaleString()} 字符 / {clipStats().droppedItems.toLocaleString()} 项
                        </span>
                    </Show>
                    <span class="opacity-50 ml-auto">请求结构 YAML（base vs mod）</span>
                </div>

                <div class="overflow-auto grow p-2 text-caption font-mono leading-[1.5]" data-compact-preview>
                    <Show
                        when={!sideBySide()}
                        fallback={
                            <table class="w-full border-collapse">
                                <tbody>
                                    <For each={renderRows()}>
                                        {({ i, row }) => (
                                            <tr
                                                class={
                                                    row.t === "add"
                                                        ? "bg-success/10"
                                                        : row.t === "del" || row.t === "change"
                                                          ? "bg-error/10"
                                                          : ""
                                                }
                                            >
                                                <td class="align-top whitespace-pre-wrap break-all w-1/2 pr-2 border-r border-base-300">
                                                    <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                                    <span class={row.t === "del" || row.t === "change" ? "text-error" : ""}>
                                                        {row.left ? INDENT.repeat(row.left.indent) + row.left.text : ""}
                                                    </span>
                                                    <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                                </td>
                                                <td class="align-top whitespace-pre-wrap break-all pl-2">
                                                    <span class={row.t === "add" || row.t === "change" ? "text-success" : ""}>
                                                        {row.right ? INDENT.repeat(row.right.indent) + row.right.text : ""}
                                                    </span>
                                                </td>
                                            </tr>
                                        )}
                                    </For>
                                </tbody>
                            </table>
                        }
                    >
                        <For each={renderRows()}>
                            {({ i, row }) => (
                                <Show
                                    when={row.t !== "change"}
                                    fallback={
                                        <>
                                            <div data-diff="del" class="bg-error/10 text-error">
                                                <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                                <span class="opacity-40 select-none">- </span>
                                                <span class="whitespace-pre-wrap break-all">
                                                    {INDENT.repeat(row.left?.indent ?? row.indent) + (row.left?.text ?? "")}
                                                </span>
                                                <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                            </div>
                                            <div data-diff="add" class="bg-success/10 text-success">
                                                <span class="inline-block w-3" />
                                                <span class="opacity-40 select-none">+ </span>
                                                <span class="whitespace-pre-wrap break-all">
                                                    {INDENT.repeat(row.right?.indent ?? row.indent) + (row.right?.text ?? "")}
                                                </span>
                                            </div>
                                        </>
                                    }
                                >
                                    <div
                                        data-diff={row.t}
                                        class={
                                            row.t === "add"
                                                ? "bg-success/10 text-success"
                                                : row.t === "del"
                                                  ? "bg-error/10 text-error"
                                                  : ""
                                        }
                                    >
                                        <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                        <span class="opacity-40 select-none">{row.t === "add" ? "+" : row.t === "del" ? "-" : " "} </span>
                                        <span class="whitespace-pre-wrap break-all">
                                            {INDENT.repeat(row.indent) + (row.right?.text ?? row.left?.text ?? "")}
                                        </span>
                                        <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                    </div>
                                </Show>
                            )}
                        </For>
                    </Show>
                    <Show when={renderRows().length === 0}>
                        {/* 预览现算（##321 懒算后 = 打开抽屉那一刻）⇒ 大会话要等数秒：把"在算"
                            与"确实没差异"分开说，否则用户看到的是"无差异"这个**假结论**。 */}
                        <div class="p-4 opacity-60">
                            {ctl.pvLoading() ? "正在计算预览…（大会话首次需要数秒）" : "无差异（当前参数与生效请求一致）"}
                        </div>
                    </Show>
                </div>
                </Show>
            </div>
        </div>
    );
}

/**
 * 折叠箭头（可折叠行才画；**只画箭头**，变更点由行尾的 ChangeMark 承担）。
 * 折叠且有内含变更时箭头染警示色（提示「里面还有东西，展开看看」）；展开后恢复常态。
 */
function FoldToggle(props: {
    i: number;
    row: YamlDiffRow;
    collapsed: boolean;
    changes?: { add: number; del: number };
    onToggle: (i: number) => void;
}) {
    if (!props.row.foldable) return <span class="inline-block w-3" />;
    const warn = props.collapsed && hasOwnChange(props.changes);
    return (
        <button
            class={`inline-block w-3 text-left select-none hover:opacity-100 ${warn ? "text-warning" : "opacity-60"}`}
            aria-label={props.collapsed ? "展开节点" : "折叠节点"}
            onClick={() => props.onToggle(props.i)}
        >
            {props.collapsed ? "▸" : "▾"}
        </button>
    );
}

/**
 * 行尾变更点：**只在节点折叠时**显示（展开后不用标注 —— 内容已可见），
 * 放行尾而非行首，避免插在缩进前破坏 YAML 的层级视觉。
 */
function ChangeMark(props: { collapsed: boolean; changes?: { add: number; del: number } }) {
    const c = props.changes;
    const show = () => props.collapsed && hasOwnChange(c);
    return (
        <Show when={show()}>
            <span
                class="ml-2 text-warning select-none"
                title={`内含变更：删 ${c!.del} / 增 ${c!.add} 行（展开查看）`}
            >
                ●{" "}
                {c!.del > 0 ? `-${c!.del}` : ""}
                {c!.del > 0 && c!.add > 0 ? " " : ""}
                {c!.add > 0 ? `+${c!.add}` : ""}
            </span>
        </Show>
    );
}


// ─── 压缩历史（事件快照列表 + 撤销）────────────────
//
// 【用户 2026-10-07】取代旧的「分代」：历史 = 固定的消息集合；一次压缩 = 用**某算法**对它定义的
// 一个**过滤条件**。列表列的就是这些不可变快照（算法 + 过滤器 + 结果 + 方式/理由）。
// 当前配置对历史回溯无效 —— 回溯只看当时那条事件。

/** 一条压缩事件（快照）。字段与账本 `CompactEventRecord` 对齐（这里只取展示需要的）。 */
interface CompactEventRow {
    kind: string;
    id?: string;
    ts?: string;
    by?: "ui" | "cli" | "auto";
    trigger?: string;
    /** 策略快照（新事件只有 toolResult；旧事件里还有已删的 budgetBytes —— 读侧兼容展示） */
    policy?: {
        mode?: string;
        modeData?: { budgetBytes?: number; toolResult?: { render?: string } };
    };
    size?: {
        before?: { turns: number; messages: number; bytes: number };
        after?: { turns: number; messages: number; bytes: number };
        keptTurns?: number;
        droppedTurns?: number;
    };
    /** undo 事件回指的 compact id */
    ref?: string;
}

/** 算法中文名（`policy.mode`）；未知算法原样显示 —— 换算法加新分支即可 */
function algoName(mode: string | undefined): string {
    return mode === "budget" ? "历史上限" : (mode ?? "—");
}

/** 事件里的算法表达：新事件没有上限字段（边界在 turns.jsonl），旧事件还留着已删的 budgetBytes */
function filterText(p: CompactEventRow["policy"]): string {
    if (!p) return "—";
    const bb = p.modeData?.budgetBytes;
    if (typeof bb !== "number") return "边界见 turns.jsonl";
    return `旧上限 ${bb === 0 ? "0" : `${Math.round(bb / 1024)} KB`}（已废弃）`;
}

const fmtBytes = (n: number | undefined): string => {
    if (n === undefined) return "—";
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
};

/** `compact.events` 的回包（##431 起限读尾部） */
interface CompactEventsPage {
    events: CompactEventRow[];
    truncated: boolean;
}

export function CompactHistoryPanel(props: { uri: string; onClose: () => void }) {
    const [page] = createResource(
        () => props.uri,
        async (u) => (await localChatStore.compactEvents(u)) as CompactEventsPage,
    );
    const [maximized, setMaximized] = createSignal(false);

    const all = () => page()?.events ?? [];
    /** 只列 compact 事件（measure / undo 是附属记录，不单独成行） */
    const rows = () => all().filter((e) => e.kind === "compact");

    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div class={`bg-base-100 rounded-xl w-full flex flex-col ${maximized() ? "max-w-[96vw] h-[92vh]" : "max-w-3xl max-h-[90vh]"}`}>
                <div class="px-4 py-3 border-b flex items-center justify-between">
                    <div class="font-bold text-title">压缩历史（{rows().length} 次快照）</div>
                    <div class="flex items-center gap-1">
                        <DrawerMaxButton max={maximized()} onToggle={() => setMaximized((v) => !v)} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                            ✕
                        </button>
                    </div>
                </div>
                <div class="px-4 py-1.5 text-caption opacity-60 border-b">
                    ⓘ 每次压缩 = 用**某算法**对历史消息定义的一个**过滤条件**（不可变快照）。当前配置改动
                    **不回改**这些快照；回溯看的就是当时这一次。
                </div>
                <div class="overflow-auto grow">
                    <Show
                        when={rows().length > 0}
                        fallback={<div class="p-6 opacity-60">还没有压缩记录。</div>}
                    >
                        {/* ##443 刀 3：压缩历史不再是「第五张表」—— 逐条列成行内清单
                            （主入口已是用量表的 step 行「压缩」标记；这里保留审计视图）。 */}
                        <div class="px-4 py-1" data-compact-history>
                            <For each={rows()}>
                                {(e) => (
                                    <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-base-200 py-1.5 text-caption">
                                        <span class="w-36 shrink-0 opacity-70">{e.ts ? new Date(e.ts).toLocaleString() : "—"}</span>
                                        <span class="badge badge-ghost badge-xs">{algoName(e.policy?.mode)}</span>
                                        <span class="tabular-nums" title="轮次：压缩前 → 压缩后">
                                            轮 {e.size?.before?.turns ?? "?"} → {e.size?.after?.turns ?? "?"}
                                        </span>
                                        <span class="tabular-nums" title="消息条数：压缩前 → 压缩后">
                                            消息 {e.size?.before?.messages ?? "?"} → {e.size?.after?.messages ?? "?"}
                                        </span>
                                        <span class="tabular-nums" title="投递字节：压缩前 → 压缩后">
                                            {fmtBytes(e.size?.before?.bytes)} → {fmtBytes(e.size?.after?.bytes)}
                                        </span>
                                        <span class="badge badge-xs" classList={{ "badge-info": e.by === "auto" }}>
                                            {e.by === "auto" ? "自动" : e.by === "ui" ? "界面" : "命令行"}
                                        </span>
                                        <span class="opacity-80">{triggerText(e.trigger)}</span>
                                        <span class="opacity-50">{filterText(e.policy)}</span>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </div>
                {/* ##431：限读尾部 ⇒ 更早的记录确实没读。必须显式说出来（不许静默截断）。 */}
                <Show when={page()?.truncated}>
                    <div class="px-4 py-1.5 text-caption opacity-60 border-t">
                        ⓘ 更早的压缩记录未加载（审计日志，可清理）—— 下面列的是最近 200 条
                    </div>
                </Show>
            </div>
        </div>
    );
}
