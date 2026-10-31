// tests/strategies.test.ts
// 🎯 ##491：provider 私有约定归策略（从 diy-app 的 prompt-cache 搬家，语义逐条保留）。
//
// 为什么要单测：
//   · `prompt_cache_retention` 决定「跨轮还命不命中」——390k 上下文冷一次就是 $0.056；
//     补错地方换来一次 400（直连上游没验证过），补错形状静默不生效（cacheRead 掉 0 才发现）。
//   · `x-opencode-session` 缺了直接 400 MissingSessionID。
//   · 注册表是「加新 provider 只需新增文件 + 注册一行」的承重墙：临时策略必须能被认领。
//
// 所以四条都锁死：**开关判据（host 不是名字）/ 不覆盖已有值 / 不改原对象 / 注册表先到先得**。

/// <reference types="vite/client" />
// ↑ 只为 import.meta.glob 的类型（读策略源码做静态扫描）；本源文件不使用任何 IO
import { describe, expect, it } from 'vitest';
import {
    OPENCODE_HEADERS,
    PROMPT_CACHE_RETENTION,
    SESSION_HEADER,
    SESSION_PLACEHOLDER,
    STRATEGIES,
    bodyTransformFor,
    headersFor,
    isOpencodeEndpoint,
    opencodeStrategy,
    passthroughStrategy,
    strategyFor,
    veniceStrategy,
    withPromptCacheRetention,
    withSessionHeader,
} from '../src/strategies/index.js';
import type { ProviderStrategy } from '../src/strategies/index.js';

const OPENCODE_ZEN = 'https://opencode.ai/inference/v1';
const OPENCODE_GO = 'https://opencode.ai/inference/go/openai/v1';

describe('isOpencodeEndpoint（开关判据：host 不是名字）', () => {
    it('opencode 的两种端点都算（zen 与 go）', () => {
        expect(isOpencodeEndpoint(OPENCODE_ZEN)).toBe(true);
        expect(isOpencodeEndpoint(OPENCODE_GO)).toBe(true);
    });

    it('直连上游不算 —— 没验证过的字段不发', () => {
        expect(isOpencodeEndpoint('https://api.deepseek.com')).toBe(false);
        expect(isOpencodeEndpoint('https://api.moonshot.cn/v1')).toBe(false);
    });

    it('子域名不冒充（只认 host 完全相等）', () => {
        expect(isOpencodeEndpoint('https://evil.opencode.ai/v1')).toBe(false);
        expect(isOpencodeEndpoint('https://opencode.ai.evil.com/v1')).toBe(false);
    });

    it('URL 解析不了 ⇒ false（不认识的端点，不补字段）', () => {
        expect(isOpencodeEndpoint('')).toBe(false);
        expect(isOpencodeEndpoint('not a url')).toBe(false);
    });
});

describe('withPromptCacheRetention（请求体）', () => {
    it('补上 24h', () => {
        expect(withPromptCacheRetention({ model: 'm' })).toEqual({
            model: 'm',
            prompt_cache_retention: PROMPT_CACHE_RETENTION,
        });
    });

    it('已有值不覆盖（逐次覆盖是调用方的权利）', () => {
        expect(withPromptCacheRetention({ prompt_cache_retention: '1h' })).toEqual({
            prompt_cache_retention: '1h',
        });
    });

    it('不改原对象（transformRequestBody 可能被同一次请求复用）', () => {
        const body = { model: 'm' };
        withPromptCacheRetention(body);
        expect(body).toEqual({ model: 'm' });
    });
});

describe('withSessionHeader（请求头）', () => {
    it('有 sessionId ⇒ 贴上网关要的 header', () => {
        expect(withSessionHeader({ 'x-static': 'on' }, { sessionId: 'ses_1' })).toEqual({
            'x-static': 'on',
            [SESSION_HEADER]: 'ses_1',
        });
    });

    it('没有 sessionId ⇒ 整条不加（空串会被网关当成显式路由键）', () => {
        expect(withSessionHeader({ 'x-static': 'on' }, {})).toEqual({ 'x-static': 'on' });
        expect(withSessionHeader({}, { sessionId: '' })).toEqual({});
    });

    it('不改原对象', () => {
        const headers = { 'x-static': 'on' };
        withSessionHeader(headers, { sessionId: 'ses_1' });
        expect(headers).toEqual({ 'x-static': 'on' });
    });
});

describe('strategyFor（注册表：按顺序匹配，第一个命中生效）', () => {
    it('opencode 端点 ⇒ opencode 策略', () => {
        expect(strategyFor(OPENCODE_ZEN).name).toBe('opencode');
        expect(strategyFor(OPENCODE_GO).name).toBe('opencode');
    });

    it('不认识的端点 ⇒ passthrough（什么都不加）', () => {
        for (const url of ['https://api.deepseek.com', 'https://api.moonshot.cn/v1', '', 'not a url']) {
            expect(strategyFor(url)).toBe(passthroughStrategy);
        }
    });

    it('venice 只是占位：不认领任何端点（未实测的字段不发）', () => {
        expect(veniceStrategy.matches('https://api.venice.ai/api/v1')).toBe(false);
        expect(strategyFor('https://api.venice.ai/api/v1')).toBe(passthroughStrategy);
    });

    it('passthrough 在注册表末尾兜底', () => {
        expect(STRATEGIES.at(-1)).toBe(passthroughStrategy);
    });
});

describe('加新 provider 只需新增文件 + 注册一行（判据 4）', () => {
    // 模拟「新增 strategies/acme.ts 并在 STRATEGIES 里加一行」：注册表就得认它
    const acmeStrategy: ProviderStrategy = {
        name: 'acme',
        matches: (baseUrl) => baseUrl === 'https://gateway.example/v1',
        transformBody: (body) => ({ ...body, acme_flag: 'on' }),
        transformHeaders: (headers, ctx) => ({ ...headers, 'x-acme-session': ctx.sessionId ?? '' }),
    };
    const registry = [acmeStrategy, opencodeStrategy, veniceStrategy, passthroughStrategy];

    it('临时策略被认领，且它的变换真的生效', () => {
        expect(strategyFor('https://gateway.example/v1', registry)).toBe(acmeStrategy);

        const transform = bodyTransformFor('https://gateway.example/v1', {}, registry);
        expect(transform?.({ model: 'm' })).toEqual({ model: 'm', acme_flag: 'on' });

        expect(headersFor('https://gateway.example/v1', { sessionId: 'ses_x' }, registry)).toEqual({
            'x-acme-session': 'ses_x',
        });
    });

    it('没被认领的端点仍走 passthrough（新增不会误伤别人）', () => {
        expect(strategyFor('https://api.deepseek.com', registry)).toBe(passthroughStrategy);
        expect(bodyTransformFor('https://api.deepseek.com', {}, registry)).toBeUndefined();
        expect(headersFor('https://api.deepseek.com', { sessionId: 'ses_x' }, registry)).toEqual({});
    });
});

describe('应用层只认这两个函数（bodyTransformFor / headersFor）', () => {
    it('opencode：body 补 retention、header 补会话、ctx 透传到策略', () => {
        expect(bodyTransformFor(OPENCODE_GO, {})?.({ model: 'm' })).toEqual({
            model: 'm',
            prompt_cache_retention: PROMPT_CACHE_RETENTION,
        });
        expect(headersFor(OPENCODE_GO, { sessionId: 'local-abc' })).toEqual({ [SESSION_HEADER]: 'local-abc' });
    });

    it('直连上游：两个都空（不挂恒等函数 = 不多复制一次对象）', () => {
        expect(bodyTransformFor('https://api.deepseek.com', {})).toBeUndefined();
        expect(headersFor('https://api.deepseek.com', { sessionId: 'local-abc' })).toEqual({});
    });

    it('opencode 的默认表头与策略同源（不重抄字面量）', () => {
        expect(OPENCODE_HEADERS).toEqual({ [SESSION_HEADER]: SESSION_PLACEHOLDER });
    });
});

describe('判据 2：策略里不许出现 if (provider === ...)（静态扫描）', () => {
    const sources = import.meta.glob('../src/strategies/*.ts', { query: '?raw', import: 'default', eager: true });

    it('每个策略文件都无 provider 名分支', () => {
        const files = Object.keys(sources);
        expect(files.length).toBeGreaterThanOrEqual(5); // types / index / opencode / venice / passthrough
        for (const [file, source] of Object.entries(sources)) {
            expect(`${file}: ${/provider\s*===/.test(source)}`).toBe(`${file}: false`);
        }
    });
});
