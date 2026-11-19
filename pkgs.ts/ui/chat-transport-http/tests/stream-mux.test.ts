// 连接纪律（##stream-mux）：**一个 client 一条 SSE**，房间是它上面的话题。
//
// 为什么锁死这一条：浏览器同源 HTTP/1.1 只有 6 条并发连接且**按 profile 共用**，6 条常驻
// SSE 占满后同 profile 下所有请求永久排队（连 /history、点「停止」的 POST 都不返回）。
// 以前的实现是「每个房间一条常驻流 + 每次发送再挂一条」，多页工作台 3 页就吃满。

import { describe, expect, it } from 'vitest';

import { HttpChatClient } from '../src/index';

/** 假后端：一条可控的 SSE + 记录所有请求 */
function fakeBackend() {
    const encoder = new TextEncoder();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const gets: string[] = [];
    const posts: { path: string; body: Record<string, unknown> }[] = [];

    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
            posts.push({ path: url, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
            return new Response('{"ok":true}', { status: 200 });
        }
        gets.push(url);
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                streams.push(controller);
            },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    /** 往第 n 条连接写一帧 */
    const send = (topic: string, event: unknown, streamIndex = streams.length - 1): void => {
        streams[streamIndex]?.enqueue(encoder.encode(`data: ${JSON.stringify({ topic, event })}\n\n`));
    };
    /** 服务端掐断第 n 条连接 */
    const kill = (streamIndex = streams.length - 1): void => {
        streams[streamIndex]?.close();
    };

    return { impl, send, kill, gets, posts };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const subscribed = (posts: { path: string; body: Record<string, unknown> }[]) =>
    posts.filter((p) => p.path.endsWith('/stream/subscribe')).map((p) => p.body.topic);

describe('HttpChatClient / 一条连接多话题', () => {
    it('看多个房间也只开一条 SSE', async () => {
        const { impl, gets, send, posts } = fakeBackend();
        const client = new HttpChatClient({ fetchImpl: impl });

        client.watch('proj:a', () => undefined);
        client.watch('proj:b', () => undefined);
        await flush();
        send('$conn', { conn: 'c1' });
        await flush();

        expect(gets).toEqual(['/api/stream']);
        expect(subscribed(posts)).toEqual(['room:proj:a', 'room:proj:b']);
        client.close();
    });

    it('事件按话题分发：别的房间的事件不进这个回调', async () => {
        const { impl, send } = fakeBackend();
        const client = new HttpChatClient({ fetchImpl: impl });

        const one: unknown[] = [];
        const two: unknown[] = [];
        client.watch('proj:a', (event) => one.push(event));
        client.watch('proj:b', (event) => two.push(event));
        await flush();
        send('$conn', { conn: 'c1' });
        await flush();

        send('room:proj:a', { kind: 'item', item: { id: 'i1' } });
        await flush();
        expect(one.at(-1)).toEqual({ kind: 'item', item: { id: 'i1' } });
        // 另一条话题只收到自己的 ready，没收到这个房间的事件
        expect(two).toEqual([{ kind: 'ready' }]);
        client.close();
    });

    it('没有任何订阅就不建连接：只开侧栏 / 只读列表的页一条也不占', async () => {
        const { impl, gets, send, posts } = fakeBackend();
        const client = new HttpChatClient({ fetchImpl: impl });

        // 光造 client（store 模块加载时就会造一个）不算「要事件」，不该拨号
        await flush();
        expect(gets).toEqual([]);
        expect(posts).toEqual([]);

        // 第一个 watch 才把它拉起来，而且只拉一条
        client.watch('proj:a', () => undefined);
        client.watch('proj:b', () => undefined);
        await flush();
        expect(gets).toEqual(['/api/stream']);
        send('$conn', { conn: 'c1' });
        await flush();
        expect(subscribed(posts)).toEqual(['room:proj:a', 'room:proj:b']);
        client.close();
    });

    it('post 不再多开连接，也不再等整轮：发完就返回', async () => {
        const { impl, gets, send, posts } = fakeBackend();
        const client = new HttpChatClient({ fetchImpl: impl });

        const watched: unknown[] = [];
        client.watch('proj:a', (event) => watched.push(event));
        await flush();
        send('$conn', { conn: 'c1' });
        await flush();
        posts.length = 0;

        const seen: unknown[] = [];
        await client.post('proj:a', { kind: 'send', text: '在吗' }, (event) => seen.push(event));

        // 只发了一条 POST：没有再开 /chat SSE（老实现里它会挂到整轮结束）
        expect(gets).toEqual(['/api/stream']);
        // 只发一条 POST：不再开 /chat SSE，也不重复订（watch 已经订过这条话题）
        expect(posts.map((p) => p.path)).toEqual(['/api/rooms/proj%3Aa/chat']);
        // 受理后立刻返回：post 的回调只覆盖请求还在飞的那一瞬，事件一律走 watch 那条话题
        send('room:proj:a', { kind: 'item', item: { id: 'i2' } });
        await flush();
        expect(watched.at(-1)).toEqual({ kind: 'item', item: { id: 'i2' } });
        expect(seen).toHaveLength(0);
        client.close();
    });

    it('最后一个监听者走了就退订；再来人重新订', async () => {
        const { impl, send, posts } = fakeBackend();
        const client = new HttpChatClient({ fetchImpl: impl });

        const off = client.watch('proj:a', () => undefined);
        await flush();
        send('$conn', { conn: 'c1' });
        await flush();
        off();
        await flush();

        expect(posts.map((p) => p.path)).toEqual(['/api/stream/subscribe', '/api/stream/unsubscribe']);
        expect(posts[1]!.body).toEqual({ conn: 'c1', topic: 'room:proj:a' });

        client.watch('proj:a', () => undefined);
        await flush();
        expect(subscribed(posts)).toEqual(['room:proj:a', 'room:proj:a']);
        client.close();
    });

    it('断线重连：换连接后重订所有话题并补一次 ready', async () => {
        const { impl, send, kill, gets, posts } = fakeBackend();
        const client = new HttpChatClient({ fetchImpl: impl });

        const seen: unknown[] = [];
        client.watch('proj:a', (event) => seen.push(event));
        await flush();
        send('$conn', { conn: 'c1' });
        await flush();
        expect(seen.filter((e) => (e as { kind: string }).kind === 'ready')).toHaveLength(1);

        // 服务端掐断 → 退避 500ms → 重连（真等，退避是常量，不值得为它上假时钟）
        kill();
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(gets).toHaveLength(2);

        send('$conn', { conn: 'c2' }, 1);
        await flush();

        // 用新 conn 重订，并且补一次 ready（上层据此补拉快照填断线）
        expect(posts.at(-1)).toEqual({ path: '/api/stream/subscribe', body: { conn: 'c2', topic: 'room:proj:a' } });
        expect(seen.filter((e) => (e as { kind: string }).kind === 'ready')).toHaveLength(2);
        client.close();
    });
});
