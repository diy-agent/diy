// post 流的连接纪律：同源 HTTP/1.1 只有 6 条连接，一条 /chat SSE 会挂到整轮结束。
// 每句插话都新开一条，攒满后连"发送"本身都发不出去。
// 这里锁住：同房间只保留最新一条；release 能收掉；旧流收尾不能误删新流。

import { describe, expect, it } from 'vitest';

import { HttpChatClient } from '../src/index';

/** fetch 永远不返回（模拟挂到整轮结束的 SSE），只响应 abort */
function hangingFetch() {
    const signals: AbortSignal[] = [];
    const impl = ((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (signal == null) throw new Error('缺少 signal');
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
    }) as unknown as typeof fetch;
    return { impl, signals };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('HttpChatClient / post 连接', () => {
    it('同一房间连续发送：旧 post 流被收掉，只留最新一条', async () => {
        const { impl, signals } = hangingFetch();
        const client = new HttpChatClient({ fetchImpl: impl });

        void client.post('room:1', { kind: 'send', text: '第一句' }, () => undefined).catch(() => undefined);
        await flush();
        void client.post('room:1', { kind: 'send', text: '第二句' }, () => undefined).catch(() => undefined);
        await flush();

        expect(signals).toHaveLength(2);
        expect(signals[0]!.aborted).toBe(true);
        expect(signals[1]!.aborted).toBe(false);
    });

    it('旧流在 abort 后收尾，不会把新流的 controller 从表里删掉', async () => {
        const { impl, signals } = hangingFetch();
        const client = new HttpChatClient({ fetchImpl: impl });

        void client.post('room:1', { kind: 'send', text: '第一句' }, () => undefined).catch(() => undefined);
        await flush();
        void client.post('room:1', { kind: 'send', text: '第二句' }, () => undefined).catch(() => undefined);
        await flush(); // 第一句的 finally 已经跑过

        client.release('room:1');
        expect(signals[1]!.aborted).toBe(true);
    });

    it('release：切走房间时收掉挂着的流；没有流时是空操作', async () => {
        const { impl, signals } = hangingFetch();
        const client = new HttpChatClient({ fetchImpl: impl });

        void client.post('room:1', { kind: 'send', text: '在吗' }, () => undefined).catch(() => undefined);
        await flush();
        client.release('room:1');

        expect(signals[0]!.aborted).toBe(true);
        expect(() => client.release('room:1')).not.toThrow();
    });

    it('不同房间互不影响', async () => {
        const { impl, signals } = hangingFetch();
        const client = new HttpChatClient({ fetchImpl: impl });

        void client.post('room:1', { kind: 'send', text: 'A' }, () => undefined).catch(() => undefined);
        void client.post('room:2', { kind: 'send', text: 'B' }, () => undefined).catch(() => undefined);
        await flush();

        expect(signals[0]!.aborted).toBe(false);
        expect(signals[1]!.aborted).toBe(false);
    });
});
