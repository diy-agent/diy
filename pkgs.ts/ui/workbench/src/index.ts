// index.ts — 工作台主进程外壳：开窗口 + 一条 `page:invoke` 通道（转发到插件的方法表）。
//
// 用法（宿主装配入口）：
//   import { app } from 'electron';
//   import { createWorkbench } from '@diy-agent/workbench';
//   import * as myPage from '@scope/my-page/main';   // ← 直接 import：tsc 检查包存在
//   const wb = await createWorkbench({
//       plugins: [{ id: 'my-page', module: myPage }],
//       preloadFile: '/abs/preload/index.cjs',
//       rendererFile: '/abs/renderer/index.html',
//   });
//   app.on('window-all-closed', () => app.quit());
//
// 边界：本包**不认识任何具体页面**（不 import 页面插件、不读业务数据）。
// 页面清单来自 plugins 清单，页面行为来自插件导出的 methods —— 加页面不改本包。

import { app, BrowserWindow, screen } from "electron";
import { ChannelClientBinding, ChannelServerBinding, createTypedClient } from "@diy-agent/rpc";
import { createMainTransport } from "@diy-agent/rpc/electron/main";
import { rendererService, workbenchService } from "./protocol.js";
import { WorkbenchError } from "./errors.js";
import { loadPages, type PluginEntry } from "./loader.js";
import type { PageContribution, PageInfo } from "./page.js";
import { PAGE_INVOKE_CHANNEL, PAGE_LIST_CHANNEL, RPC_CHANNEL, type PageInvokeRequest } from "./channels.js";
import { instanceWindowTitle, removeSelfRecord, writeSelfRecord } from "./instance-record.js";
import { sidecarWindowOptions } from "./window.js";

export { WorkbenchError } from "./errors.js";
export { orderPlugins, loadPages } from "./loader.js";
export { PAGE_INVOKE_CHANNEL, PAGE_LIST_CHANNEL, RPC_CHANNEL } from "./channels.js";
export { sidecarWindowOptions, type DisplayLike, type WorkArea } from "./window.js";
export { registryDir, writeSelfRecord, removeSelfRecord, repoRootOf, instanceUri, instanceWindowTitle } from "./instance-record.js";
export { cdpSwitchValue, readDevToolsUrl, readDevToolsPort, waitDevToolsPort } from "./cdp.js";
export type { PluginEntry } from "./loader.js";
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
    /**
     * app 短名（写进实例注册表 `~/.diy-instances/<pid>.json`，dev 启动器靠它认人）。
     * 缺省不注册 —— 显式给名字才自报，避免把临时 / 测试宿主也塞进注册表。
     */
    readonly app?: string;
    /** launch id（app.yaml 里的一条启动命令）；缺省读 `DIY_LAUNCH`，再缺省 null */
    readonly launch?: string;
    /** 是否自报实例（缺省 = 给了 app 且 `DIY_HOME` 存在） */
    readonly registerInstance?: boolean;
    /** 窗口起来时**不抢焦点**（`showInactive`）；缺省读 `DIY_NO_FOCUS === "1"` */
    readonly showInactive?: boolean;
    /** 开在非主屏（副屏）；缺省 = `DIY_ENV !== "production"` */
    readonly sidecar?: boolean;
}

/** 外壳句柄：拿页面清单、直接调方法（测试 / 无窗口场景），以及释放 */
export interface Workbench {
    listPages(): PageInfo[];
    invoke(pageId: string, method: string, args?: unknown): Promise<unknown>;
    /**
     * 给 renderer 发一条**意图测试命令**（fill / click / waitState / readState）。
     *
     * 这是 main → renderer 的方向，B1 换 rpc 之前根本不存在（自研 IPC 只有单向）。
     * 渲器侧没装钩子（生产）时抛错 —— 别把测试路径混进正常业务。
     */
    ui(command: {
        type: "fill" | "click" | "waitState" | "readState";
        selector?: string;
        value?: unknown;
        path?: string;
        equals?: unknown;
        timeoutMs?: number;
    }): Promise<unknown>;
    window(): BrowserWindow | null;
    dispose(): void;
}

export async function createWorkbench(options: CreateWorkbenchOptions): Promise<Workbench> {
    const contributions = await loadPages(options.plugins);
    const byId = new Map<string, PageContribution>(contributions.map((page) => [page.id, page]));

    // 侧栏还要图标 / 分组（可选）：缺省字段不传（结构化克隆保真，别补空串）
    const listPages = (): PageInfo[] =>
        contributions.map(({ id, title, icon, group }) => ({
            id,
            title,
            ...(icon === undefined ? {} : { icon }),
            ...(group === undefined ? {} : { group }),
        }));

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

    await app.whenReady();

    const width = options.width ?? 1040;
    const height = options.height ?? 720;
    const env = process.env["DIY_ENV"] ?? "production";
    const variant = process.env["DIY_VARIANT"] ?? "lab";
    const diyHome = process.env["DIY_HOME"];
    const showInactive = options.showInactive ?? process.env["DIY_NO_FOCUS"] === "1";
    const sidecar = options.sidecar ?? env !== "production";
    const sidecarPos = sidecar
        ? sidecarWindowOptions(screen.getAllDisplays(), screen.getPrimaryDisplay().id, width, height)
        : {};

    const shouldRegister = options.registerInstance ?? (options.app !== undefined && diyHome !== undefined);
    if (shouldRegister && options.app !== undefined && diyHome !== undefined) {
        const file = writeSelfRecord({
            app: options.app,
            launch: options.launch ?? process.env["DIY_LAUNCH"] ?? null,
            diyHome,
            variant,
            env,
        });
        console.log(`[workbench] 实例注册：${file}`);
        const drop = (): void => removeSelfRecord();
        app.once("will-quit", drop);
    }

    const win = new BrowserWindow({
        // 标题栏 = 「我是谁」的唯一出口：所有 app 都是 `标题 — diy://<instance-id>/<app>.<launch>`，
        // 同机多个窗口并排时靠它分辨谁是谁（数据根 + 启动方式都在里面）
        title: instanceWindowTitle({
            title: options.title,
            app: options.app,
            launch: options.launch ?? process.env["DIY_LAUNCH"] ?? null,
            diyHome,
        }),
        width,
        height,
        show: false,
        ...sidecarPos,
        webPreferences: {
            preload: options.preloadFile,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    // 页面自带的 `<title>`（index.html 里写死的「diy 聊天」之类）会盖掉上面的标题：
    // 窗口标题归外壳管（它才知道 instance-id / launch），页面无权改
    win.on("page-title-updated", (event) => event.preventDefault());
    win.on("closed", () => {
        removeSelfRecord();
        disposeHandlers();
    });
    win.once("ready-to-show", () => {
        if (showInactive) win.showInactive();
        else win.show();
    });
    // ── RPC 绑定（2026-11-04 B1：手写 IPC → @diy-agent/rpc）──
    //
    // 必须在 `loadFile` **之前**：preload 在页面加载时执行并开始发消息，
    // 晚一步注册就会丢掉最早那批（rpc 的 main→renderer 队列只管反方向）。
    //
    // `getWebContents` 用闭包读 `win` —— transport 建好时 webContents 可能还没就绪，
    // 每次 send 现读才安全（窗口重建时也不用重新注册）。
    const transport = createMainTransport(() => win.webContents, RPC_CHANNEL);
    const server = new ChannelServerBinding(transport);
    // 一次注册整个模块（路径自动带 `diy.ui.workbench.` 前缀，与 preload 侧的 use() 同源）
    workbenchService.bind(server, {
        page: {
            list: async () => listPages(),
            invoke: async ({ input }) => invoke(input.pageId, input.method, input.args),
        },
    });

    // 反方向（main → renderer）：同一条 transport 上 client + server 各挂一个（rpc 支持双向）
    const uiClient = rendererService.use(new ChannelClientBinding(transport));
    const ui = async (command: Parameters<Workbench["ui"]>[0]): Promise<unknown> => {
        switch (command.type) {
            case "fill":
                return uiClient.ui.fill({ selector: command.selector ?? "", value: String(command.value ?? "") });
            case "click":
                return uiClient.ui.click({ selector: command.selector ?? "" });
            case "waitState":
                return uiClient.ui.waitState({
                    path: command.path ?? "",
                    equals: command.equals,
                    timeoutMs: command.timeoutMs ?? 5000,
                });
            case "readState":
                return uiClient.ui.readState({ path: command.path ?? "" });
        }
    };

    await win.loadFile(options.rendererFile);

    const disposeHandlers = (): void => {
        server.destroy();
    };

    return {
        listPages,
        invoke,
        ui,
        window: () => (win.isDestroyed() ? null : win),
        dispose: () => {
            disposeHandlers();
            if (!win.isDestroyed()) win.close();
        },
    };
}
