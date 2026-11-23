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
    app = createDiy2App({
        config: resolveConfig({ moduleDir, mode: 'development', overrides: { home } }),
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

    it('回包里没有 key 值（账号只有名字 + 布尔）', async () => {
        // 断言序列化后的整段回包：真 key 藏进哪个字段都能被发现
        expect(JSON.stringify(await list())).not.toContain('sk-acme');
    });
});
