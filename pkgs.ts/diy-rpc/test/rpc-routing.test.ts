/**
 * rpc-routing.test.ts — 多后端共享单一 binding 的路由归属验证
 *
 * 场景：CLI → Main（共享 ChannelServerBinding，本地 diy.app + 转发 diy.ui）→ Renderer
 *   - diy.app.* 由本进程 RpcServer 直接处理
 *   - diy.ui.* 由 RpcForward 转发到 renderer 侧 RpcServer
 *   - 两个后端 registerInto 同一个 binding，路由归属 = binding 的 method→handler 表
 * 验证：本地/转发各归其位、方法名冲突（scope 冲突实质）由 binding 层显式报错。
 */

import type { EnvelopeTransport } from '../src/core/types';
import { it } from 'vitest';
import { z } from 'zod';
import {
  RpcSchema, RpcServer, RpcForward, createTypedClient,
} from '../src/index';
import { ChannelServerBinding } from '../src/core/channel-server-binding';
import { ChannelClientBinding } from '../src/core/channel-client-binding';

// ═══════════════════════════════════════════════════
//  def（模拟 app 层：diy.app 本地 + diy.ui 远端）
// ═══════════════════════════════════════════════════

const appApiDef = {
  diy: {
    app: {
      ping: RpcSchema.unary({ input: { msg: z.string() }, output: z.string() }),
    },
    ui: {
      tree: RpcSchema.unary({ input: { all: z.boolean().optional() }, output: z.string() }),
      status: RpcSchema.unary({ input: {}, output: z.object({ pid: z.number() }) }),
    },
  },
} as const;

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

  // ── 拓扑：cliTx ─ 共享 binding ← [本地 appServer] + [forward → rendererTx] ──
  console.log('\n── 建立拓扑 ──');

  const [cliTx, gwTx] = createMemTransportPair();       // CLI ↔ Main(共享 binding)
  const [main2renderer, renderer2main] = createMemTransportPair(); // Main ↔ Renderer

  // Main 侧：本地 app server（scope diy.app，脱 transport）
  const appServer = new RpcServer({ router: appApiDef.diy.app, scope: 'diy.app' });
  appServer.on(appApiDef.diy.app.ping, async ({ input }) => `pong:${input.msg}`);

  // Main 侧：转发 diy.ui.* 到 renderer（RpcForward 持有连远端的 client，不持有来源 binding）
  const uiForward = new RpcForward(main2renderer, { router: appApiDef.diy.ui, scope: 'diy.ui' });

  // Main 侧：两个后端直接 registerInto 共享同一个来源 binding
  const gwBinding = new ChannelServerBinding(gwTx);
  appServer.registerInto(gwBinding);    // diy.app.* → 本地
  uiForward.registerInto(gwBinding);    // diy.ui.* → 转发

  // Renderer 侧：本地 ui server（scope diy.ui，脱 transport）
  const rendererServer = new RpcServer({ router: appApiDef.diy.ui, scope: 'diy.ui' });
  rendererServer.on(appApiDef.diy.ui.tree, async ({ input }) => `tree:${input.all ?? false}`);
  rendererServer.on(appApiDef.diy.ui.status, async () => ({ pid: 42 }));
  rendererServer.registerInto(new ChannelServerBinding(renderer2main));

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
  // 第一个后端把 diy.app.ping 注册进 clashBinding
  const clashBinding = new ChannelServerBinding(gwTx);
  const clashSrv = new RpcServer({ router: appApiDef.diy.app, scope: 'diy.app', binding: clashBinding });
  clashSrv.on(appApiDef.diy.app.ping, async ({ input }) => `pong:${input.msg}`);
  // 第二个后端（转发）注册同名 diy.app.ping → binding 层显式报错
  const clashForward = new RpcForward(main2renderer, { router: appApiDef.diy.app, scope: 'diy.app' });
  try {
    clashForward.registerInto(clashBinding);
  } catch (e) {
    threw = e instanceof Error && e.message.includes('已注册');
  }
  assert(threw, '重复注册同一方法名抛错');

  console.log('\n── RpcServer 重复挂载报错 ──');
  threw = false;
  const dupSrv = new RpcServer({ router: appApiDef.diy.app, scope: 'diy.app' });
  dupSrv.registerInto(new ChannelServerBinding(gwTx));
  try {
    dupSrv.registerInto(new ChannelServerBinding(gwTx));
  } catch (e) {
    threw = e instanceof Error && e.message.includes('已挂载');
  }
  assert(threw, '一个 RpcServer 重复 registerInto 抛错');

  appServer.destroy();
  rendererServer.destroy();

  console.log(`\n════════════════════════════════════════`);
  console.log(`  通过: ${passed}  失败: ${failed}`);
  console.log(`════════════════════════════════════════`);

}

it('rpc-routing: 多后端共享 binding 路由归属', async () => { await main(); });
