/**
 * CompactSessionPanel — 压缩会话上下文的**面板**（控制器 + 可嵌入内容）
 *
 * ⚠️ 语义：压缩 **≠** 清除。
 *   · 压缩：只改「发给模型的上下文」—— 按字节预算保留历史 + 可选裁工具结果；
 *     **不删任何历史**，旧内容仍在会话日志里、可查、可撤销。
 *   · 清除（⋯ 菜单）：物理删除所有会话日志，不可恢复 —— 两回事，别混。
 *
 * 【M1】本文件**不再自带抽屉外壳**：`useCompactPanel(uri)` 管状态与副作用，
 *   `CompactPanelContent` 是可嵌入的纯内容（左参数 + 右预览），嵌进「窗口构成页」第一 tab；
 *   顶栏 / 执行按钮 / 关闭都归外层 drawer。`CompactHistoryPanel` 是独立的压缩历史弹窗。
 *
 * 内容布局：**左参数 + 右预览**，一眼对照。
 *   · 左栏 = 预算区（自动压缩 toggle + 压缩到 KB）+ 费用对比图形
 *   · base = **未压缩**的全量投递（compactPreview 现算），mod = 当前预算
 *   · 右栏把两者渲染成 YAML 行、做行级 diff（增删变色、可折叠、可只看差异、可并排）
 */

import { createSignal, createResource, createEffect, on, For, Show, createMemo, type JSX } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import type { AutoCompactIssue } from "../../shared/context/auto-compact";
import {
    DEFAULT_BUDGET_BYTES,
    DEFAULT_TOOL_RESULT_POLICY,
    budgetBytesOf,
    flatPolicyOf,
    normalizePolicy,
    toolResultOf,
    type CompactPolicy,
    type FlatCompactPolicy,
    type ToolResultMode,
    type ToolResultPolicy,
} from "../../shared/context/compaction";
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
import { DrawerMaxButton } from "./DrawerMaximize";
import { notificationStore } from "../store/notificationStore";
import { ConfirmDialog } from "./ConfirmDialog";
import {
    DEFAULT_EXEMPT_STEPS,
    DEFAULT_HEADTAIL_CLIP_DATA,
    DEFAULT_KEEP,
    keepStageLabel,
    retypeStage,
    validateKeepStages,
    withClip,
    withLimit,
    withMust,
    type KeepRole,
    type KeepStage,
    type KeepStageType,
} from "../../shared/context/compact-keep";

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
                            fallback={<span data-cost-saved class="opacity-60">无节省（预算未生效 / 历史本来就不多）</span>}
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

/** 版本链一行（RPC `compact.plan.versions` 的裁剪视图；形状真源 = main/services/plan-store.ts） */
export interface PlanVersionEntryModel {
    version: string;
    ts: string;
    op: "set" | "restore" | "reset";
    via: "agent" | "user";
    taskUri: string;
    parent: string | null;
    brief: string;
}
export interface PlanVersionsModel {
    /** 当前**生效内容**的版本 id（可能尚未入链，见 `pending`） */
    current: string;
    versions: PlanVersionEntryModel[];
    latest: PlanVersionEntryModel | null;
    /** 配置内容与链尾不同（手改 / UI 编辑尚未记账） */
    pending: boolean;
}
export interface PlanVersionDetailModel {
    version: string;
    text: string;
    diff?: string;
}

export interface CompactPanelCtl {
    auto: () => {
        config: { mode: "off" | "notify" | "auto"; policy: unknown; history?: { keep?: KeepStage[] } };
        raw?: { path: string; text: string };
        /** 读配置的出声条目（##370）：非空 = 有键缺失/非法，已逐键回落缺省 */
        warnings?: AutoCompactIssue[];
    } | undefined;
    autoBusy: () => boolean;
    patchAuto: (patch: Record<string, unknown>) => Promise<void>;
    autoPolicy: () => CompactPolicy;
    budgetBytes: () => number;
    kbDraft: () => string;
    setKbDraft: (v: string) => void;
    commitKb: () => Promise<void>;
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
    // ─── M2（##344）：装配管道 `history.keep[]`（级列表）读写 ───
    /** 当前级列表（配置没写 ⇒ 缺省管道**回显成数据**，用户看得见"现在在用什么"） */
    keep: () => KeepStage[];
    /** 级列表来源：`config` = 用户/agent 配的；`default` = 配置没写、回落缺省管道 */
    keepSource: () => "config" | "default";
    /** 写级列表（**写前先本地校验**；非法 ⇒ 只报错、不落盘） */
    setKeep: (next: KeepStage[]) => Promise<void>;
    /** 重置为**出厂缺省**（##363）：删配置里的 `history.keep[]`（走 RPC `compact plan reset`）。
     *  ⚠️ 不是 `setKeep([...DEFAULT_KEEP])` —— 那是把缺省**写死**进配置；这里是**删键**（跟随将来缺省）。 */
    resetKeep: () => Promise<void>;
    // ─── ##378：plan 版本链（只读展示 + 回滚）───
    /** 版本链（当前 id + 列表）；`undefined` = 还没取到（抽屉关着 / 首帧） */
    planVersions: () => PlanVersionsModel | undefined;
    /** 当前版本 id（未取到 = 空串） */
    planVersion: () => string;
    /** 展开中的版本详情（`undefined` = 没展开） */
    versionDetail: () => PlanVersionDetailModel | undefined;
    /** 展开/收起某一版（点已展开的那版 = 收起） */
    showVersion: (version: string) => Promise<void>;
    /** 回滚到某一版（**切指针**：走闸+校验+快照，回滚本身也入链） */
    restoreVersion: (version: string) => Promise<void>;
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
            return (await localChatStore.autoCompactStatus(u)) as {
                config: { mode: "off" | "notify" | "auto"; policy: unknown; history?: { keep?: KeepStage[] } };
                raw?: { path: string; text: string };
                warnings?: AutoCompactIssue[];
            };
        },
    );
    // ─── ##378：版本链（只读 + 回滚）—— 与 auto / 预览同门槛：抽屉关着不查 ───
    const [planVersionsRes, { refetch: refetchVersions }] = createResource(
        () => (visible() ? uri() : null),
        async (u) =>
            u ? ((await localChatStore.compactPlanVersions(u)) as unknown as PlanVersionsModel) : undefined,
    );
    const planVersion = (): string => planVersionsRes()?.current ?? "";
    const [versionDetail, setVersionDetail] = createSignal<PlanVersionDetailModel | undefined>(undefined);
    /** 点某一版：展开全文 + 对比（再点同一版 = 收起） */
    const showVersion = async (version: string): Promise<void> => {
        if (versionDetail()?.version === version) {
            setVersionDetail(undefined);
            return;
        }
        setErr(null);
        try {
            const r = (await localChatStore.compactPlanVersion(uri(), version)) as unknown as {
                text: string;
                diff?: string;
            };
            setVersionDetail({ version, text: r.text, diff: r.diff });
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        }
    };
    /** 回滚到某一版（确认后由界面调；这里是纯副作用，不做二次确认 —— 确认归调用点） */
    const restoreVersion = async (version: string): Promise<void> => {
        setAutoBusy(true);
        setErr(null);
        try {
            await localChatStore.compactPlanRestore(uri(), version);
            setVersionDetail(undefined);
            await refetchAuto();
            await refetchVersions();
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setAutoBusy(false);
        }
    };

    const [autoBusy, setAutoBusy] = createSignal(false);
    const patchAuto = async (patch: Record<string, unknown>) => {
        setAutoBusy(true);
        try {
            await localChatStore.autoCompactSetConfig(patch, uri());
            await refetchAuto();
            // 写了 `history.keep` ⇒ 主进程会入版本链（##378）；这里同步刷新版本列表
            if ((patch as { history?: unknown }).history) void refetchVersions();
        } finally {
            setAutoBusy(false);
        }
    };

    const autoPolicy = (): CompactPolicy => normalizePolicy(auto()?.config.policy);
    const budgetBytes = (): number => budgetBytesOf(autoPolicy()) ?? DEFAULT_BUDGET_BYTES;
    const patchAutoPolicy = (next: CompactPolicy) => patchAuto({ policy: next });
    const currentToolResult = () => toolResultOf(autoPolicy()) ?? DEFAULT_TOOL_RESULT_POLICY;
    const setBudgetBytes = (b: number) =>
        patchAutoPolicy({
            mode: "budget",
            modeData: { budgetBytes: Math.max(0, Math.round(b)), toolResult: currentToolResult() },
            summary: false,
        });
    const setBudgetKb = (kb: number) => setBudgetBytes(kb * 1024);

    /** 预算输入框草稿（KB）：不要让异步 auto() 覆盖用户正在输入的内容 —— 仅初始化 / 提交时同步 */
    const [kbDraft, setKbDraft] = createSignal("3");
    createEffect(
        on(
            () => budgetBytes(),
            (b) => setKbDraft(b % 1024 === 0 ? String(b / 1024) : (b / 1024).toFixed(1)),
            { defer: false },
        ),
    );
    /** headtail 私有参数（无 headtail 时回落到缺省 —— 切到 headtail 时用它初始化） */
    const headtailData = () => {
        const tr = currentToolResult();
        if (tr.render === "headtail") return tr.renderData;
        const d = DEFAULT_TOOL_RESULT_POLICY.render === "headtail" ? DEFAULT_TOOL_RESULT_POLICY.renderData : undefined;
        return d ?? { head: 3, tail: 3, maxLineChars: 300, maxKeepBytes: 8192 };
    };
    /** 写整个 toolResult 支（保住 budgetBytes 与 summary） */
    const patchToolResult = (next: ToolResultPolicy) =>
        patchAutoPolicy({
            mode: "budget",
            modeData: { budgetBytes: budgetBytes(), toolResult: next },
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

    // ─── M2：级列表（`history.keep[]`）───
    // 配置没写 ⇒ 回显**缺省管道**（与主进程 `planFromKeep` 的回落同一份 `DEFAULT_KEEP`）：
    // 界面必须显示"现在实际在用什么"，否则「回落」在 UI 上等于隐形。
    const configuredKeep = (): KeepStage[] | undefined => {
        const k = auto()?.config.history?.keep;
        return k && k.length > 0 ? k : undefined;
    };
    const keep = (): KeepStage[] => configuredKeep() ?? [...DEFAULT_KEEP];
    const keepSource = (): "config" | "default" => (configuredKeep() ? "config" : "default");
    /** 写级列表：**先本地校验**（同一个 `validateKeepStages`，与主进程判据同源）⇒ 立刻给反馈、不打空 RPC */
    const setKeep = async (next: KeepStage[]): Promise<void> => {
        const { issues } = validateKeepStages(next);
        const errors = issues.filter((i) => i.level === "error");
        if (errors.length > 0) {
            setErr(errors.map((e) => e.message).join("；"));
            return;
        }
        if (next.length === 0) {
            setErr("级列表不能为空（要清零请把预算设为 0）");
            return;
        }
        setErr(null);
        await patchAuto({ history: { keep: next } });
    };
    /** 重置为**出厂缺省**（##363 逃生窗口）：走 `compact plan reset`（删键），**不是**写 DEFAULT_KEEP 字面量。
     *  成功后 `refetchAuto()` ⇒ `keepSource()` 变 `default`、`keep()` 回显缺省 ⇒ 预览 key 变、自动重算。 */
    const resetKeep = async (): Promise<void> => {
        setErr(null);
        setAutoBusy(true);
        try {
            await localChatStore.compactPlanReset(uri());
            await refetchAuto();
            await refetchVersions();
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setAutoBusy(false);
        }
    };

    /** 提交预算输入（失焦 / 回车）。**返回 Promise**：写盘 + refetch 异步，apply 必须先 await 它。 */
    const commitKb = async (): Promise<void> => {
        const kb = Number(kbDraft());
        if (!Number.isFinite(kb) || kb < 0) {
            setKbDraft(String(budgetBytes() / 1024));
            return;
        }
        if (Math.round(kb * 1024) === budgetBytes()) return;
        await setBudgetKb(kb);
    };

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
        // ⚠️ 必须带上 `keep`：预览算的是「当前配置下的投递」，改了级列表要立刻重算
        // （与预算同理 —— 漏了它就会出现"改了管道但预览没变"的假象）。
        // 编码：`<uri>\0<JSON>`，JSON 里同时装 policy 与 keep —— **只能有一个分隔符**，
        // 多个分隔符会让下面的 `JSON.parse(第一个 \0 之后)` 撞上"JSON 后面还有内容"（实测红灯）。
        return u + "\u0000" + JSON.stringify({ policy: flatPolicyOf(autoPolicy()), keep: keep() });
    };
    const [pv] = createResource(pvKey, (k) => {
        const i = k.indexOf("\u0000");
        const { policy } = JSON.parse(k.slice(i + 1)) as { policy: FlatCompactPolicy };
        return localChatStore.compactPreview(k.slice(0, i), policy) as Promise<CompactPreviewModel>;
    });

    /** 预览是否在算（见 CompactPanelCtl.pvLoading） */
    const pvLoading = (): boolean => pv.loading;

    /** 立即压缩：按当前预算压一次（历史保留、可撤销） */
    const apply = async () => {
        const u = uri();
        if (!u) return;
        setBusy(true);
        setErr(null);
        try {
            // ⚠️ 先把输入框里的预算落盘（blur 的写盘是异步的）——否则可能用**旧预算**压
            await commitKb();
            const rec = await localChatStore.compact(u, flatPolicyOf(autoPolicy()));
            if (rec?.noop) notificationStore.addToastLegacy("info", "无需压缩（历史已在预算内）");
            else notificationStore.addToastLegacy("success", "已压缩（历史保留、可撤销）");
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    };

    return {
        auto, autoBusy, patchAuto, autoPolicy, budgetBytes, kbDraft, setKbDraft, commitKb, pv, pvLoading, busy, err, apply,
        render, setRender, renderData: headtailData, setRenderData, summaryEnabled, setSummary, rawText, rawPath,
        warnings,
        keep, keepSource, setKeep, resetKeep,
        planVersions: planVersionsRes, planVersion, versionDetail, showVersion, restoreVersion,
    };
}

/**
 * 压缩面板内容（**可嵌入**）—— 左参数 + 右预览，一眼对照。
 *   · 左栏 = 预算区 + 费用图（费用对比图形：当前 vs 压缩后）
 *   · 右栏 = 预览区（请求结构 YAML 行级 diff：增删变色、可折叠、可只看差异、可并排）
 * 外壳（顶栏 / 底栏 / 遮罩）由外层「窗口构成页」提供；执行按钮在 tab 栏。
 */
/** 级列表里的 clip 选择值（`inherit` = 不声明 ⇒ 回落计划级全局裁法） */
type ClipKind = "inherit" | "full" | "path" | "headtail";
const clipKindOf = (s: KeepStage): ClipKind => s.clip?.type ?? "inherit";
const stageWithClipKind = (s: KeepStage, kind: ClipKind): KeepStage => {
    if (kind === "inherit") return withClip(s, undefined);
    if (kind === "full") return withClip(s, { type: "full" });
    if (kind === "path") return withClip(s, { type: "path" });
    return withClip(s, { type: "headtail", data: { ...DEFAULT_HEADTAIL_CLIP_DATA } });
};

/**
 * **一级**的编辑器（##344 M2）：选 `type` / 必保 / `limit` / `clip` / 该取法私有的 `data`。
 *
 * 形状与校验真源是 `shared/context/compact-keep.ts` —— 这里只做「把一条级画成控件」，
 * 不自己发明字段（换取法用 `retypeStage`，它保证 `data` **整包换**，见 rule.discriminated-union）。
 */
function KeepStageRow(props: {
    stage: KeepStage;
    index: number;
    disabled: boolean;
    onChange: (next: KeepStage) => void;
    onRemove: () => void;
}) {
    const s = () => props.stage;
    /** 只改公共字段（type 不动） */
    const patch = (next: KeepStage) => props.onChange(next);
    const setMust = (must: boolean) => patch(withMust(s(), must));
    const setLimit = (v: string) => {
        const n = v.trim() === "" ? undefined : Math.max(0, Math.floor(Number(v)));
        patch(withLimit(s(), n !== undefined && Number.isFinite(n) ? n : undefined));
    };
    const setDataN = (v: string) => {
        const n = Math.max(1, Math.floor(Number(v) || 1));
        const st = s();
        if (st.type === "recent" || st.type === "steps") patch({ ...st, data: { ...st.data, n } });
    };
    const setRole = (role: KeepRole) => {
        const st = s();
        if (st.type === "role") patch({ ...st, data: { role } });
        else if (st.type === "recent") patch({ ...st, data: { ...st.data, role } });
    };
    const setHt = (key: "head" | "tail" | "maxLineChars" | "maxKeepBytes", v: string) => {
        const st = s();
        if (st.clip?.type !== "headtail") return;
        patch({ ...st, clip: { type: "headtail", data: { ...st.clip.data, [key]: Math.max(0, Math.floor(Number(v) || 0)) } } });
    };
    const d = () => (s().type === "ladder" ? undefined : (s() as { data: Record<string, unknown> }).data);
    return (
        <div data-keep-stage data-keep-type={s().type} class="rounded border border-base-300 p-2 space-y-1">
            <div class="flex items-center gap-1">
                <span class="font-mono opacity-50">{props.index + 1}</span>
                <select
                    data-keep-type-select
                    class="select select-xs select-bordered"
                    aria-label={`第 ${props.index + 1} 级取法`}
                    disabled={props.disabled}
                    value={s().type}
                    onChange={(e) => patch(retypeStage(s(), e.currentTarget.value as KeepStageType))}
                >
                    <option value="ladder">ladder 纵向阶梯</option>
                    <option value="steps">steps 最近 N 步</option>
                    <option value="recent">recent 最近 N 条</option>
                    <option value="role">role 某角色全部</option>
                </select>
                <label class="ml-auto flex items-center gap-1">
                    <input
                        data-keep-must
                        type="checkbox"
                        class="checkbox checkbox-xs"
                        aria-label={`第 ${props.index + 1} 级必保`}
                        disabled={props.disabled}
                        checked={s().must === true}
                        onChange={(e) => setMust(e.currentTarget.checked)}
                    />
                    <span class="opacity-60">必保</span>
                </label>
                <button
                    data-keep-del
                    class="btn btn-ghost btn-xs"
                    aria-label={`删除第 ${props.index + 1} 级`}
                    disabled={props.disabled}
                    onClick={props.onRemove}
                >
                    ✕
                </button>
            </div>
            <div class="flex items-center gap-1">
                <span class="opacity-60">limit</span>
                <input
                    data-keep-limit
                    type="number"
                    min="0"
                    class="input input-xs w-14"
                    aria-label={`第 ${props.index + 1} 级 limit`}
                    placeholder="不限"
                    disabled={props.disabled}
                    value={s().limit ?? ""}
                    onChange={(e) => setLimit(e.currentTarget.value)}
                />
                <span class="ml-auto opacity-60">裁</span>
                <select
                    data-keep-clip
                    class="select select-xs select-bordered"
                    aria-label={`第 ${props.index + 1} 级裁法`}
                    disabled={props.disabled}
                    value={clipKindOf(s())}
                    onChange={(e) => patch(stageWithClipKind(s(), e.currentTarget.value as ClipKind))}
                >
                    <option value="inherit">回落全局</option>
                    <option value="full">full 全量</option>
                    <option value="path">path 只留调用</option>
                    <option value="headtail">headtail 头尾</option>
                </select>
            </div>
            <Show when={s().type === "role" || s().type === "recent"}>
                <div class="flex items-center gap-1">
                    <span class="opacity-60">role</span>
                    <select
                        data-keep-role
                        class="select select-xs select-bordered"
                        aria-label={`第 ${props.index + 1} 级角色`}
                        disabled={props.disabled}
                        value={String(d()?.role ?? "")}
                        onChange={(e) => setRole(e.currentTarget.value as KeepRole)}
                    >
                        <Show when={s().type === "recent"}>
                            <option value="">不限</option>
                        </Show>
                        <option value="user">user</option>
                        <option value="assistant">assistant</option>
                        <option value="tool">tool</option>
                    </select>
                </div>
            </Show>
            <Show when={s().type === "recent" || s().type === "steps"}>
                <div class="flex items-center gap-1">
                    <span class="opacity-60">{s().type === "steps" ? "步数 n" : "条数 n"}</span>
                    <input
                        data-keep-n
                        type="number"
                        min="1"
                        class="input input-xs w-16"
                        aria-label={`第 ${props.index + 1} 级 n`}
                        disabled={props.disabled}
                        value={String(d()?.n ?? 1)}
                        onChange={(e) => setDataN(e.currentTarget.value)}
                    />
                </div>
            </Show>
            <Show when={s().clip?.type === "headtail"}>
                <div class="flex flex-wrap items-center gap-1">
                    <For each={["head", "tail", "maxLineChars", "maxKeepBytes"] as const}>
                        {(key) => (
                            <label class="flex items-center gap-1">
                                <span class="font-mono opacity-60">{key}</span>
                                <input
                                    data-keep-ht={key}
                                    type="number"
                                    class="input input-xs w-16"
                                    aria-label={`第 ${props.index + 1} 级 headtail ${key}`}
                                    disabled={props.disabled}
                                    value={String((s().clip as { type: "headtail"; data: Record<string, number> }).data[key] ?? 0)}
                                    onChange={(e) => setHt(key, e.currentTarget.value)}
                                />
                            </label>
                        )}
                    </For>
                </div>
            </Show>
            <div class="opacity-45" data-keep-label>
                {keepStageLabel(s())}
                {s().must === true ? " · 必保（不占预算）" : " · 计预算"}
            </div>
        </div>
    );
}

export function CompactPanelContent(props: { ctl: CompactPanelCtl }) {
    const ctl = props.ctl;

    /** 左栏视图：UI 表单 ⇄ 原始 YAML（同 VSCode settings 的 UI/JSON 切换；用户 2026-10-07） */
    const [panelView, setPanelView] = createSignal<"form" | "yaml">("form");
    // 破坏性操作（删级 / 恢复缺省）走应用内 ConfirmDialog（禁原生 window.confirm，见 tool.confirm）
    const [pendingRemove, setPendingRemove] = createSignal<number | null>(null);
    const [pendingReset, setPendingReset] = createSignal(false);
    /** ##378：待确认回滚的版本 id（确认弹窗读它；null = 无） */
    const [pendingRestore, setPendingRestore] = createSignal<string | null>(null);
    /** ##406：预览裁剪阈值（单条字符串 / 数组元素）—— 只影响展示副本 */
    const PREVIEW_CLIP = { maxChars: 4000, maxItems: 200 } as const;

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

    const estTok = (bytes: number) => Math.round(bytes / 4);
    /** 预算人读（KB；0 特别标「清零」） */
    const budgetKbLabel = (): string => {
        const b = ctl.budgetBytes();
        if (b === 0) return "0（清零）";
        return b % 1024 === 0 ? String(b / 1024) + " KB" : (b / 1024).toFixed(1) + " KB";
    };
    /**
     * 压缩后**整份请求**的规模（KB）—— 含固定开支（system + 工具定义 + runtime）+ 预算内历史。
     * 用费用表 total 行的 token（= 各层之和，含 system / tools）；token ≈ 字节 / 4 ⇒ ×4 反推字节。
     */
    const afterKb = (): string => {
        const t = (ctl.pv()?.facts ?? []).find((r) => r.key === "total");
        return (((t?.newTokens ?? 0) * 4) / 1024).toFixed(1) + " KB";
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
                    {/* 预算区：自动压缩开关（= config.mode，非策略） */}
                    <div class="rounded-lg border border-base-300 p-3 space-y-2">
                        <div class="flex items-center justify-between">
                            <span class="text-body font-semibold">自动压缩</span>
                            <input
                                type="checkbox"
                                class="toggle toggle-sm toggle-primary"
                                aria-label="自动压缩"
                                disabled={ctl.autoBusy()}
                                checked={ctl.auto()?.config.mode === "auto"}
                                onChange={(e) => void ctl.patchAuto({ mode: e.currentTarget.checked ? "auto" : "off" })}
                            />
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
                            历史 ≤ <b>{budgetKbLabel()}</b> · 整份请求 ≈ <b>{afterKb()}</b>
                        </div>
                        <div class="text-caption opacity-45">
                            历史按优先级保留：用户发言 &gt; 助手结论 &gt; 助手过程 &gt; 工具命令 &gt; 工具结果
                        </div>
                        <Show when={ctl.err()}>
                            <div class="text-caption text-error">{ctl.err()}</div>
                        </Show>
                    </div>

                    {/* 装配管道（级列表）：**从上往下**生效 —— 先声明的先挑；一条消息被多级选中 ⇒ 先选中级的 clip 生效 */}
                    <Block title="装配管道" extra={ctl.keepSource() === "config" ? "来自配置" : "缺省回落（未配置）"}>
                        <div class="space-y-2 text-caption">
                            <div class="flex items-center gap-1">
                                <span class="font-mono opacity-50">history.keep[]</span>
                                <button
                                    data-keep-add
                                    class="btn btn-xs ml-auto"
                                    disabled={ctl.autoBusy()}
                                    onClick={() => void ctl.setKeep([...ctl.keep(), { type: "steps", must: true, data: { n: DEFAULT_EXEMPT_STEPS } }])}
                                >
                                    + 新增级
                                </button>
                                <button
                                    data-keep-reset
                                    aria-label="重置为缺省"
                                    class="btn btn-xs btn-ghost"
                                    disabled={ctl.autoBusy() || ctl.keepSource() === "default"}
                                    title="删除配置里的 history.keep[]，回落到出厂缺省管道（逃生窗口；不依赖任何快照）"
                                    onClick={() => setPendingReset(true)}
                                >
                                    重置为缺省
                                </button>
                            </div>
                            <div data-keep-source class="opacity-50">
                                {ctl.keepSource() === "config"
                                    ? "真源 = auto-compact.yaml 的 history.keep[]（改动立即生效于下一轮投递）"
                                    : "配置里没有 history.keep[] ⇒ 用**代码缺省管道**（保底最近 6 步全量 + 纵向阶梯）；改任一字段即写入配置"}
                            </div>
                            {/* ##378：版本链 —— 当前版本 id + 最近 5 版（点开看全文/对比；可回滚） */}
                            <div data-plan-versions class="space-y-1 border-t border-base-300 pt-2">
                                <div class="flex items-center gap-1">
                                    <span class="font-mono opacity-50">version</span>
                                    <span class="font-mono opacity-80" data-plan-version>{ctl.planVersion() || "（未取到）"}</span>
                                    <Show when={ctl.planVersions()?.pending}>
                                        <span
                                            class="badge badge-warning badge-xs"
                                            title="配置内容还没入链（下一次写入 / 压缩会补录）"
                                        >
                                            未入链
                                        </span>
                                    </Show>
                                    <span class="ml-auto opacity-45">{ctl.planVersions()?.versions.length ?? 0} 版</span>
                                </div>
                                <For each={[...(ctl.planVersions()?.versions ?? [])].slice(-5).reverse()}>
                                    {(v) => (
                                        <div class="flex items-center gap-1">
                                            <button
                                                class="btn btn-xs btn-ghost font-mono"
                                                data-plan-version-row={v.version}
                                                aria-label={`查看版本 ${v.version}`}
                                                disabled={ctl.autoBusy()}
                                                onClick={() => void ctl.showVersion(v.version)}
                                            >
                                                {v.version}
                                                {v.version === ctl.planVersion() ? " ←当前" : ""}
                                            </button>
                                            <span class="truncate opacity-60" title={v.brief}>
                                                {v.brief}
                                            </span>
                                            <button
                                                class="btn btn-xs btn-ghost ml-auto"
                                                data-plan-version-restore={v.version}
                                                aria-label={`回滚到版本 ${v.version}`}
                                                disabled={ctl.autoBusy() || v.version === ctl.planVersion()}
                                                onClick={() => setPendingRestore(v.version)}
                                            >
                                                回滚
                                            </button>
                                        </div>
                                    )}
                                </For>
                                <Show when={ctl.versionDetail()}>
                                    {(d) => (
                                        <pre
                                            data-plan-version-detail
                                            class="m-0 max-h-40 overflow-auto rounded border border-base-300 p-2 text-caption font-mono whitespace-pre-wrap break-all"
                                        >
                                            {d().text}
                                            {d().diff ? `\n${d().diff}` : ""}
                                        </pre>
                                    )}
                                </Show>
                            </div>
                            <For each={ctl.keep()}>
                                {(stage, i) => (
                                    <KeepStageRow
                                        stage={stage}
                                        index={i()}
                                        disabled={ctl.autoBusy()}
                                        onChange={(next) => {
                                            const list = [...ctl.keep()];
                                            list[i()] = next;
                                            void ctl.setKeep(list);
                                        }}
                                        onRemove={() => setPendingRemove(i())}
                                    />
                                )}
                            </For>
                            <Show when={ctl.err()}>
                                <div class="text-error">{ctl.err()}</div>
                            </Show>
                        </div>
                    </Block>

                    {/* 计划级参数：预算 + 全局裁法（未声明 clip 的级回落到它） */}
                    <Block title="计划级参数" extra="策略真源">
                        <div class="space-y-2 text-caption">
                            <div class="flex items-center gap-2">
                                <span class="font-mono opacity-60">mode</span>
                                <span class="badge badge-ghost badge-xs">budget</span>
                                <span class="opacity-45">目标式预算（现役唯一算法）</span>
                            </div>
                            <div class="space-y-2 border-l-2 border-base-300 pl-2">
                                <div class="font-mono opacity-50">modeData</div>
                                <div class="flex items-center gap-2">
                                    <span class="font-mono opacity-70">budgetBytes</span>
                                    <input
                                        type="number"
                                        class="input input-xs w-16"
                                        aria-label="压缩预算KB"
                                        min="0"
                                        value={ctl.kbDraft()}
                                        disabled={ctl.autoBusy()}
                                        onInput={(e) => ctl.setKbDraft(e.currentTarget.value)}
                                        onChange={() => void ctl.commitKb()}
                                        onBlur={() => void ctl.commitKb()}
                                    />
                                    <span class="opacity-60">KB</span>
                                    <span class="opacity-45">（0 = 清零，含必保级）</span>
                                </div>
                                <div class="space-y-2 border-l-2 border-base-300 pl-2">
                                    <div class="font-mono opacity-50">toolResult（全局裁法）</div>
                                    <div class="flex items-center gap-2">
                                        <span class="font-mono opacity-70">render</span>
                                        <select
                                            class="select select-xs select-bordered"
                                            aria-label="工具结果呈现"
                                            disabled={ctl.autoBusy()}
                                            value={ctl.render()}
                                            onChange={(e) => ctl.setRender(e.currentTarget.value as ToolResultMode)}
                                        >
                                            <option value="asis">asis 原样</option>
                                            <option value="headtail">headtail 头尾裁剪</option>
                                            <option value="callpath">callpath 只留调用</option>
                                        </select>
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
                            <div class="flex items-center gap-2 border-t border-base-300 pt-2">
                                <span class="font-mono opacity-60">summary</span>
                                <input
                                    type="checkbox"
                                    class="toggle toggle-xs"
                                    aria-label="历史摘要"
                                    disabled={ctl.autoBusy()}
                                    checked={ctl.summaryEnabled()}
                                    onChange={(e) => ctl.setSummary(e.currentTarget.checked)}
                                />
                                <span class="opacity-45">额外算历史摘要（预留，暂未启用）</span>
                            </div>
                        </div>
                    </Block>
                    <Show when={pendingRemove() !== null}>
                        <ConfirmDialog
                            title="删除这一级"
                            message={`删除「${keepStageLabel(ctl.keep()[pendingRemove()!] ?? ctl.keep()[0]!)}」后，这一级挑中的消息会改由后续级决定是否保留（历史不删，只改投递）。`}
                            confirmLabel="删除"
                            onCancel={() => setPendingRemove(null)}
                            onConfirm={() => {
                                const i = pendingRemove();
                                setPendingRemove(null);
                                if (i === null) return;
                                void ctl.setKeep(ctl.keep().filter((_, k) => k !== i));
                            }}
                        />
                    </Show>
                    <Show when={pendingRestore()}>
                        <ConfirmDialog
                            title="回滚 plan 版本"
                            message={`把 history.keep[] 切到 ${pendingRestore()}（影响所有任务的投递）。回滚本身也入链、可再回滚；历史不删，只改投递。`}
                            confirmLabel="回滚"
                            onCancel={() => setPendingRestore(null)}
                            onConfirm={() => {
                                const v = pendingRestore();
                                setPendingRestore(null);
                                if (v) void ctl.restoreVersion(v);
                            }}
                        />
                    </Show>
                    <Show when={pendingReset()}>
                        <ConfirmDialog
                            title="重置为出厂缺省"
                            message="将 history.keep[] 重置为出厂缺省，影响所有任务的投递（当前级列表会先存快照，可用 restore 找回）。历史不删，只改投递。"
                            confirmLabel="重置为缺省"
                            onCancel={() => setPendingReset(false)}
                            onConfirm={() => {
                                setPendingReset(false);
                                void ctl.resetKeep();
                            }}
                        />
                    </Show>

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
    /** 策略真源（决策树）：`{ mode:"budget", modeData:{ budgetBytes, toolResult } }` */
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
    return mode === "budget" ? "预算" : (mode ?? "—");
}

/** 算法的**过滤器表达**（算法私有，故按 mode 分派；换算法加新分支） */
function filterText(p: CompactEventRow["policy"]): string {
    if (!p) return "—";
    if (p.mode === "budget") {
        const bb = p.modeData?.budgetBytes;
        const kb = bb === undefined ? "?" : bb === 0 ? "0（=清零）" : `${Math.round(bb / 1024)} KB`;
        return `上限 ${kb}`;
    }
    return "—";
}

const fmtBytes = (n: number | undefined): string => {
    if (n === undefined) return "—";
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
};

export function CompactHistoryPanel(props: { uri: string; onClose: () => void }) {
    const [events, { refetch }] = createResource(
        () => props.uri,
        async (u) => (await localChatStore.compactEvents(u)) as CompactEventRow[],
    );
    const [busy, setBusy] = createSignal(false);
    const [maximized, setMaximized] = createSignal(false);

    /** 只列 compact 事件（measure / undo 是附属记录，不单独成行） */
    const rows = () => (events() ?? []).filter((e) => e.kind === "compact");
    /** 已被 undo 的 compact id（行上标"已撤销"） */
    const undone = () => new Set((events() ?? []).filter((e) => e.kind === "undo").map((e) => e.ref));

    const undo = async (ref: string) => {
        setBusy(true);
        try {
            await localChatStore.undoCompact(props.uri, ref);
            await refetch();
        } finally {
            setBusy(false);
        }
    };

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
                        <table class="table table-xs">
                            <thead>
                                <tr>
                                    <th>时间</th>
                                    <th>算法</th>
                                    <th>过滤器</th>
                                    <th class="text-right">轮次</th>
                                    <th class="text-right">消息</th>
                                    <th class="text-right">字节</th>
                                    <th>方式 / 理由</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                <For each={rows()}>
                                    {(e) => {
                                        const isUndone = () => !!e.id && undone().has(e.id);
                                        return (
                                            <tr>
                                                <td class="opacity-70 whitespace-nowrap">
                                                    {e.ts ? new Date(e.ts).toLocaleString() : "—"}
                                                </td>
                                                <td>
                                                    <span class="badge badge-ghost badge-xs">{algoName(e.policy?.mode)}</span>
                                                </td>
                                                <td class="opacity-80 text-caption">{filterText(e.policy)}</td>
                                                <td class="text-right tabular-nums">
                                                    {e.size?.before?.turns ?? "?"} → {e.size?.after?.turns ?? "?"}
                                                </td>
                                                <td class="text-right tabular-nums">
                                                    {e.size?.before?.messages ?? "?"} → {e.size?.after?.messages ?? "?"}
                                                </td>
                                                <td class="text-right tabular-nums">
                                                    {fmtBytes(e.size?.before?.bytes)} → {fmtBytes(e.size?.after?.bytes)}
                                                </td>
                                                <td class="opacity-80 text-caption">
                                                    <span class="badge badge-xs" classList={{ "badge-info": e.by === "auto" }}>
                                                        {e.by === "auto" ? "自动" : e.by === "ui" ? "界面" : "命令行"}
                                                    </span>
                                                    <span class="ml-1">{triggerText(e.trigger)}</span>
                                                    <Show when={isUndone()}>
                                                        <span class="ml-1 badge badge-warning badge-xs">已撤销</span>
                                                    </Show>
                                                </td>
                                                <td class="text-right">
                                                    <Show when={!isUndone() && e.id}>
                                                        <button
                                                            class="btn btn-ghost btn-xs text-warning"
                                                            disabled={busy()}
                                                            title="标记这次压缩作废（append-only，可审计）"
                                                            onClick={() => void undo(e.id!)}
                                                        >
                                                            撤销
                                                        </button>
                                                    </Show>
                                                </td>
                                            </tr>
                                        );
                                    }}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </div>
            </div>
        </div>
    );
}
