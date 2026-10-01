import * as http2 from 'node:http2';
import { z } from 'zod';
import { RpcSchema } from '../src/index';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';

const api = RpcSchema.router({
  unary: RpcSchema.unary({ input: {}, output: z.unknown() }),
  collect: RpcSchema.clientStream({ input: {}, chunkIn: z.number(), output: z.number() }),
});

function request(
  session: http2.ClientHttp2Session,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': 'POST', ':path': path, ...headers });
    const chunks: Buffer[] = [];
    let status = 0;
    stream.on('response', (h) => { status = Number(h[':status'] ?? 0); });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString() }));
    stream.on('error', reject);
    stream.end(body);
  });
}

async function main() {
  const binding = new HttpServerBinding();
  binding.on(api.unary, async ({ input }) => input);
  binding.on(api.collect, async ({ stream }) => {
    let count = 0;
    for await (const _ of stream) count++;
    return count;
  });

  const server = http2.createServer();
  server.on('stream', (stream, headers) => { void binding.handleStream(stream, headers); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = http2.connect(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await new Promise<void>((resolve, reject) => {
    session.once('connect', resolve);
    session.once('error', reject);
  });

  try {
    const unary = await request(session, '/unary', { 'content-type': 'application/json' }, '{not-json');
    const badParams = await request(
      session,
      '/collect',
      { 'content-type': 'application/x-ndjson', 'x-diy-params': '{not-json' },
      '1\n',
    );
    const badChunk = await request(
      session,
      '/collect',
      { 'content-type': 'application/x-ndjson', 'x-diy-params': JSON.stringify({ input: {}, meta: {} }) },
      'not-json\n',
    );
    console.log('[http-malformed-input]', { unary, badParams, badChunk });
    const accepted = unary.status === 200 || badParams.status === 200 || badChunk.status === 200;
    if (accepted) {
      console.error('FAIL: malformed HTTP input was accepted or silently discarded');
      process.exitCode = 1;
    } else {
      console.log('PASS: malformed HTTP input rejected');
    }
  } finally {
    session.close();
    binding.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
