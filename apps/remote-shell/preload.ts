// preload.ts — 远程页面这一侧的唯一一座桥：**只读**「当前位置」。
//
// 远程页面可以问 `await window.diyShell.current()`，拿到 { endpoint, displayName, status }；
// 不能切换、不能改状态、不能碰横条 —— 那些都在壳里（横条有自己独立的 webContents 与 preload）。
//
// contextIsolation + sandbox 打开时 renderer 拿不到 Node，只能走这里；
// 通道名来自 channels.ts（与主进程同一份常量，别手写字符串）。

import { contextBridge, ipcRenderer } from 'electron';
import { SHELL_CURRENT_CHANNEL, type ShellBridge } from './channels.js';
import type { CurrentInstance } from './index.js';

const bridge: ShellBridge = {
    current: () => ipcRenderer.invoke(SHELL_CURRENT_CHANNEL) as Promise<CurrentInstance | null>,
};

contextBridge.exposeInMainWorld('diyShell', bridge);
