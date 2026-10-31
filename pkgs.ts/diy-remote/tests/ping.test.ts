// /ping 服务端 + 客户端（真起一个 loopback 端口，不 mock http）。
import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { parsePingInfo, fetchPing } from '../src/node/ping-client.js';
import { bindHint, startPingServer, type PingServerHandle } from '../src/node/ping-server.js';

const handles: PingServerHandle[] = [];
afterEach(async () => {
    while (handles.length > 0) await handles.pop()!.close();
});

async function start(port = 0, fallbackPorts?: number): Promise<PingServerHandle> {
    const h = await startPingServer({
        identity: { id: 'diy-abcdef12', displayName: 'c-mac 的 lab' },
        variant: 'lab',
        version: '0.1.0',
        host: '127.0.0.1',
        port,
        ...(fallbackPorts === undefined ? {} : { fallbackPorts }),
        startedAt: new Date(Date.now() - 5000),
    });
    handles.push(h);
    return h;
}

describe('startPingServer / fetchPing', () => {
    it('GET /ping 返回契约字段，客户端读得回', async () => {
        const h = await start();
        const r = await fetchPing(h.baseUrl, 1000);
        expect(r.ok).toBe(true);
        expect(r.info?.id).toBe('diy-abcdef12');
        expect(r.info?.displayName).toBe('c-mac 的 lab');
        expect(r.info?.variant).toBe('lab');
        expect(r.info?.pid).toBe(process.pid);
        expect(r.info?.uptimeMs).toBeGreaterThanOrEqual(5000);
    });

    it('其它路径 404；非 GET/HEAD 405', async () => {
        const h = await start();
        expect(await statusOf(`http://127.0.0.1:${h.port}/nope`, 'GET')).toBe(404);
        expect(await statusOf(`http://127.0.0.1:${h.port}/ping`, 'POST')).toBe(405);
    });

    it('端口被占时顺延（同机多实例各占一个）', async () => {
        const first = await start();
        const second = await start(first.port, 5);
        expect(second.port).not.toBe(first.port);
        expect(second.port).toBeGreaterThan(first.port);
        expect((await fetchPing(second.baseUrl, 1000)).info?.id).toBe('diy-abcdef12');
    });

    it('连不上时返回失败对象而不是抛', async () => {
        const h = await start();
        const dead = h.port; // 关掉后再打
        await h.close();
        handles.pop();
        const r = await fetchPing(`http://127.0.0.1:${dead}`, 300);
        expect(r.ok).toBe(false);
        expect(r.info).toBeNull();
        expect(r.error).not.toBeNull();
    });
});

describe('parsePingInfo', () => {
    it('字段齐全才认（防止把别人的 200 当 /ping）', () => {
        const good = {
            id: 'diy-1',
            displayName: 'x',
            variant: 'lab',
            version: '0.1.0',
            pid: 1,
            startedAt: '2026-10-31T00:00:00.000Z',
            uptimeMs: 1,
        };
        expect(parsePingInfo(good)).toEqual(good);
        expect(parsePingInfo({ ...good, pid: '1' })).toBeNull();
        expect(parsePingInfo({ ...good, id: '' })).toBeNull();
        expect(parsePingInfo(null)).toBeNull();
        expect(parsePingInfo('<html>')).toBeNull();
    });
});

describe('bindHint', () => {
    it('回环不提醒；非回环提醒「无鉴权」', () => {
        expect(bindHint('127.0.0.1')).toBeNull();
        expect(bindHint('::1')).toBeNull();
        expect(bindHint('0.0.0.0')).toContain('无鉴权');
        expect(bindHint('100.64.0.2')).toContain('公网');
    });
});

function statusOf(url: string, method: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = request(url, { method }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
    });
}
