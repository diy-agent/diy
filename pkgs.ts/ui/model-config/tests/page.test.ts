import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPage } from '../src/index.js';
import { accountLabel } from '../src/actions.js';
import type { ConfigSnapshot, WriteResult } from '../src/shared.js';

const MODEL = `stdProviders:
  acme:
    accounts:
      - type: apiKey
        name: one
        data:
          value: sk-super-secret-777
    filter:
      include: []
      exclude: []
customProviders:
  goat:
    accounts:
      - type: apiKey
        name: default
        data:
          value: ''
    filter:
      include: []
      exclude: []
`;

const CUSTOM = `goat:
  id: goat
  npm: '@ai-sdk/openai-compatible'
  api: https://goat.example/v1
  models:
    m1:
      id: m1
      name: Goat One
      limit:
        context: 1000
      cost:
        input: 1
        output: 2
`;

function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'model-config-page-'));
    writeFileSync(join(home, 'model.yaml'), MODEL, 'utf-8');
    writeFileSync(join(home, 'providers.custom.yaml'), CUSTOM, 'utf-8');
    return home;
}

describe('model-config 页面（主进程侧）', () => {
    it('交付 id / title / methods', () => {
        const page = createPage({ home: makeHome() });
        expect(page.id).toBe('model-config');
        expect(page.title).toBe('模型配置');
        expect(Object.keys(page.methods ?? {}).sort()).toEqual([
            'removeProvider',
            'saveAccount',
            'saveDefaultModel',
            'saveProvider',
            'snapshot',
        ]);
    });

    it('没有数据根 ⇒ 调用时抛（装配错误不静默）', () => {
        const page = createPage({});
        const saved = process.env['DIY_HOME'];
        delete process.env['DIY_HOME'];
        try {
            expect(() => page.methods!['snapshot']!(undefined)).toThrow(/数据根/);
        } finally {
            if (saved !== undefined) process.env['DIY_HOME'] = saved;
        }
    });

    it('snapshot：provider / 模型 / 账号都在，且**不含 key 明文**', async () => {
        const home = makeHome();
        const page = createPage({ home });
        const snapshot = (await page.methods!['snapshot']!(undefined)) as ConfigSnapshot;
        expect(snapshot.home).toBe(home);
        expect(snapshot.providers.map((item) => item.providerId).sort()).toEqual(['acme', 'goat']);
        expect(snapshot.models.map((item) => `${item.providerId}/${item.modelId}`)).toEqual(['goat/m1']);
        expect(snapshot.providers.find((item) => item.providerId === 'acme')?.accounts).toEqual([
            { name: 'one', configured: true, env: false, chars: 19 },
        ]);
        expect(JSON.stringify(snapshot)).not.toContain('sk-super-secret-777');
    });

    it('saveAccount：只回 { chars }；快照重读后状态是「已设置」，仍无原值', async () => {
        const home = makeHome();
        const page = createPage({ home });
        const result = (await page.methods!['saveAccount']!({
            providerId: 'acme',
            name: 'one',
            value: 'sk-rotated-123456',
        })) as WriteResult;
        expect(result.saved).toEqual({ providerId: 'acme', name: 'one', chars: 17 });
        expect(JSON.stringify(result)).not.toContain('sk-rotated-123456');
        expect(readFileSync(join(home, 'model.yaml'), 'utf-8')).toContain('sk-rotated-123456');
        expect(JSON.stringify(result.snapshot)).not.toContain('sk-rotated-123456');
    });

    it('saveProvider 改模型 name / 加 provider / removeProvider', async () => {
        const home = makeHome();
        const page = createPage({ home });
        const renamed = (await page.methods!['saveProvider']!({
            providerId: 'goat',
            models: { m1: { name: '改过' } },
        })) as ConfigSnapshot;
        expect(renamed.models.find((item) => item.modelId === 'm1')?.name).toBe('改过');

        const added = (await page.methods!['saveProvider']!({
            providerId: 'newco',
            spec: { api: 'https://new.example/v1', npm: '@ai-sdk/openai-compatible' },
        })) as ConfigSnapshot;
        expect(added.providers.find((item) => item.providerId === 'newco')?.kind).toBe('custom');

        const removed = (await page.methods!['removeProvider']!({ providerId: 'newco' })) as ConfigSnapshot;
        expect(removed.providers.some((item) => item.providerId === 'newco')).toBe(false);
    });

    it('saveDefaultModel 写回 model.yaml', async () => {
        const home = makeHome();
        const page = createPage({ home });
        const snapshot = (await page.methods!['saveDefaultModel']!({ modelKey: 'goat/m1' })) as ConfigSnapshot;
        expect(snapshot.defaultModel).toBe('goat/m1');
        expect(readFileSync(join(home, 'model.yaml'), 'utf-8')).toContain('defaultModel: goat/m1');
    });

    it('参数形状不对 ⇒ 抛（不猜）', () => {
        const page = createPage({ home: makeHome() });
        expect(() => page.methods!['saveAccount']!(null)).toThrow(/对象参数/);
        expect(() => page.methods!['saveAccount']!({ providerId: 'acme', name: 'x', value: 42 })).toThrow(/字符串/);
        expect(() => page.methods!['saveProvider']!({ providerId: 'x', kind: 'weird' })).toThrow(/std \/ custom/);
    });
});

describe('accountLabel（脱敏文案）', () => {
    it('未设置 / 已设置（N 字符）/ 环境变量', () => {
        expect(accountLabel({ name: 'a', configured: false, env: false })).toBe('未设置');
        expect(accountLabel({ name: 'a', configured: true, env: false, chars: 12 })).toBe('已设置（12 字符）');
        expect(accountLabel({ name: 'a', configured: true, env: true })).toBe('已设置（环境变量）');
    });
});
