// frame.ts — 布局骨架：左侧窄 bar（图标）+ 抽屉菜单 + 主区（页面内容 + 顶栏）。
//
// 页面清单来自主进程（gateway.listPages()），页面内容来自注册表（registry.ts）。
// 本文件不做任何异步业务：切页 = 调页面的 render，仅此而已。
//
// ##侧栏窄条（2026-11-02 用户裁）：左栏常驻 52px 只放**图标**（不占阅读宽度），
// 顶端一个「展开」按钮把**抽屉**拉出来 —— 抽屉里是分组 + 层级 + 收起/展开的菜单树
// （形状参考 webawesome.com 的侧边栏）。选一个页面 ⇒ 抽屉自动收起。
//
// 分组 / 图标来自 PageInfo（可选字段）：没写 group 的落「未分组」，没写 icon 的取标题首字。

import { WorkbenchUiError } from "./errors.js";
import { getPage } from "./registry.js";
import type { PageContext, PageInfo, WorkbenchFrame, WorkbenchGateway } from "./contract.js";

export interface MountOptions {
    /** 侧栏品牌名 / 窗口标题旁的字 */
    readonly title?: string;
    /** 初始页面 id；缺省 = 清单第一页 */
    readonly initialPageId?: string;
}

const STYLE_ID = "wb-frame-style";
const STYLE = `
.wb-root { position: fixed; inset: 0; display: flex; font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #fff; }
/* ── 左侧窄 bar：常驻 52px，只有图标 ── */
.wb-rail { flex: none; width: 52px; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 0; background: #f6f7f9; border-right: 1px solid #e4e7eb; box-sizing: border-box; z-index: 30; }
.wb-rail-btn { width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 9px; background: transparent; color: #3a3f46; font: inherit; font-size: 16px; cursor: pointer; }
.wb-rail-btn:hover { background: #e9ecf0; }
.wb-rail-btn[aria-current="page"] { background: #dfe6f2; }
.wb-rail-sep { width: 24px; height: 1px; margin: 4px 0; background: #e0e3e8; }
.wb-rail-expand { margin-bottom: 4px; }
/* ── 抽屉：浮在窄 bar 右边，不挤压主区 ── */
.wb-drawer { position: absolute; top: 0; bottom: 0; left: 52px; width: 232px; display: none; flex-direction: column; gap: 6px; padding: 12px; background: #fbfbfc; border-right: 1px solid #e4e7eb; box-shadow: 2px 0 12px rgba(0, 0, 0, .06); box-sizing: border-box; z-index: 20; overflow: auto; }
.wb-root[data-drawer="open"] .wb-drawer { display: flex; }
.wb-brand { font-size: 15px; font-weight: 600; margin: 0 0 6px; padding: 0 8px; color: #3a3f46; }
.wb-group { display: flex; flex-direction: column; gap: 2px; }
.wb-group-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 0; background: transparent; font: inherit; font-size: 12px; color: #6b7280; text-align: left; cursor: pointer; border-radius: 6px; }
.wb-group-head:hover { background: #eef1f5; }
.wb-group-chevron { width: 12px; font-size: 10px; color: #9aa1a9; transition: transform .12s; }
.wb-group[data-collapsed="true"] .wb-group-chevron { transform: rotate(-90deg); }
.wb-group[data-collapsed="true"] .wb-group-items { display: none; }
.wb-group-items { display: flex; flex-direction: column; gap: 2px; }
.wb-nav-item { appearance: none; display: flex; align-items: center; gap: 8px; border: 0; text-align: left; padding: 7px 10px; border-radius: 8px; background: transparent; color: #2f353c; font: inherit; cursor: pointer; }
.wb-nav-item:hover { background: #e9ecf0; }
.wb-nav-item[aria-current="page"] { background: #dfe6f2; color: #123a6b; font-weight: 600; }
.wb-nav-icon { width: 18px; text-align: center; font-size: 14px; }
.wb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.wb-header { flex: none; padding: 14px 20px; border-bottom: 1px solid #e4e7eb; font-size: 15px; font-weight: 600; }
.wb-page { flex: 1; min-height: 0; }
.wb-missing { padding: 24px; color: #8a5a00; }
`;

/** 挂载骨架：先问主进程要页面清单，再渲染窄 bar / 抽屉与首屏 */
export async function mountWorkbench(
    root: HTMLElement,
    gateway: WorkbenchGateway,
    options: MountOptions = {},
): Promise<WorkbenchFrame> {
    if (!root) throw new WorkbenchUiError("ui-workbench/bad-root", "挂载点为空");
    const pages = await gateway.listPages();
    if (pages.length === 0) throw new WorkbenchUiError("ui-workbench/no-pages", "主进程没有交付任何页面");

    ensureStyle(root.ownerDocument);
    const doc = root.ownerDocument;

    root.replaceChildren();
    const shell = el(doc, "div", "wb-root");
    shell.dataset["drawer"] = "closed";

    // ── 窄 bar ───────────────────────────────────────
    const rail = el(doc, "aside", "wb-rail");
    const expand = el<HTMLButtonElement>(doc, "button", "wb-rail-btn wb-rail-expand");
    expand.type = "button";
    expand.title = "展开菜单";
    expand.setAttribute("aria-label", "展开菜单");
    expand.setAttribute("aria-expanded", "false");
    expand.textContent = "☰";
    rail.append(expand);

    // ── 抽屉 ─────────────────────────────────────────
    const drawer = el(doc, "aside", "wb-drawer");
    const brand = el(doc, "h1", "wb-brand");
    brand.textContent = options.title ?? "Workbench";
    drawer.append(brand);

    const main = el(doc, "main", "wb-main");
    const header = el(doc, "header", "wb-header");
    const body = el(doc, "section", "wb-page");
    main.append(header, body);
    shell.append(rail, drawer, main);
    root.append(shell);

    const buttons = new Map<string, HTMLButtonElement>();
    const railButtons = new Map<string, HTMLButtonElement>();

    /** 分组 → 页面（没写 group 的落「未分组」；顺序 = 清单里首次出现的顺序） */
    const groups = new Map<string, PageInfo[]>();
    for (const info of pages) {
        const name = info.group ?? "";
        const list = groups.get(name);
        if (list === undefined) groups.set(name, [info]);
        else list.push(info);
    }

    let firstGroup = true;
    for (const [groupName, items] of groups) {
        if (!firstGroup) rail.append(el(doc, "div", "wb-rail-sep"));
        firstGroup = false;

        const group = el(doc, "div", "wb-group");
        group.dataset["collapsed"] = "false";
        if (groupName !== "") {
            const head = el<HTMLButtonElement>(doc, "button", "wb-group-head");
            head.type = "button";
            head.append(el(doc, "span", "wb-group-chevron", "▾"), el(doc, "span", "", groupName));
            head.addEventListener("click", () => {
                group.dataset["collapsed"] = group.dataset["collapsed"] === "true" ? "false" : "true";
            });
            group.append(head);
        }
        const list = el(doc, "div", "wb-group-items");
        group.append(list);
        drawer.append(group);

        for (const info of items) {
            const icon = info.icon ?? [...info.title][0] ?? "•";

            // 窄 bar：只有图标（title 属性 + aria-label 兜住可读性）
            const railButton = el<HTMLButtonElement>(doc, "button", "wb-rail-btn");
            railButton.type = "button";
            railButton.title = info.title;
            railButton.setAttribute("aria-label", info.title);
            railButton.dataset["pageIcon"] = icon;
            railButton.textContent = icon;
            railButton.addEventListener("click", () => show(info.id));
            rail.append(railButton);
            railButtons.set(info.id, railButton);

            // 抽屉：图标 + 标题（分组 + 层级）
            const button = el<HTMLButtonElement>(doc, "button", "wb-nav-item");
            button.type = "button";
            button.dataset["pageId"] = info.id;
            button.append(el(doc, "span", "wb-nav-icon", icon), el(doc, "span", "", info.title));
            button.addEventListener("click", () => {
                show(info.id);
                setDrawer(false);
            });
            list.append(button);
            buttons.set(info.id, button);
        }
    }

    const setDrawer = (open: boolean): void => {
        shell.dataset["drawer"] = open ? "open" : "closed";
        expand.setAttribute("aria-expanded", open ? "true" : "false");
        expand.textContent = open ? "✕" : "☰";
        expand.title = open ? "收起菜单" : "展开菜单";
    };

    expand.addEventListener("click", () => setDrawer(shell.dataset["drawer"] !== "open"));

    // 点抽屉外面 = 收起（只认抽屉外的区域，别把切页的点击吃掉）
    const onDocClick = (event: MouseEvent): void => {
        if (shell.dataset["drawer"] !== "open") return;
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (drawer.contains(target) || rail.contains(target)) return;
        setDrawer(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") setDrawer(false);
    };
    doc.addEventListener("click", onDocClick);
    doc.addEventListener("keydown", onKeyDown);

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
        for (const [id, button] of railButtons) {
            if (id === pageId) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        }
        const view = getPage(pageId);
        if (!view) {
            body.replaceChildren();
            const missing = el(doc, "div", "wb-missing");
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
            doc.removeEventListener("click", onDocClick);
            doc.removeEventListener("keydown", onKeyDown);
            root.replaceChildren();
        },
    };
}

function el<T extends HTMLElement = HTMLElement>(doc: Document, tag: string, className: string, text?: string): T {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node as T;
}

function ensureStyle(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.append(style);
}
