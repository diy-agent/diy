// index.ts — 工作台主进程外壳：开窗口 + 一条 `page:invoke` 通道（转发到插件的方法表）。
//
// 用法（宿主装配入口）：
//   import { app } from 'electron';
//   import { createWorkbench } from '@diy/workbench';
//   const wb = await createWorkbench({
//       plugins: [{ id: 'my-page', name: '@scope/my-page/main' }],
//       preloadFile: '/abs/preload/index.cjs',
//       rendererFile: '/abs/renderer/index.html',
//   });
//   app.on('window-all-closed', () => app.quit());
//
// 边界：本包**不认识任何具体页面**（不 import 页面插件、不读业务数据）。
// 页面清单来自 plugins 清单，页面行为来自插件导出的 methods —— 加页面不改本包。

import { app, BrowserWindow, ipcMain } from "electron";
import { WorkbenchError } from "./errors.js";
import { loadPages, type ModuleLoader, type PluginEntry } from "./loader.js";
import type { PageContribution, PageInfo } from "./page.js";
import { PAGE_INVOKE_CHANNEL, PAGE_LIST_CHANNEL, type PageInvokeRequest } from "./channels.js";

export { WorkbenchError } from "./errors.js";
export { orderPlugins, loadPages } from "./loader.js";
export { PAGE_INVOKE_CHANNEL, PAGE_LIST_CHANNEL } from "./channels.js";
export type { ModuleLoader, PluginEntry } from "./loader.js";
export type { PageContribution, PageInfo, PageMethod } from "./page.js";
export type { PageInvokeRequest, WorkbenchBridge } from "./channels.js";

export interface CreateWorkbenchOptions {
    /** 窗口标题（与页面标题无关） */
    readonly title?: string;
    /** 插件清单（按 inject 排序加载） */
    readonly plugins: readonly PluginEntry[];
    /** preload 脚本绝对路径 */
    readonly preloadFile: string;
    /** renderer 入口 html 绝对路径 */
    readonly rendererFile: string;
    readonly width?: number;
    readonly height?: number;
    /** 可注入的模块加载器（单测 / 特殊宿主用） */
    readonly load?: ModuleLoader;
}

/** 外壳句柄：拿页面清单、直接调方法（测试 / 无窗口场景），以及释放 */
export interface Workbench {
    listPages(): PageInfo[];
    invoke(pageId: string, method: string, args?: unknown): Promise<unknown>;
    window(): BrowserWindow | null;
    dispose(): void;
}

export async function createWorkbench(options: CreateWorkbenchOptions): Promise<Workbench> {
    const contributions = await loadPages(options.plugins, options.load);
    const byId = new Map<string, PageContribution>(contributions.map((page) => [page.id, page]));

    const listPages = (): PageInfo[] => contributions.map(({ id, title }) => ({ id, title }));

    const invoke = async (pageId: string, method: string, args?: unknown): Promise<unknown> => {
        const page = byId.get(pageId);
        if (!page) {
            throw new WorkbenchError("workbench/unknown-page", `没有这个页面：${pageId}`);
        }
        const fn = page.methods?.[method];
        if (typeof fn !== "function") {
            throw new WorkbenchError("workbench/unknown-method", `页面 ${pageId} 没有方法 ${method}`);
        }
        return fn(args);
    };

    ipcMain.handle(PAGE_LIST_CHANNEL, () => listPages());
    ipcMain.handle(PAGE_INVOKE_CHANNEL, (_event, request: PageInvokeRequest) => {
        if (!request || typeof request.pageId !== "string" || typeof request.method !== "string") {
            throw new WorkbenchError("workbench/bad-invoke", "page:invoke 的请求必须是 { pageId, method, args? }");
        }
        return invoke(request.pageId, request.method, request.args);
    });

    await app.whenReady();

    const win = new BrowserWindow({
        title: options.title ?? "Workbench",
        width: options.width ?? 1040,
        height: options.height ?? 720,
        show: true,
        webPreferences: {
            preload: options.preloadFile,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.on("closed", () => disposeHandlers());
    await win.loadFile(options.rendererFile);

    const disposeHandlers = (): void => {
        ipcMain.removeHandler(PAGE_LIST_CHANNEL);
        ipcMain.removeHandler(PAGE_INVOKE_CHANNEL);
    };

    return {
        listPages,
        invoke,
        window: () => (win.isDestroyed() ? null : win),
        dispose: () => {
            disposeHandlers();
            if (!win.isDestroyed()) win.close();
        },
    };
}
