#!/usr/bin/env npx tsx
/**
 * test-bridge.ts — CLI → bridge → Renderer 端到端测试（强类型版本）
 *
 * 用 api-def + renderer-api-def 的 meta（zod schema）通过 createTypedClient
 * 获得全类型推导客户端，替代 RawClient 字符串调用。
 *
 * 命名体系：
 *   diy.desktop.*            — Main 进程（RpcServer: bindApi）
 *   diy.desktop.renderer.*   — Renderer 进程（RpcServer: bindRendererApi, 桥接穿透）
 *
 * 用法:
 *   PORT=18888 npm run test:bridge
 */

import { connectHttp2Rpc } from '@diy/rpc-transport';
import type { Http2Transport } from '@diy/rpc-transport';
import { createTypedClient, RawClient } from '@diy/rpc';
import { apiDef } from '../src/main/services/api-def';
import { rendererApiDef } from '../src/renderer/components-diy/lib/renderer-api-def';

const PORT = parseInt(process.env['PORT'] ?? '18888', 10);

// 合并两个 def — 同一 transport 上的 Main + Renderer RpcServer
const app = {
  ...apiDef,
  ...rendererApiDef,
} as const;

// ═══════════════════════════════════════════════════
//  测试运行
// ═══════════════════════════════════════════════════

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label: string, err: unknown) {
  console.log(`  ❌ ${label}: ${err instanceof Error ? err.message : err}`);
  failed++;
}

async function main(): Promise<void> {
  console.log(`\n🔌 连接到 http://127.0.0.1:${PORT}/rpc ...`);

  const tx: Http2Transport = await connectHttp2Rpc(PORT);

  // ── 强类型客户端 — createTypedClient 从 meta zod 推导完整方法签名 ──
  const cli = createTypedClient(tx, app);
  console.log('  已连接\n');

  // ── Main API（CLI → Main RpcServer）───
  console.log('── Main API（CLI → Main RpcServer）───');

  try {
    const doc = await cli.doctor({});
    if (doc.status === 'ok') ok('doctor');
    else fail('doctor', `unexpected: ${JSON.stringify(doc)}`);
  } catch (e) { fail('doctor', e); }

  try {
    const tl = await cli.task.list({ subject: undefined });
    if (tl.status === 'ok') ok('task.list');
    else fail('task.list', `unexpected: ${JSON.stringify(tl)}`);
  } catch (e) { fail('task.list', e); }

  // ── Renderer API（CLI → bridge → Renderer RpcServer）───
  console.log('\n── Renderer API（CLI → bridge → Renderer）───');

  try {
    const cl = await cli.diy.desktop.renderer.component.list({});
    if (cl.status === 'ok' && cl.data.components.length > 0) ok('diy.desktop.renderer.component.list');
    else fail('diy.desktop.renderer.component.list', `no components: ${JSON.stringify(cl)}`);
  } catch (e) {
    console.log(`  ⚠  ${(e as Error).message}（Renderer 未启动或未加载）`);
  }

  try {
    const cs = await cli.diy.desktop.renderer.component.status({ name: 'taskTree' });
    if (cs.status === 'ok') ok('diy.desktop.renderer.component.status');
    else fail('diy.desktop.renderer.component.status', `unexpected: ${JSON.stringify(cs)}`);
  } catch (e) {
    console.log(`  ⚠  ${(e as Error).message}（Renderer 未启动或未加载）`);
  }

  try {
    const pi = await cli.diy.desktop.renderer.page.info({});
    if (pi.status === 'ok') ok('diy.desktop.renderer.page.info');
    else fail('diy.desktop.renderer.page.info', `unexpected: ${JSON.stringify(pi)}`);
  } catch (e) {
    console.log(`  ⚠  ${(e as Error).message}（Renderer 未启动或未加载）`);
  }

  // ── 负向测试 ───
  console.log('\n── 负向测试 ───');

  try {
    const raw = new RawClient(tx, 5000);
    const uk = await raw.invoke('nonexistent.method', { input: {}, meta: {} });
    console.log(`  ⚠  unknown method returned: ${JSON.stringify(uk)}（无 handler → 超时或 undefined）`);
  } catch (e) {
    console.log(`  ⚠  unknown method 超时（预期行为）`);
  }

  // ── 结果 ──
  const total = passed + failed;
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  通过: ${passed}  失败: ${failed}  总计: ${total}`);
  console.log(`═══════════════════════════════════════`);

  tx.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
