#!/usr/bin/env node
/**
 * test-bridge.mjs — CLI → bridge → Renderer 端到端测试
 *
 * 用 RawClient 直接发送原始 RPC 调用，验证桥接是否贯通。
 * 不依赖任何 router 定义，适合快速验证。
 *
 * 用法:
 *   npm run cli -- test:bridge              # 端口 18888
 *   PORT=18889 node bin/test-bridge.mjs     # 自定义端口
 */

import { connectHttp2Rpc } from '@diy/rpc-transport';
import { RawClient } from '@diy/rpc';

const PORT = parseInt(process.env['PORT'] ?? '18888', 10);

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     实际: ${JSON.stringify(actual)}`);
    console.log(`     期望: ${JSON.stringify(expected)}`);
    failed++;
  }
}

function assertMatch(label, actual, predicate) {
  const ok = predicate(actual);
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     实际: ${JSON.stringify(actual)}`);
    failed++;
  }
}

async function main() {
  console.log(`\n🔌 连接到 http://127.0.0.1:${PORT}/rpc ...`);

  let tx;
  try {
    tx = await connectHttp2Rpc(PORT);
  } catch (err) {
    console.log(`  ❌ 连接失败: ${err instanceof Error ? err.message : err}`);
    console.log(`\n⚠  Electron 管控台未启动或无响应。`);
    console.log(`   1. npm run dev    # 启动 Electron + RPC 端口`);
    console.log(`   2. 再次运行此测试\n`);
    process.exit(1);
  }

  const cli = new RawClient(tx, 5000); // 5s timeout

  console.log(`  已连接\n`);

  // ── Test 1: rendererApi 服务（通过 bridge 直达 Renderer） ─────────
  console.log('── Renderer API（CLI → bridge → Renderer）───');

  const compList = await cli.invoke('component.list', { input: {}, meta: {} });
  assert('component.list 返回 status=ok', compList.status, 'ok');
  assertMatch('component.list 包含 taskTree', compList, (r) =>
    r.data?.components?.some(c => c.name === 'taskTree')
  );

  const compStatus = await cli.invoke('component.status', {
    input: { name: 'taskTree' },
    meta: {},
  });
  assert('component.status 返回 status=ok', compStatus.status, 'ok');
  assert('component.status 返回 visible=true', compStatus.data?.visible, true);

  const pageInfo = await cli.invoke('page.info', { input: {}, meta: {} });
  assert('page.info 返回 status=ok', pageInfo.status, 'ok');
  assertMatch('page.info 包含 title', pageInfo, (r) => typeof r.data?.title === 'string');

  // ── Test 2: Main API（通过 bridge + 主进程 RpcServer） ────────────
  console.log('\n── Main API（CLI → bridge → Main RpcServer）───');

  const doc = await cli.invoke('doctor', { input: {}, meta: {} });
  assert('doctor 返回 status=ok', doc.status, 'ok');

  const taskList = await cli.invoke('task.list', { input: {}, meta: {} });
  assert('task.list 返回 status=ok', taskList.status, 'ok');

  // ── Test 3: 未注册的 method（应返回 undefined / 超时） ────────────
  console.log('\n── 负向测试 ───');

  try {
    const unknown = await cli.invoke('nonexistent.method', { input: {}, meta: {} });
    console.log('  ⚠ nonexistent.method 未报错（无 handler 的 call 被忽略）');
    if (unknown === undefined) {
      console.log('  （返回 undefined，符合预期）');
      passed++;
    }
  } catch {
    console.log('  ❌ nonexistent.method 报错了');
    failed++;
  }

  // ── 结果 ──
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  通过: ${passed}  失败: ${failed}`);
  console.log(`═══════════════════════════════════════`);

  tx.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n❌ 测试执行失败: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
