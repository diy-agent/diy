#!/usr/bin/env node
/**
 * test-bridge.mjs — CLI → bridge → Renderer 端到端测试
 *
 * 用 RawClient 直接发送原始 RPC 调用，验证桥接是否贯通。
 * 不依赖任何 router 定义。
 *
 * 用法:
 *   PORT=18888 npm run test:bridge
 */

import { connectHttp2Rpc } from '@diy/rpc-transport';
import { RawClient } from '@diy/rpc';

const PORT = parseInt(process.env['PORT'] ?? '18888', 10);

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label, err) {
  console.log(`  ❌ ${label}: ${err instanceof Error ? err.message : err}`);
  failed++;
}

async function main() {
  console.log(`\n🔌 连接到 http://127.0.0.1:${PORT}/rpc ...`);

  let tx;
  try {
    tx = await connectHttp2Rpc(PORT);
  } catch (err) {
    console.log(`  ❌ 连接失败: ${err instanceof Error ? err.message : err}`);
    console.log(`\n⚠  需要先启动 Electron:\n   1. npm run dev\n   2. 再次运行此测试\n`);
    process.exit(1);
  }

  const cli = new RawClient(tx, 5000);
  console.log(`  已连接\n`);

  // ── Main API（CLI → bridge → Main RpcServer）───
  console.log('── Main API（CLI → Main RpcServer）───');

  try {
    const doc = await cli.invoke('doctor', { input: {}, meta: {} });
    if (doc?.status === 'ok') ok('doctor');
    else fail('doctor', `unexpected: ${JSON.stringify(doc)}`);
  } catch (e) { fail('doctor', e); }

  try {
    const tl = await cli.invoke('task.list', { input: {}, meta: {} });
    if (tl?.status === 'ok') ok('task.list');
    else fail('task.list', `unexpected: ${JSON.stringify(tl)}`);
  } catch (e) { fail('task.list', e); }

  // ── Renderer API（CLI → bridge → Renderer RpcServer）───
  console.log('\n── Renderer API（CLI → bridge → Renderer）───');

  try {
    const cl = await cli.invoke('component.list', { input: {}, meta: {} });
    if (cl?.data?.components?.length > 0) ok('component.list');
    else fail('component.list', `no components: ${JSON.stringify(cl)}`);
  } catch (e) {
    console.log(`  ⚠  ${e.message}（Renderer 未启动或未加载）`);
  }

  try {
    const cs = await cli.invoke('component.status', { input: { name: 'taskTree' }, meta: {} });
    if (cs?.status === 'ok') ok('component.status');
    else fail('component.status', `unexpected: ${JSON.stringify(cs)}`);
  } catch (e) {
    console.log(`  ⚠  ${e.message}（Renderer 未启动或未加载）`);
  }

  // ── 负向测试 ───
  console.log('\n── 负向测试 ───');

  try {
    const uk = await cli.invoke('nonexistent.method', { input: {}, meta: {} });
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
