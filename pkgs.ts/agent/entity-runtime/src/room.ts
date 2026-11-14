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

import {
    effectiveModelOf,
    effectivePersonaOf,
    mentionsOf,
    primaryMemberOf,
} from '@diy-agent/protocol';

import { AskGate, type AskOutcome } from './ask';
import type { Compactor } from './compaction';
import type { Store } from './db';
import { RoomLog, type RoomEntry } from './room-log';
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
import type { AskRequest, Author, Bot, Delivery, InboxMode, Item, Room, RoomEvent, RoomMember } from './types';

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
    /** 是否开放 shell（缺省开放） */
    shell?: boolean;
    /** shell 缺省超时 */
    bashTimeoutMs?: number;

    /** 压缩事件（日志 / 监控） */
    onCompact?: (bot: Bot, event: CompactEvent) => void;
    now?: () => number;
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
    /** 已落库的 item id（流式更新会重复发同一条） */
    private readonly persisted = new Set<string>();
    /** 提问闸门：模型需要用户做决定时在这里停住 */
    private readonly gate: AskGate;
    private builtTools: ToolSet | undefined;

    constructor(private readonly deps: RoomActorDeps) {
        // 公共日志从库里恢复（append-only，seq 接着走）
        this.log = new RoomLog(this.deps.store.roomEntries(this.id));
        this.gate = new AskGate({
            request: (request) => this.deps.emit({ kind: 'ask', request }),
            settle: (request, result) => this.settleAsk(request, result),
            now: () => this.deps.now?.() ?? Date.now(),
        });
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

    /** 投一条消息：落库 → 进公共日志 → 按 @ 规则分发 → 等这一轮跑完 */
    async say(input: { text: string; author: Author; recipients?: string[]; mode?: InboxMode }): Promise<void> {
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

        const entry = this.appendEntry({ kind: 'say', author: input.author, text, turn: turn.turn, turnId: turn.turnId });

        const recipients = this.route(text, participants, input.recipients);
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
                ...(turn === undefined ? {} : { turn }),
            });
        }
    }

    cancel(options: { keepQueue?: boolean } = {}): void {
        // 先放掉挂起的提问（否则 execute 还停在 await 上，abort 也退不干净）
        this.gate.cancelAll('本轮已取消');
        for (const session of this.sessions.values()) session.cancel(options);
    }

    /** 用户的回答；返回是否命中一个待回答的提问 */
    answerAsk(askId: string, answer: { values?: string[]; fields?: Record<string, string> }): boolean {
        return this.gate.answer(askId, answer);
    }

    /** 还有几个提问在等回答 */
    pendingAsks(): number {
        return this.gate.pendingCount();
    }

    /** 挂起的提问（刷新 / 重连时恢复卡片） */
    pendingAskRequests(): ReturnType<AskGate['list']> {
        return this.gate.list();
    }

    /** 提问解决：广播 + 在时间线留一条痕 */
    private settleAsk(request: AskRequest, result: Omit<AskOutcome, 'request'>): void {
        this.deps.emit({
            kind: 'ask.answered',
            askId: request.askId,
            ...(result.answer === undefined ? {} : { answer: result.answer }),
            ...(result.cancelled === true ? { cancelled: true } : {}),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
        const now = this.deps.now?.() ?? Date.now();
        const labels = (result.answer?.values ?? []).map(
            (value) => request.options?.find((option) => option.value === value)?.label ?? value,
        );
        const summary =
            result.cancelled === true
                ? `未回答${result.reason === undefined ? '' : `（${result.reason}）`}`
                : result.answer?.fields !== undefined
                  ? `已填写：${Object.values(result.answer.fields).filter((value) => value.trim() !== '').length} 项`
                  : `已回答：${labels.join('、')}`;
        const turnId = this.currentTurn?.turnId;
        const notice: Item = {
            id: `askx-${request.askId}`,
            seq: 0, // appendItem 落库时会用 rowid 覆盖
            order: this.nextOrder(),
            ...(this.currentTurn === null ? {} : { turn: this.currentTurn.turn }),
            turnId: turnId ?? 'turn',
            at: now,
            status: 'done',
            type: 'notice',
            data: { text: summary, kind: 'ask' },
        };
        this.deps.emit({ kind: 'item', item: this.deps.store.appendItem(this.id, notice) });
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
        // 退出的成员把 session 一并丢掉（再进来会按日志重建）
        const keep = new Set(members.map((member) => member.botId));
        for (const botId of [...this.sessions.keys()]) if (!keep.has(botId)) this.sessions.delete(botId);
        for (const bot of this.members()) this.sessionOf(bot);
    }

    addMember(botId: string): void {
        if (this.deps.spec.members.some((member) => member.botId === botId)) return;
        this.setMembers([...this.deps.spec.members, { botId }]);
    }

    update(patch: { name?: string; modelKey?: string }): void {
        if (patch.name !== undefined && patch.name.trim() !== '') {
            this.deps.spec.name = patch.name.trim();
            const primary = this.primary();
            if (primary !== undefined) {
                const identity = this.deps.bots().find((bot) => bot.id === primary.id);
                if (identity !== undefined) {
                    this.deps.store.upsertBot({ ...identity, name: this.deps.spec.name });
                }
            }
        }
        if (patch.modelKey !== undefined) this.deps.spec.modelKey = patch.modelKey;
    }

    // ── 内部 ───────────────────────────────────────────────────

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
        this.deps.store.saveSession(this.id, botId, snapshot);
        this.turnSeq = Math.max(this.turnSeq, snapshot.turn);
    }

    /** 工具集：房间目录 + 审批闸门（构造一次，所有 session 共用） */
    private get tools(): ToolSet | undefined {
        if (this.builtTools === undefined) {
            const cwd = this.deps.cwd;
            if (cwd === undefined) return undefined;
            this.builtTools = buildRoomTools({
                cwd,
                ...(this.deps.shell === undefined ? {} : { shell: this.deps.shell }),
                ...(this.deps.bashTimeoutMs === undefined ? {} : { bashTimeoutMs: this.deps.bashTimeoutMs }),
                ask: this.gate,
            });
        }
        return this.builtTools;
    }

    private toolsHint(): string {
        return (
            '可以用 read / write / edit 读写文件、用 bash 执行命令；' +
            `工作目录是 ${this.deps.cwd ?? '未设置'}，相对路径按它解析。` +
            '改文件优先用 edit（不要整份重写）。' +
            '需要用户做决定时**必须**调用 ask（选项 / 表单）：不要在正文里提问，' +
            '也不要在正文里列选项让用户挑——那些都会被大段输出淹没。'
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

    /** 取/建某个成员的 session；新建时回放公共日志（后加入的成员也能读到此前结论） */
    private sessionOf(bot: Bot): BotSession {
        let session = this.sessions.get(bot.id);
        if (session !== undefined) return session;

        const saved = this.deps.store.loadSession(this.id, bot.id);
        session = new BotSession({
            bot,
            modelKey: bot.modelKey,
            allocateTurn: () => this.newTurn(),
            ...(saved === undefined ? {} : { seed: () => saved }),
            ...(this.deps.run === undefined ? {} : { run: this.deps.run }),
            ...(this.deps.compactor === undefined ? {} : { compactor: this.deps.compactor }),
            ...(this.deps.budget === undefined ? {} : { budget: this.deps.budget }),
            ...(this.tools === undefined ? {} : { tools: this.tools }),
            ...(this.tools === undefined ? {} : { toolsHint: this.toolsHint() }),
        });
        // 房间订阅 session 的输出：编号、落库、广播都在这一侧
        session.subscribe((event) => this.onSessionEvent(bot, event));

        for (const entry of this.log.all()) session.ingest(entry);
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
                this.deps.emit({ kind: 'item', item });
                if ((item.status === 'done' || item.status === 'failed') && !this.persisted.has(item.id)) {
                    this.persisted.add(item.id);
                    this.deps.store.appendItem(this.id, item);
                }
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
            case 'turn.end':
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
    private publishConclusion(bot: Bot, result: { turn: number; turnId: string; text: string; failed: boolean }): void {
        if (result.failed || result.text === '') return;

        const entry = this.appendEntry({
            kind: 'conclusion',
            botId: bot.id,
            name: bot.name,
            color: bot.color,
            text: result.text,
            turn: result.turn,
            turnId: result.turnId,
        });
        for (const [botId, session] of this.sessions) {
            if (botId !== bot.id) session.ingest(entry);
        }

        const name = mentionsOf(result.text).find((value) => value !== 'all');
        if (name === undefined) return;
        const target = this.members().find((candidate) => candidate.name === name && candidate.id !== bot.id);
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
            data: { text: `${bot.name} 在结论里 @${target.name}，已唤起`, kind: 'mention' },
        };
        this.deps.emit({ kind: 'item', item: this.deps.store.appendItem(this.id, notice) });

        void this.sessionOf(target).post({
            messageId: notice.id,
            text: `[${bot.name} 的结论] ${result.text}`,
            mode: 'next-turn',
            turn: { turn: result.turn, turnId: result.turnId },
        });
    }
}
