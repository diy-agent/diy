/**
 * binding.test.ts — 绑定层参数化测试
 *
 * 四流模式往返 + 错误传播是各传输实现共享的通用断言，只在此写一遍，
 * 通过 TransportHarness 参数化到 channel/http/ws/ipc 每个传输上跑。
 * 各传输协议特有的行为（http 的 curl/错误映射、ws 的 multiplex、取消语义）
 * 放对应的 *-specific.test.ts，不混在这里。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RpcSchema, RpcError, createTypedClient } from '../src/index';
import type { ServerBinding } from '../src/core';
import { channelHarness, httpHarness, wsHarness, type TransportHarness } from './harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 四流模式共享 api 定义（纯 meta，router() 回写全名） */
const api = RpcSchema.router({
  greet: RpcSchema.unary({ input: { name: z.string() }, output: z.string() }),
  fail: RpcSchema.unary({ input: {}, output: z.unknown() }),
  count: RpcSchema.serverStream({ input: { to: z.number() }, output: z.number() }),
  upload: RpcSchema.clientStream({
    input: { tag: z.string() }, chunkIn: z.string(),
    output: z.object({ tag: z.string(), received: z.array(z.string()) }),
  }),
  echo: RpcSchema.bidiStream({ input: {}, chunkIn: z.string(), chunkOut: z.string() }),
});

function wireBinding(binding: ServerBinding) {
  binding.on(api.greet, async ({ input }) => `Hello, ${input.name}!`);
  binding.on(api.fail, async () => { throw new RpcError('INTERNAL', 'boom'); });
  binding.on(api.count, async function* ({ input }) {
    for (let i = 1; i <= input.to; i++) { await sleep(1); yield i; }
  });
  binding.on(api.upload, async ({ input, stream }) => {
    const received: string[] = [];
    for await (const c of stream) received.push(c as string);
    return { tag: input.tag, received };
  });
  binding.on(api.echo, async function* ({ stream }) {
    for await (const m of stream) yield `echo: ${m}`;
  });
}

const harnesses: TransportHarness[] = [
  channelHarness,
  httpHarness,
  wsHarness,
  // ipc 后续接入
];

describe.each(harnesses.map((h) => [h.name, h] as const))(
  'binding: %s',
  (_name, h) => {
    it('四流模式往返 + 错误传播', async () => {
      const { binding, client, dispose } = await h.start();
      try {
        wireBinding(binding);
        const cli = createTypedClient(client, api);

        // 1. unary
        const g = await cli.greet({ name: 'World' });
        expect(g).toBe('Hello, World!');

        // 2. unary 错误传播
        await expect(cli.fail({})).rejects.toMatchObject({ code: 'INTERNAL', message: 'boom' });

        // 3. server-stream
        const hnd = await cli.count({ to: 3 });
        const nums: number[] = [];
        for await (const v of hnd) nums.push(v);
        expect(nums).toEqual([1, 2, 3]);

        // 4. client-stream
        async function* uploadGen() { yield 'a'; yield 'b'; }
        const up = await cli.upload({ tag: 'demo' }, uploadGen());
        expect(up).toEqual({ tag: 'demo', received: ['a', 'b'] });

        // 5. bidi-stream
        async function* msgs() { yield 'hello'; yield 'world'; }
        const replies = await cli.echo({}, msgs());
        const out: string[] = [];
        for await (const r of replies) out.push(r);
        expect(out).toEqual(['echo: hello', 'echo: world']);

        binding.destroy();
      } finally {
        await dispose();
      }
    });
  },
);
