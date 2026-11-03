// tests/intent.room.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 协作空间内核「意图测试」—— 需求级（人类语言描述需求，不断言实现）
//
// 需求定义（本文件即契约，对应 ##456 第 2 步判据）：
//   R1  一个 room 含 2 个 session：各自独立回复（不同成员并行、各答各的）
//   R2  `@` 显式寻址：`@甲 @乙` 送到各自会话；正文包装带上「谁在哪个房间说」
//   R3  focus 是隐式收件人；两者都没有 ⇒ **只落记录不投递**（不是异常，recipients = []）
//   R4  `@all` = 全部 agent（发言人自己除外）；点名不存在的人 ⇒ `room/unknown-recipient`
//   R5  同一成员串行：连发两条，第二条等第一条投完才投（顺序不丢、不合并）
//   R6  投递状态可查：delivered / skipped（人没有会话）/ failed（会话报错不拖垮别人）
//   R8  按水位增量投递：只给 `seq > lastSeenSeq`；首次加入给最近 initialN + 说明；
//       增量过大截断且 @ 他的 / 最后 human 必在；**成功才推进水位**（失败下次重投，不丢不重）
//   R7  零 task / 零 IO：src/** 里没有任务标识 / @diy-agent/task / 文件系统模块 / electron / 应用数据根
//
// 测试风格：真实 @diy-agent/session（假 LlmPort / 假 Clock）跑 R1；其余用极简假会话控时序。
// ═══════════════════════════════════════════════════════════════

/// <reference types="vite/client" />
// ↑ 只为 import.meta.glob 的类型（读源码做静态扫描）；本包源码不使用任何 IO
import { describe, expect, it } from 'vitest';
import { createSession, type Clock, type LlmPort, type SessionPeer } from '@diy-agent/session';
import {
    RoomError,
    createRoom,
    parseMentions,
    resolveRecipients,
    type Delivery,
    type PublicLogEntry,
    type RoomEvent,
    type RoomMember,
    type RoomSnapshot,
} from '../src/index.js';

const T0 = Date.parse('2026-10-29T00:00:00.000Z');

function fakeClock(): Clock {
    let n = 0;
    return { now: () => T0 + n++ * 1000 };
}

/** 假 LlmPort：每轮把一条固定回复拆成两段吐出来 */
function replyLlm(replies: string[]): LlmPort {
    return {
        async *chat() {
            const reply = replies.shift();
            if (reply === undefined) throw new Error('replyLlm：没有更多回复');
            yield { type: 'text', text: reply.slice(0, 1) };
            yield { type: 'text', text: reply.slice(1) };
            yield { type: 'usage', inputTokens: 5, outputTokens: reply.length };
            yield { type: 'done', stopReason: 'stop' };
        },
    };
}

/** 极简假会话：可控延迟、记录收到的投递文本 */
function fakePeer(
    id: string,
    options: { reply?: (text: string) => string; delayMs?: number } = {},
): SessionPeer & { received: string[] } {
    const received: string[] = [];
    let busy = false;
    return {
        id,
        received,
        get busy() {
            return busy;
        },
        async *send(text: string) {
            busy = true;
            received.push(text);
            try {
                if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
                yield { type: 'text' as const, text: options.reply ? options.reply(text) : `ok:${id}` };
                yield { type: 'done' as const };
            } finally {
                busy = false;
            }
        },
    };
}

async function collect(stream: AsyncIterable<RoomEvent>): Promise<RoomEvent[]> {
    const out: RoomEvent[] = [];
    for await (const event of stream) out.push(event);
    return out;
}

const human = { id: 'human:me', name: '我', kind: 'human' as const };

describe('R1 一个 room 含 2 个 session：各自独立回复', () => {
    it('两个 agent 各收到投递、各回各的（不串话、不合并）', async () => {
        const clock = fakeClock();
        const a = createSession({ id: 's-a', llm: replyLlm(['甲收到']), clock });
        const b = createSession({ id: 's-b', llm: replyLlm(['乙收到']), clock });
        const room = createRoom({ id: 'room-1', clock });
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: a });
        room.addMember({ id: 'agent:b', name: '乙', kind: 'agent', session: b });

        const events = await collect(room.post({ from: 'human:me', text: '@甲 @乙 开工' }));

        const responses = events.filter((event) => event.kind === 'response');
        // 两个成员并行，谁先回完谁先出现在事件流里 —— 断言集合而非顺序
        expect(responses.map((event) => [event.author, event.content]).sort()).toEqual([
            ['agent:a', '甲收到'],
            ['agent:b', '乙收到'],
        ]);
        // 各自的会话历史里只有自己那一轮
        expect(a.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
        expect(b.messages.map((message) => message.text)).toEqual([expect.stringContaining('开工'), '乙收到']);
        expect(room.members).toHaveLength(3);
    });
});

describe('R2 `@` 显式寻址', () => {
    it('投递文本带「哪个房间、谁在说」，正文原样保留', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const a = fakePeer('agent:a', { reply: () => '好的' });
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: a });

        await collect(room.post({ from: 'human:me', text: '@甲 把票关了' }));

        expect(a.received).toHaveLength(1);
        expect(a.received[0]).toContain('room-1');
        expect(a.received[0]).toContain('我');
        expect(a.received[0]).toContain('把票关了');
    });

    it('parseMentions 去重保序；按 name 或 id 都能寻址', () => {
        expect(parseMentions('@甲 @甲 @乙 一起看')).toEqual(['甲', '乙']);
        const members: RoomMember[] = [
            { id: 'agent:a', name: '甲', kind: 'agent' },
            { id: 'agent:b', name: '乙', kind: 'agent' },
        ];
        expect(resolveRecipients({ tokens: ['甲', 'agent:b'], members, authorId: 'human:me' })).toEqual([
            'agent:a',
            'agent:b',
        ]);
    });
});

describe('R3 focus 与「只落记录」', () => {
    it('正文没有 @ ⇒ 投给 focus', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const a = fakePeer('agent:a');
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: a });
        room.setFocus('agent:a');

        const events = await collect(room.post({ from: 'human:me', text: '继续' }));

        expect(a.received).toHaveLength(1);
        expect(events.find((event) => event.kind === 'message')?.recipients).toEqual(['agent:a']);
    });

    it('既没有 @ 也没有 focus ⇒ 只落记录（recipients 空，状态不是异常）', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const a = fakePeer('agent:a');
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: a });

        const events = await collect(room.post({ from: 'human:me', text: '只是记一笔' }));

        expect(events).toHaveLength(1);
        expect(events[0].recipients).toEqual([]);
        expect(a.received).toHaveLength(0);
    });
});

describe('R4 `@all` 与未知收件人', () => {
    it('@all ⇒ 全部 agent（发言人自己除外），人的成员不会收到会话投递', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const a = fakePeer('agent:a');
        const b = fakePeer('agent:b');
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: a });
        room.addMember({ id: 'agent:b', name: '乙', kind: 'agent', session: b });

        const events = await collect(room.post({ from: 'human:me', text: '@all 开会' }));

        expect(events.find((event) => event.kind === 'message')?.recipients).toEqual(['agent:a', 'agent:b']);
        expect(a.received).toHaveLength(1);
        expect(b.received).toHaveLength(1);
    });

    it('点名不存在的人 ⇒ room/unknown-recipient（不静默忽略）', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        room.addMember(human);

        await expect(room.post({ from: 'human:me', text: '@无名 在吗' }).next()).rejects.toMatchObject({
            code: 'room/unknown-recipient',
        });
        expect(room.events).toHaveLength(0);
    });
});

describe('R5 同一成员串行', () => {
    it('连发两条：第二条等第一条投完（顺序不丢、不合并）', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const a = fakePeer('agent:a', { delayMs: 20, reply: (text) => `回:${text.includes('第一') ? '一' : '二'}` });
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: a });

        const [first, second] = await Promise.all([
            collect(room.post({ from: 'human:me', text: '@甲 第一条' })),
            collect(room.post({ from: 'human:me', text: '@甲 第二条' })),
        ]);

        expect(first.filter((event) => event.kind === 'response').map((event) => event.content)).toEqual(['回:一']);
        expect(second.filter((event) => event.kind === 'response').map((event) => event.content)).toEqual(['回:二']);
        expect(a.received.map((text) => (text.includes('第一条') ? '一' : '二'))).toEqual(['一', '二']);
    });
});

describe('R6 投递状态可查', () => {
    it('delivered 落地；发言人自己不会被投递（无状态而非 skipped）', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const a = fakePeer('agent:a');
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: a });
        room.setFocus('human:me');

        const events = await collect(room.post({ from: 'human:me', text: '@甲 @我 看这里' }));
        const messageId = events[0].id;

        expect(room.deliveryOf(messageId, 'agent:a')?.state).toBe('delivered');
        expect(room.deliveryOf(messageId, 'human:me')).toBeUndefined(); // 自己不给自投递
    });

    it('会话报错 ⇒ 该成员 failed（带原因），不影响别的成员', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const broken: SessionPeer = {
            id: 's-broken',
            busy: false,
            // eslint-disable-next-line require-yield
            async *send() {
                throw new Error('上游 429');
            },
        };
        const ok = fakePeer('agent:ok');
        room.addMember(human);
        room.addMember({ id: 'agent:broken', name: '坏', kind: 'agent', session: broken });
        room.addMember({ id: 'agent:ok', name: '好', kind: 'agent', session: ok });

        const events = await collect(room.post({ from: 'human:me', text: '@坏 @好 跑一下' }));
        const messageId = events[0].id;

        const failed: Delivery | undefined = room.deliveryOf(messageId, 'agent:broken');
        expect(failed?.state).toBe('failed');
        expect(failed?.note).toContain('429');
        expect(room.deliveryOf(messageId, 'agent:ok')?.state).toBe('delivered');
        expect(events.filter((event) => event.kind === 'response').map((event) => event.author)).toEqual(['agent:ok']);
    });

    it('human 成员不会被投递（skipped），用作 focus 时也不报错', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        room.addMember(human);
        room.addMember({ id: 'human:other', name: '另一个人', kind: 'human' });
        room.setFocus('human:other');

        const events = await collect(room.post({ from: 'human:me', text: '大家好' }));

        expect(events).toHaveLength(1);
        expect(room.deliveryOf(events[0].id, 'human:other')?.state).toBe('skipped');
    });
});

describe('R6+ 存储端口（可选）', () => {
    it('缺省纯内存；传 store 则事件 / 成员快照 / 主线日志都交出去', async () => {
        const appended: RoomEvent[] = [];
        const members: RoomSnapshot[] = [];
        const publicLog: PublicLogEntry[] = [];
        const room = createRoom({
            id: 'room-1',
            clock: fakeClock(),
            store: {
                appendEvent(event) {
                    appended.push(event);
                },
                saveMembers(snapshot) {
                    members.push(snapshot);
                },
                appendPublicLog(entry) {
                    publicLog.push(entry);
                },
            },
        });
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: fakePeer('agent:a') });

        await collect(room.post({ from: 'human:me', text: '@甲 你好' }));

        expect(members.at(-1)?.members.map((member) => member.hasSession)).toEqual([false, true]);
        expect(appended.map((event) => event.kind)).toEqual(['message', 'response']);
        expect(publicLog.map((entry) => [entry.kind, entry.from])).toEqual([
            ['human', 'human:me'],
            ['agent-conclusion', 'agent:a'],
        ]);
    });
});

describe('R6++ 主线只收结论（正文副本）', () => {
    it('过程（trace / tool-call / tool-result）进会话日志但不进主线；结论正文被复制', async () => {
        const clock = fakeClock();
        // 真实 agent-session：先铺垫一句（trace）→ 调工具 → 工具结果 → 结论
        const session = createSession({
            id: 's-a',
            clock,
            llm: {
                async *chat() {
                    yield { type: 'text', text: '我先查一下' };
                    yield { type: 'tool-call', id: 't1', name: 'read', input: '{"path":"a.ts"}' };
                    yield { type: 'tool-result', id: 't1', content: 'file content' };
                    yield { type: 'text', text: '结论：没问题' };
                    yield { type: 'done' };
                },
            },
        });
        const room = createRoom({ id: 'room-1', clock });
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session });

        const events = await collect(room.post({ from: 'human:me', text: '@甲 看下 a.ts' }));

        // 主线 = 人的一句 + 结论一句；过程一个字不进
        expect(room.publicLog.map((entry) => [entry.kind, entry.text])).toEqual([
            ['human', '@甲 看下 a.ts'],
            ['agent-conclusion', '结论：没问题'],
        ]);
        expect(room.publicLog[1].sessionId).toBe('s-a');
        // 回复事件内容也只是结论
        expect(events.filter((event) => event.kind === 'response').map((event) => event.content)).toEqual([
            '结论：没问题',
        ]);
        // 二级日志里 5 种 type 齐全
        expect(session.messages.map((message) => message.type)).toEqual([
            'human',
            'agent-trace',
            'tool-call',
            'tool-result',
            'agent-conclusion',
        ]);
    });

    it('以工具调用收尾的一轮没有结论：投递 delivered 但不进主线', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const peer: SessionPeer = {
            id: 's-a',
            busy: false,
            async *send() {
                yield { type: 'text' as const, text: '先看看' };
                yield { type: 'tool-call' as const, id: 't1', name: 'read' };
                yield { type: 'done' as const };
            },
        };
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: peer });

        const events = await collect(room.post({ from: 'human:me', text: '@甲 查' }));

        expect(events.filter((event) => event.kind === 'response')).toHaveLength(0);
        expect(room.publicLog.map((entry) => entry.kind)).toEqual(['human']);
        expect(room.deliveryOf(events[0].id, 'agent:a')?.state).toBe('delivered');
        expect(room.deliveryOf(events[0].id, 'agent:a')?.note).toContain('没有结论');
    });
});

describe('R8 按水位增量投递', () => {
    it('首次加入给最近 initialN 条 + 说明；之后只投新增（不重发）', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock(), delivery: { initialN: 2 } });
        const a = fakePeer('agent:a');
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: a });
        for (const text of ['第1句', '第2句', '第3句', '第4句']) {
            await collect(room.post({ from: 'human:me', text, to: [] }));
        }
        expect(room.publicLog.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);

        // 首次加入：只给最近 2 条 + 说明
        await collect(room.post({ from: 'human:me', text: '@甲 新消息' }));
        expect(a.received).toHaveLength(1);
        expect(a.received[0]).toContain('你是新加入的');
        expect(a.received[0]).toContain('第4句');
        expect(a.received[0]).toContain('新消息');
        expect(a.received[0]).not.toContain('第1句');
        expect(room.cursorOf('agent:a').lastSeenSeq).toBe(5);

        // 第二次：只给新的那条，不带任何旧内容
        await collect(room.post({ from: 'human:me', text: '@甲 再来一条' }));
        expect(a.received[1]).toContain('再来一条');
        expect(a.received[1]).not.toContain('新消息');
        expect(a.received[1]).not.toContain('第4句');
        // 水位只按 seq 推进：agent 自己也在这条主线里，它上一轮的结论也是 seq 增量的一部分
        expect(room.cursorOf('agent:a').lastSeenSeq).toBe(7);
    });

    it('失败不推进水位：下一轮重投同一批（不丢），成功后不重复', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock() });
        const received: string[] = [];
        let fail = true;
        const peer: SessionPeer = {
            id: 's-a',
            busy: false,
            async *send(text: string) {
                received.push(text);
                if (fail) {
                    fail = false;
                    throw new Error('上游 429');
                }
                yield { type: 'text' as const, text: '收到' };
                yield { type: 'done' as const };
            },
        };
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: peer });

        await collect(room.post({ from: 'human:me', text: '@甲 第一条' }));
        expect(room.deliveryOf('evt-1', 'agent:a')?.state).toBe('failed');
        expect(room.cursorOf('agent:a').lastSeenSeq).toBe(0);

        // 下一轮把失败的那条 + 新的那条一起投（不丢）
        await collect(room.post({ from: 'human:me', text: '@甲 第二条' }));
        expect(received[1]).toContain('第一条');
        expect(received[1]).toContain('第二条');
        expect(room.cursorOf('agent:a').lastSeenSeq).toBe(2);

        // 成功过的那批不会再来一遍（不重）
        await collect(room.post({ from: 'human:me', text: '@甲 第三条' }));
        expect(received[2]).not.toContain('第一条');
        expect(received[2]).toContain('第三条');
    });

    it('增量过大：给最近 maxBatch 条 + 省略说明，且 @ 他的与最后 human 必在', async () => {
        const room = createRoom({ id: 'room-1', clock: fakeClock(), delivery: { maxBatch: 2 } });
        const received: string[] = [];
        const control = { fail: false };
        const peer: SessionPeer = {
            id: 's-a',
            busy: false,
            async *send(text: string) {
                received.push(text);
                if (control.fail) {
                    control.fail = false;
                    throw new Error('故意失败一次，让水位停住');
                }
                yield { type: 'done' as const };
            },
        };
        room.addMember(human);
        room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: peer });

        // seq1 成功投递（水位 1）
        await collect(room.post({ from: 'human:me', text: '@甲 第一句' }));
        expect(room.cursorOf('agent:a').lastSeenSeq).toBe(1);

        // seq2：点名但投递失败 ⇒ 水位不推进
        control.fail = true;
        await collect(room.post({ from: 'human:me', text: '@甲 点名这一条' }));
        expect(room.cursorOf('agent:a').lastSeenSeq).toBe(1);

        // seq3~6：不投递的静默背景
        for (const text of ['背景3', '背景4', '背景5', '背景6']) {
            await collect(room.post({ from: 'human:me', text, to: [] }));
        }

        // 下一次投递：fresh = seq2..6（5 条）> maxBatch 2 ⇒ 截断，但点名的那条必须在内
        await collect(room.post({ from: 'human:me', text: '@甲 现在' }));
        const last = received[received.length - 1];
        expect(last).toContain('省略了更早的');
        expect(last).toContain('点名这一条');
        expect(last).toContain('现在');
        expect(room.cursorOf('agent:a').lastSeenSeq).toBe(7);
    });
});

describe('R7 零 task / 零 IO', () => {
    it('src/** 不含任务标识 / @diy-agent/task / 文件系统模块 / electron / 应用数据根', () => {
        // 用 vite 的 raw 导入读源码（测试自己也不 import 文件系统）
        const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
            string,
            string
        >;
        expect(Object.keys(sources).length).toBeGreaterThan(0);
        // 关键词拼接：本文件自己不能被这些字面量扫到
        const taskWord = `task${'Uri'}`;
        const fsModule = `node:${'fs'}`;
        const appHome = `diy${'Home'}`;
        const forbidden = [
            new RegExp(taskWord),
            new RegExp(`task${'Id'}`),
            /@diy-agent\/task/,
            new RegExp(`from\\s+['"]${fsModule}`),
            /\belectron\b/,
            new RegExp(`\\b${appHome}\\b`),
        ];
        for (const [file, text] of Object.entries(sources)) {
            const code = text
                .split('\n')
                .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
                .join('\n');
            for (const re of forbidden) {
                expect(code, `${file} 命中 ${re}`).not.toMatch(re);
            }
        }
    });

    it('房间 id 的目录名安全判据（不许 .. / 结尾斜杠）', () => {
        expect(() => createRoom({ id: '../escape' })).toThrow(RoomError);
        expect(() => createRoom({ id: 'rooms/' })).toThrow(/room\/invalid-id/);
    });
});
