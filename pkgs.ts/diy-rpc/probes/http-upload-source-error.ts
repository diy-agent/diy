import { z } from 'zod';
import { RpcSchema, createTypedClient } from '../src/index';
import { httpHarness } from '../test/harness';

const api = RpcSchema.router({
  collect: RpcSchema.clientStream({ input: {}, chunkIn: z.number(), output: z.number() }),
});

async function* brokenChunks() {
  yield 1;
  throw new Error('upload-source-failed');
}

async function main() {
  const { binding, client, dispose } = await httpHarness.start();
  const cli = createTypedClient(client, api);
  binding.on(api.collect, async ({ stream }) => {
    let count = 0;
    for await (const _ of stream) count++;
    return count;
  });
  try {
    let outcome: unknown;
    try {
      outcome = await cli.collect({}, brokenChunks());
    } catch (error: any) {
      outcome = { code: error?.code, message: error?.message };
    }
    console.log('[http-upload-source-error]', outcome);
    if (typeof outcome === 'number' || (outcome && typeof outcome === 'object' && !(outcome as any).message?.includes('upload-source-failed'))) {
      console.error('FAIL: upload AsyncIterable error was swallowed or converted to success');
      process.exitCode = 1;
    } else {
      console.log('PASS: upload AsyncIterable error propagated');
    }
  } finally {
    await dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
