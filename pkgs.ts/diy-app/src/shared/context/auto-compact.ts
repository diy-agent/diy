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
//   `contextWindow` = 上下文窗口（对齐 LOCAL_MODELS.contextLimit；不叫 tokenWindow，那会与"输出 token 数"混）

import { z } from "zod";
import { cacheStateAfterGap, type EffectiveTtl } from "./cache-ttl";
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
        .describe("上下文窗口占用比例上限（0~1）；0 = 关闭该触发。撞墙即压，不是划不划算的问题"),
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
});
export type AutoCompactConfig = z.infer<typeof AutoCompactConfigSchema>;
export type AutoCompactTriggers = z.infer<typeof AutoCompactTriggersSchema>;

/**
 * 默认配置。**默认 `notify`**（不静默改用户的会话）：
 * 静默压缩是在用户背后丢他的对话历史，且损失不可见 —— 与 `rule.no-silent-catch` 同一条原则。
 * `auto` 要用户显式开（开了也会写账本 + 有理由可查）。
 */
export const DEFAULT_AUTO_COMPACT: AutoCompactConfig = {
    mode: "notify",
    triggers: { systemContextChanged: true, cacheExpired: true, contextWindowOver: 0.8 },
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
    const num = (v: unknown, d: number, min: number, max: number): number =>
        typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d;
    const mode = src["mode"] === "off" || src["mode"] === "auto" ? src["mode"] : "notify";
    return {
        mode,
        triggers: {
            systemContextChanged: t["systemContextChanged"] !== false,
            cacheExpired: t["cacheExpired"] !== false,
            contextWindowOver: num(t["contextWindowOver"], DEFAULT_AUTO_COMPACT.triggers.contextWindowOver, 0, 1),
        },
        // 策略（自动 / 手动**同一套**）→ 交给 normalizePolicy 统一宽松归一；
        // 缺省用 DEFAULT_AUTO_COMPACT.policy（见本函数头注）。
        policy: src["policy"] !== undefined ? normalizePolicy(src["policy"]) : DEFAULT_AUTO_COMPACT.policy,
    };
}

/** 判定所需的**事实**（全部可观测，不含预测） */
export interface AutoCompactFacts {
    /** 系统上下文（system 容器全文）与上一次真发相比变了没有 */
    systemContextChanged: boolean;
    /** 距上次请求的时长（ms）；null = 没有历史（首轮） */
    sinceLastRequestMs: number | null;
    /** 生效 TTL（由 cache-ttl 的实测夹逼 + 先验得出） */
    ttl: EffectiveTtl;
    /** 上下文窗口占用比（0~1）；null = 未知（无 usage） */
    windowRatio: number | null;
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
    if (t.contextWindowOver > 0 && facts.windowRatio !== null && facts.windowRatio >= t.contextWindowOver) {
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
    contextWindowOver: "上下文窗口占用超过上限（不压就撞墙）",
};

/**
 * 自动压缩的生效策略（提要：`autoCompactPolicyInput(cfg)` → 直接就是决策树）。
 * 保留这个包装只为把「配置 → 策略」这点语义显式化（调用点读起来是"要压什么"，而不是"读了个字段"）。
 */
export function autoCompactPolicyInput(cfg: AutoCompactConfig): CompactPolicy {
    return cfg.policy;
}
