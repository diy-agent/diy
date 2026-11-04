// renderer.ts — 渲染进程侧传输（preload / renderer 才能 import）。
//
// 2026-11-05 拆自 index.ts，原因见 main.ts 头注：
// main 与 renderer 必须分开 import，否则主进程加载 `electron` 时找不到 ipcRenderer。

import { ipcRenderer } from 'electron';
import type { EnvelopeTransport, _Envelope } from '../../core/types.js';

const MAX_EARLY_PENDING = 256;

/**
 * 渲染进程侧传输。
 *
 * 为什么在**本函数调用时**（preload 顶层）就挂 ipcRenderer 监听，而不是等 `on()`：
 * `ipcRenderer` 的消息**不缓存**——早到的消息直接丢，调用方则永久挂起（无超时）。
 * 而 main 侧的发送时机可以早于 renderer JS 执行：
 *   main/index.ts 启动顺序 = createWindow() → startRpcPort()（**app.port 落盘 = CLI 认为就绪**）
 *   → applyWindowTitle() → loadMainApp()（此刻 renderer 才开始加载 JS）。
 * 于是任何「app 就绪后立刻发起的 diy.ui.*」都可能在 renderer 的 `ChannelServerBinding`
 * 注册前发出 → 丢失 → 调用挂死。
 *
 * 实测（任务 223）：curl 直打 /cli 的 ui.page.navigate 在 app.port 出现后 113ms 发出，
 * 而 renderer 首个 console 落在 565ms 后 → 该调用 40s 不返回（直到窗口销毁）才报 disposed。
 * 直连 CLI 只因 node 启动 ~600ms 的延迟偶然躲过，属**潜在竞态**，非 http 模式特有。
 *
 * 修法：preload 执行期即开始接消息；订阅者（renderer 的 RPC 绑定）未就绪时先入队，
 * `on()` 时补投 —— 语义从「早到即丢」变为「等订阅者就绪再投」。
 */
function makeRenderer(channel = 'rpc'): EnvelopeTransport {
  // preload 重载（页面 reload）会重跑本函数：先清掉上一轮的监听，避免同一条消息被
  // 多个残留监听器重复投递（本 channel 由本模块独占，见 createRendererTransport 的唯一调用点）。
  ipcRenderer.removeAllListeners(channel);

  const pending: _Envelope[] = [];
  let dropped = 0;
  const handlers = new Set<(msg: _Envelope) => void>();

  ipcRenderer.on(channel, (_event: unknown, ...args: unknown[]) => {
    const msg = args[0] as _Envelope;
    if (handlers.size > 0) {
      for (const h of handlers) h(msg);
      return;
    }
    if (pending.length >= MAX_EARLY_PENDING) {
      dropped++;
      if (dropped === 1 || dropped % 50 === 0) {
        console.warn(`[rpc] renderer 未就绪，已丢弃 ${dropped} 条早期消息（上限 ${MAX_EARLY_PENDING}）`);
      }
      return;
    }
    pending.push(msg);
  });

  return {
    send: (payload) => ipcRenderer.send(channel, payload),
    on: (h) => {
      handlers.add(h);
      if (pending.length > 0) {
        // 补投早到的消息（顺序与到达一致）
        const early = pending.splice(0, pending.length);
        for (const msg of early) h(msg);
      }
      return () => { handlers.delete(h); };
    },
    onClose: (cb) => {
      window.addEventListener('beforeunload', cb);
      return () => window.removeEventListener('beforeunload', cb);
    },
  };
}

export function createRendererTransport(channel?: string): EnvelopeTransport {
  return makeRenderer(channel);
}
