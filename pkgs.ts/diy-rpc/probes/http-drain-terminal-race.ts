import * as http2 from 'node:http2';
import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';
import { HttpClientBinding } from '../src/transport/http/http-client-binding';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api = RpcSchema.router({
  collect: RpcSchema.clientStream({ input: {}, chunkIn: z.string(), output: z.boolean() }),
});

async function main() {
  const binding = new HttpServerBinding();
  binding.on(api.collect, async () => true); // 远端立即返回，触发 request-side 终态

  const server = http2.createServer();
  server.on('stream', (stream, headers) => { void binding.handleStream(stream, headers); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const port = (server.address() as { port: number }).port;
  const client = new HttpClientBinding(`http://127.0.0.1:${port}`);
  await client.ready();

  const state = { next: 0, returned: 0, forcedWriteFalse: 0 };
  const huge = 'x'.repeat(1024 * 1024);
  const runtimeClient = client as unknown as {
    request: (...args: unknown[]) => http2.ClientHttp2Stream;
  };
  const originalRequest = runtimeClient.request.bind(client);
  let forced = false;

  // 探针只为稳定进入 onceDrain：第一次大写入返回 false，模拟 HTTP/2 背压。
  runtimeClient.request = (...args) => {
    const stream = originalRequest(...args);
    const write = stream.write.bind(stream);
    stream.write = ((chunk: string | Buffer) => {
      const ok = write(chunk);
      if (!forced && String(chunk).length > 100_000) {
        forced = true;
        state.forcedWriteFalse++;
        return false;
      }
      return ok;
    }) as typeof stream.write;
    return stream;
  };

  const chunks = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          state.next++;
          if (state.next === 1) return { done: false as const, value: huge };
          // 如果 drain 唤醒后没有先检查 remoteSettled，这次 next 会永远挂起。
          return new Promise<IteratorResult<string>>(() => {});
        },
        return: async () => {
          state.returned++;
          return { done: true as const, value: undefined };
        },
      };
    },
  };

  try {
    await client.clientStream('collect', { input: {}, meta: {} }, chunks);
    await sleep(300);
    console.log('[drain-race]', state);
    // 当前缺陷：next=2。修复后应在 drain/close 唤醒后直接终止，不再启动第二次 next。
    const passed = state.forcedWriteFalse === 1 && state.next === 1 && state.returned > 0;
    console.log('[drain-race] expected next=1, returned>0:', passed);
    if (!passed) {
      console.error('FAIL: terminal drain wake-up starts another upstream.next()');
      process.exitCode = 1;
    } else {
      console.log('PASS: terminal drain wake-up stops before another upstream.next()');
    }
  } finally {
    client.dispose();
    binding.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
