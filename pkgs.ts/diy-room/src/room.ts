// room.ts — 协作空间：成员表 + `@` 投递 + 忙闲 + 水位增量投递
//
// 一条发言走完的路（##456「投递模型修订」）：
//   ① 校验发言人 / 正文，解析收件人：显式 `to` → 正文 `@X` / `@all` → focus → 没有收件人
//   ② **先落事件与主线再 yield**（消费端断开也不丢已发生的事）
//   ③ 对每个收件人按**水位增量**投递：给它 `seq > lastSeenSeq` 的那些主线条目
//      （不是「最近 N 条窗口」—— 那会每次都重发它已经收过的内容）
//   ④ 把回复带署名追加成 response 事件；结论进主线（正文副本），过程不进
//
// 水位规则（三种边界）：
//   首次加入（无 cursor）  → 最近 `initialN` 条 + 一行「这是房间已有 N 条历史，你是新加入的」
//   增量过大（> maxBatch） → 最近 `maxBatch` 条 + 一行「省略了更早的 M 条」，且 @ 他的与最后 human 必在
//   正常                   → 全给，不做任何拼接
//
// **投递成功 ≠ 已读**：水位在「这一轮跑完、消息真的进了 session」之后才推进；
// 失败 / 取消不推进 ⇒ 下次重投（不丢），成功的条目不会再来一遍（不重）。
//
// 忙闲的粒度 = 成员（##456：一个 room 的「忙」是「某个成员还有投递在跑」，
// 不是「整个房间锁死」—— 两个 agent 可以同时说话）。
//
// ⚠️ 零 task：房间只认成员 id。房间 id 由宿主给，本包不拿它去查任何东西。
// ⚠️ 零 IO：水位（MemberCursor）只是内存 + 入参/出参，持久化由宿主的 RoomStore 负责。

import { systemClock } from '@diy/agent-session';
import { RoomError } from './errors.js';
import { parseMentions, resolveRecipients } from './mentions.js';
import type {
    Clock,
    Delivery,
    DeliveryOptions,
    DeliveryResult,
    DeliveryState,
    MemberCursor,
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

/** 首次加入给最近多少条（缺省） */
export const DEFAULT_INITIAL_N = 20;
/** 一次投递最多给多少条（缺省） */
export const DEFAULT_MAX_BATCH = 50;

/** createRoom 入参 */
export interface CreateRoomOptions {
    /** 房间 id（宿主命名；本包只当标识 + 目录名安全校验） */
    id: string;
    /** 时钟端口；缺省取真时间 */
    clock?: Clock;
    /** 存储端口（缺省 = 纯内存） */
    store?: RoomStore;
    /** 投递参数（initialN / maxBatch；缺省见上方常量） */
    delivery?: DeliveryOptions;
}

/** 建一个房间。返回活视图（members / events / deliveries / publicLog 每次读都是最新副本）。 */
export function createRoom(options: CreateRoomOptions): Room {
    const id = takeRoomId(options.id);
    const clock = takeClock(options.clock);
    const store = takeStore(options.store);
    const settings = takeDeliveryOptions(options.delivery);

    const members = new Map<string, RoomMember>();
    const events: RoomEvent[] = [];
    const deliveries: Delivery[] = [];
    const deliveryIndex = new Map<string, number>();
    /** 一级数据：人说的话 + agent 的结论（正文副本，长期保留；过程不进） */
    const publicLog: PublicLogEntry[] = [];
    /** 成员水位：memberId → 已成功投递的最大 seq */
    const cursors = new Map<string, number>();
    /** 每个成员的在途投递数（忙闲的判据之一） */
    const pending = new Map<string, number>();
    /** 每个成员的串行链（同一成员的消息按到达顺序投，不并行、不合并） */
    const chains = new Map<string, Promise<unknown>>();

    let focus: string | null = null;
    let eventSeq = 0;
    let logSeq = 0;
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
        cursorOf(memberId: string): MemberCursor {
            return { memberId, lastSeenSeq: cursors.get(memberId) ?? 0 };
        },
        deliverTo(memberId: string, deliveryOptions?: DeliveryOptions) {
            // 投递本身也串行：同成员的两次投递不会看到同一批（第二次计划时水位已推进）
            return enqueue(memberId, () => runDelivery(memberId, deliveryOptions));
        },
        async *post(input: PostInput): AsyncGenerator<RoomEvent> {
            const { from, text, recipients } = parsePost(input);

            // ② 先落事件 + 主线，再 yield
            const message = newEvent('message', from.id, text, recipients);
            await persistEvent(message);
            // 人说的话进主线（agent 直接往房间发言也算它的结论）
            await appendPublic({
                at: message.at,
                from: from.id,
                kind: from.kind === 'human' ? 'human' : 'agent-conclusion',
                text,
                mentions: recipients,
                messageId: message.id,
            });
            yield message;

            // ③ 投递：同成员串行、不同成员并行；谁的回复先到谁先 yield
            const runs = recipients
                .map((memberId) => ({ memberId, run: enqueue(memberId, () => runDelivery(memberId, undefined)) }))
                .map(({ run }, index) => ({ index, promise: run.then((result) => ({ index, result })) }));
            if (runs.length === 0) return;

            const settled = new Set(runs);
            while (settled.size > 0) {
                const done = await Promise.race([...settled].map((item) => item.promise));
                for (const item of settled) {
                    if (item.index === done.index) settled.delete(item);
                }
                if (done.result.response) yield done.result.response;
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

    /** 按水位算出该给这个成员哪些条目（纯算，不发送、不推进水位） */
    function planDelivery(
        memberId: string,
        deliveryOptions?: DeliveryOptions,
    ): { entries: PublicLogEntry[]; omitted: number; notices: string[] } {
        const opts = { ...settings, ...deliveryOptions };
        const from = cursors.get(memberId) ?? 0;
        const fresh = publicLog.filter((entry) => entry.seq > from);
        if (fresh.length === 0) return { entries: [], omitted: 0, notices: [] };

        // ① 首次加入：没有水位 ⇒ 给最近 initialN 条 + 说明（不是从头灌全部历史）
        if (from === 0) {
            const entries = fresh.slice(-opts.initialN);
            const omitted = fresh.length - entries.length;
            const suffix = omitted > 0 ? `（只给最近 ${entries.length} 条）` : '';
            return {
                entries,
                omitted,
                notices: [`这是房间已有的 ${fresh.length} 条历史，你是新加入的${suffix}`],
            };
        }

        // ② 增量过大：截断但保证 @ 他的与最后一条 human 必在
        if (fresh.length > opts.maxBatch) {
            const tail = fresh.slice(-opts.maxBatch);
            const inTail = new Set(tail.map((entry) => entry.seq));
            const lastHumanSeq = [...fresh].reverse().find((entry) => entry.kind === 'human')?.seq;
            const forced = fresh.filter(
                (entry) =>
                    !inTail.has(entry.seq) &&
                    (entry.mentions?.includes(memberId) === true || entry.seq === lastHumanSeq),
            );
            const entries = [...forced, ...tail].sort((a, b) => a.seq - b.seq);
            const omitted = fresh.length - entries.length;
            return { entries, omitted, notices: [`省略了更早的 ${omitted} 条（你缺席期间的）`] };
        }

        // ③ 正常：全给，不做任何拼接
        return { entries: fresh, omitted: 0, notices: [] };
    }

    /** 真的投一次：plan → session.send → 成功才推进水位 */
    async function runDelivery(memberId: string, deliveryOptions?: DeliveryOptions): Promise<DeliveryResult> {
        const member = members.get(memberId);
        if (!member) {
            throw new RoomError('room/invalid-member', `投递对象 ${memberId} 不是房间成员`, 'memberId');
        }
        const fromSeq = cursors.get(memberId) ?? 0;
        const plan = planDelivery(memberId, deliveryOptions);
        const session = member.session;

        // 人 / 没有会话：状态记 skipped（不推进水位 —— 它本来就不读）
        if (member.kind !== 'agent' || session === undefined) {
            for (const entry of plan.entries) {
                if (entry.messageId) {
                    setDelivery(
                        entry.messageId,
                        memberId,
                        'skipped',
                        member.kind === 'human' ? '人是发言人，不是投递对象' : '成员没有会话',
                    );
                }
            }
            return {
                memberId,
                fromSeq,
                toSeq: fromSeq,
                entries: plan.entries,
                omitted: plan.omitted,
                notices: plan.notices,
                state: 'skipped',
            };
        }

        if (plan.entries.length === 0) {
            return { memberId, fromSeq, toSeq: fromSeq, entries: [], omitted: 0, notices: [], state: 'delivered' };
        }

        for (const entry of plan.entries) {
            if (entry.messageId) setDelivery(entry.messageId, memberId, 'queued');
        }
        for (const entry of plan.entries) {
            if (entry.messageId) setDelivery(entry.messageId, memberId, 'delivering');
        }

        try {
            // 主线只收结论：遇到 tool-call 就把缓冲倒掉（那是 trace），最后的缓冲才是结论
            let conclusion = '';
            for await (const delta of session.send(formatBatch(plan))) {
                if (delta.type === 'text') conclusion += delta.text;
                else if (delta.type === 'tool-call') conclusion = '';
            }

            // 这一轮跑完了、消息真的进了 session ⇒ 才推进水位
            const toSeq = plan.entries[plan.entries.length - 1].seq;
            cursors.set(memberId, toSeq);
            for (const entry of plan.entries) {
                if (!entry.messageId) continue;
                setDelivery(
                    entry.messageId,
                    memberId,
                    'delivered',
                    conclusion === '' ? '本轮没有结论（以工具调用结束）' : undefined,
                );
            }

            if (conclusion === '') {
                return {
                    memberId,
                    fromSeq,
                    toSeq,
                    entries: plan.entries,
                    omitted: plan.omitted,
                    notices: plan.notices,
                    state: 'delivered',
                };
            }

            const lastMessageId = [...plan.entries].reverse().find((entry) => entry.messageId)?.messageId;
            const response = newEvent('response', memberId, conclusion, [], lastMessageId);
            await persistEvent(response);
            await appendPublic({
                at: response.at,
                from: memberId,
                kind: 'agent-conclusion',
                text: conclusion,
                sessionId: session.id,
                messageId: response.id,
            });
            return {
                memberId,
                fromSeq,
                toSeq,
                entries: plan.entries,
                omitted: plan.omitted,
                notices: plan.notices,
                state: 'delivered',
                conclusion,
                response,
            };
        } catch (error) {
            // 失败不推进水位：下次重投（一个成员失败不影响别人）
            const note = error instanceof Error ? error.message : String(error);
            for (const entry of plan.entries) {
                if (entry.messageId) setDelivery(entry.messageId, memberId, 'failed', note);
            }
            return {
                memberId,
                fromSeq,
                toSeq: fromSeq,
                entries: plan.entries,
                omitted: plan.omitted,
                notices: plan.notices,
                state: 'failed',
            };
        }
    }

    /** 追加一条主线日志（正文副本、分配 seq）；store 缺省 = 只留在内存 */
    async function appendPublic(entry: Omit<PublicLogEntry, 'seq'>): Promise<PublicLogEntry> {
        logSeq += 1;
        const stored: PublicLogEntry = { seq: logSeq, ...entry };
        publicLog.push(stored);
        if (store) await store.appendPublicLog(stored);
        return stored;
    }

    /** 把一批条目拼成一次 send 的正文：说明行在前，然后每条一行（带房间与署名） */
    function formatBatch(plan: { entries: readonly PublicLogEntry[]; notices: readonly string[] }): string {
        const lines = plan.entries.map((entry) => {
            const fromName = members.get(entry.from)?.name ?? entry.from;
            return `[房间 ${id}] ${fromName}: ${entry.text}`;
        });
        return [...plan.notices.map((notice) => `[房间 ${id}] （系统）${notice}`), ...lines].join('\n');
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

function takeDeliveryOptions(value: DeliveryOptions | undefined): Required<DeliveryOptions> {
    const initialN = value?.initialN ?? DEFAULT_INITIAL_N;
    const maxBatch = value?.maxBatch ?? DEFAULT_MAX_BATCH;
    for (const [key, n] of [
        ['initialN', initialN],
        ['maxBatch', maxBatch],
    ] as const) {
        if (!Number.isInteger(n) || n <= 0) {
            throw new RoomError('room/invalid-options', `${key} 必须是正整数，拿到 ${String(n)}`, `delivery.${key}`);
        }
    }
    return { initialN, maxBatch };
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
