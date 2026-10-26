// src/main/services/tool-result-guard.ts
// 🎯 投递前兜底：**assistant 的 tool-call 必须有 tool-result**，缺的补占位（##445）
//
// 病灶（##444，2026-10-26 15:54Z）：整个轮次被一条本地抛错打死 ——
//   `❌ [llm] Tool result is missing for tool call call_248d39d02df14f35912f8d51.`
//   （`ai/dist/index.js` 的 `convertToLanguageModelPrompt` → `AI_MissingToolResultsError`）
// 关键事实：**请求根本没发出去**（流量日志里该任务 97 条全是 200，无 400）⇒ 不是上游拒绝，
// 是 SDK 在本地把 messages 转 prompt 时就报错（本仓 ai 版本以**流内 error part** 报出，不抛穿）；
// 而落盘的 llm.jsonl 里那个 callId 是**配对的**
// ⇒ 破坏发生在**装配投递**这一段（历史选择 / ops 重放 / toolout 读取）。
//
// 为什么必须有这道兜底（与「压缩配平」是两道独立防线）：
//   历史是**不可信输入** —— 任何环节丢一条 result，SDK 就把整轮打死（一步结果缺失 vs 整轮挂掉，
//   前者严重程度低一个量级）。所以投递前统一自检：缺 ⇒ 补一条**占位 result**，让模型看到
//   「这条结果丢了」，而不是让进程报错。
//
// ⚠️ 与 `##371 铁律`（条数 / 下标 = llm.jsonl 行号）的关系：
//   本函数**只可能新增消息**，且只在「历史已经坏了」时新增 —— 坏情况下那份历史本来也发不出去
//   （整轮报错），插入是净收益。健康历史**返回同一个数组引用**（幂等），调用方可据此判断
//   「有没有动手」；下标对齐语义在健康路径上完全不变。
//
// 调用点三处（都是「进 SDK 之前的最后一毫米」）：
//   ① runTurn 的 `sentOf`（首步 + token 预检重装）
//   ② `prepareStep` 的每步（第 2 步起 SDK 送回来的 messages）
//   ③ `previewSimulatedRequest`（预览必须与真发同形，否则预览撒谎）
import type { ModelMessage } from "ai";

/** 补出来的占位文案（与中断契约文案分开：这是「记录缺失」，不是「被中断」） */
export const MISSING_TOOL_RESULT_NOTICE = "[该工具结果已丢失 / 记录缺失]";

/** 一条没配上的 tool-call */
export interface UnpairedToolCall {
    toolCallId: string;
    toolName: string;
    /** 它所在的 assistant 消息下标（诊断用） */
    messageIndex: number;
}

/** 配对体检结果（纯读，不改消息；B 段定位用它打印差集） */
export interface ToolPairScan {
    /** 有 tool-call 但没有对应 result 的（按消息顺序） */
    missing: UnpairedToolCall[];
    /** 有 result 但没有对应 call 的 toolCallId（孤儿结果，只报告不改） */
    orphanResults: string[];
}

/** 从一条消息里取 tool-call 的 id/toolName（非 assistant / 字符串内容 ⇒ 空） */
function toolCallsOf(m: ModelMessage): Array<{ toolCallId: string; toolName: string }> {
    if (m.role !== "assistant" || typeof m.content === "string") return [];
    const out: Array<{ toolCallId: string; toolName: string }> = [];
    for (const p of m.content) {
        if (p.type === "tool-call") out.push({ toolCallId: p.toolCallId, toolName: String(p.toolName ?? "unknown") });
    }
    return out;
}

/** 从一条消息里取 tool-result 的 id（非 tool / 字符串内容 ⇒ 空） */
function toolResultsOf(m: ModelMessage): string[] {
    if (m.role !== "tool" || typeof m.content === "string") return [];
    const out: string[] = [];
    for (const p of m.content) {
        if (p.type === "tool-result") out.push(p.toolCallId);
    }
    return out;
}

/**
 * 体检：哪些 tool-call 没有 result、哪些 result 没有 call。
 *
 * 只做**一次线性扫描**：assistant 的 call 集合与紧跟其后的连续 tool 消息（OpenAI 协议要求
 * result 必须紧跟在带 tool_calls 的 assistant 之后）求差集。
 */
export function scanToolResultPairs(msgs: readonly ModelMessage[]): ToolPairScan {
    const missing: UnpairedToolCall[] = [];
    const orphanResults: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    while (i < msgs.length) {
        const m = msgs[i]!;
        if (m.role === "tool") {
            // 走到这里说明前面没有消费它的 assistant ⇒ 孤儿（正常历史里不该出现）
            for (const id of toolResultsOf(m)) if (!seen.has(id)) orphanResults.push(id);
            i += 1;
            continue;
        }
        const calls = toolCallsOf(m);
        if (calls.length === 0) {
            i += 1;
            continue;
        }
        let j = i + 1;
        const answered = new Set<string>();
        while (j < msgs.length && msgs[j]!.role === "tool") {
            for (const id of toolResultsOf(msgs[j]!)) answered.add(id);
            j += 1;
        }
        for (const c of calls) {
            seen.add(c.toolCallId);
            if (!answered.has(c.toolCallId)) missing.push({ ...c, messageIndex: i });
        }
        i = j;
    }
    return { missing, orphanResults };
}

/** 补一条占位 result（形状与 local-blocks 的 tool 消息同构，模型/上游看不出差别） */
function placeholderResult(toolCallId: string, toolName: string): ModelMessage {
    return {
        role: "tool",
        content: [
            {
                type: "tool-result",
                toolCallId,
                toolName,
                output: { type: "text", value: MISSING_TOOL_RESULT_NOTICE },
            },
        ],
    } as ModelMessage;
}

/**
 * 投递前兜底：把「缺 result 的 tool-call」补齐（占位文案 `MISSING_TOOL_RESULT_NOTICE`）。
 *
 * 三态：
 *   · 没缺 ⇒ **原样返回同一引用**（连浅拷贝都不做；SDK 看到 messages 未变，不砸前缀缓存）；
 *   · 缺一条 / 多条 ⇒ 在**那个 assistant 之后连续的 tool 消息之后**插入占位（不挪动既有消息，
 *     只做插入 —— 保住「下标尽量稳定」与协议的「result 紧跟 assistant」两条）；
 *   · 孤儿 result（有 result 没 call）⇒ **不动**，只由 `scanToolResultPairs` 报告
 *     （删消息的代价比多一条更难评估，且当前报错形态不是它）。
 */
export function ensureToolResultPairs(msgs: readonly ModelMessage[]): ModelMessage[] {
    const src = msgs as ModelMessage[];
    const { missing } = scanToolResultPairs(src);
    if (missing.length === 0) return src;

    // 按「插入点」分组：同一 assistant 的一组占位插在它那段 tool 消息之后
    const byInsertAt = new Map<number, UnpairedToolCall[]>();
    for (const miss of missing) {
        // 找该 assistant 之后的连续 tool 段末尾
        let at = miss.messageIndex + 1;
        while (at < src.length && src[at]!.role === "tool") at += 1;
        const list = byInsertAt.get(at) ?? [];
        list.push(miss);
        byInsertAt.set(at, list);
    }

    const out: ModelMessage[] = [];
    for (let i = 0; i <= src.length; i += 1) {
        const fill = byInsertAt.get(i);
        if (fill) for (const miss of fill) out.push(placeholderResult(miss.toolCallId, miss.toolName));
        if (i < src.length) out.push(src[i]!);
    }
    return out;
}
