// frame.ts — 布局骨架：左侧栏（页面清单）+ 主区（页面内容 + 顶栏）。
//
// 页面清单来自主进程（gateway.listPages()），页面内容来自注册表（registry.ts）。
// 本文件不做任何异步业务：切页 = 调页面的 render，仅此而已。

import { WorkbenchUiError } from "./errors.js";
import { getPage } from "./registry.js";
import type { PageContext, WorkbenchFrame, WorkbenchGateway } from "./contract.js";

export interface MountOptions {
    /** 侧栏品牌名 / 窗口标题旁的字 */
    readonly title?: string;
    /** 初始页面 id；缺省 = 清单第一页 */
    readonly initialPageId?: string;
}

const STYLE_ID = "wb-frame-style";
const STYLE = `
.wb-root { position: fixed; inset: 0; display: flex; font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #fff; }
.wb-sidebar { width: 220px; flex: none; display: flex; flex-direction: column; gap: 8px; padding: 16px 12px; background: #f6f7f9; border-right: 1px solid #e4e7eb; box-sizing: border-box; }
.wb-brand { font-size: 15px; font-weight: 600; margin: 0 0 8px; padding: 0 8px; color: #3a3f46; }
.wb-nav { display: flex; flex-direction: column; gap: 4px; }
.wb-nav-item { appearance: none; border: 0; text-align: left; padding: 8px 10px; border-radius: 8px; background: transparent; color: #2f353c; font: inherit; cursor: pointer; }
.wb-nav-item:hover { background: #e9ecf0; }
.wb-nav-item[aria-current="page"] { background: #dfe6f2; color: #123a6b; font-weight: 600; }
.wb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.wb-header { flex: none; padding: 14px 20px; border-bottom: 1px solid #e4e7eb; font-size: 15px; font-weight: 600; }
.wb-page { flex: 1; min-height: 0; }
.wb-missing { padding: 24px; color: #8a5a00; }
`;

/** 挂载骨架：先问主进程要页面清单，再渲染侧栏与首屏 */
export async function mountWorkbench(
    root: HTMLElement,
    gateway: WorkbenchGateway,
    options: MountOptions = {},
): Promise<WorkbenchFrame> {
    if (!root) throw new WorkbenchUiError("ui-workbench/bad-root", "挂载点为空");
    const pages = await gateway.listPages();
    if (pages.length === 0) throw new WorkbenchUiError("ui-workbench/no-pages", "主进程没有交付任何页面");

    ensureStyle(root.ownerDocument);

    root.replaceChildren();
    const shell = el(root.ownerDocument, "div", "wb-root");
    const sidebar = el(root.ownerDocument, "aside", "wb-sidebar");
    const brand = el(root.ownerDocument, "h1", "wb-brand");
    brand.textContent = options.title ?? "Workbench";
    const nav = el(root.ownerDocument, "nav", "wb-nav");
    const main = el(root.ownerDocument, "main", "wb-main");
    const header = el(root.ownerDocument, "header", "wb-header");
    const body = el(root.ownerDocument, "section", "wb-page");

    sidebar.append(brand, nav);
    main.append(header, body);
    shell.append(sidebar, main);
    root.append(shell);

    const buttons = new Map<string, HTMLButtonElement>();
    for (const info of pages) {
        const button = el<HTMLButtonElement>(root.ownerDocument, "button", "wb-nav-item");
        button.type = "button";
        button.dataset["pageId"] = info.id;
        button.textContent = info.title;
        button.addEventListener("click", () => show(info.id));
        nav.append(button);
        buttons.set(info.id, button);
    }

    let cleanup: (() => void) | undefined;

    const show = (pageId: string): void => {
        const info = pages.find((page) => page.id === pageId);
        if (!info) throw new WorkbenchUiError("ui-workbench/unknown-page", `主进程没交付页面 ${pageId}`);
        cleanup?.();
        cleanup = undefined;
        header.textContent = info.title;
        for (const [id, button] of buttons) {
            if (id === pageId) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        }
        const view = getPage(pageId);
        if (!view) {
            body.replaceChildren();
            const missing = el(root.ownerDocument, "div", "wb-missing");
            missing.textContent = `页面「${info.title}」（${pageId}）没有在 renderer 注册实现`;
            body.append(missing);
            return;
        }
        const ctx: PageContext = {
            invoke: <T,>(method: string, args?: unknown) => gateway.invoke(pageId, method, args) as Promise<T>,
        };
        const result = view.render(body, ctx);
        if (typeof result === "function") cleanup = result;
    };

    show(options.initialPageId ?? pages[0]!.id);

    return {
        element: shell,
        show,
        dispose: () => {
            cleanup?.();
            cleanup = undefined;
            root.replaceChildren();
        },
    };
}

function el<T extends HTMLElement = HTMLElement>(doc: Document, tag: string, className: string): T {
    const node = doc.createElement(tag);
    node.className = className;
    return node as T;
}

function ensureStyle(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.append(style);
}
