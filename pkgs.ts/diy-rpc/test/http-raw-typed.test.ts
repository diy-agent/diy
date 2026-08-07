/**
 * http-raw-typed.test.ts — HttpRawServer.on(meta, handler) 类型化注册入口验证
 *
 * 纯增量：不改任何现有逻辑，只验证新增能力——
 *   - router() 回写 meta.name（方法全名）
 *   - httpRaw.on(apiDef.x, handler)：handler 收 { input } 全类型、无 as、zod 校验
 *   - 4 模式经 on(meta) 注册后 wire 行为与 onXxx 一致
 *   - meta 无 name（未 router 包裹）→ 明确报错
 */
import * as http2 from 'node:http2';
import { z } from 'zod';
import { router, RpcSchema, RpcError } from '../src/index';
import { HttpRawServer } from '../src/rpc/http/raw-server';
import { HttpRawClient } from '../src/rpc/http/raw-client';

const apiDef = router({
  math: { add: RpcSchema.unary({ input: { a: z.number(), b: z.number() }, output: z.number() }) },
  greet: RpcSchema.unary({ input: { name: z.string() }, output: z.string() }),
  count: RpcSchema.serverStream({ input: { n: z.number() }, output: z.number() }),
  upload: RpcSchema.clientStream({
    input: { tag: z.string() }, chunkIn: z.number(),
    output: z.object({ tag: z.string(), sum: z.number() }),
  }),
  echo: RpcSchema.bidiStream({ input: { room: z.string() }, chunkIn: z.string(), chunkOut: z.string() }),
} as const);

async function main() {
  let passed = 0, failed = 0;
  const assert = (c: boolean, m: string) => { c ? (passed++, console.log('  ✅ ' + m)) : (failed++, console.error('  ❌ ' + m)); };

  // router() 回写 name
  assert(apiDef.math.add.name === 'math.add', `router 回写 name = ${apiDef.math.add.name}`);
  assert(apiDef.greet.name === 'greet', `嵌套 name = ${apiDef.greet.name}`);

  const httpRaw = new HttpRawServer();
  // 各注册方法带 meta 重载：handler 收 { input } 全类型、无 as、zod 校验
  httpRaw.onUnary(apiDef.math.add, async ({ input }) => input.a + input.b);
  httpRaw.onUnary(apiDef.greet, async ({ input }) => `Hello, ${input.name}!`);
  httpRaw.onServerStream(apiDef.count, async function* ({ input }) { for (let i = 0; i < input.n; i++) yield i; });
  httpRaw.onClientStream(apiDef.upload, async ({ input, stream }) => {
    let sum = 0; for await (const v of stream) sum += v; return { tag: input.tag, sum };
  });
  httpRaw.onBidiStream(apiDef.echo, async function* ({ input, stream }) { for await (const m of stream) yield `[${input.room}] ${m}`; });

  const srv = http2.createServer();
  srv.on('stream', (stream, headers) => void httpRaw.handleStream(stream as http2.ServerHttp2Stream, headers));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const cli = new HttpRawClient(`http://127.0.0.1:${port}`);

  // unary
  const add = await cli.invoke<{ input: { a: number; b: number }; meta: unknown }, number>('math.add', { input: { a: 3, b: 4 }, meta: {} });
  assert(add === 7, `on(meta) unary add = ${add}`);
  // 嵌套路径全名 greet
  const g = await cli.invoke<{ input: { name: string }; meta: unknown }, string>('greet', { input: { name: 'T' }, meta: {} });
  assert(g === 'Hello, T!', `on(meta) greet = ${g}`);
  // server-stream
  const sh = await cli.serverStream('count', { input: { n: 3 }, meta: {} });
  const nums: number[] = []; for await (const v of sh) nums.push(v as number);
  assert(JSON.stringify(nums) === '[0,1,2]', `on(meta) server-stream = ${JSON.stringify(nums)}`);
  // client-stream
  const up = await cli.clientStream('upload', { input: { tag: 'x' }, meta: {} }, (async function* () { yield 1; yield 2; yield 3; })());
  assert((up as { sum: number }).sum === 6, `on(meta) client-stream = ${JSON.stringify(up)}`);
  // bidi
  const bh = await cli.bidiStream('echo', { input: { room: 'r' }, meta: {} }, (async function* () { yield 'a'; yield 'b'; })());
  const outs: string[] = []; for await (const o of bh) outs.push(o as string);
  assert(JSON.stringify(outs) === '["[r] a","[r] b"]', `on(meta) bidi = ${JSON.stringify(outs)}`);

  // zod 校验：非法 input → INVALID_ARGUMENT/400
  try {
    await cli.invoke('math.add', { input: { a: 'bad', b: 1 }, meta: {} });
    assert(false, 'zod 应拒绝');
  } catch (e) {
    const r = e as RpcError;
    assert(r.code === 'INVALID_ARGUMENT' && r.ext?.http?.status === 400, `zod → ${r.code}/${r.ext?.http?.status}`);
  }

  // meta 无 name（未 router 包裹）→ 明确报错
  const bare = RpcSchema.unary({ input: { x: z.number() }, output: z.number() });
  try {
    httpRaw.onUnary(bare, async ({ input }) => input.x);
    assert(false, '应报 meta 无 name');
  } catch (e) {
    assert(String((e as Error).message).includes('无 name'), `裸 meta 报错 = ${(e as Error).message}`);
  }

  cli.dispose();
  httpRaw.destroy();
  await new Promise<void>((r) => srv.close(() => r()));
  console.log(`\n通过: ${passed}  失败: ${failed}`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
