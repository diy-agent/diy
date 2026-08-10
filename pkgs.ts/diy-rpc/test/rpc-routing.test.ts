/**
 * rpc-routing.test.ts — 多后端共享单一 binding 的路由归属验证
 *
 * 场景：CLI → Main（共享 ChannelServerBinding，本地 diy.app + 转发 diy.ui）→ Renderer
 *   - diy.app.* 由 Main 侧 binding.on 本地处理
 *   - diy.ui.* 由 binding.onForward 转发到 renderer 侧 binding
 *   - 两个后端注册进同一个 binding，路由归属 = binding 的 method→handler 表
 * 验证：本地/转发各归其位、方法名冲突（scope 冲突实质）由 binding 层显式报错。
 */

import type { EnvelopeTransport } from '../src/core/types';
import { it } from 'vitest';
import { z } from 'zod';
import {
  RpcSchema, router, createTypedClient,
} from '../src/index';
import { ChannelServerBinding } from '../src/core/channel-server-binding';
import { ChannelClientBinding } from '../src/core/channel-client-binding';

// ═══════════════════════════════════════════════════
//  def（模拟 app 层：diy.app 本地 + diy.ui 远端，router() 回写全名）
// ═══════════════════════════════════════════════════

const appApiDef = router({
  diy: {
    app: {
      ping: RpcSchema.unary({ input: { msg: z.string() }, output: z.string() }),
    },
    ui: {
      tree: RpcSchema.unary({ input: { all: z.boolean().optional() }, output: z.string() }),
      status: RpcSchema.unary({ input: {}, output: z.object({ pid: z.number() }) }),
    },
  },
});

function createMemTransportPair(): [EnvelopeTransport, EnvelopeTransport] {
  const qSrv: unknown[] = [];
  const qCli: unknown[] = [];
  const srvListeners = new Set<Function>();
  const cliListeners = new Set<Function>();
  function drain() {
    while (qSrv.length > 0) { const m = qSrv.shift()!; for (const h of cliListeners) h(m); }
    while (qCli.length > 0) { const m = qCli.shift()!; for (const h of srvListeners) h(m); }
    if (qSrv.length > 0 || qCli.length > 0) setImmediate(drain);
  }
  return [
    { send(p: unknown) { qSrv.push(p); setImmediate(drain); }, on(h: Function) { srvListeners.add(h); return () => srvListeners.delete(h); }, onClose() { return () => {}; } },
    { send(p: unknown) { qCli.push(p); setImmediate(drain); }, on(h: Function) { cliListeners.add(h); return () => cliListeners.delete(h); }, onClose() { return () => {}; } },
  ];
}

async function main() {
  let passed = 0;
  let failed = 0;
  function assert(cond: boolean, msg: string) {
    if (cond) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; throw new Error(msg); }
  }

  // ── 拓扑：cliTx ─ 共享 binding ← [本地 diy.app] + [onForward diy.ui → rendererTx] ──
  console.log('\n── 建立拓扑 ──');

  const [cliTx, gwTx] = createMemTransportPair();       // CLI ↔ Main(共享 binding)
  const [main2renderer, renderer2main] = createMemTransportPair(); // Main ↔ Renderer

  // Main 侧：共享来源 binding，本地 + 转发两个后端都注册进它
  const gwBinding = new ChannelServerBinding(gwTx);
  gwBinding.on(appApiDef.diy.app.ping, async ({ input }) => `pong:${input.msg}`); // diy.app.* → 本地
  gwBinding.onForward(appApiDef.diy.ui, new ChannelClientBinding(main2renderer));       // diy.ui.* → 转发

  // Renderer 侧：本地 ui binding（diy.ui.* 直接处理）
  const rendererBinding = new ChannelServerBinding(renderer2main);
  rendererBinding.on(appApiDef.diy.ui.tree, async ({ input }) => `tree:${input.all ?? false}`);
  rendererBinding.on(appApiDef.diy.ui.status, async () => ({ pid: 42 }));

  // CLI 侧：全量 client（完整 def，能调 diy.app.* 和 diy.ui.*）
  const cli = createTypedClient(new ChannelClientBinding(cliTx), appApiDef);

  // ── 断言 ──
  console.log('\n── 本地 diy.app.* ──');
  const pong = await cli.diy.app.ping({ msg: 'hi' });
  assert(pong === 'pong:hi', `diy.app.ping → ${pong}`);

  console.log('\n── 转发 diy.ui.* ──');
  const tree = await cli.diy.ui.tree({ all: true });
  assert(tree === 'tree:true', `diy.ui.tree(转发) → ${tree}`);
  const status = await cli.diy.ui.status({});
  assert(status.pid === 42, `diy.ui.status(转发) → pid=${status.pid}`);

  console.log('\n── 方法名冲突报错（scope 冲突的实质）──');
  let threw = false;
  // 第二个后端注册同名方法 diy.app.ping → binding 层显式报错
  const clashBinding = new ChannelServerBinding(gwTx);
  clashBinding.on(appApiDef.diy.app.ping, async ({ input }) => `pong:${input.msg}`);
  try {
    clashBinding.onForward(appApiDef.diy.app, new ChannelClientBinding(main2renderer));
  } catch (e) {
    threw = e instanceof Error && e.message.includes('已注册');
  }
  assert(threw, '重复注册同一方法名抛错');

  gwBinding.destroy();
  rendererBinding.destroy();

  console.log(`\n════════════════════════════════════════`);
  console.log(`  通过: ${passed}  失败: ${failed}`);
  console.log(`════════════════════════════════════════`);

}

it('rpc-routing: 多后端共享 binding 路由归属', async () => { await main(); });
