// bot-status.ts —— 「这个 bot 上一轮怎么结束的」的**磁盘侧判据**。
//
// 要两条输入才能判，因为结局事实**故意不带 author**：
//   · 轮级事实（`endItems()` 落的 notice / error）属于「这一轮」而不是「某个 bot」——
//     UI 靠这个区分「bot 说的话」和「这一轮的结局」（见 chat-core/timeline.ts 的注释）。
//     所以它**不会**出现在 `lastItemPerBot`（按 `author.id` 分组）里。
//   · 那个 bot 自己最后一条条目：定住「它最后一轮的 turnId」。
//
// 于是判据是：先按 turnId 关联起来，再看那一轮的**最后一条结局事实** ——
//   · error                     → 失败（带原文）
//   · 那五种 notice              → 截断 / 步数 / 过滤 / 工具悬空 / 中断
//   · 没有结局事实（completed）  → 正常说完
//
// 两个坑（2026-11-26 实数据里都真实发生过，见 `createTurnLookup` 的三道筛）：
//   · 同一轮里占 seq 最大的轮级通知**不是结局**（`job-done`）→ 不能让它在「一条/owner」
//     的投影里把真正的结局遮住；
//   · 机器被杀的那一轮 bot 可能**一个条目都没产出** → 它的 turnId 只能从事实本身拿，
//     拿 bot 最后一条 item 去等号比对永远对不上。
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
    /**
     * 这条 item 的落盘序号（`entity_items.seq`）。
     *
     * 只用来判「这条轮级事实是不是发生在这条 item **之后**」（见 `createTurnLookup`）：
     * `turn` 缺失的老数据只能靠它。它**不是**给人看的时间，别拿它当 `at` 用。
     */
    seq?: number;
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
        ...(item.seq === undefined ? {} : { seq: item.seq }),
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
 * 两个来源必须合成：bot 自己最后一条 item 定住「它最后一轮的 turnId」，**结局**在轮级事实里。
 * 成本：两条全表 json 分组查询（靠 `items_author_seq` / `items_fact_owner_seq` 表达式索引，
 * 实测 25ms + 54ms）；`rooms.list` 30s 一次、`bots.rows` 开浮层一次，可以接受。
 */
export function createTurnLookup(
    source: TurnFactSource,
): (roomId: string, botId: string) => BotLastTurn | undefined {
    return buildTurnLookup(source);
}

/** `createTurnLookup` 的本体（缓存版要能直接拿它造一份新的） */
function buildTurnLookup(
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
        const fact = factOf({ roomId, botId, own, facts });
        // 两种情形「最后一轮」只能由事实自己描述（bot 那一轮没留下任何条目）：
        //   · 从来没说过话（`own` 都没有）；
        //   · 事实属于**另一轮**（机器死在中途，那轮 bot 一个条目都没产出）。
        // 这时 `own` 的 turn / turnId / at 是**上一轮**的，拿它配这一轮的结局会让人看到
        // 「上轮 = 更早那个时刻」，也不该把 turn 8 中断说成 turn 7 的结局。
        const fromFact = own === undefined || (fact?.turnId !== undefined && fact.turnId !== own.turnId);
        if (fact !== undefined && fromFact) return turnOfFact(roomId, botId, fact);
        return own === undefined ? undefined : withTurnFact(own, fact);
    };
}

/**
 * 「这个 bot 最后一轮的结局事实」—— 两条键都试，**顺序是「先精确、后兜底」**：
 *
 *   · `turnId` 键：事实没带 botId 时（老数据 / 作业通知）落在轮名上，只有同轮能认；
 *   · `botId` 键：新数据的结局都带 botId（`end-reason.ts` 的 `who`），最准。
 *
 * 三道筛，任一道不过就当没找到（**继续看下一条键**，不是直接放弃）：
 *
 * 1. **不是结局的轮级通知一律不占位**。`lastFactPerTurn` 每个 owner 只留一条（seq 最大那条），
 *    所以一条 `job-done` 会**把同一个键上真正的结局遮住** —— 2026-11-26 实数据里的 #29
 *    就是这样：同一轮里既有 `job-done`（落在 turnId 键）又有 `interrupted`（落在 botId 键），
 *    先命中的 `job-done` 不是结局，`withTurnFact` 原样返回 done，红图标就没了。
 *    用户当场的原话：「两个任务都是上一轮没跑完，导航条上一个红一个不红」。
 * 2. **同 turnId ⇒ 直接认**（最确定的一条）。（没 turnId 的老数据也认：那时落盘还没带这个字段。）
 * 3. **不同 turnId ⇒ 只认「写在这条 bot 最后一条之后」的那条**。两种情况会走到这里：
 *    · 机器在中途被杀，那一轮 bot 一个条目都没产出（`turn_open` 补的 `interrupted` 是它唯一的痕迹）；
 *    · `lastFactPerTurn` 按 owner 分组，旧轮的 `interrupted` 会以「更新的 seq」留在表里
 *      （它是**启动时**补写的，seq 大但轮次早）—— 那正是 #29 曾经被误报成“出错”的原因
 *      （seq 28915 的 turn-mww2bir6 盖住了后来的 turn 95），所以这里必须比**轮次**，不能比 seq。
 */
function factOf(input: {
    roomId: string;
    botId: string;
    own: BotLastTurn | undefined;
    facts: Map<string, Item>;
}): Item | undefined {
    const { roomId, botId, own, facts } = input;
    const keys = own === undefined ? [botId] : [own.turnId, own.botId];
    for (const owner of keys) {
        const fact = facts.get(`${roomId}\u0000${owner}`);
        if (fact === undefined) continue;
        // ① 不是结局（job-done 这类）→ 不许占位，看下一条键
        if (outcomeOfFact(fact) === undefined) continue;
        if (own === undefined) return fact;
        // ② 同轮（或老数据没 turnId 字段）：认
        if (fact.turnId === undefined || fact.turnId === own.turnId) return fact;
        // ③ 不是同一轮：只有更晚的那一轮才可能是他这次没跑完的结局
        if (isLaterThan(fact, own)) return fact;
    }
    return undefined;
}

/** 这条轮级事实是否发生在 `own` 那一轮**之后**（轮次优先，缺轮次退回落盘顺序） */
function isLaterThan(fact: Item, own: BotLastTurn): boolean {
    if (fact.turn !== undefined && own.turn !== undefined) return fact.turn > own.turn;
    return own.seq !== undefined && fact.seq !== undefined && fact.seq > own.seq;
}

/** 一个**从没说过话**的 bot，只能拿轮级事实当它的「最后一轮」 */
function turnOfFact(roomId: string, botId: string, fact: Item): BotLastTurn {
    const verdict = outcomeOfFact(fact);
    return {
        roomId,
        botId,
        turnId: fact.turnId ?? '',
        at: fact.at,
        ...(fact.turn === undefined ? {} : { turn: fact.turn }),
        ...(fact.seq === undefined ? {} : { seq: fact.seq }),
        outcome: verdict?.outcome ?? 'done',
        ...(verdict?.message === undefined ? {} : { message: verdict.message }),
    };
}

/**
 * 带 **TTL 缓存**的 turn lookup（2026-11-26，页面卡顿整治）。
 *
 * 为什么要缓存：`bots.rows` 与 `rooms.list` 每隔 1.5~6 秒拉一次，每次都要跑两条全表
 * json 分组（实测 **529ms + 39ms**）—— 三个 agent 在跑时，这两条查询几乎不停地在跑，
 * 而同一条连接上的其它请求（chat.load / 点击后的任何 RPC）只能排队。
 *
 * 为什么用 TTL 而不用「seq 变了就失效」：agent 在跑时**每秒都在写 item**，seq 永远在变，
 * 那样缓存会 100% 命中不了。而这个数据的粒度本来就是「上一轮的结局」—— 它不依赖秒级
 * 新鲜度（在跑 / 等回答是内存态，另有来源）。
 *
 * 默认 5s：比 `POLL_IDLE_MS`(6s) 短一点、比 `POLL_ACTIVE_MS`(2.5s) 长一倍，
 * 即"人看着表"时每 2 次拉取共用一次计算，"没人看"时几乎每次都要重算（反正 6s 才一次）。
 */
export function createCachedTurnLookup(
    source: TurnFactSource,
    ttlMs = 5000,
    now: () => number = Date.now,
): (roomId: string, botId: string) => BotLastTurn | undefined {
    let cached: { at: number; lookup: (roomId: string, botId: string) => BotLastTurn | undefined } | undefined;
    return (roomId, botId) => {
        const at = now();
        if (cached === undefined || at - cached.at >= ttlMs) {
            cached = { at, lookup: buildTurnLookup(source) };
        }
        return cached.lookup(roomId, botId);
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
