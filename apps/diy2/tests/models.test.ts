// tests/models.test.ts —— `diy2.models.list`（RPC）：模型目录的**唯一出口**。
//
// 为什么这条命令值得一个真 socket 测试：界面不再自带 provider 表（那是第三份真源），
// 选模型器 / 上下文窗口 / 缺省模型全押在这条回包上。回包错 = 界面上要么没得选，
// 要么选到一条服务端发不出去的组合。
//
// 顺带锁一条硬边界：**回包里永远没有 key 值**（`model.yaml` 里是明文 key）。
// 浏览器侧已经没有任何 REST（只留 `/api/info` 探活），所以这里走 `/rpc` 的 WS。

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelClientBinding } from '@diy-agent/rpc';
import { WsTransport, connectWs } from '@diy-agent/rpc/ws/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiy2App, type Diy2App } from '../server/app';
import { resolveConfig } from '../server/config';

const moduleDir = join(import.meta.dirname, '..');

const MODEL_YAML = `defaultModel: main@acme/fast
customProviders:
  acme:
    accounts:
      - type: apiKey
        name: main
        data:
          value: sk-acme-SECRET-1234
      - type: apiKey
        name: spare
`;

const PROVIDERS_CUSTOM_YAML = `acme:
  id: acme
  npm: '@ai-sdk/openai-compatible'
  api: https://acme.example/v1
  models:
    fast:
      id: fast
      name: Acme Fast
      limit:
        context: 128000
        output: 4096
      cost:
        input: 1
        output: 2
`;

interface Catalog {
    providers: Array<{
        id: string;
        name: string;
        api: string;
        accounts: Array<{ name: string; configured: boolean }>;
        models: Array<Record<string, unknown>>;
    }>;
    defaultModelKey?: string;
    configured: boolean;
    modelConfigPath: string;
    snapshotMissing: boolean;
}

let home = '';
let app: Diy2App;
let server: Server;
let rpcUrl = '';
let binding: ChannelClientBinding;
let transport: WsTransport;
let previousModelConfig: string | undefined;

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'diy2-models-'));
    writeFileSync(join(home, 'model.yaml'), MODEL_YAML);
    writeFileSync(join(home, 'providers.custom.yaml'), PROVIDERS_CUSTOM_YAML);
    // 目录真源 = `model.yaml`（与生产同一档：server 装配时也是设这个变量）
    previousModelConfig = process.env['DIY_MODEL_CONFIG'];
    process.env['DIY_MODEL_CONFIG'] = join(home, 'model.yaml');
    app = await createDiy2App({
        config: await resolveConfig({ moduleDir, mode: 'development', overrides: { home } }),
        webDir: null,
    });
    server = createServer(app.handle);
    server.on('upgrade', (req, socket, head) => {
        app.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('没有端口');
    rpcUrl = `ws://127.0.0.1:${address.port}/rpc`;
    transport = new WsTransport(await connectWs(rpcUrl, { timeoutMs: 2_000 }));
    binding = new ChannelClientBinding(transport);
});

afterEach(async () => {
    transport.close();
    app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousModelConfig === undefined) delete process.env['DIY_MODEL_CONFIG'];
    else process.env['DIY_MODEL_CONFIG'] = previousModelConfig;
    rmSync(home, { recursive: true, force: true });
});

function list(): Promise<Catalog> {
    return binding.invoke<unknown, Catalog>('diy2.models.list', { input: {} });
}

describe('diy2.models.list', () => {
    it('按 provider 分组给出账号（含「填没填」）与模型（含上下文 / 上限 / 价目）', async () => {
        const catalog = await list();
        expect(catalog.providers).toHaveLength(1);
        const acme = catalog.providers[0]!;
        expect(acme.id).toBe('acme');
        expect(acme.api).toBe('https://acme.example/v1');
        expect(acme.accounts).toEqual([
            { name: 'main', configured: true },
            { name: 'spare', configured: false },
        ]);
        expect(acme.models).toEqual([
            { id: 'fast', name: 'Acme Fast', contextWindow: 128000, maxOutputTokens: 4096, cost: { input: 1, output: 2 } },
        ]);
    });

    it('defaultModelKey 来自 model.yaml（界面不再自己写死一个）', async () => {
        expect((await list()).defaultModelKey).toBe('main@acme/fast');
    });

    it('configured / snapshotMissing 是状态，不靠「目录恰好空着」去猜', async () => {
        const full = await list();
        expect(full.configured).toBe(true);
        expect(full.modelConfigPath).toBe(join(home, 'model.yaml'));
        // 测试数据根没有 data/models.dev.json：规格全来自 providers.custom.yaml
        expect(full.snapshotMissing).toBe(true);

        // 拿掉 model.yaml = 这个实例**没配模型**（不是「配了但没 key」）
        rmSync(join(home, 'model.yaml'));
        const empty = await list();
        expect(empty.configured).toBe(false);
        expect(empty.modelConfigPath).toBe(join(home, 'model.yaml'));
        expect(empty.defaultModelKey).toBeUndefined();
    });

    it('回包里没有 key 值（账号只有名字 + 布尔）', async () => {
        // 断言序列化后的整段回包：真 key 藏进哪个字段都能被发现
        expect(JSON.stringify(await list())).not.toContain('sk-acme');
    });
});

// ── 配置页（`diy2.models.config` + 写方法）────────────────────────────────────
//
// 为什么这些也走真 socket：配置页的每一次点击最终都是一条 RPC，而它要保证的三件事
// （换 key 不回显、写完回整页快照、缺快照要能报出来）全在协议边界上。
// 单测 catalog 只能保证「文件写对了」，保证不了「回包没把 key 带回来」。

interface ConfigSnapshot {
    home: string;
    modelConfigPath: string;
    snapshotMissing: boolean;
    defaultModelKey?: string;
    providers: Array<{
        id: string;
        name: string;
        kind: 'std' | 'custom';
        configured: boolean;
        api?: string;
        envKeys: string[];
        accounts: Array<{ name: string; configured: boolean; env: boolean; chars?: number }>;
        models: Array<{ id: string; enabled: boolean }>;
    }>;
}

function config(): Promise<ConfigSnapshot> {
    return binding.invoke<unknown, ConfigSnapshot>('diy2.models.config', { input: {} });
}

function save<T>(method: string, input: Record<string, unknown>): Promise<T> {
    return binding.invoke<unknown, T>(`diy2.models.${method}`, { input });
}

describe('diy2.models.config', () => {
    it('给出整页快照：写在哪、缺不缺快照、目录里每家（含还没接的）与模型开关', async () => {
        const snapshot = await config();
        expect(snapshot.home).toBe(home);
        expect(snapshot.modelConfigPath).toBe(join(home, 'model.yaml'));
        expect(snapshot.snapshotMissing).toBe(true);
        expect(snapshot.defaultModelKey).toBe('main@acme/fast');
        const acme = snapshot.providers.find((provider) => provider.id === 'acme')!;
        expect(acme.kind).toBe('custom');
        expect(acme.configured).toBe(true);
        expect(acme.api).toBe('https://acme.example/v1');
        expect(acme.models).toEqual([{ id: 'fast', enabled: true, name: 'Acme Fast', contextWindow: 128000, maxOutputTokens: 4096, cost: { input: 1, output: 2 } }]);
        expect(JSON.stringify(snapshot)).not.toContain('sk-acme');
    });

    it('saveAccount 加新号：回包只有 chars（key 原值不回来），账号立刻出现在快照里', async () => {
        const next = await save<{ config: ConfigSnapshot; saved: { chars: number } }>('saveAccount', {
            providerId: 'acme',
            name: 'third',
            value: 'sk-acme-third-999',
        });
        expect(next.saved.chars).toBe('sk-acme-third-999'.length);
        expect(JSON.stringify(next)).not.toContain('sk-acme-third-999');
        const acme = next.config.providers.find((provider) => provider.id === 'acme')!;
        expect(acme.accounts.map((account) => account.name)).toEqual(['main', 'spare', 'third']);
    });

    it('换钥只改长度、改名不动 key、删除连 key 一起没', async () => {
        // saveAccount 的回包是 `{ config, saved }`（只有这一个写方法多一层：它要回 chars）
        const rotated = (
            await save<{ config: ConfigSnapshot }>('saveAccount', {
                providerId: 'acme',
                name: 'main',
                value: 'sk-acme-rotated',
            })
        ).config;
        expect(rotated.providers.find((p) => p.id === 'acme')!.accounts[0]).toEqual({
            name: 'main',
            configured: true,
            env: false,
            chars: 'sk-acme-rotated'.length,
        });

        const renamed = await save<ConfigSnapshot>('renameAccount', { providerId: 'acme', from: 'main', to: 'primary' });
        expect(renamed.providers.find((p) => p.id === 'acme')!.accounts.map((a) => a.name)).toEqual(['primary', 'spare']);

        const removed = await save<ConfigSnapshot>('removeAccount', { providerId: 'acme', name: 'primary' });
        expect(removed.providers.find((p) => p.id === 'acme')!.accounts.map((a) => a.name)).toEqual(['spare']);
    });

    it('filter 开关：勾掉的模型仍列出来（enabled: false），目录里则消失', async () => {
        // 先加一个模型，才有「两个模型、勾掉一个」可言
        await save<ConfigSnapshot>('saveProvider', {
            providerId: 'acme',
            models: { slow: { name: 'Acme Slow', contextWindow: 8000 } },
        });
        const off = await save<ConfigSnapshot>('saveProvider', {
            providerId: 'acme',
            filter: { include: null, exclude: ['slow'] },
        });
        const acme = off.providers.find((provider) => provider.id === 'acme')!;
        expect(acme.models.map((model) => [model.id, model.enabled])).toEqual([
            ['fast', true],
            ['slow', false],
        ]);
        // 选模型器看的那份（models.list）里没有 slow
        const catalog = await list();
        expect(catalog.providers[0]!.models.map((model) => model.id)).toEqual(['fast']);
    });

    it('saveDefaultModel 能设能清（null = 回到「没设」，不猜一个）', async () => {
        expect((await save<ConfigSnapshot>('saveDefaultModel', { modelKey: 'spare@acme/fast' })).defaultModelKey).toBe(
            'spare@acme/fast',
        );
        expect((await save<ConfigSnapshot>('saveDefaultModel', { modelKey: null })).defaultModelKey).toBeUndefined();
    });

    it('removeProvider 对这家的配置与自定义 spec 一起删（自定义服务商是「彻底移除」）', async () => {
        const next = await save<ConfigSnapshot>('removeProvider', { providerId: 'acme' });
        // acme 的规格在 providers.custom.yaml、配置在 model.yaml，两边都删 ⇒ 连候选都不剩。
        // 这是有意的：自定义家的 spec 只属于它自己，留着一段没有配置的空规格反而在左栏挂着。
        expect(next.providers.find((provider) => provider.id === 'acme')).toBeUndefined();
        expect((await list()).providers).toHaveLength(0);
    });

    it('服务端的错原样传到调用方（配错 / 未知 provider 都不静默）', async () => {
        await expect(save('removeAccount', { providerId: 'acme', name: 'nobody' })).rejects.toThrow(/没有账号/);
        await expect(save('saveAccount', { providerId: 'nope', name: 'x', value: 'y' })).rejects.toThrow(/没有 provider/);
    });
});
