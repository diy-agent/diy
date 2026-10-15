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

import { z } from "zod";
import { cacheStateAfterGap, type EffectiveTtl } from "./cache-ttl";
import { validateKeepStages, type KeepStage } from "./compact-keep";
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
    keep: z
        .array(z.unknown())
        .optional()
        .describe("级列表 `{ type, must?, limit?, clip?, data }`（形状见 shared/context/compact-keep.ts）；缺省回落默认管道"),
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
    /** 级列表（已校验；非法 / 空列表在此缺席 = 回落缺省管道） */
    history?: { keep: KeepStage[] };
}
export type AutoCompactTriggers = z.infer<typeof AutoCompactTriggersSchema>;

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
export function normalizeWindowOver(v: unknown): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return DEFAULT_WINDOW_OVER_TOKENS;
    if (v > 0 && v < 1) {
        console.warn(
            `[auto-compact] contextWindowOver=${v} 疑似旧比例值；现单位为 **token 数**，已回落默认 ${DEFAULT_WINDOW_OVER_TOKENS}（≈150KB）`,
        );
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
 */
export function normalizeAutoCompact(raw: unknown): AutoCompactConfig {
    const src = (raw ?? {}) as Record<string, unknown>;
    const t = (src["triggers"] ?? {}) as Record<string, unknown>;
    const mode = src["mode"] === "off" || src["mode"] === "auto" ? src["mode"] : "notify";
    const history = normalizeHistory(src["history"]);
    return {
        mode,
        triggers: {
            systemContextChanged: t["systemContextChanged"] !== false,
            cacheExpired: t["cacheExpired"] !== false,
            contextWindowOver: normalizeWindowOver(t["contextWindowOver"]),
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
function normalizeHistory(raw: unknown): { keep: KeepStage[] } | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const keepRaw = (raw as Record<string, unknown>)["keep"];
    if (keepRaw === undefined) return undefined;
    const { stages, issues } = validateKeepStages(keepRaw);
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
        console.warn(`[auto-compact] history.keep 非法（${errors.map((e) => e.message).join("；")}）→ 回落缺省管道`);
        return undefined;
    }
    if (stages.length === 0) {
        console.warn("[auto-compact] history.keep 是空级列表 → 回落缺省管道（要清零请把 policy.modeData.budgetBytes 设为 0）");
        return undefined;
    }
    return { keep: stages };
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
