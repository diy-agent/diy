import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
    CatalogError,
    listAccountStates,
    listProviders,
    loadCatalog,
    readAccountValue,
    readDefaultModel,
    removeProvider,
    saveAccount,
    saveDefaultModel,
    saveProvider,
} from '../src/index.js';

function makeHome(files: { model?: string; custom?: string } = {}): string {
    const home = mkdtempSync(join(tmpdir(), 'model-catalog-write-'));
    if (files.model !== undefined) writeFileSync(join(home, 'model.yaml'), files.model, 'utf-8');
    if (files.custom !== undefined) writeFileSync(join(home, 'providers.custom.yaml'), files.custom, 'utf-8');
    return home;
}

const MODEL = `stdProviders:
  acme:
    accounts:
      - type: apiKey
        name: one
        data:
          value: sk-literal-123456
    filter:
      include: []
      exclude: []
customProviders:
  goat:
    accounts:
      - type: apiKey
        data:
          value: ''
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
`;

describe('saveProvider', () => {
    it('custom provider：spec 进 providers.custom.yaml，模型覆盖进 model.yaml', () => {
        const home = makeHome({ model: MODEL });
        saveProvider(home, {
            providerId: 'newco',
            spec: { api: 'https://new.example/v1', npm: '@ai-sdk/openai-compatible' },
        });
        const custom = loadYaml(readFileSync(join(home, 'providers.custom.yaml'), 'utf-8')) as Record<string, any>;
        expect(custom['newco']).toMatchObject({
            id: 'newco',
            api: 'https://new.example/v1',
            npm: '@ai-sdk/openai-compatible',
        });
        const summary = listProviders(home).find((item) => item.providerId === 'newco');
        expect(summary).toMatchObject({ kind: 'custom', api: 'https://new.example/v1', modelCount: 0 });
    });

    it('改模型 name：目录立刻读到新值（model.yaml 覆盖优先于 spec）', () => {
        const home = makeHome({ model: MODEL, custom: CUSTOM });
        expect(loadCatalog(home).find((entry) => entry.modelId === 'm1')?.name).toBe('Goat One');
        saveProvider(home, { providerId: 'goat', models: { m1: { name: '改过的名字' } } });
        expect(loadCatalog(home).find((entry) => entry.modelId === 'm1')?.name).toBe('改过的名字');
    });

    it('模型覆盖合并：只改 contextWindow 不丢已写的 name / cost', () => {
        const home = makeHome({ model: MODEL, custom: CUSTOM });
        saveProvider(home, { providerId: 'goat', models: { m1: { name: 'N', cost: { input: 1, output: 2 } } } });
        saveProvider(home, { providerId: 'goat', models: { m1: { contextWindow: 4096 } } });
        const entry = loadCatalog(home).find((item) => item.modelId === 'm1')!;
        expect(entry).toMatchObject({ name: 'N', contextWindow: 4096, cost: { input: 1, output: 2 } });
    });

    it('std provider 带 spec ⇒ 拒绝（spec 只对 custom 有意义）', () => {
        const home = makeHome({ model: MODEL });
        expect(() => saveProvider(home, { providerId: 'acme', spec: { api: 'https://x' } })).toThrow(CatalogError);
    });

    it('空 provider id ⇒ 抛', () => {
        expect(() => saveProvider(makeHome(), { providerId: '  ' })).toThrow(/provider id/);
    });
});

describe('saveAccount', () => {
    it('写入 key、只回 { chars } —— 返回值里没有原值', () => {
        const home = makeHome({ model: MODEL });
        const saved = saveAccount(home, { providerId: 'acme', name: 'two', value: 'sk-second-999' });
        expect(saved).toEqual({ providerId: 'acme', name: 'two', chars: 13 });
        expect(JSON.stringify(saved)).not.toContain('sk-second-999');
        // 文件里确实写进去了，且能按名字取回
        expect(readAccountValue(home, 'acme', 'two')).toBe('sk-second-999');
        // 原有账号不受影响
        expect(readAccountValue(home, 'acme', 'one')).toBe('sk-literal-123456');
    });

    it('同名账号 = 覆盖值，不新增一条', () => {
        const home = makeHome({ model: MODEL });
        saveAccount(home, { providerId: 'acme', name: 'one', value: 'sk-rotated' });
        const doc = loadYaml(readFileSync(join(home, 'model.yaml'), 'utf-8')) as any;
        expect(doc.stdProviders.acme.accounts).toHaveLength(1);
        expect(readAccountValue(home, 'acme', 'one')).toBe('sk-rotated');
    });

    it('未命名的账号按序号匹配（openCode 那种 `- type: apiKey` 写法）', () => {
        const home = makeHome({ model: MODEL });
        saveAccount(home, { providerId: 'acme', name: '0', value: 'sk-renamed-slot' });
        expect(readAccountValue(home, 'acme', '0')).toBe('sk-renamed-slot');
    });

    it('账号状态只给长度 / 已填，不给值；`$VAR` 不给长度', () => {
        const home = makeHome({
            model: `stdProviders:
  acme:
    accounts:
      - type: apiKey
        name: env-one
        data:
          value: \${ACME_KEY}
      - type: apiKey
        name: plain
        data:
          value: sk-abcdef
      - type: apiKey
        name: empty
        data:
          value: ''
`,
        });
        const states = listAccountStates(home)[0]!.accounts;
        expect(states).toEqual([
            { name: 'env-one', configured: true, env: true },
            { name: 'plain', configured: true, env: false, chars: 9 },
            { name: 'empty', configured: false, env: false },
        ]);
        expect(JSON.stringify(states)).not.toContain('sk-abcdef');
    });

    it('空 key / 空名字 ⇒ 抛（不会静默写进去）', () => {
        const home = makeHome({ model: MODEL });
        expect(() => saveAccount(home, { providerId: 'acme', name: 'x', value: '  ' })).toThrow(/key 不能为空/);
        expect(() => saveAccount(home, { providerId: 'acme', name: ' ', value: 'v' })).toThrow(/账号名/);
        expect(() => saveAccount(home, { providerId: 'nope', name: 'x', value: 'v' })).toThrow(/没有 provider/);
    });
});

describe('removeProvider', () => {
    it('model.yaml 与 providers.custom.yaml 一起删掉', () => {
        const home = makeHome({ model: MODEL, custom: CUSTOM });
        removeProvider(home, 'goat');
        expect(listProviders(home).map((item) => item.providerId)).toEqual(['acme']);
        const custom = loadYaml(readFileSync(join(home, 'providers.custom.yaml'), 'utf-8')) as Record<string, unknown>;
        expect(custom['goat']).toBeUndefined();
    });
});

describe('默认模型 / 原子写', () => {
    it('读写默认模型（provider/model）', () => {
        const home = makeHome({ model: MODEL });
        expect(readDefaultModel(home)).toBeNull();
        saveDefaultModel(home, 'acme/small-1');
        expect(readDefaultModel(home)).toBe('acme/small-1');
        saveDefaultModel(home, null);
        expect(readDefaultModel(home)).toBeNull();
        expect(() => saveDefaultModel(home, 'no-slash')).toThrow(/provider\/model/);
    });

    it('写入不留 tmp 残留；原有其它字段不丢', () => {
        const home = makeHome({ model: MODEL });
        saveDefaultModel(home, 'acme/x');
        saveAccount(home, { providerId: 'acme', name: 'one', value: 'sk-next' });
        expect(readdirSync(home).filter((name) => name.includes('.tmp-'))).toEqual([]);
        const doc = loadYaml(readFileSync(join(home, 'model.yaml'), 'utf-8')) as any;
        expect(doc.stdProviders.acme.filter).toEqual({ include: [], exclude: [] });
        expect(doc.customProviders.goat.accounts).toHaveLength(1);
    });

    it('目标文件不存在也能写（父目录自动建）', () => {
        const home = join(mkdtempSync(join(tmpdir(), 'model-catalog-write-')), 'nested');
        saveProvider(home, { providerId: 'solo', spec: { api: 'https://solo.example/v1' } });
        expect(existsSync(join(home, 'model.yaml'))).toBe(true);
        expect(statSync(join(home, 'model.yaml')).isFile()).toBe(true);
    });
});
