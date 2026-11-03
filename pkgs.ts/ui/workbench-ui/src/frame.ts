// frame.ts — 布局骨架：左侧可展开的窄栏（图标 → 图标+文字）+ 主区（页面内容 + 顶栏）。
//
// 页面清单来自主进程（gateway.listPages()），页面内容来自注册表（registry.ts）。
// 本文件不做任何异步业务：切页 = 调页面的 render，仅此而已。
//
// ##侧栏（2026-11-02 用户裁 ②）：**一份菜单，展开即变宽**，不再「窄 bar + 抽屉」两份列表。
// 起初是 52px 窄 bar 只放图标、☰ 拉出浮层抽屉 —— 实测糟糕：抽屉里又是同一批页面，
// 展开后 3 个入口变成 6 个按钮，看得人发懵（用户原话）。现在的形状跟聊天页的 bot 侧栏一致：
//   · 常驻 52px，只有图标（不占阅读宽度）
//   · **悬停自动变宽**到 232px，图标旁淡入文字；点 ☰ 可以把展开「钉住」（再点 / Esc 收回）
//   · 菜单树只有一份：DOM 里每个页面就一个 .wb-nav-item（分组标题在窄态隐藏、宽态出现）
// 选一个页面 ⇒ 直接切页，不收起（收不收由鼠标 / ☰ 决定，切页不该附带别的动作）。

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
/** 窄态宽 / 宽态宽（px）：窄态与聊天页 bot 侧栏同宽，切换时主区跟着让位 */
const NARROW_WIDTH = 52;
const WIDE_WIDTH = 232;
const STYLE = `
.wb-root { position: fixed; inset: 0; display: flex; font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #fff; }
/* ── 侧栏：一份菜单；窄态只有图标，悬停 / 钉住变宽后图标旁淡入文字 ── */
.wb-side { flex: none; width: ${String(NARROW_WIDTH)}px; display: flex; flex-direction: column; gap: 2px; padding: 8px 6px; background: #f6f7f9; border-right: 1px solid #e4e7eb; box-sizing: border-box; overflow: hidden; transition: width .18s ease; z-index: 30; }
.wb-side:hover, .wb-side[data-open="true"] { width: ${String(WIDE_WIDTH)}px; }
.wb-side-toggle { flex: none; width: 40px; height: 36px; display: grid; place-items: center; margin-bottom: 4px; border: 0; border-radius: 9px; background: transparent; color: #3a3f46; font: inherit; font-size: 16px; cursor: pointer; }
.wb-side-toggle:hover { background: #e9ecf0; }
.wb-brand { flex: none; margin: 0; padding: 2px 6px 6px; font-size: 15px; font-weight: 600; color: #3a3f46; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-nav { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 2px; overflow: auto; }
.wb-group { display: flex; flex-direction: column; gap: 2px; }
.wb-group-head { display: none; align-items: center; gap: 6px; padding: 6px 6px 4px; border: 0; background: transparent; font: inherit; font-size: 12px; color: #6b7280; text-align: left; white-space: nowrap; cursor: pointer; border-radius: 6px; }
.wb-side:hover .wb-group-head, .wb-side[data-open="true"] .wb-group-head { display: flex; }
.wb-group-head:hover { background: #eef1f5; }
.wb-group-chevron { width: 12px; font-size: 10px; color: #9aa1a9; transition: transform .12s; }
.wb-group[data-collapsed="true"] .wb-group-chevron { transform: rotate(-90deg); }
/* 分组「收起」只在**宽态**有意义（那时才看得见标题）：窄态一律把图标露出来，
   否则收起的组在窄栏里整组消失，人找不到入口 */
.wb-group[data-collapsed="true"] .wb-group-items { display: none; }
.wb-side:not(:hover):not([data-open="true"]) .wb-group[data-collapsed="true"] .wb-group-items { display: flex; }
.wb-group-items { display: flex; flex-direction: column; gap: 2px; }
.wb-nav-item { appearance: none; display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: #2f353c; font: inherit; text-align: left; white-space: nowrap; cursor: pointer; }
.wb-nav-item:hover { background: #e9ecf0; }
.wb-nav-item[aria-current="page"] { background: #dfe6f2; color: #123a6b; font-weight: 600; }
.wb-nav-icon { flex: none; width: 20px; text-align: center; font-size: 14px; }
.wb-nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity .12s; }
.wb-side:hover .wb-nav-label, .wb-side[data-open="true"] .wb-nav-label { opacity: 1; }
.wb-sep { flex: none; height: 1px; margin: 4px 2px; background: #e0e3e8; }
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
    const doc = root.ownerDocument;

    root.replaceChildren();
    const shell = el(doc, "div", "wb-root");

    // ── 侧栏（只有一份菜单） ─────────────────────────
    const side = el(doc, "aside", "wb-side");
    side.dataset["open"] = "false";

    const toggle = el<HTMLButtonElement>(doc, "button", "wb-side-toggle");
    toggle.type = "button";
    toggle.title = "展开菜单";
    toggle.setAttribute("aria-label", "展开菜单");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "☰";
    side.append(toggle);

    const brand = el(doc, "h1", "wb-brand");
    brand.textContent = options.title ?? "Workbench";
    side.append(brand);

    const nav = el(doc, "nav", "wb-nav");
    side.append(nav);

    const main = el(doc, "main", "wb-main");
    const header = el(doc, "header", "wb-header");
    const body = el(doc, "section", "wb-page");
    main.append(header, body);
    shell.append(side, main);
    root.append(shell);

    const buttons = new Map<string, HTMLButtonElement>();

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
        if (!firstGroup) nav.append(el(doc, "div", "wb-sep"));
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
        nav.append(group);

        for (const info of items) {
            const icon = info.icon ?? [...info.title][0] ?? "•";

            // 每个页面**只有一个**按钮：窄态只见图标，宽态图标旁淡入标题
            const button = el<HTMLButtonElement>(doc, "button", "wb-nav-item");
            button.type = "button";
            button.title = info.title;
            button.dataset["pageId"] = info.id;
            button.append(el(doc, "span", "wb-nav-icon", icon), el(doc, "span", "wb-nav-label", info.title));
            button.addEventListener("click", () => show(info.id));
            list.append(button);
            buttons.set(info.id, button);
        }
    }

    /** 展开/收起：`open` = 钉住；不钉住时靠悬停（纯 CSS），点 ☰ 才把它留在打开态 */
    const setOpen = (open: boolean): void => {
        side.dataset["open"] = open ? "true" : "false";
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.textContent = open ? "✕" : "☰";
        toggle.title = open ? "收起菜单" : "展开菜单";
    };
    toggle.addEventListener("click", () => setOpen(side.dataset["open"] !== "true"));

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "Escape" && side.dataset["open"] === "true") setOpen(false);
    };
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
