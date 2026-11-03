import * as http2 from 'node:http2';
import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';
import { HttpClientBinding } from '../src/transport/http/http-client-binding';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api = RpcSchema.router({
  collect: RpcSchema.clientStream({ input: {}, chunkIn: z.number(), output: z.boolean() }),
});

type Snapshot = {
  activeStreams: number;
  closed: boolean | undefined;
  destroyed: boolean | undefined;
  readableEnded: boolean | undefined;
  writableEnded: boolean | undefined;
};

function readSnapshot(client: HttpClientBinding, stream?: http2.ClientHttp2Stream): Snapshot {
  const activeStreams = (client as unknown as { activeStreams: Set<unknown> }).activeStreams;
  return {
    activeStreams: activeStreams.size,
    closed: stream?.closed,
    destroyed: stream?.destroyed,
    readableEnded: stream?.readableEnded,
    writableEnded: stream?.writableEnded,
  };
}

async function main() {
  const binding = new HttpServerBinding();
  binding.on(api.collect, async () => true); // 远端不消费输入，立即返回 result

  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    void binding.handleStream(stream, headers);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const port = (server.address() as { port: number }).port;
  const client = new HttpClientBinding(`http://127.0.0.1:${port}`);
  await client.ready();
  const delayedChunks = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await sleep(1000); // 远端 result 先到，模拟在途 next()
          return { done: false as const, value: 1 };
        },
        return: async () => ({ done: true as const, value: undefined }),
      };
    },
  };

  try {
    // 流引用在调用同步段后、await 前捕获（终态收束会同步移出集合，否则取到 undefined）
    const pending = client.clientStream('collect', { input: {}, meta: {} }, delayedChunks);
    const stream = [...(client as unknown as { activeStreams: Set<http2.ClientHttp2Stream> }).activeStreams][0];
    await pending;
    console.log('[client-stream] immediately:', readSnapshot(client, stream));
    await sleep(500);
    console.log('[client-stream] after 500ms:', readSnapshot(client, stream));
    console.log('[client-stream] expected fix: request stream should converge without dispose');
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
