// tests/openai.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 provider 的对外契约（##459 判据 3/4/5）：假 fetch + 假 SSE 跑通，不碰真网络
//
//   ① 流式正文：text 增量拼起来 == 完整回复
//   ② 用量：响应带 usage ⇒ 流末给出 usage 增量（含缓存桶）
//   ③ 失败分类：401 / 429 / 超时 ⇒ LlmProviderError 带可辨识 code
//   ④ 请求形状：模型 id 逐次可覆盖、消息原样映射、不掺任何本地配置
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import type { ChatMessage, SessionDelta } from '@diy-agent/session';
import {
    DEFAULT_MODEL_ID,
    LlmProviderError,
    createOpenAiCompatible,
    type LlmProvider,
    type UsageDelta,
} from '../src/index.js';

const BASE_URL = 'https://example.invalid/v1';

/** 一条 OpenAI 兼容的流式 chunk */
function chunk(delta: { content?: string }, extra: Record<string, unknown> = {}): unknown {
    return {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: null }],
        ...extra,
    };
}

/** 造一个 SSE 响应体（`data: {...}` 逐条 + 结尾 [DONE]） */
function sseResponse(chunks: readonly unknown[]): Response {
    const body = `${chunks.map((item) => `data: ${JSON.stringify(item)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 假 fetch：把请求记下来，回一个预置响应 */
function fakeFetch(respond: (request: Request) => Response | Promise<Response>): {
    fetch: typeof globalThis.fetch;
    requests: Request[];
} {
    const requests: Request[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        requests.push(request);
        return await respond(request);
    };
    return { fetch: fetchImpl as unknown as typeof globalThis.fetch, requests };
}

function provider(fetchImpl: typeof globalThis.fetch, model: string = DEFAULT_MODEL_ID): LlmProvider {
    return createOpenAiCompatible({ baseURL: BASE_URL, apiKey: 'test-key', model, fetch: fetchImpl });
}

const USER: readonly ChatMessage[] = [
    { role: 'system', text: 'ignored-by-provider' },
    { role: 'user', text: '你好' },
];

async function collect(llm: LlmProvider, messages: readonly ChatMessage[] = USER): Promise<SessionDelta[]> {
    const out: SessionDelta[] = [];
    for await (const delta of llm.chat(messages)) out.push(delta);
    return out;
}

describe('流式正文（判据 3）', () => {
    it('text 增量拼起来 == 完整回复，且以 done 收尾', async () => {
        const fake = fakeFetch(() =>
            sseResponse([
                chunk({ content: '你' }),
                chunk({ content: '好' }),
                chunk({ content: '，世界' }),
                { ...(chunk({}) as object), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ]),
        );
        const deltas = await collect(provider(fake.fetch));

        const text = deltas
            .filter((delta): delta is { type: 'text'; text: string } => delta.type === 'text')
            .map((delta) => delta.text)
            .join('');
        expect(text).toBe('你好，世界');
        expect(deltas.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' });
    });
});

describe('用量回报（判据 4）', () => {
    it('响应带 usage ⇒ 流末给出 usage 增量（含缓存读）', async () => {
        const fake = fakeFetch(() =>
            sseResponse([
                chunk({ content: 'ok' }),
                {
                    ...(chunk({}) as object),
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: {
                        prompt_tokens: 21,
                        completion_tokens: 5,
                        total_tokens: 26,
                        prompt_tokens_details: { cached_tokens: 8 },
                    },
                },
            ]),
        );
        const deltas = await collect(provider(fake.fetch));
        const usage = deltas.find((delta): delta is UsageDelta => delta.type === 'usage');

        expect(usage).toBeTruthy();
        expect(usage!.inputTokens).toBe(21);
        expect(usage!.outputTokens).toBe(5);
        expect(usage!.cacheReadTokens).toBe(8);
    });

    it('上游不报 usage ⇒ 不产出 usage 增量（不补 0）', async () => {
        const fake = fakeFetch(() =>
            sseResponse([
                chunk({ content: 'ok' }),
                { ...(chunk({}) as object), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ]),
        );
        const deltas = await collect(provider(fake.fetch));
        expect(deltas.some((delta) => delta.type === 'usage')).toBe(false);
    });
});

describe('失败分类（判据 5）', () => {
    it('401 ⇒ unauthorized（不可重试，带状态码）', async () => {
        const fake = fakeFetch(
            () =>
                new Response(JSON.stringify({ error: { message: 'bad key' } }), {
                    status: 401,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const error = await collect(provider(fake.fetch)).then(
            () => undefined,
            (cause: unknown) => cause,
        );
        expect(error).toBeInstanceOf(LlmProviderError);
        const typed = error as LlmProviderError;
        expect(typed.code).toBe('llm-provider/unauthorized');
        expect(typed.statusCode).toBe(401);
        expect(typed.retryable).toBe(false);
    });

    it('429 ⇒ rate-limit（可重试）', async () => {
        const fake = fakeFetch(
            () =>
                new Response(JSON.stringify({ error: { message: 'slow down' } }), {
                    status: 429,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const error = (await collect(provider(fake.fetch)).then(
            () => undefined,
            (cause: unknown) => cause,
        )) as LlmProviderError;
        expect(error.code).toBe('llm-provider/rate-limit');
        expect(error.statusCode).toBe(429);
        expect(error.retryable).toBe(true);
    });

    it('超时 ⇒ timeout（沿 cause 链认出 TimeoutError）', async () => {
        const fake = fakeFetch(() => {
            const timeout = new Error('The operation was aborted due to timeout');
            timeout.name = 'TimeoutError';
            throw timeout;
        });
        const error = (await collect(provider(fake.fetch)).then(
            () => undefined,
            (cause: unknown) => cause,
        )) as LlmProviderError;
        expect(error).toBeInstanceOf(LlmProviderError);
        expect(error.code).toBe('llm-provider/timeout');
        expect(error.retryable).toBe(true);
    });
});

describe('请求形状（判据 4：配置全外部传入）', () => {
    it('模型 id 逐次可覆盖；消息与 key 原样进请求', async () => {
        const fake = fakeFetch(() =>
            sseResponse([
                chunk({ content: 'ok' }),
                { ...(chunk({}) as object), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ]),
        );
        const llm = provider(fake.fetch, 'deepseek-v4-pro');

        for await (const _delta of llm.chat(USER, { model: 'gpt-4o-mini' })) {
            // 只关心请求本身
        }

        const request = fake.requests[0]!;
        expect(request.url).toBe(`${BASE_URL}/chat/completions`);
        expect(request.headers.get('authorization')).toBe('Bearer test-key');
        const body = (await request.json()) as { model: string; messages: { role: string; content: string }[] };
        expect(body.model).toBe('gpt-4o-mini');
        expect(body.messages).toEqual([
            { role: 'system', content: 'ignored-by-provider' },
            { role: 'user', content: '你好' },
        ]);
    });
});
