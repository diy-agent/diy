// tests/session-id.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 sessionId 贯通（##463 第一件）：会话自己把 id 交给 LlmPort，调用方不用管。
//
//   S8  每次 chat 的 options.sessionId == session.id（新会话 / 恢复历史都一样）
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import { createSession, type ChatMessage, type ChatOptions, type LlmPort, type SessionDelta } from '../src/index.js';

/** 假 LlmPort：记下每次收到的 options，吐一个 done 收尾 */
function recordingLlm(): LlmPort & { options: (ChatOptions | undefined)[] } {
    const options: (ChatOptions | undefined)[] = [];
    return {
        options,
        async *chat(_messages: readonly ChatMessage[], callOptions?: ChatOptions): AsyncGenerator<SessionDelta> {
            options.push(callOptions);
            yield { type: 'text', text: '好' };
            yield { type: 'done', stopReason: 'stop' };
        },
    };
}

async function drain(session: ReturnType<typeof createSession>): Promise<void> {
    for await (const _delta of session.send('在吗')) {
        // 消费完整轮
    }
}

describe('S8 会话自动带 sessionId', () => {
    it('新会话：chat 收到的 sessionId == session.id', async () => {
        const llm = recordingLlm();
        const session = createSession({ id: 'ses_abc123', llm });
        await drain(session);

        expect(llm.options).toHaveLength(1);
        expect(llm.options[0]?.sessionId).toBe('ses_abc123');
    });

    it('恢复历史的会话也带自己的 id（不是旧 id）', async () => {
        const llm = recordingLlm();
        const session = createSession({
            id: 'ses_resumed',
            llm,
            initialMessages: [{ role: 'user', text: '早先的提问', seq: 1 }],
        });
        await drain(session);

        expect(llm.options[0]?.sessionId).toBe('ses_resumed');
    });
});
