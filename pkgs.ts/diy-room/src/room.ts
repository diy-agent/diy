// room.ts — 协作空间：成员表 + `@` 投递 + 忙闲
//
// 一条发言走完的路（与既有 room-service 的对外语义对齐，但这里只有「投递」这一层）：
//   ① 校验发言人 / 正文，解析收件人：显式 `to` → 正文 `@X` / `@all` → focus → 没有收件人
//   ② **先落事件再 yield**（消费端断开也不丢已发生的事）
//   ③ 对每个收件人**投递到它自己的会话**：同一成员串行、不同成员并行
//   ④ 把回复带署名追加成 response 事件，边完成边 yield
//
// 忙闲的粒度 = 成员（##456：一个 room 的「忙」是「某个成员还有投递在跑」，
// 不是「整个房间锁死」—— 两个 agent 可以同时说话）。
//
// ⚠️ 零 task：房间只认成员 id。房间 id 由宿主给，本包不拿它去查任何东西。

import { systemClock } from '@diy/agent-session';
import { RoomError } from './errors.js';
import { parseMentions, resolveRecipients } from './mentions.js';
import type {
    Clock,
    Delivery,
    DeliveryState,
    PostInput,
    PublicLogEntry,
    Room,
    RoomEvent,
    RoomEventKind,
    RoomMember,
    RoomMemberInit,
    RoomMemberSnapshot,
    RoomSnapshot,
    RoomStore,
    SessionPeer,
} from './types.js';

/** createRoom 入参 */
export interface CreateRoomOptions {
    /** 房间 id（宿主命名；本包只当标识 + 目录名安全校验） */
    id: string;
    /** 时钟端口；缺省取真时间 */
    clock?: Clock;
    /** 存储端口（缺省 = 纯内存） */
    store?: RoomStore;
}

/** 建一个房间。返回活视图（members / events / deliveries 每次读都是最新副本）。 */
export function createRoom(options: CreateRoomOptions): Room {
    const id = takeRoomId(options.id);
    const clock = takeClock(options.clock);
    const store = takeStore(options.store);

    const members = new Map<string, RoomMember>();
    const events: RoomEvent[] = [];
    const deliveries: Delivery[] = [];
    const deliveryIndex = new Map<string, number>();
    /** 一级数据：人说的话 + agent 的结论（正文副本，长期保留；过程不进） */
    const publicLog: PublicLogEntry[] = [];
    /** 每个成员的在途投递数（忙闲的判据之一） */
    const pending = new Map<string, number>();
    /** 每个成员的串行链（同一成员的消息按到达顺序投，不并行、不合并） */
    const chains = new Map<string, Promise<unknown>>();

    let focus: string | null = null;
    let eventSeq = 0;
    let updatedAt = iso(clock.now());

    const room: Room = {
        id,
        get members() {
            return [...members.values()];
        },
        get events() {
            return events.slice();
        },
        get deliveries() {
            return deliveries.slice();
        },
        get publicLog() {
            return publicLog.slice();
        },
        get focus() {
            return focus;
        },
        addMember(init: RoomMemberInit) {
            const member = parseMember(init);
            if (members.has(member.id)) {
                throw new RoomError('room/invalid-member', `成员 ${member.id} 已在房间里`, 'id');
            }
            members.set(member.id, member);
            touch();
            void persistMembers();
            return member;
        },
        removeMember(memberId: string) {
            if (!members.delete(memberId)) {
                throw new RoomError('room/invalid-member', `成员 ${memberId} 不在房间里`, 'id');
            }
            if (focus === memberId) focus = null;
            touch();
            void persistMembers();
        },
        setFocus(memberId: string | null) {
            if (memberId !== null && !members.has(memberId)) {
                throw new RoomError('room/invalid-member', `focus 只能是房间成员（${memberId} 不在）`, 'focus');
            }
            focus = memberId;
            touch();
            void persistMembers();
        },
        busy(memberId: string) {
            const member = members.get(memberId);
            return (pending.get(memberId) ?? 0) > 0 || member?.session?.busy === true;
        },
        deliveryOf(eventId: string, memberId: string) {
            const index = deliveryIndex.get(deliveryKey(eventId, memberId));
            return index === undefined ? undefined : deliveries[index];
        },
        async *post(input: PostInput): AsyncGenerator<RoomEvent> {
            const { from, text, recipients } = parsePost(input);

            // ② 先落事件再 yield
            const message = newEvent('message', from.id, text, recipients);
            await persistEvent(message);
            // 人说的话进主线（agent 直接往房间发言也算它的结论）
            await appendPublic({
                at: message.at,
                from: from.id,
                kind: from.kind === 'human' ? 'human' : 'agent-conclusion',
                text,
                messageId: message.id,
            });
            yield message;

            // ③ 投递：同成员串行、不同成员并行；谁的回复先到谁先 yield
            const runs = recipients
                .map((memberId) => members.get(memberId))
                .filter((member): member is RoomMember => member !== undefined)
                .map((member) => ({ member, run: enqueue(member.id, () => deliver(member, message, text)) }));
            if (runs.length === 0) return;

            const settled = new Set(
                runs.map(({ run }, index) => ({
                    index,
                    promise: run.then((event) => ({ index, event })),
                })),
            );
            while (settled.size > 0) {
                const done = await Promise.race([...settled].map((item) => item.promise));
                for (const item of settled) {
                    if (item.index === done.index) settled.delete(item);
                }
                if (done.event) yield done.event;
            }
        },
    };

    return room;

    // ── 内部实现 ────────────────────────────────────────────────

    function iso(ms: number): string {
        if (typeof ms !== 'number' || !Number.isFinite(ms)) {
            throw new RoomError('room/invalid-options', `Clock.now() 必须返回有限数字，拿到 ${String(ms)}`, 'clock');
        }
        return new Date(ms).toISOString();
    }

    function touch(): void {
        updatedAt = iso(clock.now());
    }

    function snapshot(): RoomSnapshot {
        const membersSnapshot: RoomMemberSnapshot[] = [...members.values()].map((member) => ({
            id: member.id,
            name: member.name,
            kind: member.kind,
            hasSession: member.session !== undefined,
        }));
        return { id, members: membersSnapshot, focus, updatedAt };
    }

    async function persistMembers(): Promise<void> {
        if (!store) return;
        await store.saveMembers(snapshot());
    }

    async function persistEvent(event: RoomEvent): Promise<void> {
        if (!store) return;
        await store.appendEvent(event);
    }

    function newEvent(
        kind: RoomEventKind,
        author: string,
        content: string,
        recipients: readonly string[],
        replyTo?: string,
    ): RoomEvent {
        eventSeq += 1;
        const event: RoomEvent = {
            id: `evt-${eventSeq}`,
            roomId: id,
            kind,
            author,
            content,
            at: iso(clock.now()),
            recipients: [...recipients],
            ...(replyTo === undefined ? {} : { replyTo }),
        };
        events.push(event);
        touch();
        return event;
    }

    function setDelivery(eventId: string, memberId: string, state: DeliveryState, note?: string): void {
        const key = deliveryKey(eventId, memberId);
        const delivery: Delivery = { eventId, memberId, state, ...(note === undefined ? {} : { note }) };
        const index = deliveryIndex.get(key);
        if (index === undefined) {
            deliveryIndex.set(key, deliveries.length);
            deliveries.push(delivery);
        } else {
            deliveries[index] = delivery;
        }
    }

    /** 同一成员串成一条链（前一条完成才投下一条）；不同成员互不阻塞 */
    function enqueue<T>(memberId: string, task: () => Promise<T>): Promise<T> {
        pending.set(memberId, (pending.get(memberId) ?? 0) + 1);
        const previous = chains.get(memberId) ?? Promise.resolve();
        const next = previous.then(task, task);
        const settled = next.finally(() => {
            const left = (pending.get(memberId) ?? 1) - 1;
            if (left <= 0) pending.delete(memberId);
            else pending.set(memberId, left);
        });
        chains.set(
            memberId,
            settled.then(
                () => undefined,
                () => undefined,
            ),
        );
        return next;
    }

    async function deliver(member: RoomMember, message: RoomEvent, text: string): Promise<RoomEvent | null> {
        const session = member.session;
        if (member.kind !== 'agent' || session === undefined) {
            setDelivery(
                message.id,
                member.id,
                'skipped',
                member.kind === 'human' ? '人是发言人，不是投递对象' : '成员没有会话',
            );
            return null;
        }

        setDelivery(message.id, member.id, 'queued');
        setDelivery(message.id, member.id, 'delivering');
        try {
            // 主线只收结论：遇到 tool-call 就把缓冲倒掉（那是 trace），最后的缓冲才是结论
            let content = '';
            for await (const delta of session.send(formatDelivery(message, text))) {
                if (delta.type === 'text') content += delta.text;
                else if (delta.type === 'tool-call') content = '';
            }
            if (content === '') {
                // 一轮以工具调用收尾：没有结论可进主线（不是失败）
                setDelivery(message.id, member.id, 'delivered', '本轮没有结论（以工具调用结束）');
                return null;
            }
            setDelivery(message.id, member.id, 'delivered');
            const response = newEvent('response', member.id, content, [], message.id);
            await persistEvent(response);
            await appendPublic({
                at: response.at,
                from: member.id,
                kind: 'agent-conclusion',
                text: content,
                sessionId: session.id,
                messageId: response.id,
            });
            return response;
        } catch (error) {
            // 一个成员的投递失败不影响别人：状态记 failed（带原因），事件流里没有它的回复
            setDelivery(message.id, member.id, 'failed', error instanceof Error ? error.message : String(error));
            return null;
        }
    }

    /** 追加一条主线日志（正文副本）；store 缺省 = 只留在内存 */
    async function appendPublic(entry: PublicLogEntry): Promise<void> {
        publicLog.push(entry);
        if (store) await store.appendPublicLog(entry);
    }

    function formatDelivery(message: RoomEvent, text: string): string {
        const fromName = members.get(message.author)?.name ?? message.author;
        return `[房间 ${id}] ${fromName} 对你说：${text}`;
    }

    function parsePost(input: PostInput): { from: RoomMember; text: string; recipients: string[] } {
        if (typeof input !== 'object' || input === null) {
            throw new RoomError('room/invalid-post', 'post 入参必须是对象', 'post');
        }
        const from = members.get(input.from);
        if (!from) {
            throw new RoomError('room/invalid-post', `发言人 ${String(input.from)} 不是房间成员`, 'from');
        }
        if (typeof input.text !== 'string' || input.text.trim() === '') {
            throw new RoomError('room/invalid-post', '发言正文不能为空', 'text');
        }
        if (input.to !== undefined && (!Array.isArray(input.to) || input.to.some((item) => typeof item !== 'string'))) {
            throw new RoomError('room/invalid-post', 'to 必须是成员标识数组', 'to');
        }

        const all = [...members.values()];
        const tokens = input.to ?? parseMentions(input.text);
        let recipients: string[];
        if (tokens.length > 0) {
            recipients = resolveRecipients({ tokens, members: all, authorId: from.id });
        } else if (focus !== null && focus !== from.id) {
            recipients = [focus];
        } else {
            // 没有收件人 = 只落记录（UI 必须标「未投递」）：这不是异常
            recipients = [];
        }
        return { from, text: input.text, recipients };
    }
}

// ── 入参校验（不静默容错）──────────────────────────────────────

function takeRoomId(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new RoomError('room/invalid-id', '房间 id 必须是非空字符串', 'id');
    }
    if (value.includes('..') || value.endsWith('/')) {
        throw new RoomError('room/invalid-id', `房间 id 不合法（含 .. 或结尾 /）：${value}`, 'id');
    }
    return value;
}

function takeClock(value: Clock | undefined): Clock {
    if (value === undefined) return systemClock;
    if (typeof value !== 'object' || value === null || typeof value.now !== 'function') {
        throw new RoomError('room/invalid-options', 'clock 必须是带 now() 的对象', 'clock');
    }
    return value;
}

function takeStore(value: RoomStore | undefined): RoomStore | undefined {
    if (value === undefined) return undefined;
    if (
        typeof value !== 'object' ||
        value === null ||
        typeof value.appendEvent !== 'function' ||
        typeof value.saveMembers !== 'function' ||
        typeof value.appendPublicLog !== 'function'
    ) {
        throw new RoomError(
            'room/invalid-options',
            'store 必须带 appendEvent() / saveMembers() / appendPublicLog()',
            'store',
        );
    }
    return value;
}

function parseMember(init: RoomMemberInit): RoomMember {
    if (typeof init !== 'object' || init === null) {
        throw new RoomError('room/invalid-member', '成员入参必须是对象', 'member');
    }
    if (typeof init.id !== 'string' || init.id.trim() === '') {
        throw new RoomError('room/invalid-member', '成员 id 必须是非空字符串', 'member.id');
    }
    if (typeof init.name !== 'string' || init.name.trim() === '') {
        throw new RoomError('room/invalid-member', `成员 ${init.id} 缺少 name`, 'member.name');
    }
    if (init.kind !== 'human' && init.kind !== 'agent') {
        throw new RoomError('room/invalid-member', `成员 ${init.id} 的 kind 只能是 human / agent`, 'member.kind');
    }
    if (init.session !== undefined) {
        const session = init.session as SessionPeer;
        if (typeof session !== 'object' || session === null || typeof session.send !== 'function') {
            throw new RoomError('room/invalid-member', `成员 ${init.id} 的 session 必须带 send()`, 'member.session');
        }
        if (typeof session.id !== 'string' || session.id === '') {
            throw new RoomError('room/invalid-member', `成员 ${init.id} 的 session 缺少 id`, 'member.session.id');
        }
    }
    return {
        id: init.id,
        name: init.name,
        kind: init.kind,
        ...(init.session === undefined ? {} : { session: init.session }),
    };
}

function deliveryKey(eventId: string, memberId: string): string {
    return `${eventId}\u0000${memberId}`;
}
