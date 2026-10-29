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

/** preload 暴露到 window 上的桥（renderer 侧实现见 @diy/workbench-ui 的 WorkbenchGateway） */
export interface WorkbenchBridge {
    listPages(): Promise<PageInfo[]>;
    invoke(pageId: string, method: string, args?: unknown): Promise<unknown>;
}
