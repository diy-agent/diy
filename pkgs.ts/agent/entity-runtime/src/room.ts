// room.ts —— RoomActor：一个房间的聚合根。
//
// 一个 Room 拥有的东西（以前散在 server 的 7 个 Map 里）：
//   · 成员与默认应答（RoomMember：身份 + 本房间的模型/人格覆盖）
//   · 公共日志（RoomLog：人话 / 结论 / 通知，append-only）
//   · 会话池（每个 bot 一条 BotSession）
//   · 回合与展示顺序（turn / order 的唯一分配点）
//   · 路由（@ 规则）、结论发布、投递状态
//
// 不知道 HTTP / SSE：只通过 `emit` 把房间事件交出去，传输层自己决定怎么送。
//
// 领域不变量（改动前先看）：
//   1. 普通消息默认 next-step；被 @ 的人才是收件人，其余人只进上下文不唤醒
//   2. bot 的结论进公共日志，复制给其他 session，**不唤醒任何人**
//   3. bot 之间只能单人 @ 唤醒（@all 在 bot 侧忽略，防一次结论炸醒全房间）
//   4. 压缩只影响自己：没有房间级水位，也没有共享摘要
//   5. 同一房间运行中再发消息 → 沿用当前 turn（时间线不乱）

import type { ModelMessage, ToolSet } from 'ai';

import { effectiveModelOf, effectivePersonaOf, mentionsOf, primaryMemberOf } from '@diy-agent/protocol';
import type { ContextSession } from '@diy-agent/context';

import { AskGate, askAnswerHeading, describeAnswer, type AnswerOutcome, type AskResult } from './ask';
import type { Compactor } from './compaction';
import { ASK_DRAFT_PREFIX, type Store } from './db';
import { RoomLog, type RoomEntry } from './room-log';
import { createRoomContext } from './system-context';
import { buildRoomTools } from './tools/index';
import type { CompactEvent } from './compaction';
import {
    BotSession,
    type CompactOptions,
    type SessionDeps,
    type SessionEvent,
    type SessionStats,
    type Turn,
} from './session';
import { publishable } from './end-reason';
import type {
    AskAnswer,
    AskRequest,
    Author,
    Bot,
    Delivery,
    InboxMode,
    Item,
    Room,
    RoomEvent,
    RoomMember,
    TurnEndReason,
} from './types';

export interface SessionInfo {
    botId: string;
    name: string;
    stats: SessionStats;
    compactions: ReturnType<BotSession['compactions']>;
}

export interface RoomActorDeps {
    spec: Room;
    store: Store;
    /** 全局 bot 身份表（可变化） */
    bots: () => Bot[];
    /** 房间事件出口；传输层在这里挂 SSE / rpc 推送 */
    emit: (event: RoomEvent) => void;
    /** 测试注入：假的模型运行 */
    run?: SessionDeps['run'];
    compactor?: Compactor;
    budget?: CompactOptions;
    /** 房间的工作目录；不传 = 不给文件/命令工具（只用内置 get_time） */
    cwd?: string;
    /**
     * 应用数据根（diy2 = `DIY2_HOME`）：`<home>/AGENTS.md` 进规则链首、并允许读设备级知识库。
     * 不传 = 没有应用级规范（测试 / 无 app 宿主）。
     */
    home?: string;
    /** 是否开放 shell（缺省开放） */
    shell?: boolean;
    /** shell 缺省超时 */
    bashTimeoutMs?: number;

    /** 压缩事件（日志 / 监控） */
    onCompact?: (bot: Bot, event: CompactEvent) => void;
    now?: () => number;
    /** 「用户」在时间线上的身份（回答提问时以它投递）；缺省就是「我」 */
    human?: Author;
}

export class RoomActor {
    private readonly log: RoomLog;
    private readonly sessions = new Map<string, BotSession>();
    /** 展示顺序（跨 bot 稳定） */
    private order = 0;
    /** 回合号 */
    private turnSeq = 0;
    private currentTurn: Turn | null = null;
    private initialized = false;
    /** item.id → 展示顺序（同一 id 的流式更新不能换顺序） */
    private readonly orderOf = new Map<string, number>();
    /**
     * 工具条目 id → 它属于哪一轮。提问闸门用它给卡片盖 `turnId`（见 `AskGateDeps.turnOf`）。
     * 生命周期与 `orderOf` 相同（按 item id 累积）：只多了工具条目这一种，量级一样。
     */
    private readonly turnOfTool = new Map<string, string>();
    /** 已落库的 item id（流式更新会重复发同一条） */
    private readonly persisted = new Set<string>();
    /** 提问闸门：模型需要用户做决定时把卡片推到界面上（不阻塞本轮） */
    private readonly gate: AskGate;
    /** 用户的身份（回答提问时那条消息的作者） */
    private readonly human: Author;
    /**
     * 每个成员一份上下文会话：provider 值共享，但 cursor（模型已经看过哪棵树）各自推进。
     * 一个成员没被 @ 时只 ingest、不 step；等它下一次跑，增量会一次补齐。
     */
    private readonly contexts = new Map<string, ContextSession>();
    /** 系统自己的身份：「你的提问被挤掉了」这类通知的作者（不能冒充用户） */
    private static readonly SYSTEM: Author = { id: 'system:ask', name: '系统', color: '#9ca3af', role: 'system' };
    /** 每个成员一份工具集：只有 ask 的归属不同（按成员停止时要能分辨） */
    private readonly toolsByBot = new Map<string, ToolSet | undefined>();
    /** 正在跑一轮的成员（UI 的"谁在说话"用它，不由前端猜） */
    private readonly speaking = new Set<string>();
    private lastRunningKey = '';

    constructor(private readonly deps: RoomActorDeps) {
        // 公共日志从库里恢复（append-only，seq 接着走）
        this.log = new RoomLog(this.deps.store.roomEntries(this.id));
        this.gate = new AskGate({
            request: (request) => {
                // 先落库再广播：进程在广播后、用户回答前挂掉，重启还能把卡片捞回来
                this.deps.store.putAsk({
                    askId: request.askId,
                    entityId: this.id,
                    at: request.at,
                    request,
                    state: 'pending',
                });
                this.deps.emit({ kind: 'ask', request });
            },
            settle: (request, result, owner) => this.settleAsk(request, result, owner),
            turnOf: (toolCallId) => (toolCallId === undefined ? undefined : this.turnOfTool.get(`tool-${toolCallId}`)),
            now: () => this.deps.now?.() ?? Date.now(),
        });
        // 待答的提问从库里恢复（ask 不阻塞，内存状态扛不住重启）
        this.gate.restore(
            this.deps.store.asksOf(this.id).map((record) => ({
                request: record.request,
                state: record.state,
                ...(record.answer === undefined ? {} : { answer: record.answer }),
                ...(record.reason === undefined ? {} : { reason: record.reason }),
                at: record.at,
                ...(record.settledAt === undefined ? {} : { settledAt: record.settledAt }),
            })),
        );
        this.human = this.deps.human ?? { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' };
        // 成员的 session 一开始就建好：上下文、统计、恢复都不需要等第一条消息
        for (const bot of this.members()) this.sessionOf(bot);
    }

    get id(): string {
        return this.deps.spec.id;
    }

    get spec(): Room {
        return this.deps.spec;
    }

    // ── 成员 ───────────────────────────────────────────────────

    /** 房间成员（已套用本房间的模型/人格覆盖） */
    members(): Bot[] {
        const identities = this.deps.bots();
        return this.deps.spec.members
            .map((member) => identities.find((bot) => bot.id === member.botId))
            .filter((bot): bot is Bot => bot !== undefined)
            .map((bot) => this.inRoom(bot));
    }

    member(botId: string): Bot | undefined {
        return this.members().find((bot) => bot.id === botId);
    }

    primary(): Bot | undefined {
        const member = primaryMemberOf(this.deps.spec);
        return member === undefined ? undefined : this.member(member.botId);
    }

    busy(): boolean {
        for (const session of this.sessions.values()) if (session.busy) return true;
        return false;
    }

    // ── 时间线 ─────────────────────────────────────────────────

    items(afterSeq = 0): Item[] {
        return this.deps.store.itemsOf(this.id, afterSeq);
    }

    deliveries(): Delivery[] {
        return this.deps.store.listDeliveries(this.id);
    }

    /** 公共日志（只读，调试 / 重放用） */
    entries(): readonly RoomEntry[] {
        return this.log.all();
    }

    // ── 写 ─────────────────────────────────────────────────────

    /**
     * 投一条消息：落库 → 进公共日志 → 按 @ 规则分发 → 等这一轮跑完。
     *
     * `quiet`：只留痕 —— 时间线上看得到、所有人的上下文里也有，但**不投给任何人**，
     * 于是不会叫醒任何成员跑一轮。用于系统通知（「你那问作废了」）：那是给人看的状态，
     * 不是需要回复的消息；走普通投递会把一个空闲成员叫起来，只为读一句「不用再等」。
     */
    async say(input: {
        text: string;
        author: Author;
        recipients?: string[];
        mode?: InboxMode;
        quiet?: boolean;
    }): Promise<void> {
        const text = input.text.trim();
        if (text === '') throw new Error('text required');

        const participants = this.members();
        if (participants.length === 0) throw new Error('room has no bot');

        // 先把成员 session 建好（新建的会回放日志），再追加这条公共条目，
        // 否则被 @ 的人会把同一条消息收两遍（日志 + steering）
        for (const bot of participants) this.sessionOf(bot);

        const turn = this.currentTurn !== null && this.busy() ? this.currentTurn : this.newTurn();
        const now = this.deps.now?.() ?? Date.now();
        const item: Item = {
            id: `u-${now.toString(36)}-${this.order + 1}`,
            seq: this.deps.store.seqOf(this.id) + 1,
            order: this.nextOrder(),
            turn: turn.turn,
            turnId: turn.turnId,
            at: now,
            status: 'done',
            author: input.author,
            type: 'chat',
            data: { text },
        };
        const saved = this.deps.store.appendItem(this.id, item);
        this.deps.emit({ kind: 'item', item: saved });

        const entry = this.appendEntry({
            kind: 'say',
            author: input.author,
            text,
            turn: turn.turn,
            turnId: turn.turnId,
        });

        // 空 recipients ＝ 所有人都走 ingest（下面那条循环），谁也不被 post 叫醒
        const recipients = input.quiet === true ? [] : this.route(text, participants, input.recipients);
        const recipientIds = new Set(recipients.map((bot) => bot.id));
        for (const bot of participants) {
            if (!recipientIds.has(bot.id)) this.sessionOf(bot).ingest(entry);
        }

        for (const bot of recipients) {
            // 入队信息一起落库：崩溃后靠它重新投递
            const delivery = this.deps.store.setDelivery({
                roomId: this.id,
                messageId: saved.id,
                botId: bot.id,
                state: 'queued',
                mode: input.mode ?? 'next-step',
                turn: turn.turn,
                turnId: turn.turnId,
            });
            this.deps.emit({ kind: 'delivery', delivery });
        }

        // 变量增量不在这里算：它属于**模型步**（session 的 prepareStep 每步取一次），
        // 这样 say / 恢复重投 / agent 间结论走的是同一条路，不会有「时机不同就漏一把」。
        await Promise.all(
            recipients.map((bot) =>
                this.sessionOf(bot).post({
                    messageId: saved.id,
                    text,
                    mode: input.mode ?? 'next-step',
                    turn,
                    entry,
                }),
            ),
        );
    }

    /**
     * 崩溃恢复：把还没送达的投递重新投一遍。
     * `delivering` 视为未送到（进程中途挂了，模型回复也没落盘）。
     */
    recover(): void {
        for (const delivery of this.deps.store.pendingDeliveries(this.id)) {
            const bot = this.member(delivery.botId);
            if (bot === undefined) continue;
            const text = this.deps.store.textOf(this.id, delivery.messageId);
            if (text === undefined) {
                this.deps.store.setDelivery({
                    roomId: this.id,
                    messageId: delivery.messageId,
                    botId: delivery.botId,
                    state: 'failed',
                    note: '恢复时找不到原文',
                });
                continue;
            }
            const turn =
                delivery.turn === undefined
                    ? undefined
                    : { turn: delivery.turn, turnId: delivery.turnId ?? `turn-${delivery.messageId}` };
            void this.sessionOf(bot).post({
                messageId: delivery.messageId,
                text,
                mode: delivery.mode ?? 'next-step',
                // 这句人话在公共日志里，session 回放时已经读到了；再追加一次会让模型看到两遍
                alreadyInContext: true,
                ...(turn === undefined ? {} : { turn }),
            });
        }
    }

    /**
     * 停止：不给 botId 就停整个房间；给了只停那个成员。
     * 开会时"谁在说"是分开的，停一个人不该把别人也停掉。
     */
    cancel(options: { botId?: string; keepQueue?: boolean } = {}): void {
        // 注意：不动待回答的提问。ask 不阻塞，点「停止」时那一轮早就跑完了，
        // 卡片还得留在界面上等用户作答（回答会另开一轮）。
        if (options.botId === undefined) {
            for (const session of this.sessions.values()) session.cancel(options);
            return;
        }
        this.sessions.get(options.botId)?.cancel(options);
    }

    /**
     * 容器即将被删除：先停掉还在跑的会话和挂着的提问。
     * 不先停就删行的话，跑到一半的 race 收尾时还会往已删的容器里写条目。
     */
    stop(): void {
        if (this.busy()) this.cancel();
        // 容器要没了：挂在界面上的提问一并清掉，否则回答还会往已删的容器里投递
        this.gate.cancelAll('容器已关闭');
    }

    /** 当前在说话的成员（按成员顺序） */
    runningBots(): string[] {
        return this.members()
            .map((bot) => bot.id)
            .filter((botId) => this.speaking.has(botId));
    }

    /** 用户的回答（整批一次提交）；返回结局（命中 / 已失效 / 答不全） */
    answerAsk(askId: string, answer: AskAnswer): AnswerOutcome {
        return this.gate.answer(askId, answer);
    }

    /**
     * 用户撤回某一问（不想答了）：卡片收尾成「已失效」，待回答计数减一。
     *
     * 不碰正在跑的运行 —— 那件事是 `cancel()`，与这张卡无关（ask 不阻塞，
     * 点「停止」时那一轮早就跑完了）。也不叫醒任何人：只给提问的成员留一句系统说明，
     * 它下次真正被叫起来时才读到（见 `notifyAskDropped`）。
     */
    cancelAsk(askId: string, reason = '提问已被撤回'): boolean {
        return this.gate.cancel(askId, reason);
    }

    /** 还有几个提问在等回答 */
    pendingAsks(): number {
        return this.gate.pendingCount();
    }

    /** 挂起的提问（刷新 / 重连时恢复卡片） */
    pendingAskRequests(): ReturnType<AskGate['list']> {
        return this.gate.list();
    }

    /** 已有结局的提问（最近的若干条）：刷新后卡片仍在，并带着已选状态 */
    answeredAskRequests(): ReturnType<AskGate['answeredList']> {
        return this.gate.answeredList();
    }

    /**
     * 提问解决：卡片收尾 + 留痕 + （关键）把回答变成一条用户消息投给提问的人。
     *
     * 为什么必须是消息：ask 不阻塞，模型的 run 早已结束，没有 tool call 能填回答案了。
     * 他会说话 ⇒ 走 steering 在下一个 step 边界注入；已经说完 ⇒ 这条消息开新的一轮。
     */
    private settleAsk(request: AskRequest, result: AskResult, owner?: string): void {
        // 先落库（待答 → 已答/已撤）：重启后卡片仍能带着「已选」或「已失效」回来
        this.deps.store.putAsk({
            askId: request.askId,
            entityId: this.id,
            at: request.at,
            request,
            state: result.answer === undefined ? (result.expired === true ? 'expired' : 'cancelled') : 'answered',
            ...(result.answer === undefined ? {} : { answer: result.answer }),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            settledAt: Date.now(),
        });
        this.deps.store.pruneAsks(this.id, 50);
        // 提问有结局 ⇒ 半填的答案就该消失（**这个**才是回收条件，不是"过多久没人动"）。
        // 答上来 / 被撤回 / 被新提问挤掉 / 房间关了，都走这里：卡片从此只读或不再显示，
        // 留着草稿只会让侧栏的 ? 为一个不存在的提问常亮（docs/drafts-design.md §12）。
        // 只删自己这一条 field：同一房间的发言框草稿不许受牵连。
        this.deps.store.deleteDraft(this.id, `${ASK_DRAFT_PREFIX}${request.askId}`);
        this.deps.emit({
            kind: 'ask.answered',
            askId: request.askId,
            ...(result.answer === undefined ? {} : { answer: result.answer }),
            ...(result.cancelled === true ? { cancelled: true } : {}),
            ...(result.expired === true ? { expired: true } : {}),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
        // 取消（容器关闭 / 成员被移除 / 超时）：卡片消失就够了，不往时间线上写痕
        if (result.answer === undefined) {
            // 例外：被新提问挤掉的那条。提问的成员还在原地看着，而 ask 不阻塞、
            // 没有 tool call 能回填 —— 不告诉它，它会永远停在「我问了、等回答」。
            if (result.notifyOwner === true) this.notifyAskDropped(request, result, owner);
            return;
        }

        // 不再单独落一条 notice：回答本身就是一条消息，时间线上看得到，刷新也不丢。
        // 内容写成模型一眼能对上的样子：哪一问 + 答了什么
        const message = `${askAnswerHeading(request)}\n${describeAnswer(request, result.answer)}`;
        // 回答投给提问的成员；他已经不在房间了就退给主成员，再退给第一个成员。
        // 不退的话 recipients 会被 route() 过滤成空：消息落库了、没任何成员收到、也不报错 ——
        // 用户看到的是「我答了、时间线上有这条、没人理」。
        const target =
            owner !== undefined && this.member(owner) !== undefined
                ? owner
                : (this.primary()?.id ?? this.members()[0]?.id);
        void this.say({
            text: message,
            author: this.human,
            ...(target === undefined ? {} : { recipients: [target] }),
        }).catch((error: unknown) => {
            // 不能再吞：房间里一个成员的 session 都建不起来时 say 会抛，那种情况下用户必须知道答案没送到
            const reason = error instanceof Error ? error.message : String(error);
            this.deps.emit({ kind: 'error', message: `回答没有送出去：${reason}` });
        });
    }

    /**
     * 「你那问作废了」—— 落一条系统痕迹，进上下文，**不叫醒任何人**。
     *
     * 为什么是 `quiet` 而不是普通 `say`：`say` 会 post 给收件人，而 post 一个空闲成员
     * 就是**真的跑一整轮**（实测：B 先问一个→空闲，A 连问 21 个挤掉它 → 运行列表变成
     * `[bot:b#1, bot:a#1, bot:b#2]`，多出来的那一轮只为读一句「不用再等」）。
     * 通知变成叫醒：费钱、多一条无意义回复，还可能让它再提问、再挤掉别人。
     *
     * 作者是系统而不是 this.human：这条不是用户说的话，冒充用户会让模型以为
     * 「我问了、他自己把话题撤了」。transcript 里渲染成 `[系统] …`，跟真回答区分得开。
     */
    private notifyAskDropped(request: AskRequest, result: AskResult, owner?: string): void {
        const target = owner === undefined ? undefined : this.member(owner);
        // 成员已经不在房间了：没人需要知道（它那一份 pending 在移除时已被 cancelFor 清掉）
        if (target === undefined) return;
        const reason = result.reason;
        const suffix = reason === undefined || reason === '' ? '' : `：${reason}`;
        // 「过期」和「作废」对模型是两件事：作废=这问不算数了；过期=它自己已经往前走，
        // 需要的话重新提问（模型据此决定要不要再问，别一味重试一张早就过时的卡）。
        const headline = result.expired === true ? '已经过期' : '已经作废';
        // 多题时把题目都列出来：只说「提问已作废」，它不知道是哪一批（同一个成员可能问过好几张）
        const titles = request.questions.map((question) => `「${question.question}」`).join('');
        void this.say({
            text: `提问${titles}${headline}${suffix}。不用再等这个回答；还需要的话重新提问。`,
            author: RoomActor.SYSTEM,
            quiet: true,
        }).catch((error: unknown) => {
            // 同 settleAsk：送不到必须让用户看见，不能静默
            const message = error instanceof Error ? error.message : String(error);
            this.deps.emit({ kind: 'error', message: `提问作废的通知没有送出去：${message}` });
        });
    }

    /** 手动压某个成员的上下文（只影响它自己） */
    async compact(botId: string, options: CompactOptions = {}): Promise<ReturnType<BotSession['forceCompact']>> {
        const bot = this.member(botId);
        if (bot === undefined) throw new Error('bot not in room');
        return this.sessionOf(bot).forceCompact(options);
    }

    /** 调试 / 测试：某个成员当前的上下文快照 */
    contextOf(botId: string): readonly ModelMessage[] | undefined {
        return this.sessions.get(botId)?.context();
    }

    sessionsInfo(): SessionInfo[] {
        return [...this.sessions.entries()].map(([botId, session]) => ({
            botId,
            name: this.member(botId)?.name ?? botId,
            stats: session.stats(),
            compactions: session.compactions(),
        }));
    }

    // ── 成员变更（持久化在这里，不在 server）────────────────────

    setMembers(members: readonly RoomMember[]): void {
        this.deps.spec.members = [...members];
        this.deps.store.setMembers(this.id, this.deps.spec.members);
        this.deps.store.saveRoom(this.deps.spec);
        // 退出的成员把 session 一并丢掉（再进来会按日志重建）
        const keep = new Set(members.map((member) => member.botId));
        for (const botId of [...this.sessions.keys()]) {
            if (keep.has(botId)) continue;
            this.sessions.delete(botId);
            // 他问过、还没答的提问跟着失效：否则卡片永久挂在界面上，
            // 用户答了也没人收（成员已不在房间，投递会被路由成空）
            this.gate.cancelFor(botId, '提问的成员已离开房间');
        }
        for (const bot of this.members()) this.sessionOf(bot);
    }

    addMember(botId: string): void {
        if (this.deps.spec.members.some((member) => member.botId === botId)) return;
        this.setMembers([...this.deps.spec.members, { botId }]);
    }

    /**
     * 改容器元数据：默认模型 / data（名字、任务状态、描述…）。
     * data 是**浅合并**（`null` = 删掉这个键）：任务状态这类字段后端不懂语义，
     * 只按调用方给的值落库 —— 在这里写枚举就是让新类型（股票/日历）每次都要改 runtime。
     *
     * 容器的名字也在 data 里（task 的 `title` / project 的 `name`），所以改名不再有
     * 独立入参；改名后顺手把主 bot 的显示名同步过去（助手名缺省跟随容器名）。
     */
    update(patch: { modelKey?: string; data?: Record<string, unknown> }): void {
        if (patch.modelKey !== undefined) {
            this.deps.spec.modelKey = patch.modelKey;
            // 已经建好的 session 记着自己的 modelKey：不推下去，UI 上换模型就是死开关
            for (const bot of this.members()) {
                this.sessions.get(bot.id)?.setModelKey(effectiveModelOf(this.deps.spec, bot));
            }
        }
        if (patch.data !== undefined) {
            for (const [key, value] of Object.entries(patch.data)) {
                if (value === null) delete this.deps.spec.data[key];
                else this.deps.spec.data[key] = value;
            }
            const renamed = patch.data['title'] ?? patch.data['name'];
            if (typeof renamed === 'string' && renamed.trim() !== '') this.syncPrimaryName(renamed.trim());
        }
        // 改名 / 换模型 / 改 data 都要落库，否则重启后回到旧值
        this.deps.store.saveRoom(this.deps.spec);
    }

    /**
     * 容器改名 → 主 bot 跟着叫。bot 的名字是它自己的身份，这里同步的是显示名：
     * 不同步的话，改完任务标题，助手在消息里还自称旧名。
     */
    private syncPrimaryName(next: string): void {
        const primary = this.primary();
        const identity = primary === undefined ? undefined : this.deps.bots().find((bot) => bot.id === primary.id);
        // 标题没真变时也会走到这里（保存正文同一笔 data）：名同就不写 bots 表
        if (identity !== undefined && identity.name !== next) this.deps.store.upsertBot({ ...identity, name: next });
        // 已建好的 session 自己持有一份 bot 快照：不推下去，改名后它继续说旧名
        for (const session of this.sessions.values()) session.setBotName(next);
    }

    // ── 内部 ───────────────────────────────────────────────────

    /** 只在"谁在说话"真的变了时广播 */
    private syncRunning(): void {
        const key = this.runningBots().join(',');
        if (key === this.lastRunningKey) return;
        this.lastRunningKey = key;
        this.deps.emit({ kind: 'running', botIds: this.runningBots() });
    }

    /** 追加一条公共条目：内存 + 落库（唯一的写入口） */
    private appendEntry(input: Parameters<RoomLog['append']>[0]): RoomEntry {
        const entry = this.log.append(input);
        this.deps.store.appendRoomEntry(this.id, entry);
        return entry;
    }

    private persistSession(botId: string): void {
        const session = this.sessions.get(botId);
        if (session === undefined) return;
        const snapshot = session.snapshot();
        // 水位和快照一起存：重启回放只补这之后新增的公共条目
        this.deps.store.saveSession(this.id, botId, { ...snapshot, logSeq: this.log.lastSeq });
        this.turnSeq = Math.max(this.turnSeq, snapshot.turn);
    }

    /** 工具集：房间目录 + 审批闸门（每个成员一份，ask 带 owner） */
    private toolsFor(botId: string): ToolSet | undefined {
        if (this.toolsByBot.has(botId)) return this.toolsByBot.get(botId);
        const cwd = this.deps.cwd;
        const tools =
            cwd === undefined
                ? undefined
                : buildRoomTools({
                      cwd,
                      ...(this.deps.shell === undefined ? {} : { shell: this.deps.shell }),
                      ...(this.deps.bashTimeoutMs === undefined ? {} : { bashTimeoutMs: this.deps.bashTimeoutMs }),
                      ask: this.gate,
                      askOwner: botId,
                      onJournal: (input) => {
                          this.deps.store.appendJournal(this.id, input);
                      },
                  });
        this.toolsByBot.set(botId, tools);
        return tools;
    }

    /** 房间是否给成员配了工具（工具提示词据此决定说不说） */
    private get hasTools(): boolean {
        return this.deps.cwd !== undefined;
    }

    private toolsHint(): string {
        return (
            '可以用 read / write / edit 读写文件、用 bash 执行命令；' +
            `工作目录是 ${this.deps.cwd ?? '未设置'}，相对路径按它解析。` +
            '改文件优先用 edit（不要整份重写）。' +
            '留下决策 / 踩坑 / 评审结论时用 journal（一句话一条，按 kind 分类）。' +
            '需要用户做决定时**必须**调用 ask（选项 / 表单）：不要在正文里提问，' +
            '也不要在正文里列选项让用户挑——那些都会被大段输出淹没。' +
            'ask 不会停下来等：调用后当轮直接结束，用户作答会作为一条新消息回来。'
        );
    }

    private inRoom(bot: Bot): Bot {
        return {
            ...bot,
            persona: effectivePersonaOf(this.deps.spec, bot),
            modelKey: effectiveModelOf(this.deps.spec, bot),
        };
    }

    /**
     * 路由（唯一实现）：
     *   显式 recipients = 开会；@all = 全员；@名字 = 命中者；没有 @ = 默认应答。
     */
    private route(text: string, participants: Bot[], explicit?: string[]): Bot[] {
        if (explicit !== undefined && explicit.length > 0) {
            return participants.filter((bot) => explicit.includes(bot.id));
        }
        const names = mentionsOf(text);
        if (names.includes('all')) return participants;
        const picked = participants.filter((bot) => names.includes(bot.name));
        if (picked.length > 0) return picked;
        const primary = this.primary();
        return primary === undefined ? [] : [primary];
    }

    /** 开一个新回合（唯一分配点） */
    private newTurn(): Turn {
        this.ensureInit();
        this.turnSeq += 1;
        const now = this.deps.now?.() ?? Date.now();
        this.currentTurn = { turn: this.turnSeq, turnId: `turn-${now.toString(36)}` };
        return this.currentTurn;
    }

    private nextOrder(): number {
        this.ensureInit();
        this.order += 1;
        return this.order;
    }

    private ensureInit(): void {
        if (this.initialized) return;
        this.initialized = true;
        for (const item of this.deps.store.itemsOf(this.id)) {
            this.order = Math.max(this.order, item.order ?? 0);
            this.turnSeq = Math.max(this.turnSeq, item.turn ?? 0);
        }
    }

    /** 某个成员的上下文会话；没有 cwd 的房间不建（与工具同判据） */
    private contextSessionOf(bot: Bot): ContextSession {
        const existing = this.contexts.get(bot.id);
        if (existing !== undefined) return existing;
        const cwd = this.deps.cwd;
        if (cwd === undefined) throw new Error('contextOf: 房间没有 cwd');
        const ctx = createRoomContext({
            spec: this.deps.spec,
            cwd,
            ...(this.deps.home === undefined ? {} : { home: this.deps.home }),
            journal: () => this.deps.store.journalOf(this.id),
            members: () => {
                const primary = this.primary();
                return this.members().map((bot) => ({
                    id: bot.id,
                    name: bot.name,
                    key: bot.name,
                    main: bot.id === primary?.id,
                }));
            },
        });
        ctx.open();
        this.contexts.set(bot.id, ctx);
        return ctx;
    }

    /** 取/建某个成员的 session；新建时回放公共日志（后加入的成员也能读到此前结论） */
    private sessionOf(bot: Bot): BotSession {
        let session = this.sessions.get(bot.id);
        if (session !== undefined) return session;

        const saved = this.deps.store.loadSession(this.id, bot.id);
        const context = this.deps.cwd === undefined ? null : this.contextSessionOf(bot);
        const systemContext = context?.system ?? '';
        session = new BotSession({
            bot,
            modelKey: bot.modelKey,
            allocateTurn: () => this.newTurn(),
            ...(saved === undefined ? {} : { seed: () => saved }),
            ...(this.deps.run === undefined ? {} : { run: this.deps.run }),
            ...(this.deps.compactor === undefined ? {} : { compactor: this.deps.compactor }),
            ...(this.deps.budget === undefined ? {} : { budget: this.deps.budget }),
            ...(this.toolsFor(bot.id) === undefined ? {} : { tools: this.toolsFor(bot.id) }),
            ...(this.hasTools ? { toolsHint: this.toolsHint() } : {}),
            ...(systemContext === '' ? {} : { systemContext }),
            ...(context === null ? {} : { takeDelta: () => context.step().user, commitDelta: () => context.commit() }),
        });
        // 房间订阅 session 的输出：编号、落库、广播都在这一侧
        session.subscribe((event) => this.onSessionEvent(bot, event));

        // 回放水位：没有快照（后加入的成员）→ 全量回放；有快照但没水位（升级前的老库，
        // log_seq 是列默认值 0，不是真水位）→ 当作已全部 ingest 过，否则第一次启动就翻一倍。
        const from = saved === undefined ? 0 : (saved.logSeq ?? this.log.lastSeq);
        for (const entry of this.log.since(from)) session.ingest(entry);
        this.sessions.set(bot.id, session);
        return session;
    }

    /**
     * session 的唯一出口：序号与持久化都在这里补齐。
     */
    private onSessionEvent(bot: Bot, event: SessionEvent): void {
        switch (event.type) {
            case 'item': {
                const order = this.orderOf.get(event.item.id) ?? this.nextOrder();
                this.orderOf.set(event.item.id, order);
                const item: Item = { ...event.item, order };
                // 先记账再广播：ask 工具的执行体在同一个工具调用的**后面**才跑，
                // 那时 `tool-${callId}` → turnId 必须已经在这里了。
                //
                // 这张表**不恢复**（`orderOf` / `persisted` 同样）：它只需要活到本次调用结束，
                // 进程重启后不会有“拿一个上次的工具条目去问 turnId”的路径。
                // 代价是三张只增不减的 Map —— 长跑房间要清账时一起清。
                if (item.type === 'tool') this.turnOfTool.set(item.id, item.turnId);
                this.deps.emit({ kind: 'item', item });
                if ((item.status === 'done' || item.status === 'failed') && !this.persisted.has(item.id)) {
                    this.persisted.add(item.id);
                    this.deps.store.appendItem(this.id, item);
                }
                return;
            }
            case 'busy': {
                if (event.busy) this.speaking.add(bot.id);
                else this.speaking.delete(bot.id);
                this.syncRunning();
                return;
            }
            case 'delivery': {
                const delivery = this.deps.store.setDelivery({
                    roomId: this.id,
                    messageId: event.messageId,
                    botId: bot.id,
                    state: event.state,
                });
                this.deps.emit({ kind: 'delivery', delivery });
                return;
            }
            case 'turn.start':
                // 这个成员开启了新的一轮：它已经读到新消息、可能已经重新提问 —— 上一张还没答的
                // 提问依赖的世界状态没了（寿命规则见 ask.ts 头部）。过期要点明、要通知它本人，
                // 否则它永远停在「我问了、等回答」（ask 不阻塞，没有 tool call 能回填）。
                this.gate.expireFor(bot.id, `${bot.name} 已开启新一轮`);
                return;
            case 'turn.end':
                // 「这一轮是怎么停的」广播给客户端（消息页脚用它）。放在落库/发结论之前：
                // 页脚比快照早到一点没影响，但顺序上它属于这一轮自己的事实。
                this.deps.emit({
                    kind: 'turn.end',
                    botId: bot.id,
                    turnId: event.result.turnId,
                    reason: event.result.endReason,
                });
                this.persistSession(bot.id);
                this.publishConclusion(bot, event.result);
                return;
            case 'compact':
                this.persistSession(bot.id);
                this.deps.onCompact?.(bot, event.event);
                return;
            case 'error':
                this.deps.emit({ kind: 'error', message: event.message });
                return;
        }
    }

    /**
     * 结论进公共日志，并复制给其他 session —— 不唤醒任何人。
     * 唯一例外：结论里显式 @ 了某个 bot（单人），那是点名。
     */
    private publishConclusion(
        bot: Bot,
        result: { turn: number; turnId: string; text: string; failed: boolean; endReason: TurnEndReason },
    ): void {
        // 只有真正说完的一轮才算"这个 bot 的公开立场"：半句被截断的、失败的、未知停下的话
        // 发进公共日志就是在房间里传播错误信息（判据在 end-reason.ts `publishable`）。
        if (result.failed || result.text === '' || !publishable(result.endReason)) return;

        // 名字取**当前**的（deps.bots 实时读）：传进来的 bot 是 session 建好时的快照，
        // 改名后它会一直以旧名署名（容器改名 = 专属 bot 改名）。
        const name = this.member(bot.id)?.name ?? bot.name;
        const entry = this.appendEntry({
            kind: 'conclusion',
            botId: bot.id,
            name,
            color: bot.color,
            text: result.text,
            turn: result.turn,
            turnId: result.turnId,
        });

        const mention = mentionsOf(result.text).find((value) => value !== 'all');
        const target =
            mention === undefined
                ? undefined
                : this.members().find((candidate) => candidate.name === mention && candidate.id !== bot.id);

        for (const [botId, session] of this.sessions) {
            if (botId === bot.id) continue;
            // 被点名的人走下面的 post（正文只进一次），这里跳过 —— 否则同一段结论读两遍
            if (botId === target?.id) continue;
            session.ingest(entry);
        }

        if (target === undefined) return;

        const now = this.deps.now?.() ?? Date.now();
        const notice: Item = {
            id: `n-${now.toString(36)}-${this.order + 1}`,
            seq: this.deps.store.seqOf(this.id) + 1,
            order: this.nextOrder(),
            turn: result.turn,
            turnId: result.turnId,
            at: now,
            status: 'done',
            type: 'notice',
            data: { text: `${name} 在结论里 @${target.name}，已唤起`, kind: 'mention' },
        };
        this.deps.emit({ kind: 'item', item: this.deps.store.appendItem(this.id, notice) });

        void this.sessionOf(target).post({
            messageId: notice.id,
            text: `[${name} 的结论] ${result.text}`,
            mode: 'next-turn',
            turn: { turn: result.turn, turnId: result.turnId },
        });
    }
}
