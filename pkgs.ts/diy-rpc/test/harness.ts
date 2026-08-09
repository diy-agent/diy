/**
 * harness.ts — 传输 harness 抽象
 *
 * 各种传输实现（channel/http/ws/ipc）统一对接上层 RPC，因此四流模式等通用断言
 * 只在 binding.test.ts 里写一遍，通过 TransportHarness 参数化到每个传输上跑。
 *
 * TransportHarness.start() 返回：
 *   register(server)  把已装配好 handlers 的 RpcServer 接到服务端传输
 *   client            客户端 ClientBinding（传给 createTypedClient）
 *   dispose()         关闭真实传输（http2 server / ws server 等）
 */
import * as http2 from 'node:http2';
import { WebSocketServer, WebSocket } from 'ws';
import { ChannelServerBinding, ChannelClientBinding } from '../src/core';
import type { ServerBinding, ClientBinding } from '../src/core/server-binding';
import type { RpcServer } from '../src/core';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';
import { HttpClientBinding } from '../src/transport/http/http-client-binding';
import { WsTransport } from '../src/transport/ws';
import { createMemTransportPair } from './helpers';

export interface TransportHarness {
  name: string;
  start(): Promise<{
    register: (server: RpcServer) => void;
    client: ClientBinding;
    dispose: () => Promise<void>;
  }>;
}

/** channel（in-memory EnvelopeTransport）——最底层、无真实传输的参照 harness */
export const channelHarness: TransportHarness = {
  name: 'channel(in-memory)',
  async start() {
    const [txServer, txClient] = createMemTransportPair();
    return {
      register: (server) => server.registerInto(new ChannelServerBinding(txServer)),
      client: new ChannelClientBinding(txClient),
      dispose: async () => {},
    };
  },
};

export const httpHarness: TransportHarness = {
  name: 'http2',
  async start() {
    const httpRaw = new HttpServerBinding();
    const srv = http2.createServer();
    srv.on('stream', (stream, headers) => {
      void httpRaw.handleStream(stream as http2.ServerHttp2Stream, headers);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const cli = new HttpClientBinding(`http://127.0.0.1:${port}`);
    await cli.ready();
    return {
      register: (server) => server.registerInto(httpRaw),
      client: cli,
      dispose: async () => {
        cli.dispose();
        httpRaw.destroy();
        await new Promise<void>((r) => srv.close(() => r()));
      },
    };
  },
};

export const wsHarness: TransportHarness = {
  name: 'ws',
  async start() {
    const port = 18923 + Math.floor(Math.random() * 1000);
    const wss = new WebSocketServer({ port });
    await new Promise<void>((r) => wss.once('listening', () => r()));

    // 服务端 binding 绑定到 wss 建立的那条连接（与 client 复用同一条 ws，双向）
    let serverBinding: ChannelServerBinding | undefined;
    wss.on('connection', (ws) => {
      serverBinding = new ChannelServerBinding(new WsTransport(ws));
    });

    // 客户端连接
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once('open', () => r()));
    const client = new ChannelClientBinding(new WsTransport(ws));

    return {
      register: (server) => server.registerInto(serverBinding!),
      client,
      dispose: async () => {
        ws.close();
        await new Promise<void>((r) => wss.close(() => r()));
      },
    };
  },
};

export type { ServerBinding };
