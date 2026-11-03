/**
 * 双工帧归属回归（任务 205）：同一 EnvelopeTransport 上 server + client 双挂
 * （main: bindApi server + RendererForwarder client；renderer: bindRendererApi
 * server + diyService client）时，帧必须按「有 method = 请求 → server」「无 method
 * = 响应/ack → client」归属，任何一方都不能把对方的帧当自己的处理：
 *
 *   - server 误当请求回 UNIMPLEMENTED → 与对端 server 形成错误帧风暴，且错误帧
 *     id 与在飞调用撞号（两端 _reqId 各自从 1 计数）→ 假「Unknown method: undefined」
 *   - client 误当响应 settle → 请求帧把在飞调用 resolve 成 undefined
 */

import { it, expect } from 'vitest';
import { ChannelServerBinding, ChannelClientBinding, RpcSchema } from '../src/core';
import type { EnvelopeTransport, _Envelope } from '../src/core/types';
import { z } from 'zod';

const api = RpcSchema.router({
  a: RpcSchema.unary({ input: {}, output: z.object({ from: z.string() }) }),
  b: RpcSchema.unary({ input: {}, output: z.object({ from: z.string() }) }),
} as const);

/** 模拟 IPC：send 投递给对端所有监听者（两端各自 server+client 都订阅） */
function duplexPair(): [EnvelopeTransport, EnvelopeTransport] {
  const toB: Array<(m: _Envelope) => void> = [];
  const toA: Array<(m: _Envelope) => void> = [];
  const a: EnvelopeTransport = {
    send(p) { queueMicrotask(() => toB.forEach(h => h(p as _Envelope))); },
    on(h) { toA.push(h); return () => { const i = toA.indexOf(h); if (i >= 0) toA.splice(i, 1); }; },
    onClose() { return () => {}; },
  };
  const b: EnvelopeTransport = {
    send(p) { queueMicrotask(() => toA.forEach(h => h(p as _Envelope))); },
    on(h) { toB.push(h); return () => { const i = toB.indexOf(h); if (i >= 0) toB.splice(i, 1); }; },
    onClose() { return () => {}; },
  };
  return [a, b];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

it('同 transport 双挂 server+client：双向调用互不串台、无错误帧风暴', async () => {
  const [txA, txB] = duplexPair();

  // A 端：server（处理 b）+ client（调 b… 实际调对端的 a）
  const aServer = new ChannelServerBinding(txA);
  aServer.on(api.b, async () => ({ from: 'A' }));
  const aClient = new ChannelClientBinding(txA);

  // B 端：server（处理 a）+ client（反向调 A 的 b）
  const bServer = new ChannelServerBinding(txB);
  bServer.on(api.a, async () => ({ from: 'B' }));
  const bClient = new ChannelClientBinding(txB);

  // A→B：正向调用
  await expect(aClient.invoke('a', { input: {} }, { timeout: 2000 })).resolves.toEqual({ from: 'B' });
  // B→A：反向调用（响应帧会到达 A 的 server，必须被忽略而非回 UNIMPLEMENTED）
  await expect(bClient.invoke('b', { input: {} }, { timeout: 2000 })).resolves.toEqual({ from: 'A' });
  // 再来一轮：若存在错误帧风暴/撞号，第一轮的残留错误帧会污染本轮 pending
  await expect(aClient.invoke('a', { input: {} }, { timeout: 2000 })).resolves.toEqual({ from: 'B' });

  // 静置一会：风暴（若修复失效）会让帧无限往返；断言无多余帧到达
  const count = { a: 0, b: 0 };
  const offA = txA.on(() => { count.a++; });
  const offB = txB.on(() => { count.b++; });
  await sleep(50);
  offA(); offB();
  expect(count.a).toBe(0);
  expect(count.b).toBe(0);
});

it('请求帧（带 method）不会被同端 client 当响应 settle', async () => {
  const [txA, txB] = duplexPair();
  const aServer = new ChannelServerBinding(txA);
  aServer.on(api.b, async () => ({ from: 'A' }));
  const aClient = new ChannelClientBinding(txA);
  const bServer = new ChannelServerBinding(txB);
  bServer.on(api.a, async () => ({ from: 'B' }));
  const bClient = new ChannelClientBinding(txB);

  // B 的 client 发起调用（请求帧 id=1 会到达 A 端 client；A 端 client 若误处理，
  // 撞号时会把在飞调用 settle 成 undefined）
  const inflight = bClient.invoke('b', { input: {} }, { timeout: 2000 });
  await expect(inflight).resolves.toEqual({ from: 'A' });

  // A 端同时有自己的在飞调用（id 同为 1）——不得被对端请求帧/本端 server 响应污染
  await expect(aClient.invoke('a', { input: {} }, { timeout: 2000 })).resolves.toEqual({ from: 'B' });
});
