// on-path.test.ts — `binding._on(path, meta, handler)` 三参重载（2026-11-06）
//
// 与两参 `on(meta, handler)` 的区别：**不读 `meta.name`**，所以不用先 `bindNames`。
// 路径就在这一行，grep 得到。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RpcSchema } from '../../src/core/index';
import type { _AnyProcedureMeta } from '../../src/core/meta';
import { channelHarness } from '../harness';

/** 裸树：**没有** bindNames，meta.name 是 undefined */
// ⚠️ group 的心里必须有 children 字段（摊平的是 config.children）——
// 直接写 group({ math: ... }) 不会摊平，math 拿不到
const routes = RpcSchema.group({
  desc: 'root',
  children: {
    math: RpcSchema.group({
      desc: 'math',
      children: {
        add: RpcSchema.unary({
          input: { a: z.number(), b: z.number() },
          output: z.number(),
          desc: 'add',
        }),
        version: RpcSchema.unary({ input: {}, output: z.string(), desc: 'version' }),
      },
    }),
  },
});

const addMeta = RpcSchema.unary({
  input: { a: z.number(), b: z.number() },
  output: z.number(),
}) as unknown as _AnyProcedureMeta;
const versionMeta = RpcSchema.unary({
  input: {},
  output: z.string(),
}) as unknown as _AnyProcedureMeta;

describe('binding._on(path, meta, handler)', () => {
  it('不等 bindNames 就能注册 —— 路径直接给', async () => {
    const { binding, client, dispose } = await channelHarness.start();
    // ⚠️ 用 `as` 保留 meta 类型（handler 的参数推断靠它）；`Record<string, any>` 会丢成 never
    const math = (
      routes as unknown as { math: { add: typeof addMeta; version: typeof versionMeta } }
    ).math;
    expect((math.add as unknown as { name?: string }).name).toBeUndefined();

    binding._on(
      'math.add',
      math.add,
      ({ input }: { input: { a: number; b: number } }) => input.a + input.b,
    );
    binding._on('math.version', math.version, () => '1.0.0');

    const { createTypedClient } = await import('../../src/core/index');
    const c = createTypedClient(client, routes);
    expect(await c.math.add({ a: 2, b: 3 })).toBe(5);
    expect(await c.math.version({})).toBe('1.0.0');
    await dispose();
  });

  it('两参形式已退役：从 meta.name 猜路径的老写法当场报错，而不是注册成畸形名', async () => {
    // 2026-11 `bindNames` 退役后，`meta.name` 恒为 undefined。老写法 `_on(meta.name!, meta, h)`
    // 实际传的是 undefined —— 必须**当场炸**（否则会注册到 `[object Object]` / `undefined`，
    // 症状是第一条调用 `Unknown method`，而报错里看不出是注册时写错了）。
    const { binding, dispose } = await channelHarness.start();
    const math = (routes as unknown as { math: { add: typeof addMeta } }).math;
    expect((math.add as unknown as { name?: string }).name).toBeUndefined();
    expect(() =>
      binding._on(
        (math.add as unknown as { name?: string }).name!,
        math.add,
        ({ input }: { input: { a: number; b: number } }) => input.a * input.b,
      ),
    ).toThrow(/path 不能为空/);
    await dispose();
  });

  it('空 path 直接拒（比"key 变成空串"好查）', async () => {
    const { binding, dispose } = await channelHarness.start();
    const add = (routes as unknown as { math: { add: typeof addMeta } }).math.add;
    expect(() => binding._on('', add, () => 0)).toThrow(/path 不能为空/);
    await dispose();
  });
});
