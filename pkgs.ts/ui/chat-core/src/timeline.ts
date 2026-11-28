// timeline.ts —— Item[] → 时间线（唯一分组逻辑，两个 surface 共用）。
//
// 为什么要这一层：Item 是**事件级**的（一条文本、一次工具调用各一条），而 UI 需要的是
// "一条回复"。分组规则只有一条：
//
//   **一条回复 = 同一 (turnId, author) 的全部条目，合成一个整体。**
//
// 位置在**创建时**确定 —— 这个 bot 在这一轮的第一个条目出现的位置 —— 之后只往这个整体
// 里追加，永不移出、永不重排。所以同一个 bot 在同一轮里最多一条 assistant 条目：别的
// bot 的话或通知落在它这段回复的时间跨度中间，会显示在它**后面**，不会把它切成两段。
//
// 这是有意的取舍：**位置稳定优先于时间精确**。反过来做（允许切段）的话，每条被打断的
// 回复都要靠"上一条是不是同一个 bot"去重建相邻性；而这条判据一旦在重排 / 分页 /
// 窗口截断里失手，对话就成为交错的碎片 —— 那个状态没有正确答案，只能靠 #n 编号和
// "继续段"标志去粘，粘不回去就骗人。
//
// 展示顺序必须用 `order`（条目**出现**的时刻），不能用 `seq`（条目**落库**的时刻）：
// 两者只在"条目生成即落库"时才一致，`ask` 这类长时间挂起的条目 order 早、seq 晚，
// 按 seq 排会让提问卡片跑到它引发的那串回答**下面**（插话、通知跟着错位）。
//
// 由此得出 part / entry 的判据（`error` 和 `notice` 就靠这一条分）：**谁拥有它。**
// 有 `author` 的事实属于那个 bot 的回复 —— 它是 part，按时间插进回复里面
// （例如这个 bot 自己的 `run.failed`）；没有 `author` 的事实属于这一轮（`endItems()`
// 落下来的结局）—— 它是独立条目。`notice` 从不带 author，所以**永远成条**；
// 不是漏了，是它没有主人。
//
// surface 只做「时间线 → 自己的组件」，不再各写一遍分组，语义差异从结构上消失。

import type {
    AnsweredAsk,
    AskRequest,
    AttachmentRef,
    Author,
    Bot,
    Delivery,
    DeliveryState,
    Item,
    JobNotice,
    TurnEndReason,
    TurnUsage,
    ToolOutputRef,
} from './types';

/**
 * 一轮的时间与结算事实（消息头 + 底部行只读它）。
 *
 * 为什么把四件东西放在一起：它们描述的是**同一段时间**，分开放就会出现「头像旁写 22:28、
 * 底部行写耗时 3m12s、结束于 22:31」却不自洽的情况 —— startedAt / endedAt 永远成对来自服务端
 * （`turn.start` 与 `turn.end`）。运行中只有 startedAt，结束那一刻 `endedAt` 才来。
 */
export interface TurnFacts {
    startedAt?: number;
    endedAt?: number;
    /** 本轮实测用量（上游报的；没有 = 没拿到，不要用 0 充数） */
    usage?: TurnUsage;
    /** 本轮工具调用数（缺省 = 一次也没调） */
    toolCalls?: number;
    /** 这一轮为什么结束（运行中为 undefined，页脚 / 结算行靠它换档） */
    reason?: TurnEndReason;
}

export type TimelinePart =
    | { kind: 'text'; text: string }
    | {
          kind: 'tool';
          id: string;
          name: string;
          args?: unknown;
          result?: unknown;
          /**
           * 正文落在库外的引用（超 64KB 时）。有它就没有 `result` ——
           * UI 用 `preview` 的头尾显示，全文按 `ref` 去服务端取。
           */
          output?: ToolOutputRef;
          state: 'running' | 'ok' | 'error';
          /**
           * 失败原因（`tool.completed` 的 error，投影时已压成一行、截断过）。
           *
           * 为什么必须带着走（2026-11-27）：失败的工具常常**没有 result**
           * （模型入参是坏 JSON 时连结果是空的），只靠 `state: 'error'` 界面上只能显示一个
           * 「失败 unit_update」—— 到底为什么失败，人得去翻 session_state。
           */
          error?: { message: string };
      }
    /**
     * 这个 bot 自己这一轮的运行失败了（`run.failed`）。它是**回复的一部分**，不是一条独立消息：
     * 失败之后同一个 bot 在同一轮里还可能再跑一次（排队中的投递带着同一个 turnId），
     * 只有把它当作 part 按时间顺序插进去，才能渲染成「说一段 → 失败 → 再说一段」。
     * 轮级的结局（`endItems` 那些没有 author 的）仍然单独成条，见 `kind: 'error'`。
     */
    | { kind: 'error'; message: string }
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
          /** 过期（不是用户处置，是提问者已经继续工作了）：卡片要说出这件事 */
          expired?: boolean;
          reason?: string;
      };

export interface TimelineDelivery {
    botId: string;
    name: string;
    color: string;
    state: DeliveryState;
    /** `'failed'` = 没送进去（状态收敛成 3 个后的失败标记） */
    note?: string;
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
    /**
     * 段号：人插话把同一轮的 bot 输出切成多段时，第 2 段起是「续段」（segment > 0）。
     * 界面据此不重复头像 / 名字 / 时间，用一条续接引线标出「同一条回复，被插话打断后接着写」——
     * 否则看起来像 bot 说了两遍。缺省 / 0 = 首段。
     */
    segment?: number;
    /** 仅 user 条目：这条消息投给了谁、到没到 */
    deliveries: TimelineDelivery[];
    /**
     * 仅 user 条目：这条消息带的附件（图 / 文件 / 目录引用）。
     * 形状归 protocol（`Item.chat.data.attachments`），这里只是把它带出来给界面画。
     */
    attachments?: readonly AttachmentRef[];
    /**
     * 仅 `job-done` 通知：后台作业的结构化事实（界面画作业卡片，而不是一条分隔线）。
     * 老数据没有这一项（当年只存了 `text`）⇒ 退回纯文本，见 surface 里的分支。
     */
    job?: JobNotice;
    at: number;
    /**
     * 这一轮的时间与结局（`turn.start` / `turn.end` 给的事实）。**只挂在同一轮的最后一段**上 ——
     * 否则一段话被插话切成三段，"停在哪"会重复显示三遍。
     * 文案不在这一层（见 `end-footer.ts`）：这里只放事实。
     */
    turn?: TurnFacts;
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
            ...(item.data.output === undefined ? {} : { output: item.data.output }),
            ...(item.data.error === undefined ? {} : { error: item.data.error }),
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
                ...(delivery.note === undefined ? {} : { note: delivery.note }),
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
        /**
         * 各轮的时间与结局，键是 `turnId\u0000botId`（老形状只按 turnId 也兼容）。
         *
         * 运行中的轮只有 `startedAt`（快照的 `runningTurns` 与 `turn.start` 都给），
         * 结束后才补齐 `endedAt` / `usage` / `reason`。
         */
        turns?: Record<string, TurnFacts>;
    } = {},
): TimelineEntry[] {
    const entries: TimelineEntry[] = [];
    // 人插话会把 bot 的多步切成段：`(turnId, authorId, 插话代)` → 那一「段」。段 0 是老形状
    // （一轮一条）；人插话之后，同轮的 bot parts 落到新段 —— 界面上就是插话夹在两段回复中间，
    // 而不是落在整块 bot 输出之后。bot 的 @ 走 notice/conclusion，不经这个循环，所以不切段
    // （那是同轮延续）。
    const segmentOf = new Map<string, number>();
    const botSeen = new Set<string>();
    // (turnId, authorId, 段) → 那一「段」回复。**这就是回复的地址**：一个 bot 在一轮的同一段里
    // 只有一条，后来的条目一律追加进去；人插话后另起一段。
    const replies = new Map<string, TimelineEntry>();
    /**
     * 展示锚点：条目**落在界面哪个位置**（与"什么时候创建"分开）。
     *
     * 为什么需要第二套位置（2026-11-27 用户实测报的「回复在我的图上方，很诡异」）：
     * 同一轮里人可能连发两条（先文字、再补一张图），而 bot 的回复位置固定在它**第一条**
     * 条目出现的时刻 ⇒ 渲染成「人的第一条 → bot 回复 → 人的第二条」，看起来像 bot 抢在
     * 第二张图之前回了话。锚点改成「本轮最后一条人的消息」之后，顺序就是
     * 「人的两条 → bot 的整段回复」，与直觉一致；回复本身仍然**不切段**（切段才会碎）。
     *
     * **键是 `entry.key` 不是对象身份**（2026-11-28 修）：`attachTurns` 在排序前会把拿到
     * 轮次结账事实的条目换成新对象（`{ ...entry, turn }`），对象身份一变，按对象取锚点就
     * 全是 `undefined` ⇒ 那些条目被当成"没有锚点"排到最后。症状正是用户报的「回复跳到最后 /
     * 顺序乱」：只有**落过 turn_facts 的轮**（#631 之后）才会中招，越新的会话越明显。
     */
    const anchors = new Map<string, number>();
    // 每轮「目前遍历到的最新一条人的消息」的 order。**运行时维护，不是预扫描最后一条**：
    // 切段之后，每一段的锚点应该是「这一段的起始人话」（seg k 由第 k 条插话触发），而不是
    // 本轮最后一条人话 —— 否则人插话把 bot 切成两段后，前一段也会被顶到插话之后，就白切了。
    const currentHumanOrder = new Map<string, number>();
    const arrival = orderedByAppearance(items);

    for (const item of arrival) {
        if (item.type === 'notice') {
            const entry: TimelineEntry = {
                key: item.id,
                kind: 'notice',
                turnId: item.turnId,
                parts: [{ kind: 'text', text: item.data.text }],
                streaming: false,
                deliveries: [],
                at: item.at,
                ...(item.data.job === undefined ? {} : { job: item.data.job }),
            };
            anchors.set(entry.key, item.order ?? item.seq);
            entries.push(entry);
            continue;
        }

        // 没作者的错误 = **轮级**结局（`endItems`：未知原因 / 上游失败 / 内容过滤……）。
        // 它本来就是这一轮最后一句，单独成条。
        // 有作者的错误不在这里处理 —— 它属于那个 bot 的回复，见下面的 part 分支。
        if (item.type === 'error' && item.author === undefined) {
            const entry: TimelineEntry = {
                key: item.id,
                kind: 'error',
                turnId: item.turnId,
                parts: [{ kind: 'text', text: item.data.message }],
                streaming: false,
                deliveries: [],
                at: item.at,
            };
            anchors.set(entry.key, item.order ?? item.seq);
            entries.push(entry);
            continue;
        }

        const author = item.author;

        if (author?.role === 'human') {
            // 人插话 = 切段点：这一轮已经有过 bot 输出时，后续同轮的 bot parts 另起一段。
            // 轮起点的第一句人话不切（它之前没有 bot 可打断）。
            if (botSeen.has(item.turnId)) segmentOf.set(item.turnId, (segmentOf.get(item.turnId) ?? 0) + 1);
            const at = item.order ?? item.seq;
            currentHumanOrder.set(item.turnId, Math.max(currentHumanOrder.get(item.turnId) ?? 0, at));
            const entry: TimelineEntry = {
                key: item.id,
                kind: 'user',
                turnId: item.turnId,
                author,
                parts: [{ kind: 'text', text: item.type === 'chat' ? item.data.text : '' }],
                streaming: false,
                deliveries: chipsOf(deliveries, bots, item.id),
                ...(item.type === 'chat' && item.data.attachments !== undefined
                    ? { attachments: item.data.attachments }
                    : {}),
                at: item.at,
            };
            anchors.set(entry.key, at);
            entries.push(entry);
            continue;
        }

        const seg = segmentOf.get(item.turnId) ?? 0;
        const address = `${item.turnId}\u0000${author?.id ?? ''}\u0000${seg}`;
        let entry = replies.get(address);
        if (entry === undefined) {
            entry = {
                // 段 0 沿用老 key（老数据 / 单测形状不变），段 > 0 带段号
                key:
                    seg === 0
                        ? `${item.turnId}:${author?.id ?? 'unknown'}`
                        : `${item.turnId}:${author?.id ?? 'unknown'}:${seg}`,
                kind: 'assistant',
                turnId: item.turnId,
                author,
                parts: [],
                streaming: false,
                deliveries: [],
                ...(seg === 0 ? {} : { segment: seg }),
                // 位置 = 首次出现的时刻。之后追加的条目**不改**它：这就是"位置定了就定了"。
                at: item.at,
            };
            replies.set(address, entry);
            // 锚点 = 这一「段」开始前最近的一条人的消息之后（+0.5 保证排在它后面、且与它不并列）。
            // 切段时：seg 0 落在轮起点人话之后；seg k 落在触发它的那条插话之后 —— 于是
            // 「人话 → 前半段 → 插话 → 后半段」自然成立，不需要额外的位置魔法。
            const own = item.order ?? item.seq;
            const lastHuman = currentHumanOrder.get(item.turnId) ?? 0;
            anchors.set(entry.key, lastHuman > own ? lastHuman + 0.5 : own);
            entries.push(entry);
        }
        botSeen.add(item.turnId);
        if (item.type === 'error') {
            // 这个 bot 自己的运行失败（`run.failed`）：属于这条回复，按时间顺序插进去。
            // 不这么做的话它只能排在整条回复**之后** —— 而失败之后同一轮里还可能再跑一次，
            // “先失败、后重试成功”就会渲染成“成功的文字，然后调用失败”，因果关系倒挂。
            entry.parts.push({ kind: 'error', message: item.data.message });
            continue;
        }

        const part = partOf(item);
        if (part !== undefined) entry.parts.push(part);
        if (item.status === 'streaming') entry.streaming = true;
    }

    // 提问卡片：待回答的 + 已有结局的（后者只读，带已选状态）。首选挂在触发它的工具行后面。
    //
    // 挂不上工具行时按精度退，不要跳步：
    //  1. 按 `turnId` + `owner` 找那条回复 —— 那一轮还在窗口里就挂对地方；
    //  2. 还是不行（老数据没有 `turnId` / 那一轮整个也不在窗口里）：待回答的借最后一条
    //     assistant（工具行可能还没落库），已结局的造一张独立卡片。
    //
    // 窗口起点（2026-11-28）：服务端分页只给最近一窗（默认 400 条），但已结局的提问是
    // **整个房间的历史**（最近 200 条）。那些比窗口还早的卡片在 `entries` 里找不到自己的
    // 位置（`findIndex(at > x)` 落到 0），于是被塞到**时间线最顶上** —— 用户看到七八条
    // 很久以前的问题卡浮在开头。更糟的是它们把"第一个子节点"钉死在窗口之外，前插历史时
    // 滚动层以为"首条没动"，于是把视口拉到最后一条用户消息（实测：加载更早直接跳到末尾）。
    // 所以：比窗口最早的条目还早的独立卡片，这一窗里不画。
    const windowStartAt =
        arrival.length === 0
            ? Number.NEGATIVE_INFINITY
            : arrival.reduce((min, item) => Math.min(min, item.at), Number.POSITIVE_INFINITY);
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

        // 工具行不在窗口里时（滑出去了 / 还没落库），按提问方盖的 `turnId` + `owner` 找那条
        // 回复（地址即 `(turnId, author)`）：那一轮还在窗口里就能挂对地方，不必借
        // "最后一条 assistant"去猜。这一招以前做不到 —— `AskRequest` 不知道自己在哪一轮，
        // 于是只能分两种情况：待回答借最后一条，已结局造独立卡片。
        const holder =
            request.turnId === undefined || request.owner === undefined
                ? undefined
                : replies.get(
                      `${request.turnId}\u0000${request.owner}\u0000${segmentOf.get(request.turnId) ?? 0}`,
                  );
        if (holder !== undefined) {
            holder.parts.push(part);
            return;
        }

        if (fallback === 'last-assistant') {
            const target = [...entries].reverse().find((entry) => entry.kind === 'assistant');
            if (target === undefined) return;
            target.parts.push(part);
            return;
        }

        // 比这一窗还早：没有位置可挂，宁可不画（见上面 `windowStartAt` 的注释）
        if ((at ?? request.at) < windowStartAt) return;

        const bot = request.owner === undefined ? undefined : bots[request.owner];
        // 这条提问属于哪一轮：由提问方在创建时盖上去（`AskRequest.turnId`）。
        // 没有它（老数据）只能是 `''` 哨兵 —— 那种卡片既不参加"执行中"的匹配，
        // 也不会认领这一轮的页脚，因为它在数据上不属于任何一轮。
        const standalone: TimelineEntry = {
            key: `ask:${request.askId}`,
            kind: 'assistant',
            turnId: request.turnId ?? '',
            ...(bot === undefined
                ? {}
                : { author: { id: bot.id, name: bot.name, color: bot.color, role: 'bot' as const } }),
            parts: [part],
            streaming: false,
            deliveries: [],
            at: at ?? request.at,
        };
        const position = entries.findIndex((entry) => entry.at > standalone.at);
        const slot = position < 0 ? entries.length : position;
        // 独立卡片也参加锚点排序：取「插入位置前驱的锚点 + 0.5」，
        // 这样它既在原位（夹在前驱与后继之间），又不会被后面才算出锚点的回复挤到前面
        const previous = slot > 0 ? entries[slot - 1] : undefined;
        anchors.set(standalone.key, (previous === undefined ? 0 : anchors.get(previous.key) ?? 0) + 0.5);
        entries.splice(slot, 0, standalone);
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
                ...(entry.expired === true ? { expired: true } : {}),
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
        // 本轮已经产出过内容：把"还在跑"挂回它自己那条回复上。
        // 单独补一条 typing 条目会让它在列表最底部出现，于是"工具行转圈 →
        // 执行中一行 → 工具行转圈"上下交错（每条 item 到达都会重排一次）。
        // 按 (turnId, botId) 直取那条回复 —— 不需要排除独立卡片：它有自己的 turnId，
        // 而 turnId 为 '' 的（无轮次的老卡片）压根进不了这个 if（`turnId === ''` 已经挡掉）。
        const own =
            turnId === '' ? undefined : replies.get(`${turnId}\u0000${botId}\u0000${segmentOf.get(turnId) ?? 0}`);
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
            // 位置用服务端给的开始时刻（有的话）：消息头写的就是这个时间，
            // 拿条目时刻会与收轮后的结算行差几十毫秒到几秒（排队 / 唤醒）
            at: options.turns?.[`${turnId}\u0000${botId}`]?.startedAt ?? startedAt,
        });
    }

    attachTurns(entries, options.turns);
    // 按锚点稳定排序（同锚点保持插入顺序：JS 的 sort 自 ES2019 起是稳定的）
    const index = new Map(entries.map((entry, at) => [entry.key, at]));
    entries.sort((left, right) => {
        // 没给锚点的是「遍历之后才补的」条目（如「正在输入…」）：它们本来就该落在末尾
        const diff =
            (anchors.get(left.key) ?? Number.POSITIVE_INFINITY) - (anchors.get(right.key) ?? Number.POSITIVE_INFINITY);
        return diff !== 0 ? diff : (index.get(left.key) ?? 0) - (index.get(right.key) ?? 0);
    });
    return entries;
}

/**
 * 把「这一轮的时刻与结局」挂到该轮**最后一条** bot 条目上。
 *
 * 为什么是最后一条：一轮可能被插话切成多条（text → tool → text），结局属于整轮，
 * 只该在末尾说一次；挂到每条上会让页脚重复，挂到第一条会让它出现在半句话下面。
 */
function attachTurns(entries: TimelineEntry[], turns?: Record<string, TurnFacts>): void {
    if (turns === undefined) return;
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
    // 按「轮 + 成员」精确取：同一轮里 A 被截断、B 正常说完，两人的页脚不能是同一个
    const factsOf = (turnId: string, botId?: string): TurnFacts | undefined => {
        if (botId !== undefined) {
            const exact = turns[`${turnId}\u0000${botId}`];
            if (exact !== undefined) return exact;
        }
        // 老形状（只按 turnId 存）：兼容快照 / 外部构造的 turns
        const legacy = turns[turnId];
        if (legacy !== undefined) return legacy;
        // 这一轮有账、但没人来接：`turns` 的键是 `turnId\u0000botId`，而失败轮
        // 一个字都没说时最后那条 error / notice 没有 author，拿不到 botId ——
        // 只认老形状的话这一轮的身份就永远画不出来（2026-11-27 实测：模型配置报错
        // 的那一轮，磁盘上有 turn_facts 一行、界面上却什么都没有）。
        // 退到「该轮名下的那一条」：fail 的轮基本只有一个 bot 参与。
        const prefix = `${turnId}\u0000`;
        for (const [key, facts] of Object.entries(turns)) {
            if (key.startsWith(prefix)) return facts;
        }
        return undefined;
    };
    for (const [key, index] of lastBot) {
        const [turnId = '', botId] = key.split('\u0000');
        const facts = factsOf(turnId, botId);
        const entry = entries[index];
        if (facts === undefined || entry === undefined) continue;
        entries[index] = { ...entry, turn: facts };
        explained.add(turnId);
    }
    // 正主没有（这一轮没说话）：退到该轮最后一条条目上，别让结局无处可说
    for (const [turnId, index] of lastOfTurn) {
        if (explained.has(turnId)) continue;
        const facts = factsOf(turnId);
        const entry = entries[index];
        if (facts === undefined || entry === undefined) continue;
        entries[index] = { ...entry, turn: facts };
    }
}
