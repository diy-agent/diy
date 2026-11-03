import { EventEmitter } from 'node:events';
import { createMainTransport } from '../src/transport/electron/index';

/**
 * 剩余项探针：Electron main transport 的 close 语义（R19 §四 覆盖缺口）。
 *
 * 真实 Electron 主进程需要 GUI 环境，无法在 CI/无头下稳定运行；这里用与
 * `makeMain(getWebContents)` 完全同构的假 WebContents 钉住两条真实分支：
 *   A. send() 抛错（渲染进程崩溃 / frame disposed）→ 标记 dead + 触发 onClose + 后续静默 no-op；
 *   B. webContents 'destroyed'（窗口正常关闭）→ 触发 onClose。
 *
 * 覆盖的是 transport 的真实判定逻辑（src/transport/electron/index.ts），
 * 而非内存 Channel 替身，因此能证明 RPC 层确实收到 close 并会 destroy 流。
 */
class FakeWebContents extends EventEmitter {
  disposed = false;
  send(): void {
    if (this.disposed) throw new Error('Render frame was disposed');
  }
}

async function main() {
  // A. send 抛错 → dead + onClose + 静默
  const wcA = new FakeWebContents();
  const a = createMainTransport(() => wcA as any, 'rpc-a');
  let aClosed = 0;
  let aSends = 0;
  a.onClose(() => { aClosed++; });
  a.send({ type: 'call', id: 1 });
  aSends++;
  wcA.disposed = true;
  a.send({ type: 'call', id: 2 }); // 第一次失败 → fireClose
  let threwAfterDead = '';
  try { a.send({ type: 'call', id: 3 }); } catch (e: any) { threwAfterDead = String(e?.message ?? e); }

  // B. destroyed 事件
  const wcB = new FakeWebContents();
  const b = createMainTransport(() => wcB as any, 'rpc-b');
  let bClosed = 0;
  b.onClose(() => { bClosed++; });
  wcB.emit('destroyed');

  console.log('[electron-transport-close]', {
    aClosed, aSends, threwAfterDead,
    bClosed,
  });

  const ok = aClosed === 1 && threwAfterDead === '' && bClosed === 1;
  if (!ok) {
    console.error('FAIL: electron transport did not converge to a closed state on send-failure/destroy');
    process.exitCode = 1;
  } else {
    console.log('PASS: electron main transport fires onClose on send-failure and webContents destroy');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
