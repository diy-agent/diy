/**
 * browser-ws.test.ts —— 浏览器侧 WebSocket 适配（`@diy-agent/rpc/ws/browser`）。
 *
 * 两段：
 *   1. `wsLikeOf` 的形状适配：`addEventListener` → `on`、Blob/ArrayBuffer → 文本、send/close 透传；
 *   2. **真连接**：Node 24 的全局 `WebSocket`（undici，实现浏览器规范）当客户端，
 *      `ws` 当服务端 —— 一条连接上同时跑 unary 与 server-stream，证明协议与 Node 侧一致。
 */
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

import {
  ChannelClientBinding,
  ChannelServerBinding,
  RpcSchema,
  createTypedClient,
} from '../../src/index';
import { WsTransport } from '../../src/transport/ws';
import { connectWs, wsLikeOf } from '../../src/transport/ws/browser';

const api = RpcSchema.group({
  children: {
    ping: RpcSchema.unary({ input: { msg: z.string() }, output: z.string() }),
    count: RpcSchema.serverStream({ input: { n: z.number() }, output: z.number() }),
  },
});

/** 最小浏览器 WebSocket 替身：只实现适配器用到的那几个面 */
class FakeSocket {
  binaryType = 'blob';
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit('close', {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('wsLikeOf（浏览器形状适配）', () => {
  it('字符串与 ArrayBuffer 帧都能解码；send 原样透传；close 触发 onClose', () => {
    const socket = new FakeSocket();
    const transport = new WsTransport(wsLikeOf(socket as unknown as WebSocket));
    const seen: unknown[] = [];
    transport.on((msg) => seen.push(msg));

    // 适配器把 binaryType 改成 arraybuffer：blob 只能异步读，会打乱帧序
    expect(socket.binaryType).toBe('arraybuffer');

    socket.emit('message', { data: JSON.stringify({ type: 'end', stream: 1 }) });
    socket.emit('message', {
      data: new TextEncoder().encode(JSON.stringify({ type: 'end', stream: 2 })).buffer,
    });
    expect(seen).toEqual([
      { type: 'end', stream: 1 },
      { type: 'end', stream: 2 },
    ]);

    transport.send({ type: 'call', id: 1 });
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'call', id: 1 });

    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    socket.emit('close', {});
    expect(closed).toBe(true);
    expect(socket.closed).toBe(true);
  });
});

describe('connectWs + 真 ws 服务端', () => {
  it('一条连接跑 unary 与 server-stream（与 Node 客户端同一协议）', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const address = wss.address();
    if (address === null || typeof address === 'string') throw new Error('没有端口');

    wss.on('connection', (socket) => {
      const server = new ChannelServerBinding(new WsTransport(socket));
      server._on('ping', api.ping, async ({ input }) => `pong: ${input.msg}`);
      server._on('count', api.count, async function* ({ input }) {
        for (let index = 0; index < input.n; index += 1) yield index;
      });
    });

    try {
      const transport = new WsTransport(
        await connectWs(`ws://127.0.0.1:${address.port}`, { timeoutMs: 3_000 }),
      );
      const client = createTypedClient(new ChannelClientBinding(transport), api);

      try {
        expect(await client.ping({ msg: 'hi' })).toBe('pong: hi');

        const handle = await client.count({ n: 3 });
        const values: number[] = [];
        for await (const value of handle) values.push(value);
        expect(values).toEqual([0, 1, 2]);
      } finally {
        // 先关客户端：wss.close() 会等所有连接断开
        transport.close();
      }
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('端口没人听：connectWs 拒绝，不悬挂', async () => {
    // 先占一个端口再放掉，保证这个端口确实是「没人听」
    const probe = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => probe.once('listening', () => resolve()));
    const address = probe.address();
    if (address === null || typeof address === 'string') throw new Error('没有端口');
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await expect(connectWs(`ws://127.0.0.1:${address.port}`, { timeoutMs: 1_500 })).rejects.toThrow(
      /websocket/,
    );
  });
});
