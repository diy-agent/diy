import * as http2 from 'node:http2';
import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';
import { HttpClientBinding } from '../src/transport/http/http-client-binding';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api = RpcSchema.router({
  collect: RpcSchema.clientStream({ input: {}, chunkIn: z.number(), output: z.boolean() }),
});

async function main() {
  const binding = new HttpServerBinding();
  binding.on(api.collect, async () => true);
  const server = http2.createServer();
  server.on('stream', (stream, headers) => { void binding.handleStream(stream, headers); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = new HttpClientBinding(`http://127.0.0.1:${port}`);
  await client.ready();
  const delayedChunks = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => { await sleep(1000); return { done: false as const, value: 1 }; },
        return: async () => ({ done: true as const, value: undefined }),
      };
    },
  };

  try {
    await client.clientStream('collect', { input: {}, meta: {} }, delayedChunks);
    const stream = [...(client as unknown as { activeStreams: Set<http2.ClientHttp2Stream> }).activeStreams][0] as any;
    for (const event of ['finish', 'end', 'close', 'aborted', 'error']) {
      stream?.on(event, (error: Error & { code?: string }) => {
        console.log('[client event]', event, error?.code ?? '');
      });
    }
    const snapshot = () => ({
      activeStreams: (client as unknown as { activeStreams: Set<unknown> }).activeStreams.size,
      closed: stream?.closed,
      destroyed: stream?.destroyed,
      readableEnded: stream?.readableEnded,
      writableEnded: stream?.writableEnded,
      readable: stream?.readable,
      writable: stream?.writable,
      rstCode: stream?.rstCode,
    });
    console.log('[events] after result:', snapshot());
    await sleep(500);
    console.log('[events] after 500ms:', snapshot());
    console.log('[events] manual stream.end()');
    stream?.end();
    await sleep(200);
    console.log('[events] after manual end:', snapshot());
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
