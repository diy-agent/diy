/**
 * findStore — 页面内文本查找（##234 的 renderer 侧实现）。
 *
 * 为什么用 **CSS Custom Highlight API**（`CSS.highlights`）而不是包裹 `<mark>`：
 * 本仓的页面是 Solid 响应式渲染的（对话还在流式更新），改 DOM 会与渲染器的 diff 打架
 * —— 包进去的 `<mark>` 会在下一次重渲染时被丢掉/错位。Highlight API 只登记 Range、
 * **不动 DOM**，高亮由浏览器绘制，与框架互不干扰（Chromium 105+ 支持，本仓 Electron 43 满足）。
 *
 * 与「提示词页的标注」同形：都是「收集出现处区间 + i/n 计数 + ↑/↓ 跳转」，
 * 差别只在本 store 是**通用页内查找**（面向任意页面 DOM 文本），而非编辑器内的范围高亮。
 *
 * 搜索范围 = 主内容区（App 的 mainAreaEl）内的文本节点；跳过脚本/样式与显式标了
 * `data-find-skip` 的区域（悬停详情覆盖层等）。
 */
import { createSignal } from "solid-js";

const HL_ALL = "diy-find";
const HL_ACTIVE = "diy-find-active";

const [open, setOpen] = createSignal(false);
const [query, setQuery] = createSignal("");
const [count, setCount] = createSignal(0);
const [index, setIndex] = createSignal(0);

let ranges: Range[] = [];
let root: HTMLElement | undefined;

type CssHighlights = { set(name: string, h: unknown): void; delete(name: string): boolean };
function highlights(): CssHighlights | null {
    const c = (globalThis as { CSS?: { highlights?: CssHighlights } }).CSS;
    return c?.highlights ?? null;
}
function HighlightCtor(): (new (...r: Range[]) => unknown) | null {
    return (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight ?? null;
}

function clearHighlights(): void {
    const h = highlights();
    h?.delete(HL_ALL);
    h?.delete(HL_ACTIVE);
}

function collect(text: string): Range[] {
    const out: Range[] = [];
    if (!root || !text) return out;
    const q = text.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            const v = n.nodeValue;
            if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
            const p = (n as Text).parentElement;
            if (!p || p.closest("[data-find-skip]")) return NodeFilter.FILTER_REJECT;
            const tag = p.tagName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "INPUT") {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const textNode = node as Text;
        const hay = (textNode.nodeValue ?? "").toLowerCase();
        for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
            const r = document.createRange();
            r.setStart(textNode, i);
            r.setEnd(textNode, i + q.length);
            out.push(r);
        }
    }
    return out;
}

function paint(): void {
    const h = highlights();
    const H = HighlightCtor();
    if (!h || !H) return;
    if (ranges.length === 0) {
        clearHighlights();
        return;
    }
    h.set(HL_ALL, new H(...ranges));
    const cur = ranges[index()];
    if (cur) h.set(HL_ACTIVE, new H(cur));
    else h.delete(HL_ACTIVE);
}

function scrollToCurrent(): void {
    const r = ranges[index()];
    if (!r) return;
    // 用区间起点所在元素滚动；截图/流式中内容可能已变（Range 悬空）→ 忽略异常
    try {
        r.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
        /* Range 失效：忽略 */
    }
}

function runSearch(text: string): void {
    try {
        ranges = collect(text);
    } catch {
        ranges = [];
    }
    setCount(ranges.length);
    setIndex(0);
    paint();
    if (ranges.length) scrollToCurrent();
}

export const findStore = {
    get open(): boolean {
        return open();
    },
    get query(): string {
        return query();
    },
    get count(): number {
        return count();
    },
    get index(): number {
        return index();
    },
    /** 设定搜索根（App 挂载时把主内容区元素传进来） */
    setRoot(el: HTMLElement | undefined): void {
        root = el;
    },
    openFind(): void {
        setOpen(true);
    },
    close(): void {
        setOpen(false);
        setQuery("");
        ranges = [];
        setCount(0);
        setIndex(0);
        clearHighlights();
    },
    setQuery(text: string): void {
        setQuery(text);
        runSearch(text);
    },
    next(): void {
        if (ranges.length === 0) return;
        setIndex((index() + 1) % ranges.length);
        paint();
        scrollToCurrent();
    },
    prev(): void {
        if (ranges.length === 0) return;
        setIndex((index() - 1 + ranges.length) % ranges.length);
        paint();
        scrollToCurrent();
    },
    /** 页面内容变化后重跑（调用方按需触发；本 store 不自行订阅） */
    refresh(): void {
        if (open() && query()) runSearch(query());
    },
};
