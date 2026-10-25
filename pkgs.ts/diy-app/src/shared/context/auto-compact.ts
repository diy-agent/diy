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
import { validateKeepStages, type KeepStage } from "./compact-keep";
import { HistoryLimitSchema, type HistoryLimit } from "./history-limit";
import {
    CompactPolicySchema,
    DEFAULT_BUDGET_BYTES,
    DEFAULT_TOOL_RESULT_POLICY,
    normalizePolicy,
    type CompactPolicy,
    type CompactTrigger,
} from "./compaction";

/** 自动压缩的触发配置（三个都是可判定的确定事实） */
export const AutoCompactTriggersSchema = z.object({
    systemContextChanged: z.boolean().describe("系统上下文变了 → 前缀缓存必作废；此刻压缩零重建代价"),
    cacheExpired: z.boolean().describe("缓存已过期（距上次请求 > 生效 TTL）→ 同上，冷启动压缩是白赚"),
    contextWindowOver: z
        .number()
        .describe(
            "上下文窗口占用上限（**token 数** = 该会话最后一步实测用量 usage.total，见 ##268 §6.9 D7）；" +
                "0 = 关闭该触发。撞墙即压，不是划不划算的问题",
        ),
});

/**
 * `history` —— 「留给模型的历史消息」怎么装配（##344 M2 新增；压缩的**作用对象**）。
 *
 * 与 `policy` 的分工：`policy` 是**旋钮**（预算 / 工具结果全局呈现），`history.keep[]` 是**管道**
 * （级列表：每条取法留哪些、怎么裁）。缺 `keep` ⇒ 回落代码缺省管道（= ##343 M1 的 `defaultBudgetPlan`）。
 * 形状与校验的真源：`shared/context/compact-keep.ts`（此处只保证「是个数组」，容错归一在 normalizeAutoCompact）。
 */
export const AutoCompactHistorySchema = z.object({
    /**
     * 【##432 刀 2】**唯一的历史预算**：一条 token 上限（+ 摘要开关）。
     * 缺省 = `DEFAULT_HISTORY_LIMIT`（20000 token / 摘要关）。
     */
    limit: HistoryLimitSchema.optional().describe("历史预算：一条 token 上限 + 摘要开关（##432 刀 2 的唯一旋钮）"),
    keep: z
        .array(z.unknown())
        .optional()
        .describe("级列表 `{ type, must?, limit?, clip?, data }`（形状见 shared/context/compact-keep.ts）；缺省回落默认管道"),
    /**
     * **闸**：允许本地 agent 经 `compact_plan` 工具改写 plan（##362 M3a）。
     *
     * 缺省 `false` = agent 只读（get / check 始终可用）——plan 是**全局配置**，改它等于改所有任务、
     * 所有 agent 的投递；给手的同时必须给闸，且闸的缺省方向只能是"关"（写坏 keep ⇒ 全库会话静默丢上下文）。
     * 人工入口（CLI `compact plan set` / UI 编辑器）**不受此闸约束**：那是用户自己的显式操作。
     */
    allowAgentWrite: z
        .boolean()
        .optional()
        .describe("允许本地 agent 写 plan（缺省 false；CLI/UI 不受此闸约束）"),
});

export const AutoCompactConfigSchema = z.object({
    mode: z
        .enum(["off", "notify", "auto"])
        .describe("off 不检测；notify 检测并提示（默认）；auto 检测到就压"),
    triggers: AutoCompactTriggersSchema,
    /**
     * 压缩策略（自动 / 手动**同一套**）—— 直接复用 `CompactPolicy`（含 `summary`）。
     *
     * 自动压的"压什么"与手动压完全同类，就用同一个真源（差异只在**谁触发**，由 `mode`/`triggers` 表达）；
     * 各造一个形状必然分叉。
     */
    policy: CompactPolicySchema.describe("自动压时用的策略（与手动面板同一真源形状）"),
    history: AutoCompactHistorySchema.optional().describe("历史装配管道（级列表）；缺省 = 回落代码缺省管道"),
});
/**
 * 配置真源类型（**手写**而非 `z.infer`）：`history.keep` 在 schema 里是 `unknown[]`（容错由
 * `normalizeAutoCompact` 用 `validateKeepStages` 做，非法级**只丢 history、不丢整份配置**），
 * 而对外读到的必然是**校验过的** `KeepStage[]` —— 两者不同，不能靠 z.infer 硬凑。
 */
export interface AutoCompactConfig {
    mode: "off" | "notify" | "auto";
    triggers: AutoCompactTriggers;
    policy: CompactPolicy;
    /**
     * 级列表（已校验；非法 / 空列表 ⇒ `keep` 缺席 = 回落缺省管道）+ agent 写闸。
     * ⚠️ `keep` 缺席 ≠ `history` 缺席：只写了 `allowAgentWrite` 的配置也要能读到闸。
     */
    history?: { limit?: HistoryLimit; keep?: KeepStage[]; allowAgentWrite?: boolean };
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
 * 窗口触发默认阈值（**token 域**，用户 2026-10-15 拍板 = 固定数字）：
 * 38400 token —— 用户口径「窗口占用到 150KB 就压」（150×1024 字节 ÷ 4 ≈ 38400 token）。
 * 判据 = 该会话**最后一步实测用量**（`usage.total`，真实 token 数）≥ 本值 ⇒ 压。
 *
 * **不是比例**（旧 `0.8` 在 1M 窗口上 ≈ 80 万 token 才触发 ⇒ 等于不压，等爆），
 * **也不是投影字节 / 字符数 / 文本量**。常量先写死（用户：「随时可以改」），
 * 将来变量树就地编辑（##268 §6.10）再迁。
 */
export const DEFAULT_WINDOW_OVER_TOKENS = 38400;

/**
 * 窗口阈值归一（单位：**token 数**）。
 *
 * 【单位迁移】旧单位是**比例**（0~1，×contextLimit）。两单位在 (0,1) 区间**冲突**：
 * 旧的 `0.8` 会被当 0.8 token → 几乎必然触发（每轮都压，误伤用户的会话）。
 * 故把 `(0,1)` 视为**旧比例值**：出声告警并回落默认（38400），绝不静默把它当 token 用。
 * `0` = 关闭、`>=1` = 合法 token 阈值，原样保留。
 */
export function normalizeWindowOver(v: unknown, issues?: AutoCompactIssue[]): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return DEFAULT_WINDOW_OVER_TOKENS;
    if (v > 0 && v < 1) {
        const message = `contextWindowOver=${v} 疑似旧比例值；现单位为 **token 数**，已回落默认 ${DEFAULT_WINDOW_OVER_TOKENS}（≈150KB）`;
        console.warn(`[auto-compact] ${message}`);
        issues?.push({ path: "triggers.contextWindowOver", message });
        return DEFAULT_WINDOW_OVER_TOKENS;
    }
    return v;
}

/**
 * 默认配置。**默认 `notify`**（不静默改用户的会话）：
 * 静默压缩是在用户背后丢他的对话历史，且损失不可见 —— 与 `rule.no-silent-catch` 同一条原则。
 * `auto` 要用户显式开（开了也会写账本 + 有理由可查）。
 */
export const DEFAULT_AUTO_COMPACT: AutoCompactConfig = {
    mode: "notify",
    triggers: { systemContextChanged: true, cacheExpired: true, contextWindowOver: DEFAULT_WINDOW_OVER_TOKENS },
    // 目标式预算：默认 3KB（≈清零）—— 用户 2026-10-07「更倾向于清零，经验上也没啥大不了」。
    // 自动压与手动压**同一套策略**（合并后不再有第二套）。
    policy: {
        mode: "budget",
        modeData: { budgetBytes: DEFAULT_BUDGET_BYTES, toolResult: DEFAULT_TOOL_RESULT_POLICY },
        summary: false,
    },
};

/**
 * 宽松归一（从 YAML/UI 来的可能缺字段/越界）：初版紧凑、扩展松散。
 *
 * 缺 `policy` 时用 `DEFAULT_AUTO_COMPACT.policy`（目标式预算 3KB），**不**用 `normalizePolicy({})`
 * 的缺省 —— 缺省值必须有依据，不能顺手取一个（见 `DEFAULT_AUTO_COMPACT` 的注释）。
 *
 * 可选的 `issues` 收集器：凡**本函数改动过**（缺键补缺省、旧单位迁移、坏 keep 丢弃）的地方各推一条
 * 出声（##370）—— 归一**不再静默**，调用方（plan get / UI）据此把"为什么"说给用户。
 */
export function normalizeAutoCompact(raw: unknown, issues?: AutoCompactIssue[]): AutoCompactConfig {
    const src = (raw ?? {}) as Record<string, unknown>;
    const t = (src["triggers"] ?? {}) as Record<string, unknown>;
    const mode = src["mode"] === "off" || src["mode"] === "auto" ? src["mode"] : "notify";
    const history = normalizeHistory(src["history"], issues);
    return {
        mode,
        triggers: {
            systemContextChanged: t["systemContextChanged"] !== false,
            cacheExpired: t["cacheExpired"] !== false,
            contextWindowOver: normalizeWindowOver(t["contextWindowOver"], issues),
        },
        // 策略（自动 / 手动**同一套**）→ 交给 normalizePolicy 统一宽松归一；
        // 缺省用 DEFAULT_AUTO_COMPACT.policy（见本函数头注）。
        policy: src["policy"] !== undefined ? normalizePolicy(src["policy"]) : DEFAULT_AUTO_COMPACT.policy,
        // history 只在**校验通过且非空**时出现（否则缺席 = 回落缺省管道）。见 normalizeHistory。
        ...(history ? { history } : {}),
    };
}

/**
 * `history` 的容错归一（**读侧宽松**，硬要求）：
 *   · 缺 `history` / 缺 `keep` → 缺席（= 回落缺省管道）；
 *   · `keep` 有**非法级** → 只丢 `history`（出声），**不丢整份配置**（mode/triggers/policy 照用）；
 *   · `keep: []`（空级列表）→ 同样回落缺省 —— 空列表的字面后果是「什么都不留」（= 清零），
 *     而"清空所有级"几乎都是编辑途中的手滑，不该静默把会话清掉。要清零请把预算设 0。
 */
function normalizeHistory(
    raw: unknown,
    issues?: AutoCompactIssue[],
): { limit?: HistoryLimit; keep?: KeepStage[]; allowAgentWrite?: boolean } | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const src = raw as Record<string, unknown>;
    // 闸的**权威读法**：只有字面 `true` 才算开（`"yes"` / `1` 之类不算 —— 闸的缺省方向是关）。
    const allowAgentWrite = src["allowAgentWrite"] === true ? (true as const) : undefined;
    const withGate = allowAgentWrite ? { allowAgentWrite } : {};
    // ##432 刀 2：`limit` 与旧 `keep` 各自独立归一（旧字段仍在，只是投递侧不再用它选）
    const limitRaw = src["limit"];
    const withLimit = limitRaw !== undefined ? { limit: HistoryLimitSchema.parse(limitRaw) } : {};
    /** 收口：空对象 = 「这份配置没有 history 节」（缺席），不是「空 history」 */
    const finish = (extra: Record<string, unknown> = {}) => {
        const out = { ...withLimit, ...withGate, ...extra };
        return Object.keys(out).length > 0 ? out : undefined;
    };
    const keepRaw = src["keep"];
    if (keepRaw === undefined) return finish();
    // ⚠️ 局部名别叫 `issues`：与参数（出声收集器）撞名 —— oxc 会报「不能重复声明」
    const checked = validateKeepStages(keepRaw);
    const stages = checked.stages;
    const errors = checked.issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
        const message = `history.keep 非法（${errors.map((e) => e.message).join("；")}）→ 回落缺省管道`;
        console.warn(`[auto-compact] ${message}`);
        issues?.push({ path: "history.keep", message });
        // 坏 keep 只丢 keep：闸是另一件事，不该被一并丢掉（否则用户开闸的意图会被一个笔误静默撤销）
        return finish();
    }
    if (stages.length === 0) {
        const message = "history.keep 是空级列表 → 回落缺省管道（要清零请把 policy.modeData.budgetBytes 设为 0）";
        console.warn(`[auto-compact] ${message}`);
        issues?.push({ path: "history.keep", message });
        return finish();
    }
    return finish({ keep: stages });
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
    if (t.contextWindowOver > 0 && facts.windowTokens !== null && facts.windowTokens >= t.contextWindowOver) {
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
    contextWindowOver: "上下文窗口占用超过上限（token 阈值；不压就撞墙）",
};

/**
 * 自动压缩的生效策略（提要：`autoCompactPolicyInput(cfg)` → 直接就是决策树）。
 * 保留这个包装只为把「配置 → 策略」这点语义显式化（调用点读起来是"要压什么"，而不是"读了个字段"）。
 */
export function autoCompactPolicyInput(cfg: AutoCompactConfig): CompactPolicy {
    return cfg.policy;
}
