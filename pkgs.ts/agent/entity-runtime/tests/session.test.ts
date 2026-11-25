// session.test.ts —— BotSession 的投递语义 + 上下文归属（ingest / compact）。
//
// 用假 run 代替真模型：这里要锁的是"什么时候开新 turn、什么时候插进当前 turn、
// 谁能看见谁的内容、压缩只影响谁"，而不是 SDK 内部怎么把消息拼进 prompt。

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../src/agent';
import { createSummaryCompactor, simpleCompactor, type Compactor } from '../src/compaction';
import type { RoomEntry } from '../src/room-log';
import { BotSession, type SessionDeps, type SessionEvent, type Turn } from '../src/session';
import type { AgentEvent, Bot, Item } from '../src/types';

const BOT_A: Bot = { id: 'bot:a', name: 'diy', color: '#111', persona: '', homeRoomId: 'room:1', modelKey: 'm' };
const BOT_B: Bot = { id: 'bot:b', name: 'cops', color: '#222', persona: '', homeRoomId: 'room:1', modelKey: 'm' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
    session: BotSession;
    runs: string[];
    items: Item[];
    deliveries: string[];
    /** 每次开跑时真正喂给模型的上下文 */
    seen: RunOptions['messages'][];
    ends: Array<{ turn: number; turnId: string; text: string; failed: boolean }>;
    events: SessionEvent[];
}

function makeSession(
    options: {
        bot?: Bot;
        hangOnAbort?: boolean;
        /** 第一次开跑就失败（`run.failed` 的原文），用来锁「同一句话不出现两次」 */
        fail?: string;
        seed?: SessionDeps['seed'];
        budget?: SessionDeps['budget'];
        compactor?: Compactor;
    } = {},
): Harness {
    const bot = options.bot ?? BOT_A;
    const runs: string[] = [];
    const items: Item[] = [];
    const deliveries: string[] = [];
    const seen: RunOptions['messages'][] = [];
    const ends: Harness['ends'] = [];
    const events: SessionEvent[] = [];
    let turn = 0;

    const run = async function* (input: RunOptions): AsyncIterable<AgentEvent> {
        const turnId = input.turnId ?? 'turn';
        runs.push(turnId);
        seen.push(input.messages);
        yield { seq: 1, type: 'run.started', turnId, messageId: `msg-${runs.length}` };
        await sleep(5);
        if (options.fail !== undefined && runs.length === 1) {
            yield { seq: 2, type: 'run.failed', turnId, message: options.fail };
            return;
        }
        if (options.hangOnAbort === true && runs.length === 1) {
            while (!input.signal.aborted) await sleep(2);
            yield { seq: 2, type: 'run.failed', turnId, message: 'aborted' };
            return;
        }
        yield { seq: 2, type: 'text.delta', messageId: `msg-${runs.length}`, delta: `reply-${runs.length}` };
        // 模拟 SDK：模型产出（assistant）回传给 session 记账
        input.onStepTranscript?.([{ role: 'assistant', content: [{ type: 'text', text: `reply-${runs.length}` }] }]);
        // 收尾事实：与真 agent 对齐（不给的话这一轮会被判成 unknown / no-finish）
        yield {
            seq: 3,
            type: 'run.finished',
            turnId,
            finishReason: 'stop',
            steps: 1,
            maxOutputTokens: input.maxOutputTokens ?? 0,
        };
        yield { seq: 4, type: 'message.completed', messageId: `msg-${runs.length}` };
        yield { seq: 5, type: 'run.completed', turnId };
    } as (input: RunOptions) => AsyncIterable<AgentEvent>;

    const session = new BotSession({
        bot,
        modelKey: 'm',
        seed: options.seed,
        budget: options.budget,
        compactor: options.compactor,
        allocateTurn: (): Turn => ({ turn: ++turn, turnId: `turn-${turn}` }),
        run,
    });
    session.subscribe((event) => {
        events.push(event);
        if (event.type === 'item') items.push(event.item);
        if (event.type === 'delivery') deliveries.push(`${event.messageId}:${event.state}`);
        if (event.type === 'turn.end') ends.push(event.result);
    });

    return { session, runs, items, deliveries, seen, ends, events };
}

/** 一份“确实能压出东西”的种子：早期一轮里有工具调用 + 大输出，压缩时会被拓掉 */
const compressibleSeed = () => ({
    entries: [
        { message: { role: 'user' as const, content: '早期需求' }, origin: 'public' as const, turn: 1 },
        {
            message: {
                role: 'assistant' as const,
                content: [{ type: 'tool-call' as const, toolCallId: 't1', toolName: 'read', input: {} }],
            },
            origin: 'self' as const,
            turn: 1,
        },
        {
            message: {
                role: 'tool' as const,
                content: [
                    {
                        type: 'tool-result' as const,
                        toolCallId: 't1',
                        toolName: 'read',
                        output: { type: 'text' as const, value: '工具输出'.repeat(200) },
                    },
                ],
            },
            origin: 'self' as const,
            turn: 1,
        },
        {
            message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: '结论：已修复' }] },
            origin: 'self' as const,
            turn: 1,
        },
        { message: { role: 'user' as const, content: '最新一句' }, origin: 'public' as const, turn: 2 },
    ],
});

const conclusion = (bot: Bot, seq: number, text: string): RoomEntry => ({
    kind: 'conclusion',
    botId: bot.id,
    name: bot.name,
    color: bot.color,
    text,
    seq,
    at: 0,
});

describe('BotSession', () => {
    it('空闲时投 next-step：开一轮，消息在第一 step 送达', async () => {
        const h = makeSession();
        await h.session.post({ messageId: 'm1', text: '你好' });

        expect(h.runs).toEqual(['turn-1']);
        expect(h.deliveries).toEqual(['m1:delivering', 'm1:delivered']);
        expect(h.items.some((item) => item.type === 'chat' && item.status === 'done')).toBe(true);
    });

    it('运行中投 next-step：不新开 turn（插进当前步边界）', async () => {
        const h = makeSession();
        const first = h.session.post({ messageId: 'm1', text: '第一句' });
        await sleep(2);
        const second = h.session.post({ messageId: 'm2', text: '补充' });

        await Promise.all([first, second]);

        expect(h.runs).toEqual(['turn-1']);
        expect(h.deliveries).toContain('m2:delivering');
    });

    it('运行中投 next-turn：等这一轮结束再开新一轮', async () => {
        const h = makeSession();
        const first = h.session.post({ messageId: 'm1', text: '第一句' });
        await sleep(2);
        const later = h.session.post({ messageId: 'm2', text: '下一轮说', mode: 'next-turn' });

        await Promise.all([first, later]);

        expect(h.runs).toEqual(['turn-1', 'turn-2']);
    });

    it('cancel：中止在跑的 turn，并丢弃排队', async () => {
        const h = makeSession({ hangOnAbort: true });
        const running = h.session.post({ messageId: 'm1', text: '会被取消' });
        await sleep(2);
        const queued = h.session.post({ messageId: 'm2', text: '排队也没了', mode: 'next-turn' });

        h.session.cancel();

        await Promise.all([running, queued]);
        expect(h.runs).toEqual(['turn-1']);
        expect(h.deliveries).toContain('m1:delivered');
        expect(h.deliveries).not.toContain('m1:failed');
    });

    it('cancel keepQueue：排队的 next-turn 不丢，取消这一轮后继续跑', async () => {
        const h = makeSession({ hangOnAbort: true });
        const running = h.session.post({ messageId: 'm1', text: '会被取消' });
        await sleep(2);
        const a = h.session.post({ messageId: 'm2', text: '留到下一轮 A', mode: 'next-turn' });
        const b = h.session.post({ messageId: 'm3', text: '留到下一轮 B', mode: 'next-turn' });

        h.session.cancel({ keepQueue: true });
        await Promise.all([running, a, b]);

        expect(h.runs.length).toBe(2);
    });

    it('自己的产出原样入账（assistant 带完整消息）', async () => {
        const h = makeSession();
        await h.session.post({ messageId: 'm1', text: '你好' });

        const own = h.session.context().filter((message) => message.role === 'assistant');
        expect(own).toHaveLength(1);
        expect(JSON.stringify(own[0])).toContain('reply-1');
    });

    it('ingest 别人的结论：只进上下文，不唤醒；自己的结论被忽略', async () => {
        const h = makeSession();
        h.session.ingest(conclusion(BOT_B, 1, 'review 过，foo.ts:42 少了锁'));
        h.session.ingest(conclusion(BOT_A, 2, '我自己的结论别重复'));

        expect(h.runs).toEqual([]);
        expect(h.session.busy).toBe(false);

        const content = JSON.stringify(h.session.context());
        expect(content).toContain('[cops 的结论] review 过，foo.ts:42 少了锁');
        expect(content).not.toContain('我自己的结论别重复');
    });

    it('运行中到达的公共条目排在本轮产出之后（下一轮才读到）', async () => {
        const h = makeSession({ hangOnAbort: true });
        const running = h.session.post({ messageId: 'm1', text: '正在跑' });
        await sleep(2);
        h.session.ingest(conclusion(BOT_B, 1, '跑的过程中来的结论'));
        h.session.cancel();

        await running;
        const roles = h.session.context().map((message) => `${message.role}:${JSON.stringify(message.content)}`);
        expect(roles.at(-1)).toContain('跑的过程中来的结论');
    });

    it('压缩只压自己：a 的 tool 被折叠，b 的上下文一条不少', async () => {
        const long = '工具输出'.repeat(200);
        const seed = () => ({
            entries: [
                { message: { role: 'user', content: '麻烦修改 bug 并提交' }, origin: 'public' as const, turn: 1 },
                {
                    message: {
                        role: 'assistant',
                        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read', input: {} }],
                    },
                    origin: 'self' as const,
                    turn: 1,
                },
                {
                    message: {
                        role: 'tool',
                        content: [
                            {
                                type: 'tool-result',
                                toolCallId: 't1',
                                toolName: 'read',
                                output: { type: 'text', value: long },
                            },
                        ],
                    },
                    origin: 'self' as const,
                    turn: 1,
                },
                {
                    message: { role: 'assistant', content: [{ type: 'text', text: '结论：已修复并提交' }] },
                    origin: 'self' as const,
                    turn: 1,
                },
                { message: { role: 'user', content: '人: 最新一句' }, origin: 'public' as const, turn: 2 },
            ],
        });
        // keepTurns: 1 —— 种子有两轮（turn 1 带 tool、turn 2 是最后一句），
        // 保 1 轮才轮得到折叠 turn 1 的 tool（保 2 轮 = 全保留，什么也压不动）
        const a = makeSession({ seed, budget: { keepTurns: 1, maxChars: 200 } });
        const b = makeSession({ bot: BOT_B, seed, budget: { keepTurns: 1, maxChars: 200 } });

        await a.session.post({ messageId: 'm1', text: '继续' });

        const sent = a.seen[0]!;
        const text = JSON.stringify(sent);
        expect(text).not.toContain('工具输出');
        expect(text).not.toContain('tool-result');
        expect(text).toContain('结论：已修复并提交');
        expect(text).toContain('麻烦修改 bug 并提交');

        // b 没跑过，也没被 a 的压缩影响
        expect(JSON.stringify(b.session.context())).toContain('工具输出');
    });

    it('只靠事件观察输出：条目 / 投递 / 回合结束，且不自己分配展示顺序', async () => {
        const h = makeSession();
        await h.session.post({ messageId: 'm1', text: '你好' });

        const kinds = new Set(h.events.map((event) => event.type));
        expect(kinds.has('item')).toBe(true);
        expect(kinds.has('delivery')).toBe(true);
        expect(kinds.has('turn.end')).toBe(true);

        // order 是房间的职责，session 不该碰
        expect(h.items.every((item) => item.order === undefined)).toBe(true);
    });

    it('一轮结束报告结论（房间层据此写公共日志）', async () => {
        const h = makeSession();
        await h.session.post({ messageId: 'm1', text: '你好' });

        // `endReason` 是这一轮**为什么**结束的收尾事实。脚本 run 现在也发 `run.finished`
        // （与真 agent 一致），所以这里是 completed + 上游原文 stop，不是"猜"出来的。
        // 没有它，「被截断」和「说完了」在数据里就没区别（见 intent.truncation.test.ts）
        expect(h.ends).toEqual([
            {
                turn: 1,
                turnId: 'turn-1',
                text: 'reply-1',
                failed: false,
                endReason: { type: 'completed', finishReason: 'stop', steps: 1 },
            },
        ]);
    });

    it('运行失败只落一条错误条目（run.failed 的原文不重复）', async () => {
        // Projector 收到 `run.failed` 时会自己落一条错误条目；收尾时 `endItems('error')`
        // 若再补一条，时间线上同一句失败原文会出现两次 —— 用户看到两条一模一样的红条。
        const h = makeSession({ fail: '401 Invalid API key（检查 DEEPSEEK_API_KEY）' });
        await h.session.post({ messageId: 'm1', text: '你好' });

        const errors = h.items.filter((item) => item.type === 'error');
        expect(errors.length).toBe(1);
        expect(errors[0]?.data).toEqual({ message: '401 Invalid API key（检查 DEEPSEEK_API_KEY）' });
        expect(h.ends[0]?.endReason.type).toBe('error');
    });

    it('压缩策略可替换：换一个 Compactor，session 一行不改', async () => {
        const calls: number[] = [];
        const custom: Compactor = {
            name: 'test-strategy',
            compact({ entries }) {
                calls.push(entries.length);
                return { entries: [...entries], folded: 0, dropped: 0, summarized: true };
            },
        };
        const h = makeSession({ compactor: custom });
        await h.session.post({ messageId: 'm1', text: '你好' });

        expect(calls.length).toBeGreaterThan(0);
        expect(h.session.stats().strategy).toBe('test-strategy');
        const event = h.session.compactions()[0]!;
        expect(event.strategy).toBe('test-strategy');
        expect(event.summarized).toBe(true);
    });

    it('手动 forceCompact：只压自己、返回事件、不触发运行', async () => {
        const seed = compressibleSeed;
        const h = makeSession({ seed });

        const event = await h.session.forceCompact({ maxChars: 120, keepTurns: 1 });

        expect(h.runs).toEqual([]);
        expect(event).not.toBeNull();
        expect(event?.folded ?? 0).toBeGreaterThan(0);
        expect(event?.dropped ?? 0).toBeGreaterThan(0);
        expect(h.session.stats().collapsed).toBe(event?.dropped);
        expect(JSON.stringify(h.session.context())).not.toContain('工具输出');
    });

    it('手动压缩会广播进度：running 先到、done 带结果', async () => {
        const compactor = createSummaryCompactor({
            modelKey: () => 'm',
            sessionId: 'bot:test',
            generateSummary: async () => JSON.stringify({ conclusions: ['C'], changes: [], todos: [], open: [] }),
        });
        const h = makeSession({ seed: compressibleSeed, compactor });

        const event = await h.session.forceCompact({ maxChars: 120, keepTurns: 1 });

        const progress = h.events.flatMap((entry) => (entry.type === 'compact.progress' ? [entry.compact] : []));
        // UI 靠这条做「摘要中…」：必须**先**有 running（await LLM 之前），再有终态
        expect(progress.map((entry) => entry.state)).toEqual(['running', 'done']);
        expect(progress[0]?.compactId).toBe(progress[1]?.compactId);
        expect(progress[0]?.manual).toBe(true);
        expect(progress[1]?.folded).toBe(event?.folded);
        expect(progress[1]?.after?.entries).toBe(h.session.stats().entries);
        expect(progress[1]?.summarized).toBe(true);
    });

    it('取消手动压缩：报 cancelled、上下文原样、不产生压缩事件', async () => {
        const controller = new AbortController();
        const compactor = createSummaryCompactor({
            modelKey: () => 'm',
            sessionId: 'bot:test',
            // 挂着等取消：真实场景里这正是那次要好几秒的 LLM 调用
            generateSummary: (_prompt, signal) =>
                new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        });
        const h = makeSession({ seed: compressibleSeed, compactor });
        const before = JSON.stringify(h.session.context());

        const pending = h.session.forceCompact({ maxChars: 120, keepTurns: 1, signal: controller.signal });
        await sleep(5);
        controller.abort();
        const event = await pending;

        // 取消 = 这次不压：而不是「按新边界压了、只是没摘要」
        expect(event).toBeNull();
        expect(JSON.stringify(h.session.context())).toBe(before);
        const states = h.events.flatMap((entry) => (entry.type === 'compact.progress' ? [entry.compact.state] : []));
        expect(states).toEqual(['running', 'cancelled']);
        expect(h.events.some((entry) => entry.type === 'compact')).toBe(false);
    });

    it('运行中也能手动压：本轮输入还在 pending，不参与这次压缩也不会丢', async () => {
        const h = makeSession({ hangOnAbort: true, compactor: simpleCompactor });
        const running = h.session.post({ messageId: 'm1', text: '你好' });
        await sleep(1);

        // 运行中不拦（回归 regressions.test.ts::F 就靠这条：压缩不得吞掉在跑的那一句）
        const event = await h.session.forceCompact({ maxChars: 120, keepTurns: 1 });
        expect(event).toBeNull(); // 已入账的 transcript 还没东西可压
        h.session.cancel();
        await running;
        // 本轮输入收尾时照样入账：运行中那次压缩没有把它弄丢
        expect(JSON.stringify(h.session.context())).toContain('你好');
    });

    it('压缩事件带上摘要正文，stats 也看得到（模型此刻的承接信息）', async () => {
        const compactor = createSummaryCompactor({
            modelKey: () => 'm',
            sessionId: 'bot:test',
            generateSummary: async () =>
                JSON.stringify({ conclusions: ['保留结论'], changes: [], todos: [], open: [] }),
        });
        const h = makeSession({ seed: compressibleSeed, compactor });

        const event = await h.session.forceCompact({ maxChars: 120, keepTurns: 1 });

        expect(event?.summarized).toBe(true);
        expect(event?.summary).toContain('保留结论');
        expect(event?.summaryError).toBeUndefined();
        // stats.summary = 上下文首条说明里的正文（UI 读取处）
        expect(h.session.stats().summary).toContain('保留结论');
    });

    it('摘要失败：压缩照常生效，事件如实标 summaryError', async () => {
        const compactor = createSummaryCompactor({
            modelKey: () => 'm',
            sessionId: 'bot:test',
            generateSummary: async () => {
                throw new Error('401 Invalid API key');
            },
        });
        const h = makeSession({ seed: compressibleSeed, compactor });

        const event = await h.session.forceCompact({ maxChars: 120, keepTurns: 1 });

        // 压缩不能因为摘要失败而回滚：压不下去就直接超窗
        expect(event).not.toBeNull();
        expect(event?.folded ?? 0).toBeGreaterThan(0);
        expect(JSON.stringify(h.session.context())).not.toContain('工具输出');
        expect(event?.summarized).toBe(false);
        expect(event?.summaryError).toContain('401');
        expect(h.session.stats().summary).toBeUndefined();
    });

    it('stats 反映当前规模与真实用量', async () => {
        const h = makeSession();
        await h.session.post({ messageId: 'm1', text: '你好' });

        const stats = h.session.stats();
        expect(stats.entries).toBe(2);
        expect(stats.chars).toBeGreaterThan(0);
        expect(stats.compactions).toBe(0);
        expect(stats.strategy).toBe('summary-fold-drop');
    });
});
