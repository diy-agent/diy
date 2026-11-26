// bot-status.ts —— 「这个 bot 上一轮怎么结束的」的**磁盘侧判据**。
//
// 要两条输入才能判，因为结局事实**故意不带 author**：
//   · 轮级事实（`endItems()` 落的 notice / error）属于「这一轮」而不是「某个 bot」——
//     UI 靠这个区分「bot 说的话」和「这一轮的结局」（见 chat-core/timeline.ts 的注释）。
//     所以它**不会**出现在 `lastItemPerBot`（按 `author.id` 分组）里。
//   · 那个 bot 自己最后一条条目：定住「它最后一轮的 turnId」。
//
// 于是判据是：先按 turnId 关联起来，再看那一轮的最后一条轮级事实 ——
//   · error                     → 失败（带原文）
//   · 那四种 notice              → 截断 / 步数 / 过滤 / 工具悬空
//   · 没有轮级事实（completed）  → 正常说完
//
// **这条判据不需要新表、新字段**，也不需要把 `turn.end` 从 ephemeral 改成落盘。
// 老数据同样适用（`endItems` 一直带着 turnId 落盘）。
//
// **已知局限（故意不猜）**：进程崩溃 / 被杀的轮次没有收尾条目，最后一条停在中途产出上，
// 这里会判成「正常」—— 磁盘上没有「那一刻进程死了」这个事实。
// 补这个事实的是 `turn_open` 表（轮开始写、收尾删；重启时还留着就补一条 `interrupted`
// notice 再销掉，见 room.ts 的构造函数）。
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
    interrupted: 'interrupted',
};

/** 一条**轮级事实**（notice / error）→ 结局；不是结局（chat / tool / 作业通知这类）返回 undefined */
export function outcomeOfFact(item: Item): { outcome: BotOutcome; message?: string } | undefined {
    if (item.type === 'error') return { outcome: 'failed', message: item.data.message };
    if (item.type === 'notice') {
        const outcome = NOTICE_OUTCOMES[item.data.kind];
        if (outcome !== undefined) return { outcome };
    }
    return undefined;
}

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

/** 一条 item → 它所属 bot 的「最后一轮」；没有 author 的条目（轮级事实、system）返回 undefined */
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
    // 带 author 的 error 本身就是结局（`run.failed` 那条）；其余条目要先看轮级事实
    const verdict = outcomeOfFact(item);
    if (verdict !== undefined) {
        return { ...base, outcome: verdict.outcome, ...(verdict.message === undefined ? {} : { message: verdict.message }) };
    }
    return { ...base, outcome: 'done' };
}

/**
 * 把「那一轮的轮级事实」套到这个 bot 的结局上（`completed` 没有事实 = 维持「正常」）。
 *
 * 为什么要分两步：事实条目不带 author（它是「这一轮的结局」而不是「某个 bot 说的话」），
 * 所以拿不到 bot 归属 —— 只能由调用方先按 turnId 找到它，再回头盖到对应的那一轮。
 */
export function withTurnFact(turn: BotLastTurn, fact: Item | undefined): BotLastTurn {
    if (fact === undefined) return turn;
    const verdict = outcomeOfFact(fact);
    if (verdict === undefined) return turn;
    return {
        ...turn,
        outcome: verdict.outcome,
        ...(verdict.message === undefined ? {} : { message: verdict.message }),
    };
}

/** `createTurnLookup` 要的两个投影（结构类型：bot-status 不依赖 db） */
export interface TurnFactSource {
    lastItemPerBot(): Array<{ roomId: string; item: Item }>;
    lastFactPerTurn(): Array<{ roomId: string; owner: string; item: Item }>;
}

/**
 * 造一个「(房间, bot) → 它最后一轮的结局」查询器。
 *
 * `rooms.list`（侧栏红图标）与 `bots.rows`（三级表格）**共用一份** —— 各算一份迟早走散，
 * 用户 2026-11-26 看到的就是“表格说「出错」，侧栏图标却什么事都没有”。
 *
 * 两个来源必须合成：bot 自己最后一条 item 给 turnId，**结局**在轮级事实里。
 * 成本：两条全表 json 分组查询（靠 `items_author_seq` / `items_fact_owner_seq` 表达式索引，
 * 实测 25ms + 54ms）；`rooms.list` 30s 一次、`bots.rows` 开浮层一次，可以接受。
 */
export function createTurnLookup(
    source: TurnFactSource,
): (roomId: string, botId: string) => BotLastTurn | undefined {
    const last = new Map<string, BotLastTurn>();
    for (const { roomId, item } of source.lastItemPerBot()) {
        const turn = botLastTurnOf(roomId, item);
        if (turn !== undefined) last.set(`${roomId}\u0000${turn.botId}`, turn);
    }
    // 轮级事实（不带 author 的 notice / error）只能单独认领。
    // key 用 `owner`（= 事实自带的 botId，老数据退回 turnId）—— 一轮里 @all 的
    // 各 bot 共享 turnId，只按它查会把 A 的截断盖到 B 头上。
    const facts = new Map<string, Item>();
    for (const { roomId, owner, item } of source.lastFactPerTurn()) {
        facts.set(`${roomId}\u0000${owner}`, item);
    }
    return (roomId, botId) => {
        const own = last.get(`${roomId}\u0000${botId}`);
        if (own === undefined) return undefined;
        /** 事实必须属于**当前这一轮**，否则丢弃（见下面那条注释） */
        const pick = (key: string): Item | undefined => {
            const fact = facts.get(key);
            if (fact === undefined) return undefined;
            // `owner=botId` 这条键会命中**很早那一轮**带 botId 的 `interrupted`
            // （`lastFactPerTurn` 按 owner 分组，一个 bot 在它那里只留一条）——
            // 拿它盖当前轮的结局，就会出现「导航图标红着，进去却没看到问题」
            // （用户 2026-11-26 报的 #29 任务分解 dag：最新一轮是 job-done 退出码 0，
            // 却被 34387 之前、seq 28915 那条 turn-mww2bir6 的 interrupted 盖成“出错”）。
            // 没有 turnId 的老事实接受（那时落盘还没带这个字段）。
            return fact.turnId === undefined || fact.turnId === own.turnId ? fact : undefined;
        };
        return withTurnFact(own, pick(`${roomId}\u0000${own.turnId}`) ?? pick(`${roomId}\u0000${own.botId}`));
    };
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
        case 'interrupted':
            return '中断（上一轮没跑完）';
        case 'failed':
            return message === undefined || message === '' ? '运行失败' : `失败：${message}`;
    }
}
