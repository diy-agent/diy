import * as http2 from 'node:http2';
import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';
import { HttpClientBinding } from '../src/transport/http/http-client-binding';

const api = RpcSchema.router({
  collect: RpcSchema.clientStream({ input: {}, chunkIn: z.string(), output: z.boolean() }),
});

async function main() {
  const binding = new HttpServerBinding();
  // handler 不返回，模拟请求流先 close/error、RPC response 尚未正常终态。
  binding.on(api.collect, async () => new Promise<boolean>(() => {}));

  const server = http2.createServer();
  server.on('stream', (stream, headers) => { void binding.handleStream(stream, headers); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const port = (server.address() as { port: number }).port;
  const client = new HttpClientBinding(`http://127.0.0.1:${port}`);
  await client.ready();

  const state = { next: 0, returned: 0, forcedWriteFalse: 0, clientError: '' };
  const runtimeClient = client as unknown as {
    request: (...args: unknown[]) => http2.ClientHttp2Stream;
  };
  const originalRequest = runtimeClient.request.bind(client);
  runtimeClient.request = (...args) => {
    const stream = originalRequest(...args);
    const originalWrite = stream.write.bind(stream);
    let forced = false;
    stream.write = ((chunk: string | Buffer) => {
      const ok = originalWrite(chunk);
      if (!forced) {
        forced = true;
        state.forcedWriteFalse++;
        // close/error 发生在 onceDrain 已开始监听之后，但响应尚未正常落定。
        queueMicrotask(() => {
          try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
        });
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
          if (state.next === 1) return { done: false as const, value: 'x'.repeat(1024 * 1024) };
          // 缺陷版本在 close/error 唤醒 drain 后会启动这个永挂 next。
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
    await client.clientStream('collect', { input: {}, meta: {} }, chunks)
      .catch((error: any) => { state.clientError = String(error?.code ?? error); });
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log('[drain-close-before-response]', state);
    // 无论 client error 是 CANCELLED 还是其它连接错误，不能再次拉取上游。
    const passed = state.forcedWriteFalse === 1 && state.next === 1 && state.returned > 0;
    console.log('[drain-close-before-response] expected next=1, returned>0:', passed);
    if (!passed) {
      console.error('FAIL: close/error wake-up started another upstream.next()');
      process.exitCode = 1;
    } else {
      console.log('PASS: close/error wake-up stopped before another upstream.next()');
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
