// src/shared/context/auto-compact.ts
// 🎯 自动压缩的**配置契约 + 触发判定**（纯函数，禁止 import node:*）
//
// ── 判据全是「确定事实」，不是「划不划算」的预测（用户 2026-10-06）──
// 这条界线很重要：230#25 放弃的是**压缩效果评估**（"省了多少钱、值不值"这种没底气的预测）；
// 自动压缩要回答的是"**该不该压**"，而它是可判定的：
//   · 系统上下文变了 → 前缀缓存**必作废**（invalidated）→ 保留部分本来就要按全价重读，
//     此刻压缩**零重建代价**（盈亏平衡里 X=T ⇒ N=0 步，用户原话「哪怕清零都是合理的」）；
//   · 缓存**已过期**（expired，见 cache-ttl.ts）→ 同上，冷启动时压缩是白赚窗口；
//   · 上下文窗口超上限 → 不压就撞墙（不是"划不划算"，是硬约束）。
//
// ── 命名（用户 2026-10-06：名字要能看懂是哪个模块）──
//   expired（过期/时间） ≠ invalidated（作废/内容变） ≠ miss（未命中/观测结果）
//   `systemContext` = `buildDelivery` 的 system 容器（不是 OS 的 system，本仓库里 system 是歧义词）
//   `contextWindow` = 上下文窗口（对齐运行时模型目录的 contextLimit；不叫 tokenWindow，那会与"输出 token 数"混）
//
// ── 【##370】宽松归一**不是**兜底，是主路径：这份 yaml 是手写 / LLM 写的全局配置，
//   严格 schema 只当**探测器**（它才说得出"缺了哪个必填键"）；值一律经 `normalizeAutoCompact`，
//   凡被它改动过的键各推一条 `AutoCompactIssue`（`issues` 收集器）⇒ 归一改了什么，人看得见。──

import { z } from "zod";
import { cacheStateAfterGap, type EffectiveTtl } from "./cache-ttl";
import { HistoryLimitSchema, isCompleteHistoryLimit, normalizeHistoryLimit, type HistoryLimit } from "./history-limit";
import {
    CompactPolicySchema,
    DEFAULT_TOOL_RESULT_POLICY,
    normalizePolicy,
    type CompactPolicy,
    type CompactTrigger,
} from "./compaction";

/** 自动压缩的触发配置（三个都是可判定的确定事实） */
export const AutoCompactTriggersSchema = z.object({
    systemContextChanged: z.boolean().describe("系统上下文变了 → 前缀缓存必作废；此刻压缩零重建代价"),
    cacheExpired: z.boolean().describe("缓存已过期（距上次请求 > 生效 TTL）→ 同上，冷启动压缩是白赚"),
    windowOverRatio: z
        .number()
        .describe(
            "上下文窗口占用**比例**（0~1；判据 = 最后一步实测用量 usage.total >= 模型窗口 contextLimit × ratio）；" +
                "0 = 关闭该触发。窗口上限取不到 ⇒ 不触发（不猜数）。缺省 0.5",
        ),
});

/**
 * `history` —— 「留给模型的历史消息」怎么装配（压缩的**作用对象**）。
 *
 * ##442（2026-10-27 用户拍板「统一为总窗口比例，向 dsh 看齐」）：这里**只有两项** ——
 * 保留比例 `limit.retainRatio`（缺省 0.16 = dsh）+ 摘要模式 `limit.summary.mode`（model / self）。
 * 绝对上限 `limitTokens` / 下限夹取 / 保头 / 事后配平 全部删除，**不留兼容壳**；
 * 旧配置里的 `limitTokens` / `summary.enabled` 读时忽略并出声（见 `normalizeHistory`）。
 */
export const AutoCompactHistorySchema = z.object({
    /**
     * **唯一的历史预算**：窗口比例 + 摘要模式。
     * 缺省 = `DEFAULT_HISTORY_LIMIT`（0.16 / model）。
     */
    limit: HistoryLimitSchema.optional().describe("历史预算：保留比例（窗口 × 本值）+ 摘要模式（唯一旋钮）"),
});

export const AutoCompactConfigSchema = z.object({
    triggers: AutoCompactTriggersSchema,
    /**
     * 压缩策略（自动 / 手动**同一套**）—— 直接复用 `CompactPolicy`（含 `summary`）。
     *
     * 自动压的"压什么"与手动压完全同类，就用同一个真源（差异只在**谁触发**，由 `triggers` 表达）；
     * 各造一个形状必然分叉。
     */
    policy: CompactPolicySchema.describe("自动压时用的策略（与手动面板同一真源形状）"),
    history: AutoCompactHistorySchema.optional().describe("历史预算（一条 token 上限 + 摘要开关）；缺省 = 30000 token"),
});
/**
 * 配置真源类型（**手写**而非 `z.infer`）：`history.limit` 的容错归一（宽松补齐 + 出声）
 * 由 `normalizeHistory` 做，读到的必然是**补全过的** `HistoryLimit` —— 与 schema 里的可选项不同，
 * 不能靠 `z.infer` 硬凑。
 */
export interface AutoCompactConfig {
    triggers: AutoCompactTriggers;
    policy: CompactPolicy;
    /** 历史预算：**保留比例 + 摘要模式**（唯一旋钮；缺省 = `DEFAULT_HISTORY_LIMIT`） */
    history?: { limit?: HistoryLimit };
}
export type AutoCompactTriggers = z.infer<typeof AutoCompactTriggersSchema>;

/**
 * 配置读入的**出声条目**（##370）：哪一层有问题 + 已回落成什么。
 *
 * 为什么要有这个类型：`auto-compact.yaml` 是**手写 / LLM 写的全局配置**，过去写漏一个必填键
 * = 整份静默作废（只剩应用日志里一行 `console.warn`，而 CLI/UI 只看到 `source:"default"`，
 * 用户精心写的 plan「不见了」）。这条类型是「原因」的载体 —— 让 `plan get` / UI 把**为什么**说出来。
 * 与 ##338（`task edit --body` 静默丢正文）同一族病：**静默回退 + 只见结果不见因**。
 */
export interface AutoCompactIssue {
    /** 出问题的键路径（点号连接，如 `policy.summary`）；整份级问题 = 空串 */
    path: string;
    /** 人读说明，**必带「已回落成什么」** —— CLI / UI / 工具输出原样展示 */
    message: string;
}

/** zod issue 的**最小读面**（只取要展示的几个字段 —— 不绑 zod 内部类型，跨版本不炸） */
interface ZodIssueLike {
    code: string;
    path: readonly PropertyKey[];
    message: string;
    expected?: unknown;
    values?: readonly unknown[];
}

/** 按路径取值（出声条目要报出「回落成了哪份值」） */
function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
    let cur: unknown = root;
    for (const k of path) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<PropertyKey, unknown>)[k];
    }
    return cur;
}

/** 值 → 人读短串（对象只报"缺省值"：把一整包策略展开会把一行提示撑成十行） */
function briefValue(v: unknown): string {
    if (v === undefined) return "缺省值";
    if (v === null) return "null";
    if (Array.isArray(v)) return `[${v.length} 项]`;
    if (typeof v === "object") return "缺省值";
    return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** zod issue → 人读原因（英文 message 只作兜底：给人看的提示不留英文） */
function describeZodIssue(i: ZodIssueLike): string {
    if (i.code === "invalid_type") {
        // zod v4 不单列「收到什么」，只把 `received undefined` 写进 message；缺键是最常见的一类，单独说清
        return i.message.includes("received undefined") ? "缺失（必填）" : `类型不符（期望 ${String(i.expected)}）`;
    }
    if (i.code === "invalid_value") return `取值非法（合法值：${(i.values ?? []).map(String).join(" / ")}）`;
    return i.message;
}

/**
 * `AutoCompactConfigSchema` 的校验错误 → 出声条目（「哪一层缺什么 / 什么不对 + 已回落成什么」）。
 *
 * 纯函数（不碰 fs），与 schema 同处真源；文件层（`main/core/auto-compact-config.ts`）只负责把它接到
 * `loadAutoCompactDetailed` 上。**回落值从归一后的配置里取** ⇒ 报的必须是真正生效的那份。
 */
export function autoCompactIssuesFromZod(error: z.ZodError, resolved: AutoCompactConfig): AutoCompactIssue[] {
    return (error.issues as unknown as ZodIssueLike[]).map((i) => {
        const path = i.path.map((k) => String(k)).join(".");
        const where = path === "" ? "（整份配置）" : path;
        return { path, message: `${where}：${describeZodIssue(i)}；已回落 ${briefValue(valueAtPath(resolved, i.path))}` };
    });
}

/**
 * 窗口触发默认阈值（**比例**，用户 2026-10-26 拍板）：模型窗口上限的 50%。
 *
 * 判据 = 该会话**最后一步实测用量**（`usage.total`，真实 token 数）≥ `contextLimit × 本值` ⇒ 压。
 * 固定 token 数在 1M 窗口下只有 3.84%（38400/1M），实际每步 80–95k ⇒ 恒超 ⇒ 每轮空转压缩；
 * 比例才跟得上不同模型。窗口上限取不到 ⇒ **不触发**（不猜数）。
 */
export const DEFAULT_WINDOW_OVER_RATIO = 0.5;

/**
 * 窗口阈值归一（单位：**比例 0~1**）。
 *
 * - `(0,1)`：合法比例，原样采纳（旧配置里本就是比例的 `0.8` 不再告警回落）；
 * - `0`：关闭该触发；
 * - `>=1`：**旧 token 绝对数**（如 800000）⇒ 按当前模型窗口一次性折算成比例；
 *   窗口未知时无法折算，本次按缺省 `0.5` 判定并出声（读到窗口后会再折算并写回）。
 */
export function normalizeWindowOverRatio(
    v: unknown,
    issues?: AutoCompactIssue[],
    windowLimitTokens?: number | null,
): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return DEFAULT_WINDOW_OVER_RATIO;
    if (v === 0) return 0;
    if (v < 1) return v;
    // 旧 token 绝对数 → 比例
    if (typeof windowLimitTokens === "number" && Number.isFinite(windowLimitTokens) && windowLimitTokens > 0) {
        const ratio = Math.max(1e-4, Math.min(1, Math.round((v / windowLimitTokens) * 10000) / 10000));
        const message =
            `contextWindowOver=${v}（旧 token 绝对数）已按模型窗口 ${windowLimitTokens} ` +
            `一次性折算为 windowOverRatio=${ratio}，并写回`;
        console.warn(`[auto-compact] ${message}`);
        issues?.push({ path: "triggers.windowOverRatio", message });
        return ratio;
    }
    const message =
        `windowOverRatio=${v} 是旧 token 绝对数，但当前模型窗口上限未知 ⇒ 本次按缺省 ` +
        `${DEFAULT_WINDOW_OVER_RATIO} 判定（不猜数；读到窗口上限后自动折算并写回）`;
    console.warn(`[auto-compact] ${message}`);
    issues?.push({ path: "triggers.windowOverRatio", message });
    return DEFAULT_WINDOW_OVER_RATIO;
}

/** 这份原始配置是否需要做「旧 token 阈值 → 比例」的**一次性迁移写回** */
export function needsWindowRatioMigration(raw: unknown): boolean {
    const src = (raw ?? {}) as Record<string, unknown>;
    const t = (src["triggers"] ?? {}) as Record<string, unknown>;
    if (t["contextWindowOver"] !== undefined) return true;
    const r = t["windowOverRatio"];
    return typeof r === "number" && Number.isFinite(r) && r >= 1;
}

/**
 * 默认配置：**到点就压**（用户 2026-10-26：「没有必要这个复杂性，到了就压缩」）。
 * 静默压缩的代价由「重建记忆提示」承担（刀 2）—— 不再用 off/notify 三态延长决定。
 */
export const DEFAULT_AUTO_COMPACT: AutoCompactConfig = {
    triggers: { systemContextChanged: true, cacheExpired: true, windowOverRatio: DEFAULT_WINDOW_OVER_RATIO },
    // 自动压与手动压**同一套策略**（合并后不再有第二套）。
    // ⚠️ 历史预算不在这里 —— 它是 `history.limit.limitTokens`（缺省 30000 token）。
    policy: {
        mode: "budget",
        modeData: { toolResult: DEFAULT_TOOL_RESULT_POLICY },
        summary: false,
    },
};

/**
 * 宽松归一（从 YAML/UI 来的可能缺字段/越界）：初版紧凑、扩展松散。
 *
 * 缺 `policy` 时用 `DEFAULT_AUTO_COMPACT.policy`，**不**用 `normalizePolicy({})`
 * 的缺省 —— 缺省值必须有依据，不能顺手取一个（见 `DEFAULT_AUTO_COMPACT` 的注释）。
 *
 * 可选的 `issues` 收集器：凡**本函数改动过**（缺键补缺省、旧单位迁移、坏 keep 丢弃）的地方各推一条
 * 出声（##370）—— 归一**不再静默**，调用方（plan get / UI）据此把"为什么"说给用户。
 */
export function normalizeAutoCompact(
    raw: unknown,
    issues?: AutoCompactIssue[],
    windowLimitTokens?: number | null,
): AutoCompactConfig {
    const src = (raw ?? {}) as Record<string, unknown>;
    const t = (src["triggers"] ?? {}) as Record<string, unknown>;
    // mode 已删除（##442）：旧配置残留 **忽略并出声**，不再有 off/notify/auto 三态
    if (src["mode"] !== undefined) {
        const message = `mode=${JSON.stringify(src["mode"])} 已删除（##442：到点就压）→ 已忽略`;
        console.warn(`[auto-compact] ${message}`);
        issues?.push({ path: "mode", message });
    }
    // 旧键 contextWindowOver 改名为 windowOverRatio；值语义同「比例」，旧 token 数由归一折算
    const rawRatio = t["windowOverRatio"] !== undefined ? t["windowOverRatio"] : t["contextWindowOver"];
    const history = normalizeHistory(src["history"], issues, legacyBudgetBytes(src["policy"]));
    return {
        triggers: {
            systemContextChanged: t["systemContextChanged"] !== false,
            cacheExpired: t["cacheExpired"] !== false,
            windowOverRatio: normalizeWindowOverRatio(rawRatio, issues, windowLimitTokens),
        },
        // 策略（自动 / 手动**同一套**）→ 交给 normalizePolicy 统一宽松归一；
        // 缺省用 DEFAULT_AUTO_COMPACT.policy（见本函数头注）。
        policy: src["policy"] !== undefined ? normalizePolicy(src["policy"]) : DEFAULT_AUTO_COMPACT.policy,
        // history 只在**校验通过且非空**时出现（否则缺席 = 回落缺省管道）。见 normalizeHistory。
        ...(history ? { history } : {}),
    };
}

/** 旧配置里的字节预算（`{modeData:{budgetBytes}}` 或扁平 `{budgetBytes}`）；没有 = undefined */
function legacyBudgetBytes(rawPolicy: unknown): number | undefined {
    if (rawPolicy === null || typeof rawPolicy !== "object") return undefined;
    const p = rawPolicy as Record<string, unknown>;
    const md = (p["modeData"] ?? {}) as Record<string, unknown>;
    const v = md["budgetBytes"] ?? p["budgetBytes"];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * `history` 的容错归一（**读侧宽松**，硬要求）：
 *   · 缺 `history` / 缺 `limit` → 缺席（= 回落缺省）；
 *   · `limit` 残缺 / 超界 → **宽松归一**（补缺省、夹下限）并出声，**绝不抛**（##432 review B1：
 *     用户照 header 只写 `{limitTokens: 8000}` 曾让整份配置读不出来）；
 *   · 旧字段 `keep[]` / `allowAgentWrite` → **忽略 + 出声**（已不决定投递；不保留兼容壳）。
 */
/** 旧键是否出现在这段配置里（用于出声，`enabled` 可能在 `limit.summary` 或顶层） */
function src0Has(raw: unknown, key: string): boolean {
    if (raw === null || typeof raw !== "object") return false;
    const o = raw as Record<string, unknown>;
    if (key in o) return true;
    const sum = o["summary"];
    return sum !== null && typeof sum === "object" && key in (sum as Record<string, unknown>);
}

function normalizeHistory(
    raw: unknown,
    issues?: AutoCompactIssue[],
    legacyBudgetBytes?: number,
): { limit?: HistoryLimit } | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const src = raw as Record<string, unknown>;
    // 旧字段的出声：写了就当"你的这份没按新形状写"，但继续用（不炸、不静默）
    for (const dead of ["keep", "allowAgentWrite"] as const) {
        if (src[dead] === undefined) continue;
        const message =
            `history.${dead} 已删除（##432：不让人/agent 编排装配计划）→ 已忽略；` +
            "历史预算只看 history.limit.retainRatio（没有「清零」这种说法）";
        console.warn(`[auto-compact] ${message}`);
        issues?.push({ path: `history.${dead}`, message });
    }
    const limitRaw = src["limit"];
    if (limitRaw === undefined) {
        // **旧字段一次性名字映射**（不保留两套字段名）：没有 `history.limit` 但旧配置带
        // `policy.modeData.budgetBytes` ⇒ 折算成 token 上限（bytes / 4，与仓库同一个粗估口径）
        // 并出声。写回时 `saveAutoCompact` 落的就是新形状，映射只发生这一次。
        if (legacyBudgetBytes === undefined) return undefined;
        // ##442：保留量改窗口比例后，旧字节预算**没有等价物可折算**（同一个字节数在 128k / 1M 窗口上
        // 该占多少完全相反）⇒ 忽略并出声，回落到 `DEFAULT_HISTORY_LIMIT`，不猜一个比例出来。
        const message =
            `policy.modeData.budgetBytes=${String(legacyBudgetBytes)} 是旧口径（已删除）→ 无法折算成窗口比例，` +
            "已忽略并回落缺省 retainRatio=" + String(0.16);
        console.warn(`[auto-compact] ${message}`);
        issues?.push({ path: "policy.modeData.budgetBytes", message });
        return { limit: normalizeHistoryLimit(undefined) };
    }
    // ⚠️ **不许裸 parse**：`HistoryLimitSchema` 里 `summary` 是必填，
    // 用户照 header 只写 `{retainRatio: 0.16}` 就会抛 ZodError，而外层没有 try/catch ⇒ 整份配置读不出来。
    // 一律走宽松归一：缺的字段补缺省、越界的夹回范围，读不出来时**出声**但不炸。
    const parsed = HistoryLimitSchema.safeParse(limitRaw);
    const legacyKeys = ["limitTokens", "enabled"].filter((k) => src0Has(limitRaw, k));
    if (!parsed.success || !isCompleteHistoryLimit(limitRaw) || legacyKeys.length > 0) {
        const message =
            `history.limit 不完整 / 非法 / 含旧键（${parsed.success ? "缺字段" : parsed.error.issues.map((i) => i.path.join(".")).join("，")}` +
            `${legacyKeys.length > 0 ? `；旧键 ${legacyKeys.join("/")} 已删除` : ""}）` +
            "→ 已回落为补齐后的值（缺 summary ⇒ mode=model；retainRatio 越界 ⇒ 夹到 (0.01, 0.5]）";
        console.warn(`[auto-compact] ${message}`);
        // 出声路径尽量**指到具体那个键**（谁缺就说谁），这样调用方能一键定位
        const missingKey = (limitRaw as { retainRatio?: unknown } | null)?.retainRatio === undefined ? "retainRatio" : "summary";
        issues?.push({ path: `history.limit.${missingKey}`, message });
    }
    return { limit: normalizeHistoryLimit(limitRaw) };
}

/** 判定所需的**事实**（全部可观测，不含预测） */
export interface AutoCompactFacts {
    /** 系统上下文（system 容器全文）与上一次真发相比变了没有 */
    systemContextChanged: boolean;
    /** 距上次请求的时长（ms）；null = 没有历史（首轮） */
    sinceLastRequestMs: number | null;
    /** 生效 TTL（由 cache-ttl 的实测夹逼 + 先验得出） */
    ttl: EffectiveTtl;
    /** 上下文窗口占用（**token 数** = 该会话最后一步实测用量 `usage.total`）；null = 未知（无用量账） */
    windowTokens: number | null;
    /**
     * 模型窗口上限（token，`contextLimitOf(model)`）；null = 未知。
     * 窗口未知 ⇒ 窗口触发**不判**（不拿缺省数猜一个阈值）。
     */
    windowLimitTokens: number | null;
    /**
     * 上次真发时**投递出去的那段历史** ≈ token（= 最后一步的 `historySelection.keptTokens`，同口径粗估）；
     * null = 还没有投递记录。它和 `windowTokens` 不是一回事：后者是整份请求的实测用量。
     */
    retainedTokens: number | null;
    /**
     * 已落盘的**压缩边界**（`turns.jsonl` 的 compaction entry —— ##432 刀 2 的事件制）：
     * null = 从没压过（投递 = 全量）。有它之后每步只按它切，不再重算。
     */
    /** 当前生效的压缩边界（v2 老账没有 windowTokens ⇒ 0） */
    boundary: { at: string; dropped: number; retainTokens: number; windowTokens: number } | null;
    /**
     * 本会话**一共写过几条压缩事件**（`turns.jsonl` 的 compaction entry）—— 「压缩次数」的真源。
     * ⚠️ 不是 `compact.jsonl` 的条数：那份自 ##431 起是纯审计日志，两者在界面上要分开叫。
     */
    compactionCount: number;
}

/**
 * 判定该压不该压 → 触发理由（**按紧急度排序**：撞墙最急，其次缓存白赚）。
 *
 * 为什么返回数组而不是布尔：多个理由同时成立时，账本要能如实记下**全部**理由
 * （`trigger` 字段取首个 = 主因，其余进日志说明）—— "为什么压"是给用户看的审计信息。
 */
export function detectAutoCompactTriggers(
    facts: AutoCompactFacts,
    cfg: AutoCompactConfig,
): CompactTrigger[] {
    const out: CompactTrigger[] = [];
    const t = cfg.triggers;
    // 窗口触发 = **比例**：实测用量 ≥ 窗口上限 × ratio。窗口 / 用量任一未知 ⇒ 不触发（不猜数）
    if (
        t.windowOverRatio > 0 &&
        facts.windowTokens !== null &&
        facts.windowLimitTokens !== null &&
        facts.windowLimitTokens > 0 &&
        facts.windowTokens >= facts.windowLimitTokens * t.windowOverRatio
    ) {
        out.push("contextWindowOver");
    }
    if (t.systemContextChanged && facts.systemContextChanged) out.push("systemContextChanged");
    if (t.cacheExpired && facts.sinceLastRequestMs !== null && cacheStateAfterGap(facts.sinceLastRequestMs, facts.ttl) === "dead") {
        out.push("cacheExpired");
    }
    return out;
}

/** 触发理由 → 中文说明（UI 提示与账本注释共用；一处文案，不许两处各写） */
export const TRIGGER_TEXT: Record<CompactTrigger, string> = {
    manual: "手动触发",
    systemContextChanged: "系统上下文已变化 → 前缀缓存已作废（此刻压缩无重建代价）",
    cacheExpired: "缓存已过期（距上次请求超过生效 TTL）→ 冷启动，压缩无重建代价",
    contextWindowOver: "上下文窗口占用超过模型窗口的比例阈值（不压就撞墙）",
};

/**
 * 自动压缩的生效策略（提要：`autoCompactPolicyInput(cfg)` → 直接就是决策树）。
 * 保留这个包装只为把「配置 → 策略」这点语义显式化（调用点读起来是"要压什么"，而不是"读了个字段"）。
 */
export function autoCompactPolicyInput(cfg: AutoCompactConfig): CompactPolicy {
    return cfg.policy;
}
