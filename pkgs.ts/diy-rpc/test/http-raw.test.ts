/**
 * http-raw.test.ts — HttpRawServer/HttpRawClient 绑定层验证（raw 层，不依赖第3层类型化 API）
 *
 * 真实 http2 server + HttpRawServer，handler 用原始 onXxx 接口直接注册，
 * 验证 HttpRaw 绑定本身的 wire 行为：
 *   - curl 可访问 unary / server-stream（HTTP 常态，motivating case）
 *   - 四模式 + notify 往返
 *   - 错误映射：RpcError code → HTTP status（codes.ts）+ ext.http.status 透传；未注册 → 501
 *   - 两流取消：server-stream abort（RST_STREAM→生成器 finally）、client-stream abort（incoming CANCELLED）
 *
 * 注：zod 校验→INVALID_ARGUMENT、scope 前缀、RpcGateway 路由等属第3层职责，
 *     在 rpc-layer/gateway/typed-client 测试里覆盖，不在本文件。
 */

import * as http2 from 'node:http2';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { RpcError } from '../src/index';
import { HttpRawServer } from '../src/rpc/http/raw-server';
import { HttpRawClient } from '../src/rpc/http/raw-client';

const exec = promisify(execCb);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════
//  handler 用 HttpRawServer 原始接口直接注册（不经过 RpcServer/RpcGateway）
// ═══════════════════════════════════════════════════

let slowCleanup = false;
let csCancelled: string | null = null;

const httpRaw = new HttpRawServer();
// unary
httpRaw.onUnary('diy.app.greet', async (p) => `Hello, ${(p as { input: { name: string } }).input.name}!`);
httpRaw.onUnary('diy.app.fail', async () => { throw new RpcError('PERMISSION_DENIED', 'no access'); });
httpRaw.onUnary('diy.app.invalid', async () => {
  throw new RpcError('INVALID_ARGUMENT', 'Invalid input', { details: [{ path: ['name'], message: 'bad' }] });
});
// server-stream
httpRaw.onServerStream('diy.app.count', async function* (p) {
  for (let i = 1; i <= (p as { input: { to: number } }).input.to; i++) yield i;
});
httpRaw.onServerStream('diy.app.slow', async function* () {
  try { for (let i = 0; ; i++) { yield i; await sleep(1); } }
  finally { slowCleanup = true; }
});
// client-stream
httpRaw.onClientStream('diy.app.upload', async (p, incoming) => {
  const items: string[] = [];
  for await (const c of incoming) items.push(c as string);
  return { tag: (p as { input: { tag: string } }).input.tag, items };
});
httpRaw.onClientStream('diy.app.recv', async (_p, incoming) => {
  try { for await (const _ of incoming) {} }
  catch (e: unknown) { csCancelled = (e as RpcError).code ?? null; }
  return { errCode: csCancelled };
});
// bidi-stream
httpRaw.onBidiStream('diy.app.echo', async function* (_p, incoming) {
  for await (const m of incoming) yield `echo: ${m}`;
});
// notify
let notified = '';
httpRaw.onNotify('diy.app.toast', (p) => { notified = (p as { text: string }).text; });

async function main() {
  let passed = 0;
  let failed = 0;
  function assert(cond: boolean, msg: string) {
    if (cond) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; console.error(`  ❌ ${msg}`); }
  }

  const srv = http2.createServer();
  srv.on('stream', (stream, headers) => { void httpRaw.handleStream(stream as http2.ServerHttp2Stream, headers); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const cli = new HttpRawClient(base);

  // ── 1. curl 打 unary（motivating case：像正常 http 那样 curl）──
  console.log('\n── curl unary ──');
  const { stdout: curlOut } = await exec(
    `curl -s --http2-prior-knowledge -m 8 -X POST ${base}/diy.app.greet ` +
    `-H 'Content-Type: application/json' -d '{"input":{"name":"Curl"},"meta":{}}'`,
  );
  const curlParsed = JSON.parse(curlOut);
  assert(curlParsed.result === 'Hello, Curl!', `curl unary → ${curlOut.trim()}`);

  // ── 2. HttpRawClient unary ──
  console.log('\n── unary ──');
  const g = await cli.invoke('diy.app.greet', { input: { name: 'World' }, meta: {} });
  assert(g === 'Hello, World!', `greet = ${JSON.stringify(g)}`);

  // ── 3. curl 打 server-stream（NDJSON）──
  console.log('\n── curl server-stream ──');
  const { stdout: curlSrv } = await exec(
    `curl -s --http2-prior-knowledge -m 8 -N -X POST ${base}/diy.app.count ` +
    `-H 'Content-Type: application/json' -d '{"input":{"to":3},"meta":{}}'`,
  );
  assert(curlSrv.includes('{"v":1}') && curlSrv.includes('{"v":3}'), `curl server-stream → ${JSON.stringify(curlSrv)}`);

  // ── 4. server-stream（HttpRawClient）──
  console.log('\n── server-stream ──');
  const sh = await cli.serverStream('diy.app.count', { input: { to: 3 }, meta: {} });
  const got: number[] = [];
  for await (const v of sh) got.push(v as number);
  assert(JSON.stringify(got) === '[1,2,3]', `count = ${JSON.stringify(got)}`);

  // ── 5. notify（fire-and-forget）──
  console.log('\n── notify ──');
  cli.send('diy.app.toast', { text: 'hi' });
  await sleep(60);
  assert(notified === 'hi', `notify 送达 = ${notified}`);

  // ── 6. client-stream ──
  console.log('\n── client-stream ──');
  async function* uploadGen() { yield 'a'; yield 'b'; }
  const upRaw = await cli.clientStream('diy.app.upload', { input: { tag: 'demo' }, meta: {} }, uploadGen());
  const up = upRaw as { tag: string; items: string[] };
  assert(up.tag === 'demo' && JSON.stringify(up.items) === '["a","b"]', `upload = ${JSON.stringify(up)}`);

  // ── 7. bidi-stream ──
  console.log('\n── bidi-stream ──');
  async function* msgs() { yield 'hello'; yield 'world'; }
  const replies = await cli.bidiStream('diy.app.echo', { input: {}, meta: {} }, msgs());
  const out: string[] = [];
  for await (const r of replies) out.push(r as string);
  assert(JSON.stringify(out) === '["echo: hello","echo: world"]', `echo = ${JSON.stringify(out)}`);

  // ── 8. 错误映射：RpcError INVALID_ARGUMENT → 400 + ext.http.status 透传 ──
  //    注意：这是 raw 层对 RpcError code → HTTP status 的映射（codes.ts），
  //    不含 zod 校验（zod→INVALID_ARGUMENT 是第3层 validateInput 的职责）。
  console.log('\n── 错误映射 (RpcError → 400) ──');
  try {
    await cli.invoke('diy.app.invalid', { input: {}, meta: {} });
    assert(false, 'should have thrown');
  } catch (e) {
    const r = e as RpcError;
    assert(r instanceof RpcError && r.code === 'INVALID_ARGUMENT', `code = ${r.code}`);
    assert(r.ext?.http?.status === 400, `http status = ${r.ext?.http?.status}`);
    assert(Array.isArray(r.details), `details 透传`);
  }

  // ── 9. 错误映射：自定义 RpcError → PERMISSION_DENIED/403 ──
  console.log('\n── 错误映射 (RpcError → 403) ──');
  try {
    await cli.invoke('diy.app.fail', { input: {}, meta: {} });
    assert(false, 'should have thrown');
  } catch (e) {
    const r = e as RpcError;
    assert(r.code === 'PERMISSION_DENIED', `code = ${r.code}`);
    assert(r.ext?.http?.status === 403, `http status = ${r.ext?.http?.status}`);
  }

  // ── 10. 未注册方法 → UNIMPLEMENTED/501 ──
  console.log('\n── 错误映射 (unimplemented) ──');
  try {
    await cli.invoke('diy.app.nope', { input: {}, meta: {} });
    assert(false, 'should have thrown');
  } catch (e) {
    const r = e as RpcError;
    assert(r.code === 'UNIMPLEMENTED' && r.ext?.http?.status === 501, `code=${r.code} http=${r.ext?.http?.status}`);
  }

  // ── 11. server-stream 取消：RST_STREAM → 生成器 finally 必跑 ──
  console.log('\n── server-stream 取消 ──');
  const ac = new AbortController();
  const sh2 = await cli.serverStream('diy.app.slow', { input: {}, meta: {} }, { signal: ac.signal });
  const it = sh2[Symbol.asyncIterator]();
  const first = await it.next();
  assert(!first.done, `拿到首帧 ${JSON.stringify(first.value)}`);
  ac.abort(); // RST_STREAM
  await sleep(80);
  assert(slowCleanup, '服务端生成器 finally 在客户端 abort 后已执行');

  // ── 12. client-stream 取消：incoming 以 CANCELLED 收尾 ──
  // 用无限生成器保证取消在传输中打断（非已 flush 完的正常 end），服务端必见 CANCELLED
  console.log('\n── client-stream 取消 ──');
  const ac2 = new AbortController();
  async function* infiniteChunks() { for (let i = 0; ; i++) { await sleep(1); yield i; } }
  const cp = cli.clientStream('diy.app.recv', { input: {}, meta: {} }, infiniteChunks(), { signal: ac2.signal });
  setTimeout(() => ac2.abort(), 30);
  try { await cp; } catch { /* abort 后响应不可靠，忽略 */ }
  await sleep(80);
  assert(csCancelled === 'CANCELLED', `服务端 incoming 收到取消 = ${csCancelled}`);

  // ── 清理 ──
  cli.dispose();
  httpRaw.destroy();
  await new Promise<void>((r) => srv.close(() => r()));

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`通过: ${passed}  失败: ${failed}`);
  console.log(`${'═'.repeat(40)}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
