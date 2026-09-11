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

  return {
    send: (payload) => {
      if (dead) return; // 渲染进程已死，静默丢弃
      try {
        getWebContents().send(channel, payload);
      } catch {
        // Render frame disposed / WebContents destroyed — 标记死亡并通知上层
        fireClose();
      }
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

function makeRenderer(channel = 'rpc'): EnvelopeTransport {
  return {
    send: (payload) => ipcRenderer.send(channel, payload),
    on: (h) => {
      const wrapped = (_event: unknown, ...args: unknown[]) => h(args[0] as _Envelope);
      ipcRenderer.on(channel, wrapped as any);
      return () => { ipcRenderer.removeListener(channel, wrapped as any); };
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
