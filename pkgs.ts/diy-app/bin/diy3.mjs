#!/usr/bin/env node
/**
 * bin/diy3.mjs — EnvelopeTransport 桥接实验
 *
 * 验证：两个 createMemTransportPair 通过 pipe() 连接，
 * CLI 侧 createTypedClient → bridge → Renderer 侧 RpcServer，
 * 无需中间代理配置。
 *
 *                      pipe()
 *   CLI  ──memA──→ [bridgeIn] ←──memB──  Renderer
 *   txA  ──send──→ bridgeIn.on ──send──→ rendererIn.on → rendererTx
 *   txA.on ←──send── bridgeIn  ←──send── rendererIn
 *                     ↑_______↔_____↑
 */

import { createMemTransportPair, RpcImpl, RpcServer, router, createTypedClient, ChannelClientBinding, ChannelServerBinding } from '@diy/rpc';
import { z } from 'zod';

// ═══════════════════════════════════════════════════
//  1. 定义 Renderer 侧的 API
// ═══════════════════════════════════════════════════

const rendererApi = router({
  ui: router({
    tree: RpcImpl.unary({
      input: { all: z.boolean().optional() },
      output: z.object({ status: z.string(), data: z.string() }),
      call: async ({ input }) => {
        console.log(`  [Renderer] ui.tree(all=${input.all})`);
        return { status: 'ok', data: '📂 项目根\n  ├── 任务1\n  └── 任务2' };
      },
    }),
    status: RpcImpl.unary({
      input: {},
      output: z.object({ status: z.string(), data: z.object({ pid: z.number(), uptime: z.number() }) }),
      call: async () => {
        console.log('  [Renderer] ui.status');
        return { status: 'ok', data: { pid: process.pid, uptime: 42 } };
      },
    }),
    toast: RpcImpl.unary({
      input: { message: z.string(), level: z.string().optional() },
      output: z.object({ status: z.string() }),
      call: async ({ input }) => {
        console.log(`  [Renderer] ui.toast("${input.message}")`);
        return { status: 'ok' };
      },
    }),
  }),
});

// ═══════════════════════════════════════════════════
//  2. EnvelopeTransport 桥接
//
//   │CLI txA│ ←──memA──→ │bridgeIn│
//                           │ pipe() │
//   │Renderer txB│ ←──memB──→ │rendererIn│
// ═══════════════════════════════════════════════════

// memA: CLI → bridgeIn
const { serverTx: cliTx, clientTx: bridgeA } = createMemTransportPair();
// memB: rendererIn → rendererTx（Renderer 内部用）
const { serverTx: rendererA, clientTx: rendererTx } = createMemTransportPair();

// pipe: bridgeA ↔ rendererA
const unsub1 = bridgeA.on((msg) => {
  console.log(`  [Bridge → Renderer] ${msg.type} ${msg.method ?? ''}`);
  rendererA.send(msg);
});
const unsub2 = rendererA.on((msg) => {
  console.log(`  [Bridge → CLI] ${msg.type} ${msg.method ?? ''}`);
  bridgeA.send(msg);
});

// ═══════════════════════════════════════════════════
//  3. Renderer 侧：RpcServer 注册 rendererApi
// ═══════════════════════════════════════════════════

console.log('\n[Renderer] 启动 RpcServer...');
const rendererServer = new RpcServer({ router: rendererApi });
rendererServer.registerInto(new ChannelServerBinding(rendererTx));

// ═══════════════════════════════════════════════════
//  4. CLI 侧：createTypedClient 直通 Renderer
// ═══════════════════════════════════════════════════

console.log('\n[CLI] 创建客户端...');
const cli = createTypedClient(new ChannelClientBinding(cliTx), rendererApi);

// ═══════════════════════════════════════════════════
//  5. 调用测试
// ═══════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════');
console.log('  CLI → Bridge → Renderer');
console.log('═══════════════════════════════════════\n');

// ui.tree
const tree = await cli.ui.tree({ all: true });
console.log(`  ✅ ui.tree = ${tree.status}`);
console.log(`     ${tree.data.replace(/\n/g, '\n     ')}`);

// ui.status
const status = await cli.ui.status({});
console.log(`  ✅ ui.status = ${status.status} (pid=${status.data.pid})`);

// ui.toast
const toast = await cli.ui.toast({ message: 'hello from CLI!' });
console.log(`  ✅ ui.toast = ${toast.status}`);

// ═══════════════════════════════════════════════════
//  6. 清理
// ═══════════════════════════════════════════════════

rendererServer.destroy();
unsub1();
unsub2();

console.log('\n═══════════════════════════════════════');
console.log('  全部通过！桥接模式验证成功');
console.log('═══════════════════════════════════════');
