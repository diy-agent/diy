// channels.ts — 主进程与 renderer 之间的唯一契约（preload 也用这份常量，避免字符串两处写）。
import type { PageInfo } from "./page.js";

/** renderer 问「有哪些页面」 */
export const PAGE_LIST_CHANNEL = "workbench:list-pages";

/** renderer 调某个页面的一个方法（转发到插件） */
export const PAGE_INVOKE_CHANNEL = "page:invoke";

export interface PageInvokeRequest {
    readonly pageId: string;
    readonly method: string;
    readonly args?: unknown;
}

/** preload 暴露到 window 上的桥（renderer 侧实现见 @diy-agent/workbench-ui 的 WorkbenchGateway） */
export interface WorkbenchBridge {
    listPages(): Promise<PageInfo[]>;
    invoke(pageId: string, method: string, args?: unknown): Promise<unknown>;
}

/**
 * RPC 通道名（2026-11-04 B1 起唯一通道）。
 *
 * 旧的 `PAGE_LIST_CHANNEL` / `PAGE_INVOKE_CHANNEL` 仍导出（renderer 的
 * `WorkbenchGateway` 形状不变），但**底层已换成 @diy-agent/rpc**：
 * 两个 IPC 字符串常量 → 一条 envelope 通道（`rpc`）。
 *
 * 通道名单一是有意的：rpc 的 transport 自带「renderer 就绪闸门」与取消/流式，
 * 每多一条手写通道就多一份要自己维护的时序与生命周期。
 */
export const RPC_CHANNEL = "workbench-rpc";
