// strategies.probe.test.ts — 每个 provider 策略的独特行为
//
// 为什么单开一份：strategies.test.ts 测的是**通用变换函数**（isOpencodeEndpoint /
// withPromptCacheRetention），但「策略注册表怎么选、选错了会怎样」没人守。
//
// 探针来源（都不是我编的，是代码里写死的事实）：
//   ① 策略按 **host** 认领，不看 provider 名 —— 名是调用方起的路由名，可随意改
//   ② 未验证的字段不发 —— venice 故意什么都不做（venice.ts 头注）
//   ③ 兜底 passthrough 认领一切，放在注册表末尾
//
// 三条都是「改错就静默出问题」的类型：多发一个 header → 上游 400；少发 → 路由不了。
// 所以每条都要有断言，而不是靠人记。

import { describe, expect, it } from 'vitest';
import {
    OPENCODE_HEADERS,
    SESSION_HEADER,
    STRATEGIES,
    bodyTransformFor,
    headersFor,
    passthroughStrategy,
    strategyFor,
    veniceStrategy,
    withSessionHeader,
    type ProviderStrategy,
} from '../src/strategies/index.js';

const ZEN = 'https://opencode.ai/zen/go/v1';
const GO = 'https://opencode.ai/inference/go/openai/v1';
const OTHER = 'https://api.deepseek.com/v1';

describe('withSessionHeader', () => {
    it('有 sessionId ⇒ 补上 x-opencode-session', () => {
        expect(withSessionHeader({}, { sessionId: 'loc-abc' })).toEqual({ [SESSION_HEADER]: 'loc-abc' });
    });

    it('无 sessionId / 空串 ⇒ **原引用返回**（不是新对象）', () => {
        const base = { a: '1' };
        expect(withSessionHeader(base, {})).toBe(base);
        expect(withSessionHeader(base, { sessionId: '' })).toBe(base);
    });

    it('不覆盖已有的同名 header？—— **覆盖**（调用方显式传的 sessionId 优先）', () => {
        // 这条是「语义选择」而不是 bug：ctx.sessionId 是本次请求的事实来源
        expect(withSessionHeader({ [SESSION_HEADER]: 'old' }, { sessionId: 'new' })).toEqual({
            [SESSION_HEADER]: 'new',
        });
    });

    it('其它 header 原样保留', () => {
        expect(withSessionHeader({ 'x-trace': 't1' }, { sessionId: 's1' })).toEqual({
            'x-trace': 't1',
            [SESSION_HEADER]: 's1',
        });
    });
});

describe('OPENCODE_HEADERS（常量表）', () => {
    it('含 session 占位符 —— 静态 header 里原样带着 $SESSION，等每次调用替换', () => {
        expect(JSON.stringify(OPENCODE_HEADERS)).toContain('$SESSION');
    });
});

describe('strategyFor（按 host 认领，不看 provider 名）', () => {
    it('opencode 的两个端点都命中 opencode 策略', () => {
        expect(strategyFor(ZEN).name).toBe('opencode');
        expect(strategyFor(GO).name).toBe('opencode');
    });

    it('直连上游 ⇒ 兜底 passthrough（不补任何东西）', () => {
        expect(strategyFor(OTHER).name).toBe('passthrough');
    });

    it('venice **不认领**任何端点（未实测 ⇒ 故意 matches 恒 false）', () => {
        expect(veniceStrategy.matches('https://api.venice.ai/v1')).toBe(false);
    });

    it('passthrough 认领一切（兜底）', () => {
        expect(passthroughStrategy.matches('anything')).toBe(true);
    });
});

describe('headersFor / bodyTransformFor（调用方只认这两个）', () => {
    it('opencode 端点 + sessionId ⇒ 返回该 header', () => {
        expect(headersFor(GO, { sessionId: 's1' })).toEqual({ [SESSION_HEADER]: 's1' });
    });

    it('opencode 端点但无 sessionId ⇒ {} （缺什么整体跳过）', () => {
        expect(headersFor(GO, {})).toEqual({});
    });

    it('陌生端点 ⇒ {} 且 bodyTransform 为 undefined（**别挂恒等函数**，白复制一次对象）', () => {
        expect(headersFor(OTHER, { sessionId: 's1' })).toEqual({});
        expect(bodyTransformFor(OTHER, {})).toBeUndefined();
    });

    it('opencode 端点 ⇒ bodyTransform 存在且能补 prompt_cache_retention', () => {
        const t = bodyTransformFor(GO, {});
        expect(t).toBeDefined();
        expect(t!({})).toMatchObject({ prompt_cache_retention: expect.any(String) });
    });
});

describe('注册表（加新 provider = 新增文件 + 加一行）', () => {
    it('顺序即优先级：具体策略在 passthrough 之前', () => {
        const iOpen = STRATEGIES.findIndex((s) => s.name === 'opencode');
        const iPass = STRATEGIES.findIndex((s) => s.name === 'passthrough');
        expect(iOpen).toBeGreaterThanOrEqual(0);
        expect(iPass).toBeGreaterThan(iOpen);
    });

    it('临时塞一个策略进去就能被认领（registry 可注入 —— 这条守的是「扩展机制」本身）', () => {
        const fake: ProviderStrategy = {
            name: 'fake',
            matches: (url) => url.includes('example.test'),
        };
        expect(strategyFor('https://example.test/v1', [fake, passthroughStrategy]).name).toBe('fake');
    });

    it('**同名 provider 换 URL 就走不同策略**（判据：认领只看 host，不看名字）', () => {
        // types.ts 头注：「按 host 判，不看 provider 名 —— 名是调用方自己起的路由名，可随意改」。
        // 行为验证：同一家 provider 指向陌生 URL 时应该落到 passthrough（什么都不补），
        // 而不是因为"名字叫 opencode"就继续补 header。
        const custom = 'https://my-own-proxy.example/v1';
        expect(strategyFor(custom).name).toBe('passthrough');
        expect(headersFor(custom, { sessionId: 's1' })).toEqual({});
    });
});
