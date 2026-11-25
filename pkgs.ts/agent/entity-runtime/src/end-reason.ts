// end-reason.ts —— 「这一轮为什么结束」的**唯一判据**（session / 房间 / 测试 / lab 页共用）。
//
// 存在的理由：没有它的时候，「被输出上限截断」「工具结果没回来」「流被提前关闭」和
// 「正常说完」在数据里长得一模一样 —— 用户看到的是「执行一半就停下，UI 却显示完成」。
//
// 两条铁律：
//   1. **未知按错误处理**。没收到收尾信号、上游给了不认识的收尾原因、空产出就停 ——
//      一律 `unknown`，并且按失败处理（不发结论、时间线上一条错误）。
//      「没有证据」不等于「正常完成」，把未知说成完成就是那个 bug 本身。
//   2. **只说事实**。`type` 是类别、`note` 是细因（机器读）、`finishReason` 是上游原文。
//      该怎么跟用户说在 `endItems()` / `adviceOf()` 里，UI 不必再猜。
//
// 这个文件**保持纯净**（不 import agent / db / room）：所以能在浏览器里跑（lab 页就是
// 拿同一份判据 + 真实的 Projector 重放脚本化的事件流，见 `stop-scenarios.ts`）。

import { nextId } from './projection';
import type { Item, TurnEndReason } from './types';

/** 判定所需的全部事实：运行侧收集，判定只看这里（不读别处、不猜） */
export interface EndFacts {
    /** 运行真的失败了（抛异常 / SDK 的 error part） */
    failed?: boolean;
    /** 这一轮被 abort 了（人按停 / 看门狗到点） */
    aborted?: boolean;
    /**
     * 谁按的停：`human` = 用户点了停止（事实，不是故障）；`deadline` = agent 层的
     * StallWatchdog 判模型流失联、主动收（见 stall-watchdog.ts；`stall` 事实随
     * `run.failed.stall` 带上来）。缺省当 `human`：历史上只有人会按。
     */
    abortedBy?: 'human' | 'deadline';
    /** 看门狗收尾时的事实：卡在哪个 await、空了多久（`abortedBy === 'deadline'` 才有） */
    stall?: { awaiting: string; idleMs: number };
    /** 收到过 `run.finished` 吗 —— 缺它 = 流没正常收尾 */
    finished: boolean;
    /** 上游 finishReason 原文（`stop` / `length` / `tool-calls` / `error` / …） */
    finishReason?: string;
    steps?: number;
    /** 本轮产出的文本长度（判定"空产出"） */
    textLength: number;
    /** 本轮发起的工具调用数（判定"空产出" + 区分"只做了事没说话"） */
    toolCalls: number;
    /** 本轮实际发出去的输出上限（对账：到底是哪一层截的） */
    maxOutputTokens: number;
    /** 本轮的步数上限（撞到它 + 上游还想继续 = `max-steps`） */
    maxSteps?: number;
}

/**
 * 判定顺序 = 事实的确定性：失败 > 被停 > 没收尾信号 > 截断 > 过滤 > 工具悬空 > 其他收尾原因。
 *
 * 每一种「停」用户要做的事都不一样，所以必须分开：
 *   · `max-tokens`   模型没说完 → 说「继续」就能接上
 *   · `tool-mismatch` 工具结果没回来 → 补结果，不是续写
 *   · `unknown`      不知道为啥停 → 按错误处理（重试 / 查网关）
 *   · `interrupted`  人按的停 → 不需要动作
 */
export function endReasonOf(facts: EndFacts): TurnEndReason {
    const base = {
        ...(facts.finishReason === undefined ? {} : { finishReason: facts.finishReason }),
        ...(facts.steps === undefined ? {} : { steps: facts.steps }),
    };
    const budget = {
        maxOutputTokens: facts.maxOutputTokens,
        ...(facts.maxSteps === undefined ? {} : { maxSteps: facts.maxSteps }),
    };

    // 看门狗到点（deadline）优先于 failed：abort 之后 SDK 可能抛 AbortError，
    // 那是**我们杀的后果**，不是独立故障。把它说成 error 就把「失联 120s」这个真事实丢了。
    if (facts.abortedBy === 'deadline') {
        return {
            type: 'stalled',
            ...(facts.stall === undefined ? {} : { awaiting: facts.stall.awaiting, idleMs: facts.stall.idleMs }),
            ...base,
        };
    }
    // 人按停是**事实，不是故障**：abort 之后 SDK 抛 AbortError / 工具报被中断，都很常见，
    // 那些 failed 是我们杀出来的后果。说成 `error` 等于把「用户按了停」这个确定性事实
    // 降级成「可能出错了」。所以 aborted(human) 排在 failed 之前。
    if (facts.aborted === true) return { type: 'interrupted', ...base };
    if (facts.failed === true) return { type: 'error', ...base };
    // 流结束了却没给收尾信号：网关掐断 / 上游静默关闭 / 传输层断了。**这是错误**。
    if (!facts.finished) return { type: 'unknown', note: 'no-finish', ...base };

    switch (facts.finishReason) {
        case 'length':
            return { type: 'max-tokens', ...budget, ...base };
        // 撞步数上限：**不是失败** —— 活可能刚干到一半，说「继续」能接着干（与 max-tokens 同构）。
        // 上游把这个 finishReason 改写为 `max-steps` 的前提是「还想继续调工具」
        // （见 agent.ts 循环后那段）；模型自然说完的第 N 步不会走到这里。
        case 'max-steps':
            return { type: 'max-steps', ...budget, ...base };
        case 'content-filter':
            return { type: 'filtered', ...base };
        case 'tool-calls':
            return { type: 'tool-mismatch', ...base };
        case 'error':
            return { type: 'error', ...base };
        case 'stop': {
            // finish=stop 但一个字都没有：不是"说完了一句没有的话"，是可疑的静默停。
            const empty = facts.textLength === 0 && facts.toolCalls === 0;
            return empty ? { type: 'unknown', note: 'empty-output', ...base } : { type: 'completed', ...base };
        }
        default:
            // 上游给了我们不认识的收尾原因（`unknown` / 空串 / 新词）：同样是未知，按错误处理。
            return { type: 'unknown', note: `finish=${facts.finishReason ?? 'none'}`, ...base };
    }
}

export interface EndItemContext {
    turn: number;
    turnId: string;
    at?: number;
    /** 运行时给的失败原文（`run.failed.message`）：`error` 类带上它，别把话丢了 */
    failureMessage?: string;
    /**
     * 这一轮是**哪个 bot** 的（session 是 per-bot 的，调用方一定有这个信息）。
     *
     * 必须带上：`turnId` 是**房间级**的（一轮里 @all 的各 bot 共享同一个），只按它归属结局
     * 会把 A 的截断算到 B 头上。见 protocol 的 `Item.notice.data.botId` 注释。
     */
    botId?: string;
}

/**
 * 这一轮结束时要额外落到时间线上的条目 —— 让"怎么停的"**看得见**。
 *
 * `completed` 与 `interrupted` 不给条目：前者没什么可说，后者是人自己按的。
 */
/**
 * `errorAlreadyReported`：失败原文**已经**作为条目落过了（`Projector` 收到 `run.failed`
 * 时会自己落一条错误条目）—— 那就别再补一条，否则同一句话在时间线上出现两次。
 */
export interface EndItemOptions {
    errorAlreadyReported?: boolean;
}

export function endItems(reason: TurnEndReason, ctx: EndItemContext, options: EndItemOptions = {}): Item[] {
    const items = endItemsOf(reason, ctx);
    return options.errorAlreadyReported === true ? items.filter((item) => item.type !== 'error') : items;
}

function endItemsOf(reason: TurnEndReason, ctx: EndItemContext): Item[] {
    const base = {
        seq: 0,
        turn: ctx.turn,
        turnId: ctx.turnId,
        at: ctx.at ?? Date.now(),
        status: 'done' as const,
    };
    /** 结局归属：有 botId 就记上，让消费方能在共享 turnId 的一轮里认出是谁的结局 */
    const who = ctx.botId === undefined ? {} : { botId: ctx.botId };

    switch (reason.type) {
        case 'max-tokens':
            return [
                {
                    ...base,
                    id: nextId('notice'),
                    type: 'notice',
                    data: {
                        text: `这次回复被输出上限截断（max_tokens=${reason.maxOutputTokens ?? '?'}），说「继续」可接上`,
                        kind: 'max-tokens',
                        ...who,
                    },
                },
            ];
        case 'max-steps':
            return [
                {
                    ...base,
                    id: nextId('notice'),
                    type: 'notice',
                    data: {
                        text: `这一轮撞到步数上限（${reason.maxSteps ?? reason.steps ?? '?'} 步）先停下 —— 说「继续」接着干；反复撞就把它拆小`,
                        kind: 'max-steps',
                        ...who,
                    },
                },
            ];
        case 'filtered':
            return [
                {
                    ...base,
                    id: nextId('notice'),
                    type: 'notice',
                    data: { text: '这次回复被上游内容策略拦截（content-filter）', kind: 'content-filter', ...who },
                },
            ];
        case 'tool-mismatch':
            return [
                {
                    ...base,
                    id: nextId('notice'),
                    type: 'notice',
                    data: {
                        text: '工具结果没回来，这一轮被迫停下了（finish=tool-calls），说「继续」可以接着跑',
                        kind: 'tool-mismatch',
                        ...who,
                    },
                },
            ];
        case 'stalled':
            return [
                {
                    ...base,
                    id: nextId('notice'),
                    type: 'notice',
                    data: { text: stalledText(reason), kind: 'stalled' },
                },
            ];
        case 'unknown':
            return [
                {
                    ...base,
                    id: nextId('error'),
                    type: 'error',
                    data: { message: unknownText(reason), ...who },
                },
            ];
        case 'error':
            return [
                {
                    ...base,
                    id: nextId('error'),
                    type: 'error',
                    data: { message: ctx.failureMessage ?? '本轮运行失败', ...who },
                },
            ];
        default:
            return [];
    }
}

/** 「失联」说清两件事：在等谁、空了多久（都是我们真的知道的） */
function stalledText(reason: TurnEndReason): string {
    const what = reason.awaiting === undefined ? '' : awaitText(reason.awaiting);
    const idle = reason.idleMs === undefined ? '很久' : formatIdle(reason.idleMs);
    return `这一轮失联了：${what}${idle}没有进展，已中止 —— 说「继续」重试；总在这一步断就查网关超时`;
}

/** 机器码 → 人话（与 progress.ts 的 `what` 一一对应） */
function awaitText(awaiting: string): string {
    if (awaiting === 'model-stream') return '等模型回话时 ';
    if (awaiting === 'tool') return '工具执行时 ';
    if (awaiting === 'compact') return '压缩上下文时 ';
    if (awaiting.startsWith('tool:')) return `${awaiting.slice('tool:'.length)} 在跑时 `;
    return `${awaiting} 处 `;
}

// **这里没有「进度提醒」了**（用户 2026-11-24）：`progressNotice` 已删 —— 它就是那句
// “61 秒还没吐出第一个字”，被当成结局条目写进了 append-only 的时间线。
// 过程只活在 ephemeral 的 `progress` 事件里（progress.ts 的 `stageOf` 分档），
// 只有**结局**在这里成条目：stalled / error / max-steps / max-tokens / 用户停止。

function formatIdle(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 90) return `${seconds} 秒`;
    const minutes = Math.round(seconds / 60);
    return `${minutes} 分钟`;
}

function unknownText(reason: TurnEndReason): string {
    switch (reason.note) {
        case 'no-finish':
            return '这一轮不明原因中断：没收到结束信号（流被提前关闭 / 上游静默结束）—— 已按失败处理，建议重试';
        case 'empty-output':
            return '模型一个字都没说就结束了（finish=stop、0 字）—— 已按失败处理，建议重试';
        default:
            return `这一轮不明原因结束（${reason.note ?? '原因未知'}）—— 已按失败处理，建议重试`;
    }
}

/**
 * 这一轮的产出能不能当**结论**发到房间。
 *
 * 只有 `completed` 可以：结论是"这个 bot 的公开立场"，会被复制进其他 bot 的上下文。
 * 半句被截断的话、失败的话、被停的话公开出去，就是在房间里传播错误信息 ——
 * 所以这些只留在自己的时间线上（用户看得见、说「继续」能接上），不进公共日志。
 */
export function publishable(reason: TurnEndReason): boolean {
    return reason.type === 'completed';
}

/** 用户该做什么（lab 页与 UI 共用；只给动作，不重复判定） */
export function adviceOf(reason: TurnEndReason): string {
    switch (reason.type) {
        case 'completed':
            return '不需要动作';
        case 'max-tokens':
            return '说「继续」接上；常撞的话提高 maxOutputTokens，或让它分段写';
        case 'max-steps':
            return '说「继续」接着干；反复撞上限就拆任务，或提高一轮的步数上限';
        case 'filtered':
            return '换个说法再问，或换个模型';
        case 'tool-mismatch':
            return '说「继续」重跑这一步；反复出现说明某个工具在挂';
        case 'interrupted':
            return '你按的停 —— 说「继续」接着来';
        case 'stalled':
            return '说「继续」重试；总在这一步断就查网关超时 / 把这一步拆小';
        case 'unknown':
            if (reason.note === 'no-finish') return '重试；总在这一步断就查 SSE / 网关超时';
            if (reason.note === 'empty-output') return '重试；连续空产出先查模型与额度';
            return `上游给了不认识的收尾原因（${reason.note ?? '?'}）—— 对一下 finishReason 原文`;
        case 'error':
            return '按错误处理：看错误条目里的话';
        default:
            return '未知状态';
    }
}
