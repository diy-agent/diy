/**
 * electron/index.ts — Electron EnvelopeTransport 实现（第1层）
 *
 * 依赖：@diy/rpc（EnvelopeTransport/_Envelope 类型）+ electron
 * 只在 Electron 主进程和 preload 中使用。
 *
 * 安全机制：
 *   makeMain.send() 包裹 try-catch：渲染进程崩溃（frame disposed）时
 *   首次 send 失败 → 标记 dead → 触发 onClose 回调 → 后续 send 静默 no-op。
 *   上层 ChannelServerBinding 订阅 onClose 自动 destroy（取消所有流）。
 */

import { ipcMain, ipcRenderer } from 'electron';
import type { WebContents } from 'electron';
import type { EnvelopeTransport, _Envelope } from '../../core/types';

/**
 * renderer 就绪前的 main→renderer 消息闸门上限（超出丢弃并计数，防页面永不加载时堆积）。
 * 见 makeMain 的注释：这类消息早发会**永久丢失**，不是延迟。
 */
const MAX_PRELOAD_QUEUE = 512;

function makeMain(getWebContents: () => WebContents, channel = 'rpc'): EnvelopeTransport {
  let dead = false;
  const closeCallbacks: Array<() => void> = [];

  const fireClose = () => {
    if (dead) return;
    dead = true;
    for (const cb of closeCallbacks) {
      try { cb(); } catch { /* 回调异常不扩散 */ }
    }
  };

  const rawSend = (payload: unknown): void => {
    if (dead) return; // 渲染进程已死，静默丢弃
    try {
      getWebContents().send(channel, payload);
    } catch {
      // Render frame disposed / WebContents destroyed — 标记死亡并通知上层
      fireClose();
    }
  };

  // ── renderer 就绪闸门（任务 223 实测的时序坑）──
  //
  // `webContents.send` 在 renderer 页面**加载完成前**发出 = 被 Chromium 静默丢弃，
  // 接收方（renderer 的 RPC 绑定）永远等不到 → 调用方永久挂起。实测时间线：
  //   窗口创建 → RPC 端口就绪（app.port 落盘，CLI 认为可用）→ loadMainApp()
  //   → preload 执行 → 页面 JS 注册绑定
  // 其中「app.port 就绪」比「preload 执行」早 ~80ms，比「绑定注册」更早；
  // 于是任何在 app 就绪后立刻发起的 diy.ui.* 都会丢（直连 CLI 只因 node 启动
  // ~600ms 的延迟偶然躲过，是**潜在竞态**，非某个入口特有）。
  //
  // 修法：就绪前入队，`did-finish-load`（页面模块脚本执行完、绑定已订阅）后按序补发。
  // 拿不到 webContents 时不闸（保持原行为）。
  let ready = true;
  const gateQueue: _Envelope[] = [];
  let gatedDropped = 0;
  try {
    const wc = getWebContents();
    ready = false;
    wc.once('did-finish-load', () => {
      ready = true;
      const queued = gateQueue.splice(0, gateQueue.length);
      for (const payload of queued) rawSend(payload);
    });
  } catch {
    ready = true; // 探测失败：不引入闸门，走原路径
  }

  return {
    send: (payload) => {
      if (!ready) {
        if (gateQueue.length >= MAX_PRELOAD_QUEUE) {
          gatedDropped++;
          if (gatedDropped === 1 || gatedDropped % 50 === 0) {
            console.warn(`[rpc] renderer 未就绪，已丢弃 ${gatedDropped} 条消息（上限 ${MAX_PRELOAD_QUEUE}）`);
          }
          return;
        }
        gateQueue.push(payload as _Envelope);
        return;
      }
      rawSend(payload);
    },
    on: (h) => {
      const wrapped = (_event: unknown, ...args: unknown[]) => h(args[0] as _Envelope);
      ipcMain.on(channel, wrapped as any);
      return () => { ipcMain.removeListener(channel, wrapped as any); };
    },
    onClose: (cb) => {
      closeCallbacks.push(cb);
      // 同时挂 webContents.destroyed 作为备用触发（窗口正常关闭路径）
      const wc = getWebContents();
      const handler = () => fireClose();
      wc.on('destroyed', handler);
      return () => {
        wc.removeListener('destroyed', handler);
        const idx = closeCallbacks.indexOf(cb);
        if (idx >= 0) closeCallbacks.splice(idx, 1);
      };
    },
  };
}

/**
 * main → renderer 的**早期消息缓冲**上限（超出即丢弃并计数，防 renderer 永不就绪时堆积）。
 * 见 makeRenderer 的长注释：窗口创建到 renderer 注册绑定之间到达的消息必须留住。
 */
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

export function createMainTransport(getWebContents: () => WebContents, channel?: string): EnvelopeTransport {
  return makeMain(getWebContents, channel);
}

export function createRendererTransport(channel?: string): EnvelopeTransport {
  return makeRenderer(channel);
}
