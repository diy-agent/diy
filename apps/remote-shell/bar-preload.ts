// bar-preload.ts — 横条页专用的桥（横条是**本地** data: 页，与远程页面互不共享 webContents）。
//
// 横条只拿到四件事：读状态、连接、重新发现、布局自述。
// 注意这里**没有**「确认 / 拦截」一类的方法 —— 本壳按本机操作一致原则，不做二次确认。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { BAR_INVOKE_CHANNEL, BAR_STATE_CHANNEL, type BarBridge, type BarRequest } from './channels.js';
import type { BarState, ShellLayout } from './index.js';

function invoke(request: BarRequest): Promise<unknown> {
    return ipcRenderer.invoke(BAR_INVOKE_CHANNEL, request) as Promise<unknown>;
}

const bridge: BarBridge = {
    getState: () => invoke({ method: 'state' }) as Promise<BarState>,
    connect: (endpoint: string) => invoke({ method: 'connect', endpoint }).then(() => undefined),
    refresh: () => invoke({ method: 'refresh' }).then(() => undefined),
    layout: () => invoke({ method: 'layout' }) as Promise<ShellLayout>,
    onState: (handler: (state: BarState) => void) => {
        const listener = (_event: IpcRendererEvent, state: BarState): void => handler(state);
        ipcRenderer.on(BAR_STATE_CHANNEL, listener);
        return () => {
            ipcRenderer.removeListener(BAR_STATE_CHANNEL, listener);
        };
    },
};

contextBridge.exposeInMainWorld('diyBar', bridge);
