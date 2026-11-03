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
import { toolCallDeltaOf, toolResultDeltaOf } from '../src/openai.js';
import { createSession } from '@diy-agent/session';

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

/** 收尾 chunk（finish_reason='stop'）—— 流里没有它，ai-sdk 会报「ended without a finish reason」 */
function stopChunk(): unknown {
    return { ...(chunk({}) as object), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
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

describe('$SESSION 占位符（判据 5：会话 header 逐次填）', () => {
    function sessionProvider(fetchImpl: typeof globalThis.fetch): LlmProvider {
        return createOpenAiCompatible({
            baseURL: BASE_URL,
            apiKey: 'test-key',
            model: DEFAULT_MODEL_ID,
            headers: { 'x-static': 'on', 'x-opencode-session': '$SESSION' },
            fetch: fetchImpl,
        });
    }

    it('带了 sessionId ⇒ 占位符贴成会话 id，静态 header 照旧', async () => {
        const fake = fakeFetch(() =>
            sseResponse([{ ...(chunk({}) as object), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
        );
        for await (const _delta of sessionProvider(fake.fetch).chat(USER, { sessionId: 'ses_123' })) {
            // 只关心请求头
        }
        const request = fake.requests[0]!;
        expect(request.headers.get('x-opencode-session')).toBe('ses_123');
        expect(request.headers.get('x-static')).toBe('on');
    });

    it('没带 sessionId ⇒ 整条 header 不传（不是空串）', async () => {
        const fake = fakeFetch(() =>
            sseResponse([{ ...(chunk({}) as object), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
        );
        for await (const _delta of sessionProvider(fake.fetch).chat(USER)) {
            // 只关心请求头
        }
        const request = fake.requests[0]!;
        expect(request.headers.has('x-opencode-session')).toBe(false);
        // 静态 header 不受占位符逻辑牵连
        expect(request.headers.get('x-static')).toBe('on');
    });
});

describe('工具调用转发（##514 第 2 步）', () => {
    /** OpenAI 兼容流的 tool_calls 分片（arguments 分两段，验「只产出一次完整调用」） */
    function toolCallChunks(): unknown[] {
        return [
            {
                ...(chunk({}) as object),
                choices: [
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'read', arguments: '{"path":' },
                                },
                            ],
                        },
                        finish_reason: null,
                    },
                ],
            },
            {
                ...(chunk({}) as object),
                choices: [
                    {
                        index: 0,
                        delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
                        finish_reason: null,
                    },
                ],
            },
            { ...(chunk({}) as object), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ];
    }

    it('上游 tool_calls ⇒ 产出一条 tool-call（id / name / input 是 JSON 字符串）', async () => {
        const fake = fakeFetch(() => sseResponse(toolCallChunks()));
        const deltas = await collect(provider(fake.fetch));
        const calls = deltas.filter((delta) => delta.type === 'tool-call');

        // 分片不重复产出：一次调用 = 一条 delta
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({
            type: 'tool-call',
            id: 'call_1',
            name: 'read',
            input: '{"path":"a.txt"}',
        });
        // 调用之后流仍正常收尾
        expect(deltas.at(-1)).toMatchObject({ type: 'done' });
    });

    it('tool-call part → delta：input 对象转 JSON 字符串，缺 id/name 丢', () => {
        expect(toolCallDeltaOf({ toolCallId: 'c1', toolName: 'read', input: { path: 'a.txt' } })).toEqual({
            type: 'tool-call',
            id: 'c1',
            name: 'read',
            input: '{"path":"a.txt"}',
        });
        // 参数不是合法 JSON 时 ai-sdk 给原始字符串 —— 原样透传（session 侧会退回字符串）
        expect(toolCallDeltaOf({ toolCallId: 'c2', toolName: 'read', input: '{"bad"' })).toMatchObject({
            input: '{"bad"',
        });
        // 无参数 → "null"（与 toolArgsFromInput(undefined) === null 同义）
        expect(toolCallDeltaOf({ toolCallId: 'c3', toolName: 'read' })).toMatchObject({ input: 'null' });
        // 缺 id / name → 不产出（落盘后无从回填结果）
        expect(toolCallDeltaOf({ toolName: 'read', input: null })).toBeUndefined();
        expect(toolCallDeltaOf({ toolCallId: 'c4', input: null })).toBeUndefined();
    });

    it('接进 session：tool-call 落成 tool-call 消息，args 已解析回对象', async () => {
        const fake = fakeFetch(() => sseResponse(toolCallChunks()));
        const session = createSession({ id: 's1', llm: provider(fake.fetch) });
        for await (const _delta of session.send('读一下 a.txt')) {
            // 只关心落盘的消息
        }
        const call = session.messages.find((message) => message.type === 'tool-call');
        expect(call?.data).toEqual({ tool: { name: 'read', args: { path: 'a.txt' }, id: 'call_1' } });
        // 调用前没有正文 ⇒ 不该凭空造一条 agent-trace
        expect(session.messages.some((message) => message.type === 'agent-trace')).toBe(false);
    });

    it('入向映射：tool-call / tool-result 真的出现在请求体里（第二轮模型才看得到结果）', async () => {
        const fake = fakeFetch(() => sseResponse([chunk({ content: 'ok' }), stopChunk()]));
        const history: ChatMessage[] = [
            { role: 'user', text: '读一下 a.txt' },
            // Session 存 tool-call 的形状：分支私有载荷进 data.tool
            { role: 'assistant', type: 'tool-call', data: { tool: { id: 'call_1', name: 'read', args: { path: 'a.txt' } } } },
            { role: 'tool', type: 'tool-result', text: 'hello-514', data: { tool: { id: 'call_1', name: 'read' } } },
            { role: 'user', text: '继续' },
        ];
        for await (const _delta of provider(fake.fetch).chat(history)) {
            // 只关心请求体
        }
        const body = (await fake.requests[0]!.json()) as { messages: Record<string, unknown>[] };

        // ① assistant 消息带着 tool_calls（toolCallId + 参数）
        const assistant = body.messages.find((message) => message['role'] === 'assistant');
        expect(assistant).toMatchObject({
            role: 'assistant',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
        });
        // ② tool 消息按 tool_call_id 挂回去（不带它 = 上游无法配对，模型会重复调工具）
        const tool = body.messages.find((message) => message['role'] === 'tool');
        expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'hello-514' });
        // ③ 顺序不变：user → assistant(tool_calls) → tool → user
        expect(body.messages.map((message) => message['role'])).toEqual(['user', 'assistant', 'tool', 'user']);
    });

    it('入向映射：连续 assistant 消息（先说话再调工具）合并成一条，正文不丢', async () => {
        const fake = fakeFetch(() => sseResponse([chunk({ content: 'ok' }), stopChunk()]));
        const history: ChatMessage[] = [
            { role: 'user', text: '查一下' },
            { role: 'assistant', type: 'agent-trace', text: '我先看看文件' },
            { role: 'assistant', type: 'tool-call', data: { tool: { id: 'call_9', name: 'read', args: { path: 'x' } } } },
            { role: 'tool', type: 'tool-result', text: '内容', data: { tool: { id: 'call_9', name: 'read' } } },
        ];
        for await (const _delta of provider(fake.fetch).chat(history)) {
            // 只关心请求体
        }
        const body = (await fake.requests[0]!.json()) as { messages: Record<string, unknown>[] };
        const assistants = body.messages.filter((message) => message['role'] === 'assistant');
        expect(assistants).toHaveLength(1);
        expect(JSON.stringify(assistants[0])).toContain('我先看看文件');
        expect(JSON.stringify(assistants[0])).toContain('call_9');
    });

    it('tool-result part → delta：文本类取 value，其余转 JSON 文本', () => {
        expect(toolResultDeltaOf({ toolCallId: 'c1', output: { type: 'text', value: '内容' } })).toEqual({
            type: 'tool-result',
            id: 'c1',
            content: '内容',
        });
        expect(toolResultDeltaOf({ toolCallId: 'c2', output: { type: 'json', value: { ok: true } } })).toMatchObject({
            content: '{"ok":true}',
        });
        expect(toolResultDeltaOf({ toolCallId: 'c3', output: '裸文本' })).toMatchObject({ content: '裸文本' });
        expect(toolResultDeltaOf({ output: 'x' })).toBeUndefined();
    });
});

describe('工具透传（##514 教训：循环交给 ai-sdk，不在宿主手写）', () => {
    it('chat 收到 tools ⇒ 请求体里带 tools 字段', async () => {
        const fake = fakeFetch(() =>
            sseResponse([{ ...(chunk({}) as object), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
        );
        const llm = provider(fake.fetch);
        for await (const _delta of llm.chat(USER, {
            tools: { bash: { description: '跑命令', parameters: { type: 'object', properties: {} } } },
            maxSteps: 3,
        })) {
            // 只关心请求体，流内容不重要
        }
        const body = (await fake.requests[0]!.clone().json()) as Record<string, unknown>;
        expect(body['tools']).toBeDefined();
        expect(Array.isArray(body['tools'])).toBe(true);
    });
});
