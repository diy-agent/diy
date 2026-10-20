/**
 * hit-highlight — 定位到位后「命中的那几个字」的临时标记（##389）。
 *
 * 用的还是 **CSS Custom Highlight API**（`CSS.highlights`），与 findStore（##234）同一条路：
 * 只登记 Range、**不动 DOM** —— 对话页是流式渲染的，包 `<mark>` 会在下一次 diff 里被丢掉/错位。
 *
 * 与 findStore 的差别只有两点：① 高亮名独立（`diy-chat-hit`），两套高亮互不覆盖；
 * ② 范围是**一个轮元素之内**（不是整页）—— 定位之后用户要的是"这轮里哪儿写着"，整页高亮
 * 反而把周边无关的命中一起点亮（那正是页内查找的活，别抢它的）。
 */
const HL_HIT = "diy-chat-hit";

interface Highlights {
    set(name: string, h: unknown): void;
    delete(name: string): boolean;
}

function highlights(): Highlights | null {
    return (globalThis as { CSS?: { highlights?: Highlights } }).CSS?.highlights ?? null;
}

function HighlightCtor(): (new (...r: Range[]) => unknown) | null {
    return (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight ?? null;
}

/** 清掉上一次的标记（面板关闭 / 下一次定位 / 元素已卸载时都要调） */
export function clearHitHighlight(): void {
    highlights()?.delete(HL_HIT);
}

/**
 * 在 `root` 子树里把 `query` 的每一处登记为高亮。返回登记了几处（0 = 没找到，调用方别当成功）。
 *
 * 只走**文本节点**并跳过 `data-find-skip`（与 findStore 同一条判据）：否则会把面板/提示条的
 * 文字也算进来。Markdown 渲染后原文与 DOM 文本会有细微差异（加粗/链接），故不按字符偏移
 * 映射，而是**在 DOM 里再找一遍** —— 这几处命中的是"看得见的字"，比偏移更贴近用户预期。
 */
export function paintHitHighlight(root: HTMLElement | null, query: string): number {
    const h = highlights();
    const H = HighlightCtor();
    if (!h || !H || !root || !query.trim()) return 0;
    const q = query.trim().toLowerCase();
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            const v = n.nodeValue;
            if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
            const p = (n as Text).parentElement;
            if (!p || p.closest("[data-find-skip]")) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        const hay = (text.nodeValue ?? "").toLowerCase();
        for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
            const r = document.createRange();
            r.setStart(text, i);
            r.setEnd(text, i + q.length);
            ranges.push(r);
        }
    }
    if (ranges.length === 0) {
        clearHitHighlight();
        return 0;
    }
    h.set(HL_HIT, new H(...ranges));
    return ranges.length;
}
