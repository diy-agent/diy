// context-guard.ts —— **轮内水位**：这一步要发的东西会不会把窗口顶爆。
//
// 为什么需要它（2026-11-27 实证，task-mwlxxv3u）：
//   压缩只在**轮首**按「窗口 − max(10%,16k)」判一次（`session.ts::runTurn` 开头）。
//   可一轮最多 200 步、每步都全量重发，单条工具输出上限 50KB（≈1.7 万 token）——
//   几十个工具结果就能把请求从 20 万堆到 100 万以上。实测 opencode-go/deepseek-v4.1-flash：
//   窗口确确实实是 100 万（60 万 token 的请求都能过），而轮首 20 万时压缩不触发，
//   于是那样一轮跑到中途被网关回 `context_length_exceeded`，整轮作废；
//   更糟的是失败前每一步都已落 transcript ⇒ 下一轮起步即爆。
//
// 所以闸门要装在**每一步**上：本轮请求的估算超过**压缩那把尺子**的触发线，就把**最早的工具输出**
// 换成一行说明（结构 / toolCallId / 配对关系全部保留），降到**压缩的保留量**为止。
//
// 三条边界，别越过：
//   · **只影响这一次请求**（返回值只传给 `streamText`）：transcript、界面、下一轮全都不变 ——
//     丢历史是压缩的活，不是这里的活；
//   · **不动工具调用参数**（`write` 的 content 也是大块，但那是一次写的原始意图，删了工具就白跑了）；
//   · **不猜窗口**：`windowTokens` 未知 ⇒ 返回 null（与压缩判据同一条规矩）。

import type { ModelMessage } from 'ai';

import { estimateTokensOf, retainTokensOf, triggerTokensOf } from '@diy-agent/compaction';

/**
 * 两个阀值**不是新旋钮**，全部来自 `@diy-agent/compaction`：
 *   · 触发线 = `triggerTokensOf(W)` = `W − max(10%W, 16k)`（与压缩同一个函数）
 *   · 折到 = `retainTokensOf(W)` = `W × 0.16`（dsh `compaction-basic` 的 retainRatio）
 *
 * 参照：dsh 在 `agent/pre-step` 每步用 tokenMeter 对比 `W × thresholdRatio(0.8)`；
 * diy1（Electron）在发请求前用 `PREFLIGHT_RATIO = 0.8` 预检 system+tools+messages。
 * diy2 的 entity-runtime 两样都没搬过来（2026-11-27 实证的漏网），本文件补的就是这一段。
 */

/** 太小的工具输出折了没意义，反而多一行噪音 */
const MIN_COLLAPSIBLE_CHARS = 2_000;

export interface WatermarkOptions {
    /** 模型窗口（token）；未知就别调本函数 */
    windowTokens: number;
    /**
     * 除 messages 之外已经占掉的量（system + 工具定义）。
     *
     * 压缩判据只看 transcript，但**真发出去的是三段之和** —— diy1 的预检就是这么量的
     *（`estimateRequest`: system + tools + messages）。不给 = 0（只看 messages）。
     */
    fixedTokens?: number;
}

export interface WatermarkResult {
    messages: ModelMessage[];
    /** 折叠掉几条工具输出 */
    collapsed: number;
    /** 折叠前 / 后的估算（token） */
    before: number;
    after: number;
}

/**
 * 本步要发的消息估算（token）。
 *
 * 用 `estimateTokensOf`（CJK 1 字 1 token、其余 4 字符 1 token）：与压缩判据同一口径，
 * 两处各写一套就会漂成「压缩觉得没超、水位觉得超」。
 */
export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
    let total = 0;
    for (const message of messages) total += estimateTokensOf(JSON.stringify(message));
    return total;
}

/**
 * 超出水位就把最早的工具输出折叠掉；没超 ⇒ null（**什么都不做**，一个字节都不改）。
 *
 * 从**最早**的开始折：越早的工具结果越可能已经被模型消化、越后面的步骤还在用。
 */
export function guardMessages(
    messages: readonly ModelMessage[],
    options: WatermarkOptions,
): WatermarkResult | null {
    const window = options.windowTokens;
    if (!(window > 0)) return null;
    const fixed = Math.max(0, options.fixedTokens ?? 0);
    // 与压缩同一把尺子（见函数头：这两个数不许自己拍）
    const trigger = triggerTokensOf(window);
    // ⚠️ 与下面的 `total` **同口径**：total 含 fixed（真发出去的量），所以 target 也得是总量。
    // 若写成 `retain − fixed` 再跟含 fixed 的 total 比，system 会被扣两次 —— 折得过狠。
    const target = retainTokensOf(window);
    if (!(trigger > 0)) return null;

    // 量的是**真发出去的量**：system + tools + messages，不是只有 transcript
    const before = fixed + estimateMessagesTokens(messages);
    if (before < trigger) return null;

    let total = before;
    let collapsed = 0;
    const next: ModelMessage[] = [];
    for (const message of messages) {
        if (total <= target) {
            next.push(message);
            continue;
        }
        const folded = foldToolOutputs(message);
        if (folded === null) {
            next.push(message);
            continue;
        }
        total -= folded.saved;
        collapsed += folded.count;
        next.push(folded.message);
    }
    // 一条都折不动（本轮的增长不在工具输出里，比如全是模型自己写的大段文本）：
    // 不假装收过 —— 让调用方按原样发，由超窗 400 的自愈路径兜底
    if (collapsed === 0) return null;
    return { messages: next, collapsed, before, after: total };
}

/** 把一条消息里的 tool-result 输出换成一行说明；没有可折的返回 null */
function foldToolOutputs(message: ModelMessage): { message: ModelMessage; count: number; saved: number } | null {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return null;
    let count = 0;
    let saved = 0;
    const content = message.content.map((part) => {
        if (part.type !== 'tool-result') return part;
        const output = part.output;
        // 只折文本输出：json / 媒体没有「原文在哪」可指，折了模型更没法自救
        if (output === undefined || output.type !== 'text') return part;
        const value = output.value;
        if (typeof value !== 'string' || value.length < MIN_COLLAPSIBLE_CHARS) return part;
        const marker =
            `[已折叠：这次 ${part.toolName} 的输出约 ${Math.round(value.length / 1000)} 千字符，` +
            '为了给本轮后面的步骤腾出窗口而没有随本次请求发出。需要时重新调用工具取回，' +
            '或在 toolout 目录下按 toolCallId 找原文。]';
        count += 1;
        saved += estimateTokensOf(value) - estimateTokensOf(marker);
        return { ...part, output: { type: 'text' as const, value: marker } };
    });
    if (count === 0) return null;
    return { message: { ...message, content }, count, saved };
}
