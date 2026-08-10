#!/usr/bin/env npx tsx
/**
 * test-bridge.ts — CLI → gateway → Renderer 端到端测试（强类型版本）
 *
 * 用 api-def（含 diy.app + diy.ui 合并）的 meta（zod schema）通过
 * createTypedClient 获得全类型推导客户端。
 *
 * 命名体系：
 *   diy.app.* — Main 进程（bindAppHandlers，本地处理）
 *   diy.ui.*  — Renderer 进程（Main 经 onForward 转发）
 *
 * 用法:
 *   PORT=18888 npm run test:bridge
 */

import { HttpClientBinding } from '@diy/rpc/http';
import { createTypedClient } from '@diy/rpc';
import { apiDef } from '../src/main/services/api-def';

const PORT = parseInt(process.env['PORT'] ?? '18888', 10);

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
  console.log(`\n🔌 连接到 http://127.0.0.1:${PORT} ...`);

  const raw = new HttpClientBinding(`http://127.0.0.1:${PORT}`);
  await raw.ready();

  // ── 强类型客户端 — createTypedClient 从 meta zod 推导完整方法签名 ──
  const cli = createTypedClient(raw, apiDef);
  console.log('  已连接\n');

  // ── Main API（CLI → Main）───
  console.log('── Main API（CLI → Main）───');

  try {
    const doc = await cli.diy.app.doctor({});
    if (doc.status === 'ok') ok('doctor');
    else fail('doctor', `unexpected: ${JSON.stringify(doc)}`);
  } catch (e) { fail('doctor', e); }

  try {
    const tl = await cli.diy.app.task.list({ subject: undefined });
    if (tl.status === 'ok') ok('task.list');
    else fail('task.list', `unexpected: ${JSON.stringify(tl)}`);
  } catch (e) { fail('task.list', e); }

  // ── Renderer API（CLI → bridge → Renderer）───
  console.log('\n── Renderer API（CLI → bridge → Renderer）───');

  try {
    const cl = await cli.diy.ui.component.list({});
    if (cl.status === 'ok' && cl.data.components.length > 0) ok('diy.ui.component.list');
    else fail('diy.ui.component.list', `no components: ${JSON.stringify(cl)}`);
  } catch (e) {
    console.log(`  ⚠  ${(e as Error).message}（Renderer 未启动或未加载）`);
  }

  try {
    const cs = await cli.diy.ui.component.status({ name: 'taskTree' });
    if (cs.status === 'ok') ok('diy.ui.component.status');
    else fail('diy.ui.component.status', `unexpected: ${JSON.stringify(cs)}`);
  } catch (e) {
    console.log(`  ⚠  ${(e as Error).message}（Renderer 未启动或未加载）`);
  }

  try {
    const pi = await cli.diy.ui.page.info({});
    if (pi.status === 'ok') ok('diy.ui.page.info');
    else fail('diy.ui.page.info', `unexpected: ${JSON.stringify(pi)}`);
  } catch (e) {
    console.log(`  ⚠  ${(e as Error).message}（Renderer 未启动或未加载）`);
  }

  // ── 负向测试 ───
  console.log('\n── 负向测试 ───');

  try {
    const uk = await raw.invoke('nonexistent.method', { input: {}, meta: {} });
    console.log(`  ⚠  unknown method returned: ${JSON.stringify(uk)}（无 handler → 超时或 undefined）`);
  } catch (e) {
    console.log(`  ⚠  unknown method 报错（预期行为）：${(e as Error).message}`);
  }

  // ── 结果 ──
  const total = passed + failed;
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  通过: ${passed}  失败: ${failed}  总计: ${total}`);
  console.log(`═══════════════════════════════════════`);

  raw.dispose();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
