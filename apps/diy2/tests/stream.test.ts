// 服务端「一条连接多话题」的契约（##stream-mux）。
//
// 这里锁的是 diy2 通讯保障的硬指标：**连接数与打开多少个房间无关**。
// 老实现是「一个房间一条常驻 SSE」，浏览器同源 HTTP/1.1 6 条的上限下，多页工作台 3 页就打满，
// 之后连 /history、点「停止」的 POST 都永久排队（不是慢，是不返回）。

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createStreamHub, CONN_TOPIC, type StreamHub } from '../server/stream';

interface Harness {
    hub: StreamHub;
    url: string;
    server: Server;
    /** 每个话题被接上 / 摘掉数据源的次数（验证「没人听就不占广播」） */
    attached: string[];
    detached: string[];
}

const servers: Server[] = [];
const hubs: StreamHub[] = [];

afterEach(async () => {
    for (const hub of hubs.splice(0)) hub.close();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

async function harness(): Promise<Harness> {
    const attached: string[] = [];
    const detached: string[] = [];
    const hub = createStreamHub({
        onFirstSubscriber(topic, push) {
            attached.push(topic);
            void push({ hello: topic });
            return () => detached.push(topic);
        },
    });
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/stream') {
            hub.handle(req, res);
            return;
        }
        if (url.pathname === '/subscribe' || url.pathname === '/unsubscribe') {
            void (async () => {
                let raw = '';
                for await (const chunk of req) raw += String(chunk);
                const { conn, topic } = JSON.parse(raw) as { conn: string; topic: string };
                const subscribing = url.pathname === '/subscribe';
                const hit = subscribing ? hub.subscribe(conn, topic) : (hub.unsubscribe(conn, topic), true);
                res.writeHead(hit ? 200 : 404, { 'content-type': 'application/json' });
                res.end('{}');
            })();
            return;
        }
        res.writeHead(404).end();
    });
    servers.push(server);
    hubs.push(hub);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('没有端口');
    return { hub, url: `http://127.0.0.1:${address.port}`, server, attached, detached };
}

/** 一条 SSE 客户端：把帧攒成数组，按需等下一帧 */
async function openStream(url: string) {
    const res = await fetch(`${url}/stream`, { headers: { accept: 'text/event-stream' } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const frames: { topic: string; event: Record<string, unknown> }[] = [];
    let buffer = '';

    const pump = async (): Promise<void> => {
        for (;;) {
            const index = buffer.indexOf('\n\n');
            if (index < 0) return;
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line !== undefined) frames.push(JSON.parse(line.slice(6)));
        }
    };

    const next = async (): Promise<(typeof frames)[number]> => {
        for (;;) {
            await pump();
            const frame = frames.shift();
            if (frame !== undefined) return frame;
            const { done, value } = await reader.read();
            if (done) throw new Error('流断了');
            buffer += decoder.decode(value, { stream: true });
        }
    };

    const close = () => reader.cancel();
    return { next, close };
}

describe('createStreamHub', () => {
    it('首帧就交身份（客户端不许自造连接 id）', async () => {
        const h = await harness();
        const stream = await openStream(h.url);
        const first = await stream.next();
        expect(first.topic).toBe(CONN_TOPIC);
        expect(typeof first.event.conn).toBe('string');
        stream.close();
    });

    it('一条连接订两个话题，事件各归各的', async () => {
        const h = await harness();
        const stream = await openStream(h.url);
        const conn = String((await stream.next()).event.conn);

        for (const topic of ['room:a', 'room:b']) {
            const res = await fetch(`${h.url}/subscribe`, {
                method: 'POST',
                body: JSON.stringify({ conn, topic }),
            });
            expect(res.status).toBe(200);
        }

        // 订阅时接上数据源会立刻给一帧（diy2 里用来贴快照）
        expect(await stream.next()).toEqual({ topic: 'room:a', event: { hello: 'room:a' } });
        expect(await stream.next()).toEqual({ topic: 'room:b', event: { hello: 'room:b' } });

        // 连接数就是 1 —— 这就是「开多少页都不涨连接」的硬指标
        expect(h.hub.size).toBe(1);
        stream.close();
    });

    it('没人听的话题不占广播：最后一个订阅者走了就摘数据源', async () => {
        const h = await harness();
        const stream = await openStream(h.url);
        const conn = String((await stream.next()).event.conn);

        await fetch(`${h.url}/subscribe`, { method: 'POST', body: JSON.stringify({ conn, topic: 'room:a' }) });
        await stream.next();
        expect(h.attached).toEqual(['room:a']);

        await fetch(`${h.url}/unsubscribe`, { method: 'POST', body: JSON.stringify({ conn, topic: 'room:a' }) });
        expect(h.detached).toEqual(['room:a']);
        stream.close();
    });

    it('连接不存在时订阅返回 404（客户端据此等重连，别重试）', async () => {
        const h = await harness();
        const res = await fetch(`${h.url}/subscribe`, {
            method: 'POST',
            body: JSON.stringify({ conn: 'c999', topic: 'room:a' }),
        });
        expect(res.status).toBe(404);
    });

    it('断开连接会连同它的订阅一起退掉（不留空话题）', async () => {
        const h = await harness();
        const stream = await openStream(h.url);
        const conn = String((await stream.next()).event.conn);
        await fetch(`${h.url}/subscribe`, { method: 'POST', body: JSON.stringify({ conn, topic: 'room:a' }) });
        await stream.next();

        stream.close();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(h.hub.size).toBe(0);
        expect(h.detached).toEqual(['room:a']);
    });
});
