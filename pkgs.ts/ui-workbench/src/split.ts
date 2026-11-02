// split.ts — 可拖拉的横向分栏（左栏 + 拖条），宽度夹在 [min, max]。
//
// 为什么放骨架而不是某个页面里：凡是「左列表 + 右详情」的页面都要它，判据只有一条 ——
// 拖条把左栏宽度改到 min~max 之间，松手后记住（localStorage）。页面只管给左栏元素与边界，
// 拖条由本函数创建并插在左栏后面（调用方 append 到容器即可）。
//
// 纯 DOM，不认识任何业务；不引第三方。

export interface SplitPaneOptions {
    /** 左栏最小宽度（px） */
    readonly min: number;
    /** 左栏最大宽度（px） */
    readonly max: number;
    /** 初始宽度（px）；缺省 = min */
    readonly initial?: number;
    /** 记住上次宽度的 key（缺省不记） */
    readonly storageKey?: string;
}

export interface SplitPane {
    /** 拖条元素（调用方把它插到左栏后面） */
    readonly handle: HTMLElement;
    /** 当前左栏宽度 */
    width(): number;
    setWidth(px: number): void;
    dispose(): void;
}

/** 夹到 [min, max]；非数值 / NaN 一律回 min（不让一次坏输入把布局弄坏） */
export function clampPaneWidth(px: number, min: number, max: number): number {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    if (!Number.isFinite(px)) return lo;
    return Math.max(lo, Math.min(hi, px));
}

function storageOf(doc: Document): Storage | null {
    try {
        return doc.defaultView?.localStorage ?? null;
    } catch {
        return null; // 隐私模式 / 沙箱里 localStorage 可能直接抛
    }
}

/**
 * 给 `pane` 挂一个拖条。返回的 `handle` 由调用方插进 DOM（pane 的下一个兄弟）。
 * 拖动过程中直接改 `pane.style.width`；松手写 localStorage。
 */
export function createSplitPane(pane: HTMLElement, options: SplitPaneOptions): SplitPane {
    const doc = pane.ownerDocument;
    const { min, max } = options;
    const store = options.storageKey === undefined ? null : storageOf(doc);
    const remembered = store?.getItem(options.storageKey ?? "") ?? null;
    const initial = remembered === null ? (options.initial ?? min) : Number(remembered);

    const handle = doc.createElement("div");
    handle.className = "wb-split-handle";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-valuemin", String(Math.min(min, max)));
    handle.setAttribute("aria-valuemax", String(Math.max(min, max)));
    handle.style.flex = "none";
    handle.style.width = "5px";
    handle.style.cursor = "col-resize";
    handle.style.touchAction = "none";

    const apply = (px: number): number => {
        const next = clampPaneWidth(px, min, max);
        pane.style.width = `${next}px`;
        handle.setAttribute("aria-valuenow", String(next));
        return next;
    };

    let current = apply(initial);
    let dragging = false;

    const onMove = (event: MouseEvent): void => {
        if (!dragging) return;
        current = apply(event.clientX - pane.getBoundingClientRect().left);
    };
    const onUp = (): void => {
        if (!dragging) return;
        dragging = false;
        handle.style.background = "";
        if (store && options.storageKey !== undefined) {
            try {
                store.setItem(options.storageKey, String(current));
            } catch {
                /* 配额满了也不影响本次拖动 */
            }
        }
        doc.removeEventListener("mousemove", onMove);
        doc.removeEventListener("mouseup", onUp);
    };
    const onDown = (event: MouseEvent): void => {
        dragging = true;
        handle.style.background = "#3b6fd4";
        doc.addEventListener("mousemove", onMove);
        doc.addEventListener("mouseup", onUp);
        event.preventDefault();
    };

    handle.addEventListener("mousedown", onDown);

    return {
        handle,
        width: () => current,
        setWidth: (px: number) => {
            current = apply(px);
        },
        dispose: () => {
            onUp();
            handle.removeEventListener("mousedown", onDown);
            handle.remove();
        },
    };
}
