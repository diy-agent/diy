import * as http2 from 'node:http2';
import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';
import { HttpClientBinding } from '../src/transport/http/http-client-binding';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const api = RpcSchema.router({
  collect: RpcSchema.clientStream({ input: {}, chunkIn: z.number(), output: z.boolean() }),
  bidi: RpcSchema.bidiStream({ input: {}, chunkIn: z.number(), chunkOut: z.number() }),
});

type StreamSnapshot = {
  activeStreams: number;
  closed: boolean | undefined;
  destroyed: boolean | undefined;
  readableEnded: boolean | undefined;
  writableEnded: boolean | undefined;
};

function snapshot(client: HttpClientBinding, stream?: http2.ClientHttp2Stream): StreamSnapshot {
  return {
    activeStreams: (client as unknown as { activeStreams: Set<unknown> }).activeStreams.size,
    closed: stream?.closed,
    destroyed: stream?.destroyed,
    readableEnded: stream?.readableEnded,
    writableEnded: stream?.writableEnded,
  };
}

function delayedChunks() {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await sleep(1000);
          return { done: false as const, value: 1 };
        },
        return: async () => ({ done: true as const, value: undefined }),
      };
    },
  };
}

async function startServer() {
  const binding = new HttpServerBinding();
  binding.on(api.collect, async () => true);
  binding.on(api.bidi, async function* () {});

  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    void binding.handleStream(stream, headers);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const port = (server.address() as { port: number }).port;
  const client = new HttpClientBinding(`http://127.0.0.1:${port}`);
  await client.ready();
  return { binding, server, client };
}

async function probeClientStream(): Promise<boolean> {
  const { binding, server, client } = await startServer();
  try {
    // 流在调用同步段注册、终态收束时同步移出集合——引用必须在 await 前捕获，
    // 否则集合已空 → stream=undefined → closed 恒 undefined，判据永不可满足（测量 bug 修正）
    const pending = client.clientStream('collect', { input: {}, meta: {} }, delayedChunks());
    const stream = [...(client as unknown as { activeStreams: Set<http2.ClientHttp2Stream> }).activeStreams][0];
    await pending;
    const immediately = snapshot(client, stream);
    await sleep(500);
    const afterWait = snapshot(client, stream);
    console.log('[client-stream] immediately:', immediately);
    console.log('[client-stream] after 500ms:', afterWait);
    // 关键判据：远端终态处理返回时，不能还依赖后续随机 close 才收束。
    return immediately.activeStreams === 0 && immediately.closed === true && immediately.writableEnded === true;
  } finally {
    client.dispose();
    binding.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function probeBidi(): Promise<boolean> {
  const { binding, server, client } = await startServer();
  try {
    // 同上：流引用在 await 前捕获（终态后集合已空）
    const pending = client.bidiStream('bidi', { input: {}, meta: {} }, delayedChunks());
    const stream = [...(client as unknown as { activeStreams: Set<http2.ClientHttp2Stream> }).activeStreams][0];
    const output = await pending;
    for await (const _ of output) {}
    const immediately = snapshot(client, stream);
    await sleep(500);
    const afterWait = snapshot(client, stream);
    console.log('[bidi] immediately:', immediately);
    console.log('[bidi] after 500ms:', afterWait);
    return immediately.activeStreams === 0 && immediately.closed === true && immediately.writableEnded === true;
  } finally {
    client.dispose();
    binding.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const results = {
  clientStream: await probeClientStream(),
  bidi: await probeBidi(),
};

console.log('[summary]', results);
if (!results.clientStream || !results.bidi) {
  console.error('FAIL: request-side HTTP/2 streams did not converge after remote terminal state');
  process.exitCode = 1;
} else {
  console.log('PASS: request-side HTTP/2 streams converged');
}
