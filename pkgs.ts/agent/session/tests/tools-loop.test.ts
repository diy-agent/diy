// tests/tools-loop.test.ts — 工具循环的会话侧契约（##514 第 3 步）
//
// `continueWithToolResults()` 存在的理由：`send()` 恒追加 **user** 消息，而工具结果在协议上
// 必须落成 `role:'tool'` + `tool_call_id` 配对。所以它和 send 共用同一个 `runTurn()`，
// 只是「这一轮开始前落什么历史」不同。
//
// 钉住的判据：
//   ① 结果落成 role:'tool' 消息，且 `data.tool.id` = 对应 tool-call 的 id（投递侧靠它配对）
//   ② 记账 / 收尾与 send 完全一致（usage 累加、正文成 agent-conclusion）
//   ③ 非法入口不静默：没有待回收的 tool-call / 空结果都抛带 code 的错误

import { describe, expect, it } from 'vitest';
import { SessionError, createSession, type ChatMessage, type LlmPort, type SessionDelta } from '../src/index.js';

/** 脚本化 LLM：每轮吐一段预置增量，并记录它收到的 messages */
function scripted(rounds: readonly (readonly SessionDelta[])[]): {
    llm: LlmPort;
    seen: ChatMessage[][];
    calls: () => number;
} {
    const seen: ChatMessage[][] = [];
    return {
        seen,
        calls: () => seen.length,
        llm: {
            async *chat(messages): AsyncIterable<SessionDelta> {
                seen.push([...messages]);
                const round = rounds[seen.length - 1];
                if (round === undefined) throw new Error(`多余的调用：第 ${seen.length} 轮`);
                for (const delta of round) yield delta;
            },
        },
    };
}

describe('continueWithToolResults（##514 第 3 步）', () => {
    it('结果按 tool_call_id 落成 role:tool 消息，第二轮拿到「带结果的历史」', async () => {
        const s = scripted([
            [
                { type: 'text', text: '我先看看' },
                { type: 'tool-call', id: 'call_1', name: 'read', input: '{"path":"a.txt"}' },
                { type: 'usage', inputTokens: 10, outputTokens: 3 },
                { type: 'done', stopReason: 'tool-calls' },
            ],
            [
                { type: 'text', text: '文件里是 hello' },
                { type: 'usage', inputTokens: 20, outputTokens: 5 },
                { type: 'done' },
            ],
        ]);
        const session = createSession({ id: 's1', llm: s.llm });

        for await (const _delta of session.send('读一下 a.txt')) {
            // 只关心落盘
        }
        // 第一步：先说话再调工具 ⇒ 正文落成 agent-trace，调用落成 tool-call
        expect(session.messages.map((m) => m.type)).toEqual(['human', 'agent-trace', 'tool-call']);

        for await (const _delta of session.continueWithToolResults([
            { id: 'call_1', name: 'read', content: 'hello' },
        ])) {
            // 只关心落盘
        }

        // ① 结果消息：role=tool + data.tool.id（协议靠它挂回调用）
        const result = session.messages.find((m) => m.type === 'tool-result');
        expect(result).toMatchObject({ role: 'tool', type: 'tool-result', text: 'hello' });
        expect(result?.data).toEqual({ tool: { id: 'call_1', name: 'read' } });

        // ② 第二轮请求里带上了那条结果（不是靠 bot 猜）
        const second = s.seen[1]!;
        expect(second.some((m) => m.role === 'tool' && m.text === 'hello')).toBe(true);

        // ③ 记账与 send 同口径：两轮都算，turns = 2
        expect(session.usage).toMatchObject({ inputTokens: 30, outputTokens: 8, turns: 2 });
        // ④ 最后一段正文是结论
        expect(session.messages.at(-1)).toMatchObject({ type: 'agent-conclusion', text: '文件里是 hello' });
    });

    it('没有待回收的 tool-call ⇒ session/nothing-to-continue（不静默跑一轮空对话）', async () => {
        const s = scripted([[{ type: 'text', text: '不用工具' }, { type: 'done' }]]);
        const session = createSession({ id: 's2', llm: s.llm });
        for await (const _delta of session.send('你好')) {
            // 只关心落盘
        }
        await expect(async () => {
            for await (const _delta of session.continueWithToolResults([{ id: 'x', content: 'y' }])) {
                // 不关心
            }
        }).rejects.toMatchObject({ code: 'session/nothing-to-continue' });
        // 没有发起第三次 LLM 调用
        expect(s.calls()).toBe(1);
    });

    it('空结果 / 缺 id ⇒ session/invalid-tool-results（空继续 = 让模型重调一次工具）', async () => {
        const s = scripted([
            [{ type: 'tool-call', id: 'c1', name: 'read', input: '{}' }, { type: 'done', stopReason: 'tool-calls' }],
        ]);
        const session = createSession({ id: 's3', llm: s.llm });
        for await (const _delta of session.send('x')) {
            // 只关心落盘
        }
        const drain = async (results: unknown): Promise<void> => {
            for await (const _delta of session.continueWithToolResults(results as never)) {
                // 不关心
            }
        };
        await expect(drain([])).rejects.toBeInstanceOf(SessionError);
        await expect(drain([])).rejects.toMatchObject({ code: 'session/invalid-tool-results' });
        await expect(drain([{ content: '没有 id' }])).rejects.toMatchObject({ code: 'session/invalid-tool-results' });
        await expect(drain([{ id: '', content: 'x' }])).rejects.toMatchObject({ code: 'session/invalid-tool-results' });
    });

    it('并发守卫共用：一轮没跑完时 continue 也抛 session/busy', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const llm: LlmPort = {
            async *chat(): AsyncIterable<SessionDelta> {
                await gate;
                yield { type: 'done' };
            },
        };
        const session = createSession({ id: 's4', llm });
        const first = (async () => {
            for await (const _delta of session.send('x')) {
                // 不关心
            }
        })();
        await expect(async () => {
            for await (const _delta of session.continueWithToolResults([{ id: 'c1', content: 'y' }])) {
                // 不关心
            }
        }).rejects.toMatchObject({ code: 'session/busy' });
        release();
        await first;
    });
});
