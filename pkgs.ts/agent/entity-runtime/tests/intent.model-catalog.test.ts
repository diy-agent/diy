// intent.model-catalog.test.ts —— 模型接入的**真源**：目录（model.yaml）而不是代码里的表。
//
// 锁三件事：
//   1. 端点来自目录里该 provider 的 spec（不是写死的 PROVIDER_API）；
//   2. key 来自目录里该账号（不是写死的环境变量名 PROVIDER_ENV）；
//   3. 找不到 / 配错时**响亮失败**，并指出数据根在哪（旧版会静默退回默认模型 + 别人的 key）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modelConfigPath, modelHome, modelOf } from '../src/providers';
import { useModelHome, type ModelHome } from './support/model-home';

let modelHomeDir: ModelHome;

beforeEach(() => {
    modelHomeDir = useModelHome();
});

afterEach(() => {
    modelHomeDir.restore();
});

describe('模型接入只看目录', () => {
    it('modelHome = model.yaml 所在目录（目录包按目录读三个文件）', () => {
        expect(modelConfigPath()).toBe(modelHomeDir.configPath);
        expect(modelHome()).toBe(modelHomeDir.home);
    });

    it('按 account@provider/model 建出模型，端点取自目录 spec', () => {
        const model = modelOf('main@acme/fast') as unknown as { modelId?: string; provider?: string };
        expect(model.modelId).toBe('fast');
        // ai-sdk 的 openai-compatible 用 `name` 当 provider 标识（我们传的就是目录里的 providerId）
        expect(model.provider).toContain('acme');
    });

    it('目录里没有这个模型 ⇒ 报错并指出数据根', () => {
        expect(() => modelOf('main@acme/nope')).toThrow(/模型目录里没有 acme\/nope/);
    });

    it('目录里没有这个 provider ⇒ 同样是这条错（不是偷偷用别人的端点）', () => {
        expect(() => modelOf('main@ghost/fast')).toThrow(/模型目录里没有 ghost\/fast/);
    });

    it('provider 有、账号没有 ⇒ 报错并带数据根（不静默退回第一个账号）', () => {
        expect(() => modelOf('nobody@acme/fast')).toThrow(/取不到 acme\/nobody 的 key/);
    });

    it('会话 id 只影响请求头，不影响解析（不给也不炸）', () => {
        const withoutSession = modelOf('main@acme/fast') as unknown as { modelId?: string };
        const withSession = modelOf('main@acme/fast', { sessionId: 'room-1' }) as unknown as { modelId?: string };
        expect(withoutSession.modelId).toBe('fast');
        expect(withSession.modelId).toBe('fast');
    });
});
