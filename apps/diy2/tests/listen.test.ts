// tests/listen.test.ts —— 端口粘性的落地行为（真 socket，不 mock）。
//
// 这里验的三件事就是需求本身：
//   1. `app.port` 记着的端口还在空着 → 下次就用它（不用真起两个进程：记录 + 监听即可）；
//   2. 那个端口被别人占了 → 换一个空闲端口，并**重写**记录（下次粘在新的上）；
//   3. 显式点名的端口（`--port`）被占 → **不漂**，原样报错。

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readPortFile, resolveConfig, writePortFile, type Diy2Config } from '../server/config';
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

function configOf(home: string, extra: { port?: number; launch?: string } = {}): Promise<Diy2Config> {
    return resolveConfig({ moduleDir, mode: 'development', overrides: { home, ...extra } });
}

describe('listenWithStickyPort', () => {
    it('记录还空着 → 下次就用它（关掉 server 也不删记录）', async () => {
        const home = tmp();
        const config = await configOf(home);
        const server = createServer();
        servers.push(server);

        const first = await listenWithStickyPort(config, server);
        expect(first.driftedFrom).toBeNull();
        expect(first.port).toBeGreaterThan(0);
        expect(await readPortFile(config.portFile)).toBe(first.port);
        // 退出（close）不动记录：它不是活体登记，删了下次就换成内核随机端口
        await new Promise<void>((resolve) => server.close(() => resolve()));
        servers.splice(servers.indexOf(server), 1);
        expect(await readPortFile(config.portFile)).toBe(first.port);

        const next = await configOf(home);
        expect(next.port).toBe(first.port);
        expect(next.portSource).toBe('recorded');
    });

    it('记录的端口被占用 → 换一个空闲端口，并重写记录', async () => {
        const home = tmp();
        const taken = await occupy();
        await writePortFile(join(home, 'app.port'), taken);

        const config = await configOf(home);
        expect(config.port).toBe(taken);
        expect(config.portSource).toBe('recorded');

        const server = createServer();
        servers.push(server);
        const result = await listenWithStickyPort(config, server);

        expect(result.driftedFrom).toBe(taken);
        expect(result.port).not.toBe(taken);
        expect(await readPortFile(config.portFile)).toBe(result.port);
        // 再下一次启动就粘在新端口上
        expect((await configOf(home)).port).toBe(result.port);
    });

    it('显式给的端口（--port）被占 → 不漂，原样抛 EADDRINUSE', async () => {
        const home = tmp();
        const taken = await occupy();
        const config = await configOf(home, { port: taken });
        expect(config.portSource).toBe('cli');

        const server = createServer();
        servers.push(server);
        await expect(listenWithStickyPort(config, server)).rejects.toMatchObject({ code: 'EADDRINUSE' });
        // 启动失败不写记录：记录只记「监听成功过的端口」，失败没有东西可记
        expect(await readPortFile(config.portFile)).toBeNull();
    });
});
