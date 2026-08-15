/**
 * http-specific.test.ts — HttpServerBinding 协议特有行为
 *
 * 四流模式往返已在 binding.test.ts 参数化覆盖（http harness），这里只测 http 独有的：
 *   - curl 直接访问 unary / server-stream（HTTP 常态，motivating case）
 *   - 错误映射：RpcError code → HTTP status（_codes.ts）+ ext.http.status 透传；未注册 → 501
 *   - 两流取消：server-stream abort（RST_STREAM → 生成器 finally）、client-stream abort（incoming CANCELLED）
 */
import { describe, it, expect } from 'vitest';
import * as http2 from 'node:http2';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RpcSchema, RpcError } from '../src/index';
import { HttpServerBinding } from '../src/transport/http/http-server-binding';
import { HttpClientBinding } from '../src/transport/http/http-client-binding';

const exec = promisify(execCb);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = RpcSchema.router({
  diy: RpcSchema.group({
    desc: "diy 命名空间",
    children: {
      app: RpcSchema.group({
        desc: "Main 进程域",
        children: {
          greet: RpcSchema.unary({ input: { name: z.string() }, output: z.string() }),
          fail: RpcSchema.unary({ input: {}, output: z.unknown() }),
          invalid: RpcSchema.unary({ input: {}, output: z.unknown() }),
          count: RpcSchema.serverStream({ input: { to: z.number() }, output: z.number() }),
          slow: RpcSchema.serverStream({ input: {}, output: z.number() }),
          recv: RpcSchema.clientStream({ input: {}, chunkIn: z.unknown(), output: z.object({ errCode: z.unknown() }) }),
        },
      }),
    },
  }),
});

describe('http-server-binding 协议特有', () => {
  it('curl unary + server-stream（NDJSON）+ 错误映射 + 取消', async () => {
    const httpRaw = new HttpServerBinding();
    let slowCleanup = false;
    let csCancelled: string | null = null;

    const server = httpRaw;
    server.on(api.diy.app.greet, async ({ input }) => `Hello, ${input.name}!`);
    server.on(api.diy.app.fail, async () => { throw new RpcError('PERMISSION_DENIED', 'no access'); });
    server.on(api.diy.app.invalid, async () => {
      throw new RpcError('INVALID_ARGUMENT', 'Invalid input', { details: [{ path: ['name'], message: 'bad' }] });
    });
    server.on(api.diy.app.count, async function* ({ input }) {
      for (let i = 1; i <= input.to; i++) yield i;
    });
    server.on(api.diy.app.slow, async function* () {
      try { for (let i = 0; ; i++) { yield i; await sleep(1); } }
      finally { slowCleanup = true; }
    });
    server.on(api.diy.app.recv, async ({ stream }) => {
      try { for await (const _ of stream) {} }
      catch (e: unknown) { csCancelled = (e as RpcError).code ?? null; }
      return { errCode: csCancelled };
    });

    const srv = http2.createServer();
    srv.on('stream', (stream, headers) => { void httpRaw.handleStream(stream as http2.ServerHttp2Stream, headers); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const cli = new HttpClientBinding(base);
    await cli.ready();

    try {
      // ── 1. curl unary（motivating case）──
      const { stdout: curlOut } = await exec(
        `curl -s --http2-prior-knowledge -m 8 -X POST ${base}/diy.app.greet ` +
        `-H 'Content-Type: application/json' -d '{"input":{"name":"Curl"},"meta":{}}'`,
      );
      expect(JSON.parse(curlOut).result).toBe('Hello, Curl!');

      // ── 2. curl server-stream（NDJSON）──
      const { stdout: curlSrv } = await exec(
        `curl -s --http2-prior-knowledge -m 8 -N -X POST ${base}/diy.app.count ` +
        `-H 'Content-Type: application/json' -d '{"input":{"to":3},"meta":{}}'`,
      );
      expect(curlSrv).toContain('{"v":1}');
      expect(curlSrv).toContain('{"v":3}');

      // ── 3. 错误映射 INVALID_ARGUMENT → 400 + ext.http.status 透传 ──
      try {
        await cli.invoke('diy.app.invalid', { input: {}, meta: {} });
        expect.unreachable('should have thrown');
      } catch (e) {
        const r = e as RpcError;
        expect(r).toBeInstanceOf(RpcError);
        expect(r.code).toBe('INVALID_ARGUMENT');
        expect(r.ext?.http?.status).toBe(400);
        expect(Array.isArray(r.details)).toBe(true);
      }

      // ── 4. 错误映射 PERMISSION_DENIED → 403 ──
      try {
        await cli.invoke('diy.app.fail', { input: {}, meta: {} });
        expect.unreachable('should have thrown');
      } catch (e) {
        const r = e as RpcError;
        expect(r.code).toBe('PERMISSION_DENIED');
        expect(r.ext?.http?.status).toBe(403);
      }

      // ── 5. 未注册方法 → UNIMPLEMENTED/501 ──
      try {
        await cli.invoke('diy.app.nope', { input: {}, meta: {} });
        expect.unreachable('should have thrown');
      } catch (e) {
        const r = e as RpcError;
        expect(r.code).toBe('UNIMPLEMENTED');
        expect(r.ext?.http?.status).toBe(501);
      }

      // ── 6. server-stream 取消：RST_STREAM → 生成器 finally 必跑 ──
      const ac = new AbortController();
      const sh = await cli.serverStream('diy.app.slow', { input: {}, meta: {} }, { signal: ac.signal });
      const it = sh[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.done).toBe(false);
      ac.abort(); // RST_STREAM
      await sleep(80);
      expect(slowCleanup).toBe(true);

      // ── 7. client-stream 取消：incoming 以 CANCELLED 收尾 ──
      const ac2 = new AbortController();
      async function* infiniteChunks() { for (let i = 0; ; i++) { await sleep(1); yield i; } }
      const cp = cli.clientStream('diy.app.recv', { input: {}, meta: {} }, infiniteChunks(), { signal: ac2.signal });
      setTimeout(() => ac2.abort(), 30);
      try { await cp; } catch { /* abort 后响应不可靠，忽略 */ }
      await sleep(80);
      expect(csCancelled).toBe('CANCELLED');
    } finally {
      cli.dispose();
      httpRaw.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
