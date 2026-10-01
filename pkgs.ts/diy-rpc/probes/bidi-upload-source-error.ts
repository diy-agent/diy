import { z } from 'zod';
import { RpcSchema, createTypedClient } from '../src/index';
import { httpHarness, channelHarness } from '../test/harness';

/**
 * 剩余项探针：bidi 上传源错误是否也像 clientStream 一样被传播（P1-2 对称性缺口）。
 *
 * P1-2 修复只覆盖 HTTP `clientStream` 的上传 IIFE；HTTP bidi 的上传 catch 仍是
 * `/* ignore * /`。channel 侧 bidi 已发 `end{error: STREAM_ERROR}`。
 * 判据：上游迭代抛错后，输出流必须以错误落定，不得静默完成。
 */
const api = RpcSchema.router({
  echo: RpcSchema.bidiStream({ input: {}, chunkIn: z.number(), chunkOut: z.number() }),
});

async function* brokenChunks() {
  yield 1;
  throw new Error('bidi-upload-source-failed');
}

async function run(name: string, harness: typeof httpHarness | typeof channelHarness) {
  const { binding, client, dispose } = await harness.start();
  const cli = createTypedClient(client, api);
  binding.on(api.echo, async function* ({ stream }) {
    for await (const v of stream) yield v as number;
  });
  try {
    const handle = await cli.echo({}, brokenChunks());
    const out: number[] = [];
    let outcome = 'completed(no-error)';
    try {
      for await (const v of handle) out.push(v as number);
    } catch (e: any) {
      outcome = `threw:${e?.code ?? ''}`;
    }
    console.log(`[bidi-upload-source-error:${name}]`, { out, outcome });
    return outcome === 'completed(no-error)' ? 'SWALLOWED' : 'PROPAGATED';
  } finally {
    await dispose();
  }
}

async function main() {
  const http = await run('http', httpHarness);
  const channel = await run('channel', channelHarness);
  console.log('[bidi-upload-source-error]', { http, channel });
  if (http === 'SWALLOWED') {
    console.error('FAIL: http bidi upload AsyncIterable error swallowed (clientStream fixed, bidi not)');
    process.exitCode = 1;
  } else if (channel === 'SWALLOWED') {
    console.error('FAIL: channel bidi upload error swallowed');
    process.exitCode = 1;
  } else {
    console.log('PASS: bidi upload error propagated on both transports');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
