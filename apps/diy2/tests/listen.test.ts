// tests/listen.test.ts —— 端口粘性的落地行为（真 socket，不 mock）。
//
// 这里验的三件事就是需求本身：
//   1. `port.sticky` 记着的端口还在空着 → 下次就用它（不用真起两个进程：记录 + 监听即可）；
//   2. 那个端口被别人占了 → 换一个空闲端口，并**重写**记录（下次粘在新的上）；
//   3. 显式点名的端口（`DIY2_PORT` / `--port`）被占 → **不漂**，原样报错。

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readPortFile, resolveConfig, writeStickyPort, type Diy2Config } from '../server/config';
import { listenWithStickyPort } from '../server/listen';

const moduleDir = join(import.meta.dirname, '..');
const dirs: string[] = [];
const servers: Server[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy2-listen-'));
    dirs.push(dir);
    return dir;
}

/** 占一个端口（模拟「上次的端口现在被别人用了」） */
async function occupy(): Promise<number> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('拿不到端口');
    return address.port;
}

function closeAll(): void {
    for (const server of servers.splice(0)) server.close();
}

afterEach(() => {
    closeAll();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configOf(home: string, extra: Record<string, string> = {}): Diy2Config {
    return resolveConfig({ moduleDir, env: { DIY2_ENV: 'development', DIY2_HOME: home, ...extra } });
}

describe('listenWithStickyPort', () => {
    it('粘性端口还空着 → 用它，并同时落 app.port 与 port.sticky', async () => {
        const home = tmp();
        const config = configOf(home);
        const server = createServer();
        servers.push(server);

        const first = await listenWithStickyPort(config, server);
        expect(first.driftedFrom).toBeNull();
        expect(first.port).toBeGreaterThan(0);
        expect(readPortFile(config.portFile)).toBe(first.port);
        expect(readPortFile(config.stickyPortFile)).toBe(first.port);
        server.close();

        // 「下次启动」：只剩粘性记录（app.port 是活体登记，优雅退出会删）
        rmSync(config.portFile, { force: true });
        const next = configOf(home);
        expect(next.port).toBe(first.port);
        expect(next.portSource).toBe('sticky');
    });

    it('粘性端口被占用 → 换一个空闲端口，并重写**两份**记录', async () => {
        const home = tmp();
        const taken = await occupy();
        writeStickyPort(join(home, 'port.sticky'), taken);

        const config = configOf(home);
        expect(config.port).toBe(taken);
        expect(config.portSource).toBe('sticky');

        const server = createServer();
        servers.push(server);
        const result = await listenWithStickyPort(config, server);

        expect(result.driftedFrom).toBe(taken);
        expect(result.port).not.toBe(taken);
        expect(readPortFile(config.portFile)).toBe(result.port);
        expect(readPortFile(config.stickyPortFile)).toBe(result.port);
        // 再下一次启动就粘在新端口上
        expect(configOf(home).port).toBe(result.port);
    });

    it('显式给的端口（DIY2_PORT）被占 → 不漂，原样抛 EADDRINUSE', async () => {
        const home = tmp();
        const taken = await occupy();
        const config = configOf(home, { DIY2_PORT: String(taken) });
        expect(config.portSource).toBe('env');

        const server = createServer();
        servers.push(server);
        await expect(listenWithStickyPort(config, server)).rejects.toMatchObject({ code: 'EADDRINUSE' });
        // 失败不该留下「看起来在跑」的活体登记
        expect(readPortFile(config.portFile)).toBeNull();
    });
});
