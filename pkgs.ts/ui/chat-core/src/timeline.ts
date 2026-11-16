// timeline.ts —— Item[] → 时间线（唯一分组逻辑，两个 surface 共用）。
//
// 为什么要这一层：Item 是**事件级**的（一条文本、一次工具调用各一条），而 UI 需要的是
// "一条消息"。分组的坑在多 agent 并发时暴露：
//   - 展示顺序必须用 `order`（条目**出现**的时刻），不能用 `seq`（条目**落库**的时刻）。
//     两者只在"条目生成即落库"时才一致：`ask` 这类长时间挂起的条目 order 早、seq 晚，
//     按 seq 排会让提问卡片跑到它引发的那串回答**下面**（插话、通知跟着错位）。
//   - 同一 bot 的工具与文本要留在同一条里，且保持原有先后（text → tool → text）；
//     但只在 order **相邻**时合并：中间插进了别人的话（人或通知），就是真的被打断了，
//     另起一条 —— 否则后来插入的内容会显示在这条消息下面，顺序还是错。
// surface 只做「时间线 → 自己的组件」，不再各写一遍分组，语义差异从结构上消失。

import type { AnsweredAsk, AskRequest, Author, Bot, Delivery, DeliveryState, Item, TurnEndReason } from './types';

export type TimelinePart =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; id: string; name: string; args?: unknown; result?: unknown; state: 'running' | 'ok' | 'error' }
    /**
     * 需要用户回答的提问：渲染在触发它的那个工具行下面。
     * 答过（或失效）之后**不删**，只是变成只读：选项还在，用户选过的项标出来，
     * 这样“问了哪些选项”和“最后选了哪个”能对上。
     */
    | {
          kind: 'ask';
          request: AskRequest;
          answer?: AnsweredAsk['answer'];
          cancelled?: boolean;
          reason?: string;
      };

export interface TimelineDelivery {
    botId: string;
    name: string;
    color: string;
    state: DeliveryState;
}

export interface TimelineEntry {
    /** 稳定 key（React key / 测试锚点）：用户与提示是 item id，bot 消息是 turnId:authorId */
    key: string;
    /**
     * typing = 这个 bot 已经开跑但还没产出内容（"正在输入…"占位）。
     * 没有它，用户发完消息只会看到投递 chip，没有任何"bot 收到了"的反馈。
     */
    kind: 'user' | 'assistant' | 'notice' | 'error' | 'typing';
    turnId: string;
    author?: Author;
    parts: TimelinePart[];
    /** 有任一 item 仍在流式 */
    streaming: boolean;
    /**
     * 这个 bot 本轮还在跑，但当前没有任何流式内容（工具刚结束、下一段还没开始）。
     * 表现成这条消息末尾的"执行中 Ns"，而不是列表末尾单独一行 —— 否则工具行的
     * 转圈和它会在上下两个位置来回闪。
     */
    waiting?: boolean;
    /** 仅 user 条目：这条消息投给了谁、到没到 */
    deliveries: TimelineDelivery[];
    at: number;
    /**
     * 这一轮的结局（`turn.end` 事件给的事实）。**只挂在同一轮的最后一段**上 ——
     * 否则一段话被插话切成三段，"停在哪"会重复显示三遍。
     * 文案不在这一层（见 `end-footer.ts`）：这里只放事实。
     */
    endReason?: TurnEndReason;
    /**
     * 同一轮里这个 bot 的第 2+ 段（中间被插话/通知打断过）。
     * 顺序上它必须另起一条（否则后来插入的内容会显示在前一段下面），
     * 但视觉上不该像一条新消息：surface 据此不重复头像与名字。
     */
    continued?: boolean;
}

function partOf(item: Item): TimelinePart | undefined {
    if (item.type === 'chat') return { kind: 'text', text: item.data.text };
    if (item.type === 'tool') {
        return {
            kind: 'tool',
            id: item.id,
            name: item.data.name,
            args: item.data.args,
            result: item.data.result,
            state: item.data.state,
        };
    }
    return undefined;
}

function chipsOf(deliveries: readonly Delivery[], bots: Record<string, Bot>, messageId: string): TimelineDelivery[] {
    return deliveries
        .filter((delivery) => delivery.messageId === messageId)
        .map((delivery) => {
            const bot = bots[delivery.botId];
            return {
                botId: delivery.botId,
                name: bot?.name ?? delivery.botId,
                color: bot?.color ?? '#9ca3af',
                state: delivery.state,
            };
        });
}

/**
 * 展示顺序 = 条目**出现**的顺序（order），不是落库顺序（seq）。
 * 房间是 order 的唯一分配点，它单调递增且覆盖所有来源（人、bot、通知），
 * 而 seq 是 DB 自增列，分配时刻是"条目写进库"——挂起很久的条目（ask）会被排到后面。
 * 没有 order 的（老数据 / 单测构造）退化成 seq。
 */
function orderedByAppearance(items: readonly Item[]): Item[] {
    return [...items].sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.seq - right.seq);
}

export function buildTimeline(
    items: readonly Item[],
    deliveries: readonly Delivery[] = [],
    bots: Record<string, Bot> = {},
    options: {
        speaking?: readonly string[];
        asks?: readonly AskRequest[];
        answered?: readonly AnsweredAsk[];
        /** 某一轮的结局（turnId → 判定），挂在最后一段的页脚上 */
        endReasons?: Record<string, TurnEndReason>;
    } = {},
): TimelineEntry[] {
    const entries: TimelineEntry[] = [];
    // 同一 (turnId, authorId) 的第 n 段：key 要稳定且唯一（React key / 测试锚点），
    // 第一段沿用老格式，后续加 #n，免得键变来变去导致整条消息重挂。
    const segments = new Map<string, number>();

    for (const item of orderedByAppearance(items)) {
        if (item.type === 'notice') {
            entries.push({
                key: item.id,
                kind: 'notice',
                turnId: item.turnId,
                parts: [{ kind: 'text', text: item.data.text }],
                streaming: false,
                deliveries: [],
                at: item.at,
            });
            continue;
        }

        if (item.type === 'error') {
            entries.push({
                key: item.id,
                kind: 'error',
                turnId: item.turnId,
                ...(item.author === undefined ? {} : { author: item.author }),
                parts: [{ kind: 'text', text: item.data.message }],
                streaming: false,
                deliveries: [],
                at: item.at,
            });
            continue;
        }

        const author = item.author;

        if (author?.role === 'human') {
            entries.push({
                key: item.id,
                kind: 'user',
                turnId: item.turnId,
                author,
                parts: [{ kind: 'text', text: item.type === 'chat' ? item.data.text : '' }],
                streaming: false,
                deliveries: chipsOf(deliveries, bots, item.id),
                at: item.at,
            });
            continue;
        }

        const base = `${item.turnId}:${author?.id ?? 'unknown'}`;
        const previous = entries.at(-1);
        // 紧跟在同一个 bot 的上一条 assistant 条目后面 → 并进去；否则另起一段
        let entry: TimelineEntry | undefined =
            previous?.kind === 'assistant' && previous.turnId === item.turnId && previous.author?.id === author?.id
                ? previous
                : undefined;
        if (entry === undefined) {
            const segment = (segments.get(base) ?? 0) + 1;
            segments.set(base, segment);
            entry = {
                key: segment === 1 ? base : `${base}#${segment}`,
                kind: 'assistant',
                turnId: item.turnId,
                author,
                parts: [],
                streaming: false,
                deliveries: [],
                at: item.at,
                ...(segment === 1 ? {} : { continued: true }),
            };
            entries.push(entry);
        }
        const part = partOf(item);
        if (part !== undefined) entry.parts.push(part);
        if (item.status === 'streaming') entry.streaming = true;
    }

    // 提问卡片：待回答的 + 已有结局的（后者只读，带已选状态）。都挂到触发它的工具行后面。
    //
    // 找不到工具行时两种情况的处理**不能一样**：
    //  - 待回答：工具行可能还在流式、没落库，挂到最后一条 assistant 条目上是当时唯一的选择；
    //  - 已有结局：这条提问可能是几百条之前、那条工具行已经滑出窗口的。借用「最后一条
    //    assistant」会让卡片凭空跑到时间线底部、看不出属于哪一轮，所以挂成**独立卡片**，
    //    带提问者头像和收尾时刻，按 at 插回时间线。
    const attachAsk = (
        part: TimelinePart,
        request: AskRequest,
        fallback: 'last-assistant' | 'standalone',
        at?: number,
    ): void => {
        const toolCallId = request.toolCallId;
        const owner =
            toolCallId === undefined
                ? undefined
                : entries.find((entry) =>
                      entry.parts.some(
                          (candidate) => candidate.kind === 'tool' && candidate.id === `tool-${toolCallId}`,
                      ),
                  );
        if (owner !== undefined && toolCallId !== undefined) {
            const index = owner.parts.findIndex(
                (candidate) => candidate.kind === 'tool' && candidate.id === `tool-${toolCallId}`,
            );
            if (index >= 0) {
                owner.parts.splice(index + 1, 0, part);
                return;
            }
        }

        if (fallback === 'last-assistant') {
            const target = [...entries].reverse().find((entry) => entry.kind === 'assistant');
            if (target === undefined) return;
            target.parts.push(part);
            return;
        }

        const bot = request.owner === undefined ? undefined : bots[request.owner];
        const standalone: TimelineEntry = {
            key: `ask:${request.askId}`,
            kind: 'assistant',
            turnId: '',
            ...(bot === undefined
                ? {}
                : { author: { id: bot.id, name: bot.name, color: bot.color, role: 'bot' as const } }),
            parts: [part],
            streaming: false,
            deliveries: [],
            at: at ?? request.at,
        };
        const position = entries.findIndex((entry) => entry.at > standalone.at);
        entries.splice(position < 0 ? entries.length : position, 0, standalone);
    };

    for (const ask of options.asks ?? []) {
        attachAsk({ kind: 'ask', request: ask }, ask, 'last-assistant');
    }
    for (const entry of options.answered ?? []) {
        attachAsk(
            {
                kind: 'ask',
                request: entry.request,
                ...(entry.answer === undefined ? {} : { answer: entry.answer }),
                ...(entry.cancelled === true ? { cancelled: true } : {}),
                ...(entry.reason === undefined ? {} : { reason: entry.reason }),
            },
            entry.request,
            'standalone',
            entry.at,
        );
    }

    // 正在跑但还没有任何流式内容的 bot：补一个"正在输入…"占位
    const streamingAuthors = new Set(
        entries.filter((entry) => entry.kind === 'assistant' && entry.streaming).map((entry) => entry.author?.id ?? ''),
    );
    const lastItem = items.at(-1);
    const turnId = lastItem?.turnId ?? '';
    // "开跑时刻" = 这一轮的**第一条** item（通常就是用户那条消息）。
    //  - 不能用 Date.now()：每次 rebuild 都变，秒数会来回跳；
    //  - 也不能用最后一条：工具跑完再进入思考时，秒数会被重置成 0。
    const turnStart = items.find((item) => item.turnId === turnId);
    const startedAt = turnStart?.at ?? lastItem?.at ?? Date.now();
    for (const botId of options.speaking ?? []) {
        if (streamingAuthors.has(botId)) continue;
        // 本轮已经产出过内容：把"还在跑"挂回它自己那条消息的末尾。
        // 单独补一条 typing 条目会让它在列表最底部出现，于是"工具行转圈 →
        // 执行中一行 → 工具行转圈"上下交错（每条 item 到达都会重排一次）。
        // 最后一段：被插话切开的 bot 消息，"执行中"要挂在最新那段末尾
        const own = [...entries]
            .reverse()
            .find((entry) => entry.kind === 'assistant' && entry.turnId === turnId && entry.author?.id === botId);
        if (own !== undefined) {
            own.waiting = true;
            continue;
        }
        const bot = bots[botId];
        entries.push({
            key: `typing:${botId}:${turnId}`,
            kind: 'typing',
            turnId,
            ...(bot === undefined
                ? {}
                : { author: { id: bot.id, name: bot.name, color: bot.color, role: 'bot' as const } }),
            parts: [],
            streaming: true,
            deliveries: [],
            at: startedAt,
        });
    }

    attachEndReasons(entries, options.endReasons);
    return entries;
}

/**
 * 把「这一轮为什么结束」挂到该轮**最后一条** bot 条目上。
 *
 * 为什么是最后一条：一轮可能被插话切成多条（text → tool → text），结局属于整轮，
 * 只该在末尾说一次；挂到每条上会让页脚重复，挂到第一条会让它出现在半句话下面。
 */
function attachEndReasons(entries: TimelineEntry[], endReasons?: Record<string, TurnEndReason>): void {
    if (endReasons === undefined) return;
    // 优先挂在 bot 的话上（页脚是"这条回复"的属性）；这一轮压根没有 bot 消息时
    // （空产出 / 直接失败）退到该轮最后一条 notice / error —— 否则那一轮的结局就没地方说了。
    const lastBot = new Map<string, number>();
    const lastOfTurn = new Map<string, number>();
    entries.forEach((entry, index) => {
        if (entry.kind === 'user') return;
        lastOfTurn.set(entry.turnId, index);
        if (entry.kind === 'assistant' || entry.kind === 'typing') {
            lastBot.set(`${entry.turnId}\u0000${entry.author?.id ?? ''}`, index);
        }
    });

    const explained = new Set<string>();
    // 结局按「轮 + 成员」精确取：同一轮里 A 被截断、B 正常说完，两人的页脚不能是同一个
    const reasonOf = (turnId: string, botId?: string): TurnEndReason | undefined => {
        if (botId !== undefined) {
            const exact = endReasons[`${turnId}\u0000${botId}`];
            if (exact !== undefined) return exact;
        }
        // 老形状（只按 turnId 存）：兼容快照 / 外部构造的 endReasons
        return endReasons[turnId];
    };
    for (const [key, index] of lastBot) {
        const [turnId = '', botId] = key.split('\u0000');
        const reason = reasonOf(turnId, botId);
        const entry = entries[index];
        if (reason === undefined || entry === undefined) continue;
        entries[index] = { ...entry, endReason: reason };
        explained.add(turnId);
    }
    // 正主没有（这一轮没说话）：退到该轮最后一条条目上，别让结局无处可说
    for (const [turnId, index] of lastOfTurn) {
        if (explained.has(turnId)) continue;
        const reason = reasonOf(turnId);
        const entry = entries[index];
        if (reason === undefined || entry === undefined) continue;
        entries[index] = { ...entry, endReason: reason };
    }
}
