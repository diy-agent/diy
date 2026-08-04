/**
 * rpc-gateway.test.ts — RpcGateway 路由 + RpcForward 转发验证
 *
 * 场景：CLI → Main（gateway，本地 diy.app + 转发 diy.ui）→ Renderer
 *   - diy.app.* 由本进程 RpcServer 直接处理
 *   - diy.ui.* 由 RpcForward 转发到 renderer 侧 RpcServer
 * 验证：路由归属清晰、无广播、scope 冲突报错。
 */

import type { Transport } from '../src/transport/types';
import { z } from 'zod';
import {
  RpcSchema, RpcServer, RpcGateway, RpcForward, createTypedClient,
} from '../src/index';
import { RawServer } from '../src/rpc/raw-server';

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

function createMemTransportPair(): [Transport, Transport] {
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
    else { failed++; console.error(`  ❌ ${msg}`); }
  }

  // ── 拓扑：cliTx ─ gateway → [本地 appServer] + [forward → rendererTx] ──
  console.log('\n── 建立拓扑 ──');

  const [cliTx, gwTx] = createMemTransportPair();       // CLI ↔ Main(gateway)
  const [main2renderer, renderer2main] = createMemTransportPair(); // Main ↔ Renderer

  // Main 侧：本地 app server（scope diy.app，脱 transport）
  const appServer = new RpcServer({ router: appApiDef.diy.app, scope: 'diy.app' });
  appServer.on(appApiDef.diy.app.ping, async ({ input }) => `pong:${input.msg}`);

  // Main 侧：转发 diy.ui.* 到 renderer
  const uiForward = new RpcForward(main2renderer, { router: appApiDef.diy.ui, scope: 'diy.ui' });

  // Main 侧：gateway 绑来源 cliTx，注册本地 + 转发两个后端
  const gateway = new RpcGateway(gwTx)
    .register(appServer)
    .register(uiForward);

  // Renderer 侧：本地 ui server（scope diy.ui，脱 transport）
  const rendererServer = new RpcServer({ router: appApiDef.diy.ui, scope: 'diy.ui' });
  rendererServer.on(appApiDef.diy.ui.tree, async ({ input }) => `tree:${input.all ?? false}`);
  rendererServer.on(appApiDef.diy.ui.status, async () => ({ pid: 42 }));
  rendererServer.registerInto(new RawServer(renderer2main));

  // CLI 侧：全量 client（完整 def，能调 diy.app.* 和 diy.ui.*）
  const cli = createTypedClient(cliTx, appApiDef);

  // ── 断言 ──
  console.log('\n── 本地 diy.app.* ──');
  const pong = await cli.diy.app.ping({ msg: 'hi' });
  assert(pong === 'pong:hi', `diy.app.ping → ${pong}`);

  console.log('\n── 转发 diy.ui.* ──');
  const tree = await cli.diy.ui.tree({ all: true });
  assert(tree === 'tree:true', `diy.ui.tree(转发) → ${tree}`);
  const status = await cli.diy.ui.status({});
  assert(status.pid === 42, `diy.ui.status(转发) → pid=${status.pid}`);

  console.log('\n── scope 冲突报错 ──');
  let threw = false;
  try {
    new RpcGateway(gwTx).register(appServer).register(appServer);
  } catch (e) {
    threw = e instanceof Error && e.message.includes('已注册');
  }
  assert(threw, '重复 register 同一 scope 抛错');

  gateway.destroy();
  appServer.destroy();
  rendererServer.destroy();

  console.log(`\n════════════════════════════════════════`);
  console.log(`  通过: ${passed}  失败: ${failed}`);
  console.log(`════════════════════════════════════════`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
