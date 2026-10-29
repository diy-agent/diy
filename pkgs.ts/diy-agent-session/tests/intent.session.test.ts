// tests/intent.session.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 单会话内核「意图测试」—— 需求级（人类语言描述需求，不断言实现）
//
// 需求定义（本文件即契约，对应 ##456「AgentSession 的边界」与四步判据第 1 步）：
//   S1  流式对话：一句 user 进去 → LlmPort 的增量**边收边吐** → 历史落成 user + assistant
//   S2  token 计量：usage 增量累计到会话上（input / output / 轮数）
//   S3  串行：上一轮没结束就再 send ⇒ `session/busy`（不排队、不合并 —— 排队是 room 的事）
//   S4  响亮失败：非法消息 / 非法增量 / 空正文一律报错，不静默丢弃
//   S5  压缩是注入策略：每轮调用前跑一次，改的是「这一轮看到的历史」，结果照样要过校验
//   S6  存储是注入适配器：不传 = 一个字节不落盘；传了就拿到完整快照
//   S7  零 IO 纯内核：src/** 里没有文件系统模块 / electron / 应用数据根 / 任务标识
//
// 测试风格：假 LlmPort + 假 Clock（不碰真 LLM、不碰真时间），断言公开 API 行为与错误码。
// ═══════════════════════════════════════════════════════════════

/// <reference types="vite/client" />
// ↑ 只为 import.meta.glob 的类型（读源码做静态扫描）；本包源码不使用任何 IO
import { describe, expect, it } from 'vitest';
import {
    SessionError,
    assertDelta,
    createSession,
    parseMessage,
    type ChatMessage,
    type Clock,
    type LlmPort,
    type SessionDelta,
    type SessionSnapshot,
} from '../src/index.js';

const T0 = Date.parse('2026-10-29T00:00:00.000Z');

/** 假时钟：每次取时间 +1s（`at` 确定且单调） */
function fakeClock(): Clock {
    let n = 0;
    return { now: () => T0 + n++ * 1000 };
}

/** 假 LlmPort：脚本化每次调用的增量序列，并记录收到的消息 */
function scriptedLlm(scripts: SessionDelta[][]): LlmPort & { calls: ChatMessage[][] } {
    const calls: ChatMessage[][] = [];
    return {
        calls,
        async *chat(messages) {
            calls.push([...messages]);
            const script = scripts.shift();
            if (!script) throw new Error('scriptedLlm：没有更多脚本');
            for (const delta of script) yield delta;
        },
    };
}

/** 可暂停的假 LlmPort：吐完 first 后等 gate，用来制造「上一轮还没结束」 */
function gatedLlm(first: SessionDelta[]): LlmPort & { open(): void } {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
        open = resolve;
    });
    return {
        open,
        async *chat() {
            for (const delta of first) yield delta;
            await gate;
            yield { type: 'done' };
        },
    };
}

function iterator(stream: AsyncIterable<SessionDelta>): AsyncIterator<SessionDelta> {
    return stream[Symbol.asyncIterator]();
}

async function collect(stream: AsyncIterable<SessionDelta>): Promise<SessionDelta[]> {
    const out: SessionDelta[] = [];
    for await (const delta of stream) out.push(delta);
    return out;
}

describe('S1 流式对话', () => {
    it('一句 user 进去 → 增量边收边吐 → 历史落成 user + assistant', async () => {
        const llm = scriptedLlm([
            [
                { type: 'text', text: '你' },
                { type: 'text', text: '好' },
                { type: 'done', stopReason: 'stop' },
            ],
        ]);
        const session = createSession({ id: 's1', llm, clock: fakeClock() });

        const deltas = await collect(session.send('在吗'));

        expect(deltas).toEqual([
            { type: 'text', text: '你' },
            { type: 'text', text: '好' },
            { type: 'done', stopReason: 'stop' },
        ]);
        expect(session.messages.map((m) => [m.role, m.content])).toEqual([
            ['user', '在吗'],
            ['assistant', '你好'],
        ]);
        // LlmPort 只看见 user 消息；assistant 的回复由本包落历史
        expect(llm.calls[0].map((m) => m.role)).toEqual(['user']);
    });

    it('流式是真流：消费端拿到第一个增量时，assistant 消息还没落历史', async () => {
        const llm = gatedLlm([{ type: 'text', text: '半' }]);
        const session = createSession({ id: 's1', llm, clock: fakeClock() });
        const it = session.send('说半句')[Symbol.asyncIterator]();

        const first = await it.next();
        expect(first.value).toEqual({ type: 'text', text: '半' });
        expect(session.messages.map((m) => m.role)).toEqual(['user']);
        expect(session.busy).toBe(true);

        llm.open();
        await it.return?.(undefined); // 主动断流（不 await 完也无害）
        expect(session.busy).toBe(false);
    });
});

describe('S1b 消息分类（5 种 kind）', () => {
    it('遇 tool-call 把缓冲 flush 成 trace；最后一段才是 agent-conclusion', async () => {
        const llm = scriptedLlm([
            [
                { type: 'text', text: '我先看看' },
                { type: 'tool-call', id: 't1', name: 'read', input: '{"path":"a.ts"}' },
                { type: 'tool-result', id: 't1', content: 'ok' },
                { type: 'text', text: '结论：可以合并' },
                { type: 'done' },
            ],
        ]);
        const session = createSession({ id: 's1', llm, clock: fakeClock() });

        await collect(session.send('看下 a.ts'));

        expect(session.messages.map((message) => [message.role, message.kind, message.content])).toEqual([
            ['user', 'human', '看下 a.ts'],
            ['assistant', 'agent-trace', '我先看看'],
            ['assistant', 'tool-call', '{"path":"a.ts"}'],
            ['tool', 'tool-result', 'ok'],
            ['assistant', 'agent-conclusion', '结论：可以合并'],
        ]);
    });

    it('kind 不传时按 role 推导；非法 kind 报错', () => {
        expect(parseMessage({ role: 'assistant', content: 'x' }).kind).toBe('agent-conclusion');
        expect(() => parseMessage({ role: 'assistant', content: 'x', kind: 'thought' })).toThrow(/未知消息分类/);
    });
});

describe('S2 token 计量', () => {
    it('usage 增量累计到会话上：input / output / 轮数', async () => {
        const llm = scriptedLlm([
            [{ type: 'text', text: 'a' }, { type: 'usage', inputTokens: 10, outputTokens: 4 }, { type: 'done' }],
            [{ type: 'text', text: 'b' }, { type: 'usage', inputTokens: 20, outputTokens: 6 }, { type: 'done' }],
        ]);
        const session = createSession({ id: 's1', llm, clock: fakeClock() });

        await collect(session.send('一'));
        await collect(session.send('二'));

        expect(session.usage).toEqual({ inputTokens: 30, outputTokens: 10, turns: 2 });
    });
});

describe('S3 一个会话同一时刻只有一轮', () => {
    it('上一轮没结束再 send ⇒ session/busy（不排队、不合并）', async () => {
        const llm = gatedLlm([{ type: 'text', text: '慢' }]);
        const session = createSession({ id: 's1', llm, clock: fakeClock() });
        const it = session.send('第一句')[Symbol.asyncIterator]();
        await it.next();

        await expect(iterator(session.send('第二句')).next()).rejects.toMatchObject({ code: 'session/busy' });

        session.cancel();
        await it.return?.(undefined);
        expect(session.busy).toBe(false);
    });
});

describe('S4 响亮失败', () => {
    it('非法消息带点路径报 session/invalid-message', () => {
        expect(() => parseMessage({ role: 'robot', content: 'x' })).toThrow(SessionError);
        try {
            parseMessage({ role: 'robot', content: 'x' });
        } catch (error) {
            expect((error as SessionError).code).toBe('session/invalid-message');
            expect((error as SessionError).path).toBe('message.role');
        }
        // 拼错字段名必须是显式失败（不能表现为「字段没生效」）
        expect(() => parseMessage({ role: 'user', content: 'x', extra: 1 })).toThrow(/未知字段/);
    });

    it('LlmPort 吐出未知增量 ⇒ session/invalid-delta（不半条流进历史）', async () => {
        const llm: LlmPort = {
            // @ts-expect-error 故意给非法增量：适配器写错了要在边界炸
            async *chat() {
                yield { type: 'text', text: '半' };
                yield { type: 'image', url: 'x' };
            },
        };
        const session = createSession({ id: 's1', llm, clock: fakeClock() });

        await expect(collect(session.send('hi'))).rejects.toMatchObject({ code: 'session/invalid-delta' });
        // 半条正文不落历史（这一轮失败，历史保持在 user 之前的状态 + 那条 user）
        expect(session.messages.map((m) => m.role)).toEqual(['user']);
        expect(session.busy).toBe(false);
    });

    it('空正文 ⇒ session/empty-text（没有可发给 LLM 的内容）', async () => {
        const session = createSession({ id: 's1', llm: scriptedLlm([]), clock: fakeClock() });
        await expect(iterator(session.send('   ')).next()).rejects.toMatchObject({ code: 'session/empty-text' });
    });

    it('增量校验可以直接调用（宿主复用同一把尺子）', () => {
        expect(assertDelta({ type: 'usage', inputTokens: 3, outputTokens: 1 })).toEqual({
            type: 'usage',
            inputTokens: 3,
            outputTokens: 1,
        });
        expect(() => assertDelta({ type: 'usage', inputTokens: -1, outputTokens: 0 })).toThrow(/非负/);
    });
});

describe('S5 压缩是注入策略', () => {
    it('每轮调用前跑一次；改的是这一轮看到的历史，会话历史同步替换', async () => {
        const llm = scriptedLlm([[{ type: 'text', text: 'ok' }, { type: 'done' }]]);
        const seen: ChatMessage[][] = [];
        const session = createSession({
            id: 's1',
            llm,
            clock: fakeClock(),
            compact: (messages) => {
                seen.push([...messages]);
                // 策略：只留最后一条（真实的窗口压缩归 @diy/compact）
                return messages.slice(-1);
            },
        });
        session.append({ role: 'system', content: '你是助手' });

        await collect(session.send('新问题'));

        expect(seen[0].map((m) => m.role)).toEqual(['system', 'user']);
        expect(llm.calls[0].map((m) => m.content)).toEqual(['新问题']);
        expect(session.messages.map((m) => m.content)).toEqual(['新问题', 'ok']);
    });

    it('策略返回非法形状 ⇒ session/invalid-message（不静默接受）', async () => {
        const session = createSession({
            id: 's1',
            llm: scriptedLlm([]),
            clock: fakeClock(),
            // @ts-expect-error 故意返回非法形状
            compact: () => [{ role: 'bot', content: 'x' }],
        });
        await expect(collect(session.send('hi'))).rejects.toMatchObject({ code: 'session/invalid-message' });
        expect(session.busy).toBe(false);
    });
});

describe('S6 存储是注入适配器', () => {
    it('传了 store：每轮结束拿到完整快照（含刚落的 assistant）', async () => {
        const snapshots: SessionSnapshot[] = [];
        const session = createSession({
            id: 's1',
            llm: scriptedLlm([[{ type: 'text', text: '收到' }, { type: 'done' }]]),
            clock: fakeClock(),
            store: {
                save(snapshot) {
                    snapshots.push(snapshot);
                },
            },
        });

        await collect(session.send('记一下'));

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].id).toBe('s1');
        expect(snapshots[0].messages.map((m) => m.content)).toEqual(['记一下', '收到']);
        expect(snapshots[0].usage.turns).toBe(1);
    });

    it('不传 store：纯内存（不发任何写调用）', async () => {
        const session = createSession({
            id: 's1',
            llm: scriptedLlm([[{ type: 'text', text: 'x' }, { type: 'done' }]]),
            clock: fakeClock(),
        });
        await collect(session.send('hi'));
        expect(session.messages).toHaveLength(2);
    });
});

describe('S7 零 IO 纯内核', () => {
    it('src/** 不含文件系统模块 / electron / 应用数据根 / 任务标识', () => {
        // 用 vite 的 raw 导入读源码（测试自己也不 import 文件系统），判据与实现无关
        const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
            string,
            string
        >;
        const files = Object.keys(sources);
        expect(files.length).toBeGreaterThan(0);
        // 关键词拼接：本文件自己不能被这些字面量扫到
        const fsModule = `node:${'fs'}`;
        const appHome = `diy${'Home'}`;
        const taskUri = `task${'Uri'}`;
        const forbidden = [
            new RegExp(`from\\s+['"]${fsModule}`),
            /\belectron\b/,
            new RegExp(`\\b${appHome}\\b`),
            new RegExp(`\\b${taskUri}\\b`),
        ];
        for (const [file, text] of Object.entries(sources)) {
            // 头注里的「不许出现」说明不算违规：只扫 import 与代码行
            const code = text
                .split('\n')
                .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
                .join('\n');
            for (const re of forbidden) {
                expect(code, `${file} 命中 ${re}`).not.toMatch(re);
            }
        }
    });
});
