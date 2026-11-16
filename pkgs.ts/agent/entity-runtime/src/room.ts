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

import { AskGate, describeAnswer, type AskResult } from './ask';
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
import { publishable } from './end-reason';
import type {
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
    /** 已落库的 item id（流式更新会重复发同一条） */
    private readonly persisted = new Set<string>();
    /** 提问闸门：模型需要用户做决定时把卡片推到界面上（不阻塞本轮） */
    private readonly gate: AskGate;
    /** 用户的身份（回答提问时那条消息的作者） */
    private readonly human: Author;
    /** 每个成员一份工具集：只有 ask 的归属不同（按成员停止时要能分辨） */
    private readonly toolsByBot = new Map<string, ToolSet | undefined>();
    /** 正在跑一轮的成员（UI 的"谁在说话"用它，不由前端猜） */
    private readonly speaking = new Set<string>();
    private lastRunningKey = '';

    constructor(private readonly deps: RoomActorDeps) {
        // 公共日志从库里恢复（append-only，seq 接着走）
        this.log = new RoomLog(this.deps.store.roomEntries(this.id));
        this.gate = new AskGate({
            request: (request) => this.deps.emit({ kind: 'ask', request }),
            settle: (request, result, owner) => this.settleAsk(request, result, owner),
            now: () => this.deps.now?.() ?? Date.now(),
        });
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

        const entry = this.appendEntry({
            kind: 'say',
            author: input.author,
            text,
            turn: turn.turn,
            turnId: turn.turnId,
        });

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
        this.deps.emit({
            kind: 'ask.answered',
            askId: request.askId,
            ...(result.answer === undefined ? {} : { answer: result.answer }),
            ...(result.cancelled === true ? { cancelled: true } : {}),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
        // 取消（容器关闭 / 超时）：卡片消失就够了，不往时间线上写痕
        if (result.answer === undefined) return;

        // 不再单独落一条 notice：回答本身就是一条消息，时间线上看得到，刷新也不丢。
        // 内容写成模型一眼能对上的样子：哪一问 + 答了什么
        const message = `回答提问「${request.question}」：\n${describeAnswer(request, result.answer)}`;
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
     * 改容器元数据：名字 / 默认模型 / data（任务状态、描述…）。
     * data 是**浅合并**（`null` = 删掉这个键）：任务状态这类字段后端不懂语义，
     * 只按调用方给的值落库 —— 在这里写枚举就是让新类型（股票/日历）每次都要改 runtime。
     */
    update(patch: { name?: string; modelKey?: string; data?: Record<string, unknown> }): void {
        if (patch.name !== undefined && patch.name.trim() !== '') {
            this.deps.spec.name = patch.name.trim();
            const primary = this.primary();
            if (primary !== undefined) {
                const identity = this.deps.bots().find((bot) => bot.id === primary.id);
                if (identity !== undefined) {
                    this.deps.store.upsertBot({ ...identity, name: this.deps.spec.name });
                }
            }
            // 已建好的 session 自己持有一份 bot 快照：不推下去，改名后它继续说旧名
            for (const session of this.sessions.values()) session.setBotName(this.deps.spec.name);
        }
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
        }
        // 改名 / 换模型 / 改 data 都要落库，否则重启后回到旧值
        this.deps.store.saveRoom(this.deps.spec);
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
            ...(this.toolsFor(bot.id) === undefined ? {} : { tools: this.toolsFor(bot.id) }),
            ...(this.hasTools ? { toolsHint: this.toolsHint() } : {}),
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
