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

import type { ModelMessage } from 'ai';

import {
    effectiveModelOf,
    effectivePersonaOf,
    mentionsOf,
    primaryMemberOf,
} from '@diy-agent/protocol';

import type { Compactor } from './compaction';
import type { Store } from './db';
import { RoomLog, type RoomEntry } from './room-log';
import { BotSession, type CompactOptions, type SessionDeps, type SessionStats } from './session';
import type { Author, Bot, Delivery, InboxMode, Item, Room, RoomEvent, RoomMember } from './types';

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
    now?: () => number;
}

export class RoomActor {
    private readonly log = new RoomLog();
    private readonly sessions = new Map<string, BotSession>();
    /** 展示顺序（跨 bot 稳定） */
    private order = 0;
    /** 回合号 */
    private turnSeq = 0;
    private currentTurn: { turn: number; turnId: string } | null = null;
    private initialized = false;

    constructor(private readonly deps: RoomActorDeps) {}

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

        const turn = this.turnFor();
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

        const entry = this.log.append({ kind: 'say', author: input.author, text, turn: turn.turn, turnId: turn.turnId });

        const recipients = this.route(text, participants, input.recipients);
        const recipientIds = new Set(recipients.map((bot) => bot.id));
        for (const bot of participants) {
            if (!recipientIds.has(bot.id)) this.sessionOf(bot).ingest(entry);
        }

        for (const bot of recipients) {
            const delivery = this.deps.store.setDelivery({ roomId: this.id, messageId: saved.id, botId: bot.id, state: 'queued' });
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

    cancel(options: { keepQueue?: boolean } = {}): void {
        for (const session of this.sessions.values()) session.cancel(options);
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

    /** 运行中沿用当前回合；空闲时开新回合 */
    private turnFor(): { turn: number; turnId: string } {
        if (this.currentTurn !== null && this.busy()) return this.currentTurn;
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

        const persisted = new Set<string>();
        session = new BotSession({
            actor: `${this.id}::${bot.id}`,
            bot,
            modelKey: bot.modelKey,
            nextTurn: () => this.turnFor(),
            nextOrder: () => this.nextOrder(),
            onItem: (item) => {
                this.deps.emit({ kind: 'item', item });
                if ((item.status === 'done' || item.status === 'failed') && !persisted.has(item.id)) {
                    persisted.add(item.id);
                    this.deps.store.appendItem(this.id, item);
                }
            },
            onError: (message) => this.deps.emit({ kind: 'error', message }),
            onDelivery: (messageId, state) => {
                const delivery = this.deps.store.setDelivery({ roomId: this.id, messageId, botId: bot.id, state });
                this.deps.emit({ kind: 'delivery', delivery });
            },
            onTurnEnd: (result) => this.publishConclusion(bot, result),
            ...(this.deps.run === undefined ? {} : { run: this.deps.run }),
            ...(this.deps.compactor === undefined ? {} : { compactor: this.deps.compactor }),
            ...(this.deps.budget === undefined ? {} : { budget: this.deps.budget }),
        });

        for (const entry of this.log.all()) session.ingest(entry);
        this.sessions.set(bot.id, session);
        return session;
    }

    /**
     * 结论进公共日志，并复制给其他 session —— 不唤醒任何人。
     * 唯一例外：结论里显式 @ 了某个 bot（单人），那是点名。
     */
    private publishConclusion(bot: Bot, result: { turn: number; turnId: string; text: string; failed: boolean }): void {
        if (result.failed || result.text === '') return;

        const entry = this.log.append({
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
