// src/shared/context/delivery-badge.ts
// 🎯 「投递」徽章的**文案真源**（##423）：徽章到底在说什么维度 + 压缩三触发器的现场。
//
// ── 病根（用户 2026-10-23）──
// 旧文案 `投递·全量` 的真实含义是「这一步一条历史消息都没丢」（**历史裁剪维度**），
// 但在 runtime 语境里读起来像「runtime 全量投递」⇒ 用户以为是 runtime 的事。
// 结论：**文案必须自带维度名**（`历史·…`），且三个跨维度的词（全量 / 投递 / 压缩）
// 不许裸用 —— 「全量」在这里既不是 runtime 全量、也不是会话全量，只表示「本轮没人被丢」。
//
// ── 为什么做纯函数 ──
// 徽章文本 / hover 是**契约**（意图测试断言它），必须可单测；组件只负责取数。
// 文案归出口：主进程不拼句子，渲染层不拼数字，这份函数同时被 UI 用与单测钉。

import type { CompactTrigger } from "./compaction";
import { DEFAULT_KEEP, type KeepStage } from "./compact-keep";

/** 该步（轮首）投递时的历史选择事实（= `StepUsageRecord.historySelection`） */
export interface DeliverySelection {
    budgetBytes: number;
    keptBytes: number;
    keptRuns: number;
    droppedMessages: number;
    totalMessages: number;
}

/** 本步命中的压缩事件（只取判断徽章需要的两个字段） */
export interface DeliveryHit {
    trigger: CompactTrigger;
    by: "ui" | "cli" | "auto";
}

/** 当前生效的自动压缩配置（只取**说清触发条件**需要的字段；缺省 = 没读到 → 不编数字） */
export interface DeliveryTriggerCfg {
    mode: "off" | "notify" | "auto";
    triggers: { systemContextChanged: boolean; cacheExpired: boolean; contextWindowOver: number };
    /** 生效 TTL（毫秒）；`null` = 无实测也无先验 → 不写时长 */
    ttlMs: number | null;
    /** 装配管道里 **must 级**（必保、不吃预算）；空数组 = 没有任何必保级 */
    mustStages: { type: string; summary: string }[];
}

export interface DeliveryBadgeInput {
    selection: DeliverySelection;
    /** 本步命中的压缩事件（升序；空 = 未命中） */
    hits: DeliveryHit[];
    /** 当前配置；`null` = 未读到（徽章只讲历史裁剪，不编触发条件） */
    cfg: DeliveryTriggerCfg | null;
    /** 本步实测窗口占用 token（= 总输入 + 总输出）；无实测 → null（不编 0） */
    stepTokens: number | null;
}

/** 触发器 → 人读短名（徽章与压缩详情共用同一套词） */
export const TRIGGER_LABEL: Record<CompactTrigger, string> = {
    manual: "手动",
    systemContextChanged: "系统上下文变",
    cacheExpired: "缓存过期",
    contextWindowOver: "窗口超限",
};

/** 字节人读：0 是「清零」（不是 0 字节上限的另一种说法），其余按 KB / B */
export function fmtBudgetBytes(n: number): string {
    if (n === 0) return "0（清零）";
    return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

/** 徽章**文本**：维度必须写在词里（`历史·…`），不再出现裸「全量」 */
export function deliveryBadgeText(sel: DeliverySelection): string {
    return sel.droppedMessages > 0 ? `历史·丢 ${sel.droppedMessages} 条` : "历史·无裁剪";
}

/** 一条级 → 短摘要（`steps n=6` / `role tool` …）；只为人读，不参与判据 */
export function stageSummary(s: KeepStage): string {
    const d = (s as { data?: Record<string, unknown> }).data ?? {};
    const n = d["n"];
    const role = d["role"];
    if (typeof n === "number") return `${s.type} n=${n}`;
    if (typeof role === "string") return `${s.type} ${role}`;
    return s.type;
}

/** 生效管道里的 must 级（配置没写 `history.keep` ⇒ 回落代码缺省管道） */
export function mustStagesOf(keep: readonly KeepStage[] | undefined): { type: string; summary: string }[] {
    const plan = keep && keep.length > 0 ? keep : DEFAULT_KEEP;
    return plan.filter((s) => (s as { must?: boolean }).must === true).map((s) => ({
        type: s.type,
        summary: stageSummary(s),
    }));
}

/** 触发器三行（本步命中 / 阈值 / 实测值）—— 徽章 hover 的主体 */
function triggerLines(cfg: DeliveryTriggerCfg, input: DeliveryBadgeInput): string[] {
    const t = cfg.triggers;
    const hits = input.hits;
    const line = (label: string, state: string) => `- ${label}：${state}`;

    const { systemContextChanged, cacheExpired, contextWindowOver } = t;

    // ① 系统上下文变：配置开/关 + 本步是否因此压过
    const hitOf = (trig: CompactTrigger) => hits.some((h) => h.trigger === trig);
    const sysState = !systemContextChanged
        ? "已关闭"
        : hitOf("systemContextChanged")
          ? "开 · 本步命中（system 容器与上次真发不同 → 前缀缓存作废）"
          : "开 · 本步未命中（system 容器与上次真发一致）";

    // ② 缓存过期：配置开/关 + 生效 TTL
    const ttl = cfg.ttlMs != null && cfg.ttlMs > 0 ? `${Math.round(cfg.ttlMs / 60000)} 分钟` : "未知";
    const cacheState = !cacheExpired
        ? "已关闭"
        : hitOf("cacheExpired")
          ? `开 · 本步命中（距上次请求超过生效 TTL ${ttl}）`
          : `开 · 本步未命中（距上次请求未超生效 TTL ${ttl}）`;

    // ③ 窗口超限：阈值 + 本步实测（有实测才报 vs，没有就如实说无法判定）
    const overLimit = contextWindowOver > 0 ? `${contextWindowOver} tok` : null;
    const winState = !overLimit
        ? "已关闭（上限 0 = 关闭该触发）"
        : hitOf("contextWindowOver")
          ? `开 · 本步命中（实测 ${input.stepTokens == null ? "无实测" : `${input.stepTokens} tok`} vs 上限 ${overLimit}）`
          : `开 · 本步未命中（实测 ${input.stepTokens == null ? "无实测" : `${input.stepTokens} tok`} vs 上限 ${overLimit}）`;

    const manual = hits.filter((h) => h.trigger === "manual").length;
    const rows = [
        line("systemContextChanged", sysState),
        line("cacheExpired", cacheState),
        line("contextWindowOver", winState),
    ];
    // 手动压不属三触发器 —— 不解释清楚会被当成「三个都未命中却压过」
    if (manual > 0) rows.push(`- 另有手动压缩 ${manual} 次（不属触发器，由界面/命令行发起）`);
    return rows;
}

/**
 * 徽章 **hover 全文**（多行）。
 *
 * 四块，缺一不可：
 *   ① 维度：这是**历史裁剪**，与 runtime 无关
 *   ② 本步事实：预算 / 丢几条 / 保留几段
 *   ③ **must 级不吃预算**（「压完还超预算、于是每轮都在压」的根因，必须写在脸上）
 *   ④ 三触发器的配置与**本步命中**（阈值 + 实测，不再只说「预算多少」）
 */
export function deliveryBadgeTitle(input: DeliveryBadgeInput): string {
    const s = input.selection;
    const cfg = input.cfg;
    const out: string[] = [];
    out.push(
        `历史裁剪（本步投递的唯一维度，与 runtime 无关）：预算 ${fmtBudgetBytes(s.budgetBytes)}` +
            ` · 丢 ${s.droppedMessages}/${s.totalMessages} 条 · 保留 ${s.keptRuns} 段` +
            ` · 实际保留 ${fmtBudgetBytes(s.keptBytes)}`,
    );
    // ③ must 级：预算只约束非 must 级 —— 压完还超预算、每轮都在压的根因
    out.push("预算只约束非 must 级：must 级（必保）不吃预算，压完仍可能超预算，于是每轮都在压。");
    if (cfg) {
        const must = cfg.mustStages.length
            ? cfg.mustStages.map((m) => m.summary).join(" / ")
            : "无（本 plan 没有必保级）";
        out.push(`本 plan 的 must 级：${must}`);
        out.push(`压缩触发器（mode=${cfg.mode}）：`);
        out.push(...triggerLines(cfg, input));
    } else {
        out.push("压缩触发器：配置未读到（本徽章只讲历史裁剪事实）");
    }
    return out.join("\n");
}
