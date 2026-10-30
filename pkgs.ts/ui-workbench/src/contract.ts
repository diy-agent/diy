// contract.ts — 布局骨架与页面插件之间的契约（renderer 侧）。
//
// 骨架只认三样：页面的 id / title，以及 render(root, ctx)。
// 页面拿到 ctx 后通过 `ctx.invoke` 回主进程找自己的插件方法 —— 骨架不转述任何业务调用。

/** 主进程给的页面身份（与 @diy-agent/workbench 的 PageInfo 同形） */
export interface PageInfo {
    readonly id: string;
    readonly title: string;
}

/** 页面可用的通道：调用自己（pageId = 本页 id）在主进程侧的方法 */
export interface PageContext {
    invoke<T = unknown>(method: string, args?: unknown): Promise<T>;
}

/** 一个页面在 renderer 侧的实现 */
export interface PageView extends PageInfo {
    /** 画到 root 里；返回函数 = 切走时的清理 */
    render(root: HTMLElement, ctx: PageContext): void | (() => void);
}

/** preload 暴露的桥（形状见 @diy-agent/workbench/channels 的 WorkbenchBridge） */
export interface WorkbenchGateway {
    listPages(): Promise<readonly PageInfo[]>;
    invoke(pageId: string, method: string, args?: unknown): Promise<unknown>;
}

/** 骨架挂载后的句柄 */
export interface WorkbenchFrame {
    /** 切到某个页面（不在清单里 = 抛错） */
    show(pageId: string): void;
    /** 拆除骨架（含当前页面的清理） */
    dispose(): void;
    readonly element: HTMLElement;
}
