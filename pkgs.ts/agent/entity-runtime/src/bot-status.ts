// bot-status.ts —— 「这个 bot 上一轮怎么结束的」的**磁盘侧判据**。
//
// 判据只有一条：该 bot 在房间里的最后一条 item 是不是收尾条目。
// 为什么成立：一轮结束时 `endItems()` 把 notice / error 作为该轮**最后**的条目落盘
// （`completed` 与 `interrupted` 不产条目，见 end-reason.ts）—— 于是
//   · 最后一条是 error              → 失败（带原文）
//   · 最后一条是那四种 notice        → 截断 / 步数 / 过滤 / 工具悬空
//   · 其余（chat / tool / 作业通知） → 正常说完
//
// 也就是说「谁最后说话」和「怎么停的」是同一个查询的两种读法，不需要新表、新字段、
// 也不需要把 `turn.end` 从 ephemeral 改成落盘。
//
// **已知局限（故意不猜）**：进程崩溃 / 被杀的轮次没有收尾条目，最后一条停在中途产出上，
// 这里会判成「正常」。要区分它得知道「那一刻进程死了」，磁盘上没有这个事实 ——
// diy1 的 `interrupted` 靠冷读补 closer，diy2 没有（见 ##519 的讨论）。
// 在跑 / 等回答由内存侧覆盖（`Actor.runningBots` / `pendingAsks`），不在这个文件里判。

import type { BotOutcome, Item } from './types';

/**
 * 收尾 notice 的 kind → 结局。
 *
 * 与 `end-reason.ts` 的 `endItemsOf()` 一一对应：那边加一种 notice，这里就要加一行，
 * 否则新结局会被静默读成「正常完成」—— 那正是这套判据要消灭的 bug。
 */
const NOTICE_OUTCOMES: Readonly<Record<string, BotOutcome>> = {
    'max-tokens': 'truncated',
    'max-steps': 'max-steps',
    'content-filter': 'filtered',
    'tool-mismatch': 'tool-mismatch',
};

export interface BotLastTurn {
    roomId: string;
    botId: string;
    turnId: string;
    /** 轮次序号（老数据可能没有） */
    turn?: number;
    /** 最后一条 item 的时刻 —— 这一轮最后的动静 */
    at: number;
    outcome: BotOutcome;
    /** `outcome: 'failed'` 时的原文（error 条目的 message） */
    message?: string;
}

/** 一条 item → 它所属 bot 的「最后一轮」；没有 author 的条目（system 之类）返回 undefined */
export function botLastTurnOf(roomId: string, item: Item): BotLastTurn | undefined {
    const botId = item.author?.id;
    if (botId === undefined) return undefined;
    const base = {
        roomId,
        botId,
        turnId: item.turnId,
        at: item.at,
        ...(item.turn === undefined ? {} : { turn: item.turn }),
    };
    if (item.type === 'error') return { ...base, outcome: 'failed', message: item.data.message };
    if (item.type === 'notice') {
        const outcome = NOTICE_OUTCOMES[item.data.kind];
        if (outcome !== undefined) return { ...base, outcome };
    }
    return { ...base, outcome: 'done' };
}

/**
 * 这个结局要不要人动手。
 *
 * `done` 之外全要：截断 / 撞步数 / 工具悬空都说「继续」能接上，过滤要换说法，
 * 失败要人看错误原文。在跑（正常进行中）与等回答（ask）不属于「结局」，另算。
 */
export function needsHuman(outcome: BotOutcome): boolean {
    return outcome !== 'done';
}

/** 一句话说清这个结局（二级弹层 / 三级表格同一套文案，别让两处各写一遍） */
export function outcomeText(outcome: BotOutcome, message?: string): string {
    switch (outcome) {
        case 'done':
            return '正常结束';
        case 'truncated':
            return '被输出上限截断';
        case 'max-steps':
            return '撞到步数上限';
        case 'filtered':
            return '被内容策略拦截';
        case 'tool-mismatch':
            return '工具结果没回来';
        case 'failed':
            return message === undefined || message === '' ? '运行失败' : `失败：${message}`;
    }
}
