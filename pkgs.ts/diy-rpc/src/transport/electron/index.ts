/**
 * electron/index.ts — Electron Transport 实现（第1层）
 *
 * 依赖：@diy/rpc（Transport/Envelope 类型）+ electron
 * 只在 Electron 主进程和 preload 中使用。
 */

import { ipcMain, ipcRenderer } from 'electron';
import type { WebContents } from 'electron';
import type { Transport, Envelope } from '../../core/types';

function makeMain(getWebContents: () => WebContents, channel = 'rpc'): Transport {
  return {
    send: (payload) => getWebContents().send(channel, payload),
    on: (h) => {
      const wrapped = (_event: unknown, ...args: unknown[]) => h(args[0] as Envelope);
      ipcMain.on(channel, wrapped as any);
      return () => { ipcMain.removeListener(channel, wrapped as any); };
    },
    onClose: (cb) => {
      const handler = () => cb();
      const wc = getWebContents();
      wc.on('destroyed', handler);
      return () => { wc.removeListener('destroyed', handler); };
    },
  };
}

function makeRenderer(channel = 'rpc'): Transport {
  return {
    send: (payload) => ipcRenderer.send(channel, payload),
    on: (h) => {
      const wrapped = (_event: unknown, ...args: unknown[]) => h(args[0] as Envelope);
      ipcRenderer.on(channel, wrapped as any);
      return () => { ipcRenderer.removeListener(channel, wrapped as any); };
    },
    onClose: (cb) => {
      window.addEventListener('beforeunload', cb);
      return () => window.removeEventListener('beforeunload', cb);
    },
  };
}

export function createMainTransport(getWebContents: () => WebContents, channel?: string): Transport {
  return makeMain(getWebContents, channel);
}

export function createRendererTransport(channel?: string): Transport {
  return makeRenderer(channel);
}
