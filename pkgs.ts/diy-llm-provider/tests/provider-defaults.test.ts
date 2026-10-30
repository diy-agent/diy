// tests/provider-defaults.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 协议表（##463 第二件）的对外契约：
//
//   ① 每个条目都能被 createOpenAiCompatible 直接消费（解析 → 发请求，URL 就是表里的 endpoint）
//   ② 加新 provider = 加一行数据（不改任何代码：塞一行进表，解析与发请求立刻认）
//   ③ opencode-go 的会话 header 走 $SESSION（##463 实测 200 的端点）
//   ④ 表外名字响亮失败，并列出可选项
//   ⑤ 零 IO：表里没有 fs / 数据根 / 网络探测（静态扫描）
// ═══════════════════════════════════════════════════════════════

/// <reference types="vite/client" />
// ↑ 只为 import.meta.glob 的类型（读源码做静态扫描）；本源文件不使用任何 IO
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@diy-agent/session';
import {
    PROVIDER_DEFAULTS,
    SESSION_PLACEHOLDER,
    createOpenAiCompatible,
    resolveProviderConfig,
    type ProviderDefaults,
} from '../src/index.js';

const USER: readonly ChatMessage[] = [{ role: 'user', text: '你好' }];

/** 一条 OpenAI 兼容的流式 chunk（够用就好：正文 + 结束） */
function sseResponse(): Response {
    const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model' };
    const body = [
        { ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
        .map((item) => `data: ${JSON.stringify(item)}`)
        .join('\n\n');
    return new Response(`${body}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

/** 假 fetch：把请求记下来，一律回一段正常 SSE */
function fakeFetch(): { fetch: typeof globalThis.fetch; requests: Request[] } {
    const requests: Request[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requests.push(new Request(input, init));
        return sseResponse();
    };
    return { fetch: fetchImpl as unknown as typeof globalThis.fetch, requests };
}

describe('每个条目都能被 createOpenAiCompatible 直接消费（判据 1）', () => {
    for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
        it(`${provider}：解析 → 发请求，URL 落在表里的 endpoint 上`, async () => {
            expect(defaults.npm).toBe('@ai-sdk/openai-compatible');
            expect(defaults.api).toBeTypeOf('string');

            const fake = fakeFetch();
            const llm = createOpenAiCompatible(
                resolveProviderConfig({ provider, apiKey: 'test-key', model: 'test-model', fetch: fake.fetch }),
            );
            for await (const _delta of llm.chat(USER)) {
                // 只关心请求本身
            }

            expect(fake.requests).toHaveLength(1);
            expect(fake.requests[0]!.url).toBe(`${defaults.api}/chat/completions`);
            expect(fake.requests[0]!.headers.get('authorization')).toBe('Bearer test-key');
        });
    }
});

describe('加新 provider = 加一行数据（判据 2）', () => {
    it('往表里塞一行自定义网关，解析与发请求立刻认（不改代码）', async () => {
        const table = PROVIDER_DEFAULTS as Record<string, ProviderDefaults>;
        const added: ProviderDefaults = {
            npm: '@ai-sdk/openai-compatible',
            api: 'https://gateway.example/v1',
            headers: { 'x-session': SESSION_PLACEHOLDER },
        };
        table['acme-gateway'] = added;
        try {
            const fake = fakeFetch();
            const llm = createOpenAiCompatible(
                resolveProviderConfig({
                    provider: 'acme-gateway',
                    apiKey: 'test-key',
                    model: 'test-model',
                    fetch: fake.fetch,
                }),
            );
            for await (const _delta of llm.chat(USER, { sessionId: 'ses_acme' })) {
                // 只关心请求本身
            }

            expect(fake.requests[0]!.url).toBe('https://gateway.example/v1/chat/completions');
            expect(fake.requests[0]!.headers.get('x-session')).toBe('ses_acme');
        } finally {
            delete table['acme-gateway'];
        }
    });
});

describe('opencode-go：$SESSION 会话 header（判据 3）', () => {
    it('表里带会话占位符，chat 时贴成 sessionId', async () => {
        const defaults = PROVIDER_DEFAULTS['opencode-go']!;
        expect(defaults.api).toBe('https://opencode.ai/inference/go/openai/v1');
        expect(defaults.headers?.['x-opencode-session']).toBe(SESSION_PLACEHOLDER);

        const fake = fakeFetch();
        const llm = createOpenAiCompatible(
            resolveProviderConfig({
                provider: 'opencode-go',
                apiKey: 'test-key',
                model: 'test-model',
                fetch: fake.fetch,
            }),
        );
        for await (const _delta of llm.chat(USER, { sessionId: 'ses_go_1' })) {
            // 只关心请求本身
        }

        expect(fake.requests[0]!.headers.get('x-opencode-session')).toBe('ses_go_1');
    });
});

describe('表外名字响亮失败（判据 4）', () => {
    it('未知 provider ⇒ TypeError 且列出可选项', () => {
        expect(() => resolveProviderConfig({ provider: 'no-such-provider', apiKey: 'k', model: 'm' })).toThrow(
            /未知 provider "no-such-provider".*deepseek/,
        );
    });

    it('baseURL 可覆盖表里的 endpoint（自建代理）', () => {
        const config = resolveProviderConfig({
            provider: 'deepseek',
            apiKey: 'k',
            model: 'm',
            baseURL: 'https://proxy.example/v1',
        });
        expect(config.baseURL).toBe('https://proxy.example/v1');
        expect(config.name).toBe('deepseek');
    });
});

describe('零 IO（判据 5）', () => {
    it('src/provider-defaults.ts 里没有文件系统 / 数据根 / 环境变量读取', async () => {
        const modules = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
            string,
            string
        >;
        const source = modules['../src/provider-defaults.ts'];
        expect(source).toBeTypeOf('string');
        for (const banned of ['node:fs', 'diyHome', 'process.env', 'node:net', 'node:http']) {
            expect(source!.includes(banned), `${banned} 不该出现在协议表里`).toBe(false);
        }
    });
});
