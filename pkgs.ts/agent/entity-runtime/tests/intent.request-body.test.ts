// intent.request-body.test.ts —— 发出去的请求体里到底有什么（**看真请求，不看我们的意图**）。
//
// 锁一件事：opencode 网关的 `prompt_cache_retention: '24h'` 真的进了 body。
//
// 为什么值得一条测试（##491 的实测账）：缺这个字段时自动前缀缓存只活 ~5 分钟，跨轮
// （真实对话间隔常 >5min）整段重算 —— 120k prompt 实测差 119,936 命中 tokens。
// 而「策略包里有这个函数」≠「请求里有这个字段」：`bodyTransformFor` 没人挂上就是死代码，
// 之前的 diy2 正是这样（策略层有、应用层没接线），静默丢钱且没有任何测试会红。
//
// 做法：替换 `globalThis.fetch` 截获请求体（不出网），对两个端点各发一次：
//   · 认得上的 host（opencode.ai）⇒ body 里有 retention；
//   · 认不上的 host（acme.example）⇒ 一个字段都不多加（未验证的字段不发，省下的钱不值得换一次 400）。

import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modelOf } from '../src/providers';
import { useModelHome, type ModelHome } from './support/model-home';

/** 一次被截获的请求 */
interface Captured {
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
let captured: Captured[] = [];

/** 假上游：把请求体记下来，回一个最小可用的 chat completion（ai-sdk 只要求这些字段） */
function installFakeFetch(): void {
    captured = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        const headers: Record<string, string> = {};
        new Headers(init?.headers ?? {}).forEach((value, key) => {
            headers[key.toLowerCase()] = value;
        });
        captured.push({ url, body: JSON.parse(raw) as Record<string, unknown>, headers });
        return new Response(
            JSON.stringify({
                id: 'chatcmpl-test',
                object: 'chat.completion',
                created: 0,
                model: 'fast',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof globalThis.fetch;
}

/** 发一次最小请求并返回截获到的第一个请求 */
async function sendOne(modelKey: string, sessionId?: string): Promise<Captured> {
    await generateText({
        model: modelOf(modelKey, sessionId === undefined ? {} : { sessionId }),
        prompt: 'hi',
    });
    expect(captured).toHaveLength(1);
    return captured[0]!;
}

let modelHomeDir: ModelHome;

beforeEach(() => {
    modelHomeDir = useModelHome();
    installFakeFetch();
});

afterEach(() => {
    modelHomeDir.restore();
    globalThis.fetch = realFetch;
});

describe('请求体里的 provider 私有字段', () => {
    it('opencode 端点 ⇒ 带 prompt_cache_retention=24h（跨轮缓存才留得住）', async () => {
        const request = await sendOne('main@gateway/fast');
        expect(request.url).toContain('opencode.ai');
        expect(request.body['prompt_cache_retention']).toBe('24h');
    });

    it('同一份配置换个端点 ⇒ 一个字段都不多加（未验证的字段不发）', async () => {
        const request = await sendOne('main@acme/fast');
        expect(request.body['prompt_cache_retention']).toBeUndefined();
    });

    it('会话头与 retention 是两条独立的路：给了 sessionId 才带 x-opencode-session', async () => {
        const withSession = await sendOne('main@gateway/fast', 'room-1');
        expect(withSession.headers['x-opencode-session']).toBe('room-1');
        expect(withSession.body['prompt_cache_retention']).toBe('24h');

        captured = [];
        const withoutSession = await sendOne('main@gateway/fast');
        expect(withoutSession.headers['x-opencode-session']).toBeUndefined();
        expect(withoutSession.body['prompt_cache_retention']).toBe('24h');
    });
});

/** 一条「工具结果里带图片」的请求（view_image 的真实形状） */
async function sendToolImage(modelKey: string): Promise<Captured> {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await generateText({
        model: modelOf(modelKey),
        maxOutputTokens: 8,
        messages: [
            { role: 'user', content: 'call peek' },
            { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'peek', input: {} }] },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'c1',
                        toolName: 'peek',
                        output: {
                            type: 'content',
                            value: [
                                { type: 'text', text: 'look' },
                                {
                                    type: 'file',
                                    mediaType: 'image/png',
                                    data: { type: 'data', data: png },
                                    filename: 'x.png',
                                },
                            ],
                        },
                    },
                ],
            },
        ],
    });
    expect(captured).toHaveLength(1);
    return captured[0]!;
}

describe('tool 结果里的图片（view_image 那条链）', () => {
    it('opencode ⇒ 按 image_url 发；不 JSON 化成字节数组', async () => {
        const request = await sendToolImage('main@gateway/fast');
        const messages = request.body['messages'] as Array<{ role: string; content: unknown }>;
        const tool = messages.find((message) => message.role === 'tool');
        expect(Array.isArray(tool?.content)).toBe(true);
        const parts = tool!.content as Array<{ type: string; image_url?: { url: string } }>;
        const image = parts.find((part) => part.type === 'image_url');
        // 缺这个开关时 ai-sdk 会把 Uint8Array 走 JSON.stringify，body 是 {"0":137,...}（5.9MB 图 → ~59MB）
        expect(image?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('没声明能力的端点 ⇒ 仍是文本兜底（不在未验证端点上发明 image_url）', async () => {
        const request = await sendToolImage('main@acme/fast');
        const messages = request.body['messages'] as Array<{ role: string; content: unknown }>;
        const tool = messages.find((message) => message.role === 'tool');
        expect(typeof tool?.content).toBe('string');
    });
});
