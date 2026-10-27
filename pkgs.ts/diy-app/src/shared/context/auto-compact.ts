// src/shared/context/auto-compact.ts
// 🎯 自动压缩的配置契约 + 触发判定（纯函数，禁止 import node:*）
//
// ##442 最大精简（2026-10-27 用户拍板）：
//   · 触发线 = `W − max(10%W, 16k)` —— **零旋钮**，不再有 windowOverRatio / token 绝对值；
//   · 保留量 = `W × 0.16` —— 固定，不配置；
//   · 配置面只剩 `history.limit.summary.mode`（model / self）与工具结果呈现 `policy`；
//   · 旧字段（triggers / limitTokens / summary.enabled / mode）读时忽略并出声。

import { z } from "zod";
import { triggerTokensOf } from "./select-kept-boundary";
import { HistoryLimitSchema, isCompleteHistoryLimit, normalizeHistoryLimit, type HistoryLimit } from "./history-limit";
import {
    CompactPolicySchema,
    DEFAULT_TOOL_RESULT_POLICY,
    normalizePolicy,
    type CompactPolicy,
    type CompactTrigger,
} from "./compaction";

/** 压缩配置：工具结果呈现 + 摘要模式（就这两项） */
export const AutoCompactConfigSchema = z.object({
    policy: CompactPolicySchema.describe("工具结果呈现（asis / headtail / callpath）"),
    history: z
        .object({ limit: HistoryLimitSchema.optional() })
        .optional()
        .describe("历史压缩：只剩摘要模式（model / self）"),
});

export interface AutoCompactConfig {
    policy: CompactPolicy;
    history?: { limit?: HistoryLimit };
}

export type AutoCompactIssue = {
    /** 出问题的键路径（点号连接） */
    path: string;
    /** 人读说明（必带「已回落成什么」） */
    message: string;
};

export const DEFAULT_AUTO_COMPACT: AutoCompactConfig = {
    policy: {
        mode: "budget",
        modeData: { toolResult: DEFAULT_TOOL_RESULT_POLICY },
        summary: false,
    },
    history: { limit: { summary: { mode: "model" } } },
};

/** zod issue → 人读原因（只留必要字段，跨 zod 版本不炸） */
interface ZodIssueLike {
    code: string;
    path: readonly PropertyKey[];
    message: string;
    expected?: unknown;
    values?: readonly unknown[];
}

function describeZodIssue(i: ZodIssueLike): string {
    if (i.code === "invalid_type") {
        return i.message.includes("received undefined") ? "缺失（必填）" : `类型不符（期望 ${String(i.expected)}）`;
    }
    if (i.code === "invalid_value") return `取值非法（合法值：${(i.values ?? []).map(String).join(" / ")}）`;
    return i.message;
}

export function autoCompactIssuesFromZod(error: z.ZodError, resolved: AutoCompactConfig): AutoCompactIssue[] {
    return (error.issues as unknown as ZodIssueLike[]).map((i) => {
        const path = i.path.map((k) => String(k)).join(".");
        const where = path === "" ? "（整份配置）" : path;
        let cur: unknown = resolved;
        for (const k of i.path) {
            if (cur === null || typeof cur !== "object") {
                cur = undefined;
                break;
            }
            cur = (cur as Record<PropertyKey, unknown>)[k];
        }
        const fallback = cur === undefined ? "缺省值" : typeof cur === "object" ? "缺省值" : String(cur);
        return { path, message: `${where}：${describeZodIssue(i)}；已回落 ${fallback}` };
    });
}

function warnDead(issues: AutoCompactIssue[] | undefined, path: string, why: string): void {
    const message = `${path} ${why} → 已忽略`;
    console.warn(`[auto-compact] ${message}`);
    issues?.push({ path, message });
}

/**
 * 宽松归一：读 `policy` 与 `history.limit.summary.mode`；
 * 旧字段一律忽略并出声（不保留兼容壳）。
 */
export function normalizeAutoCompact(raw: unknown, issues?: AutoCompactIssue[]): AutoCompactConfig {
    const src = (raw ?? {}) as Record<string, unknown>;
    if (src["mode"] !== undefined) warnDead(issues, "mode", "已删除（##442：到点就压）");
    if (src["triggers"] !== undefined) warnDead(issues, "triggers", "已删除（##442：触发线是派生量，零旋钮）");
    const hist = (src["history"] ?? {}) as Record<string, unknown>;
    if (hist["keep"] !== undefined) warnDead(issues, "history.keep", "已删除（##432）");
    if (hist["allowAgentWrite"] !== undefined) warnDead(issues, "history.allowAgentWrite", "已删除（##432）");
    const limit = (hist["limit"] ?? {}) as Record<string, unknown>;
    if (limit["limitTokens"] !== undefined)
        warnDead(issues, "history.limit.limitTokens", "已删除（##442：保留量固定 W×0.16）");
    const summary = (limit["summary"] ?? {}) as Record<string, unknown>;
    if (summary["enabled"] !== undefined)
        warnDead(issues, "history.limit.summary.enabled", "已删除（改成 summary.mode）");
    if (Array.isArray(hist["limit"]) || typeof hist["limit"] === "string") {
        warnDead(issues, "history.limit", "形状不对（应为对象）");
    }
    if (!isCompleteHistoryLimit(limit)) {
        const message = "history.limit.summary.mode 缺失或非法；已回落 model";
        issues?.push({ path: "history.limit.summary.mode", message });
    }
    return {
        policy: src["policy"] !== undefined ? normalizePolicy(src["policy"]) : DEFAULT_AUTO_COMPACT.policy,
        history: { limit: normalizeHistoryLimit(limit) },
    };
}

/** 判定所需的**事实**（只保留窗口相关；其余字段留给旧 UI 读，不再参与触发） */
export interface AutoCompactFacts {
    /** 上下文窗口占用（token = 最后一步实测 usage.total）；null = 未知 */
    windowTokens: number | null;
    /** 模型窗口上限；null = 未知（不压，不猜数） */
    windowLimitTokens: number | null;
    /** 上次真发投递的历史 ≈ token（UI 展示用） */
    retainedTokens: number | null;
    /** 已落盘边界（UI 展示用） */
    boundary: { at: string; dropped: number; limitTokens: number } | null;
    /** 压缩事件条数（UI 展示用） */
    compactionCount: number;
    /** 旧 UI 字段（不再参与触发） */
    systemContextChanged?: boolean;
    sinceLastRequestMs?: number | null;
    ttl?: unknown;
}

/**
 * 该不该压：**一个比较**。
 * `windowTokens >= W − max(10%W, 16k)`；任一未知 ⇒ 不触发。
 */
export function detectAutoCompactTriggers(facts: AutoCompactFacts, _cfg?: AutoCompactConfig): CompactTrigger[] {
    const w = facts.windowLimitTokens;
    const used = facts.windowTokens;
    if (w === null || used === null || !(w > 0)) return [];
    return used >= triggerTokensOf(w) ? ["contextWindowOver"] : [];
}

/** 触发理由 → 中文说明（UI / 账本共用） */
export const TRIGGER_TEXT: Record<CompactTrigger, string> = {
    manual: "手动触发",
    systemContextChanged: "系统上下文已变化（旧触发，##442 已删）",
    cacheExpired: "缓存已过期（旧触发，##442 已删）",
    contextWindowOver: "上下文窗口占用到触发线（窗口 − max(10%, 16k)）",
};

export function autoCompactPolicyInput(cfg: AutoCompactConfig): CompactPolicy {
    return cfg.policy;
}
