// registry.test.ts — ##495 的判据 1/2/3/4/6：
//   · 两个 web 实例 ⇒ /ping 的 address 各带自己的端口；一个实例 ⇒ 不带端口
//   · 启动写 `~/.diy-instances/<pid>.json`（含 app / address），退出删除
//   · 残留 / 假条目由 local 发现器的 /ping 探活过滤（进程活着但端口已关 = 不算数）
//
// 注册表目录由 tests/setup.ts 指到临时目录（绝不碰真实家目录）。
//
// ⚠️ 判据 1 必须**真起两个进程**：注册表按 pid 一条，同进程里起两个 server 会互相覆盖。
// 子进程用 `node --import tsx` 直接跑 server.ts（不依赖 build 产物），退出走 SIGTERM → close()。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { localDiscoverer } from '@diy-agent/remote/node';
import { recordFile, registryDir } from '../registry.js';
import { startWebServer, type WebServerHandle } from '../server.js';
import { makeHome, makeStaticDir } from './helpers.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SERVER_URL = new URL('../server.ts', import.meta.url).href;

const handles: WebServerHandle[] = [];
const children: ChildServer[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) await child.stop();
    for (const handle of handles.splice(0)) await handle.close();
});

async function start(): Promise<WebServerHandle> {
    const handle = await startWebServer({
        port: 0,
        host: '127.0.0.1',
        home: makeHome(),
        staticDir: makeStaticDir(),
        variant: 'test',
    });
    handles.push(handle);
    return handle;
}

async function pingOf(url: string): Promise<{ address: string }> {
    const response = await fetch(`${url}/ping`);
    expect(response.status).toBe(200);
    return (await response.json()) as { address: string };
}

interface ChildServer {
    readonly port: number;
    stop(): Promise<void>;
}

/** 真起一个 web 经历（独立 pid，注册表里才是两条） */
async function startProcess(): Promise<ChildServer> {
    const dir = mkdtempSync(join(tmpdir(), 'app-web-child-'));
    const script = join(dir, 'child.mjs');
    writeFileSync(
        script,
        [
            `import { startWebServer } from ${JSON.stringify(SERVER_URL)};`,
            `const handle = await startWebServer({`,
            `    port: 0, host: '127.0.0.1', home: process.env['WEB_HOME'],`,
            `    staticDir: process.env['WEB_STATIC'], variant: 'test',`,
            `});`,
            `process.stdout.write(JSON.stringify({ port: handle.port }) + '\\n');`,
            `const stop = async () => { await handle.close(); process.exit(0); };`,
            `process.on('SIGTERM', () => void stop());`,
            `process.on('SIGINT', () => void stop());`,
        ].join('\n'),
        'utf-8',
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: APP_DIR,
        env: { ...process.env, WEB_HOME: makeHome(), WEB_STATIC: makeStaticDir() },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await new Promise<number>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`子进程未就绪：${output}`)), 30_000);
        child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            for (const line of output.split('\n')) {
                if (!line.startsWith('{')) continue;
                clearTimeout(timer);
                resolve((JSON.parse(line) as { port: number }).port);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`子进程退出 ${String(code)}：${output}`));
        });
    });
    return {
        port,
        stop: () =>
            new Promise<void>((resolve) => {
                if (child.exitCode !== null) return resolve();
                child.once('exit', () => resolve());
                child.kill('SIGTERM');
            }),
    };
}

describe('apps/web 实例自报（##495）', () => {
    it('只起一个 ⇒ 地址不带端口；注册表里有一条可用的自报', async () => {
        const handle = await start();
        const ping = await pingOf(handle.url);
        expect(ping.address).toMatch(/^.+@.+\/diy-web\.test$/);
        expect(ping.address).not.toMatch(/:\d+$/);

        const file = recordFile(registryDir(), process.pid);
        expect(existsSync(file)).toBe(true);
        const record = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
        expect(record['app']).toBe('diy-web');
        expect(record['variant']).toBe('test');
        expect(record['port']).toBe(handle.port);
        expect(record['pingPort']).toBe(handle.port);
        expect(record['address']).toBe(ping.address);
        expect(typeof record['diyHome']).toBe('string');
        expect(Array.isArray(record['parents'])).toBe(true);
    });

    it('同格两个实例 ⇒ 两个地址各自带端口；关掉一个 ⇒ 回到不带端口', async () => {
        const first = await startProcess();
        children.push(first);
        const second = await startProcess();
        children.push(second);

        const firstPing = await pingOf(`http://127.0.0.1:${first.port}`);
        const secondPing = await pingOf(`http://127.0.0.1:${second.port}`);
        expect(firstPing.address.endsWith(`:${first.port}`)).toBe(true);
        expect(secondPing.address.endsWith(`:${second.port}`)).toBe(true);
        // 同格 = 除端口外完全一致
        expect(firstPing.address.replace(/:\d+$/, '')).toBe(secondPing.address.replace(/:\d+$/, ''));

        await second.stop();
        children.splice(children.indexOf(second), 1);

        const after = await pingOf(`http://127.0.0.1:${first.port}`);
        expect(after.address).not.toMatch(/:\d+$/);
    });

    it('退出删除自己那一条（close 后记录消失）', async () => {
        const handle = await start();
        const file = recordFile(registryDir(), process.pid);
        expect(existsSync(file)).toBe(true);
        await handle.close();
        handles.splice(handles.indexOf(handle), 1);
        expect(existsSync(file)).toBe(false);
    });

    it('进程活着但端口已关的残留条目被 local 发现器过滤掉', async () => {
        // 一条指向「没人监听」的端口、pid 却是真进程的记录：探活失败 ⇒ 不算实例
        const dir = registryDir();
        writeFileSync(
            recordFile(dir, process.pid),
            JSON.stringify({
                pid: process.pid,
                port: 1,
                pingPort: 1,
                diyHome: '/tmp/nope',
                variant: 'test',
                env: 'test',
                argv: [],
                cwd: '',
                startedAt: '',
                updatedAt: '',
                parents: [],
                app: 'diy-web',
            }),
            'utf-8',
        );
        const found = await localDiscoverer({ dir }).discover();
        expect(found).toEqual([]);
    });

    it('地址全部由 formatAddress 拼（apps/web 里没有自研 displayAddress）', async () => {
        await start();
        const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf-8');
        expect(source).not.toMatch(/function displayAddress/);
        // 注册表目录被 setup 指到临时目录（没有往真实家目录泄漏）
        expect(registryDir().startsWith(tmpdir())).toBe(true);
        expect(readdirSync(registryDir()).some((name) => name.endsWith('.json'))).toBe(true);
    });
});
