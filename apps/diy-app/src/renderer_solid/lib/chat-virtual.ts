/**
 * chat-virtual —— 块树滚动区的**视口虚拟化**纯逻辑（##301）
 *
 * 判据（本任务）：DOM 节点数与会话轮数**无关**（只挂视口附近若干轮）；未渲染轮的高度用
 * **实测账**（渲染过就记住实测值、随滚动修正），滚动位置不跳。
 *
 * 为什么不能只靠 `content-visibility: auto`：它只跳过「离屏子树的布局与绘制」，**DOM 仍是全量**
 * —— 一次 48 轮的会话实测 1441 个节点全体在树里，堆随会话长度无界。要真降下来，必须把远端轮
 * 从 DOM 摘掉。
 *
 * 布局用**绝对定位 + 前缀和**（行间距由账显式加）：每行的顶边完全由账面高度决定，不受
 * `space-y-*` 这类「相邻兄弟选择器」干扰 —— 后者的间距要另推一遍账，边界（首行 / spacer）
 * 极易差一个 gap。
 */

/** 行间距（与原容器 `space-y-3` 一致：0.75rem） */
export const ROW_GAP = 12;
/** 从未渲染过的高度的兜底估算（与原 `contain-intrinsic-size: auto 24rem` 同口径） */
export const ROW_FALLBACK = 384;

export interface RowLayout {
    /** 第 i 行的顶边（含行距的前缀和） */
    tops: number[];
    /** 内容总高（不含最后一行的尾随行距） */
    total: number;
}

/** 前缀和布局：heights = 每行高度（实测或估算） */
export function stackRows(heights: readonly number[], gap: number = ROW_GAP): RowLayout {
    const n = heights.length;
    const tops = new Array<number>(n);
    let y = 0;
    for (let i = 0; i < n; i++) {
        tops[i] = y;
        y += heights[i]! + gap;
    }
    return { tops, total: n === 0 ? 0 : Math.max(0, y - gap) };
}

/**
 * 视口窗口（含 overscan）→ 半开区间 `[from, to)`。
 *
 * 可见判据 = 行与 `[scrollTop - over, scrollTop + viewH + over]` 相交。窗口**至少一行**
 * （全部在视口外时也挂一行，否则永远空窗、量不到高度、无从收敛）。
 */
export function windowRange(
    tops: readonly number[],
    heights: readonly number[],
    scrollTop: number,
    viewH: number,
    overscanPx: number,
): [number, number] {
    const n = tops.length;
    if (n === 0) return [0, 0];
    const lo = Math.max(0, scrollTop - overscanPx);
    const hi = scrollTop + Math.max(0, viewH) + overscanPx;
    let from = 0;
    while (from < n - 1 && bottomOf(tops, heights, from) < lo) from++;
    let to = n;
    while (to > from + 1 && (tops[to - 1] ?? 0) > hi) to--;
    return [from, to];
}

/** 第 i 行的底边（不含行距） */
export const bottomOf = (tops: readonly number[], heights: readonly number[], i: number): number =>
    (tops[i] ?? 0) + (heights[i] ?? 0);

/**
 * 高度账：**实测优先**；未实测的用**动态均值**（已实测高度的均值，一个样本都没有时用兜底）。
 *
 * 为什么动态更新是安全的：任何「未实测行估算变化」都会被调用方的**视口锚定**吸收
 * （见组件的 `withVpAnchor`）—— 锚定保证「视口顶那一行相对 scrollTop 的位置」不变，
 * 而它是唯一的位置基准。均值比固定兜底准得多（真实会话每轮高度差几倍），
 * 滚动条长度与「拖到底」的手感都靠它。
 */
export class HeightLedger {
    private map = new Map<string, number>();
    private sum = 0;

    /** 账面高度（实测或估算） */
    get(key: string): number {
        return this.map.get(key) ?? this.estimate();
    }
    /** 有没有实测过（区别于 get 的估算） */
    has(key: string): boolean {
        return this.map.has(key);
    }
    /** 写入实测高度；返回**高度增量**（未实测 → 实测时，基准是当时的估算值） */
    set(key: string, h: number): number {
        const old = this.get(key);
        if (old === h) return 0;
        this.map.set(key, h);
        this.sum += h;
        return h - old;
    }
    /** 估算：已实测高度的均值；一个样本都没有时用兜底 */
    estimate(): number {
        return this.map.size > 0 ? Math.round(this.sum / this.map.size) : ROW_FALLBACK;
    }
    /** 丢弃不再存在的行（会话清空 / 重置）—— 不清的话均值会被早已删除的轮拖着走 */
    retain(keys: readonly string[]): void {
        if (this.map.size === 0) return;
        const keep = new Set(keys);
        for (const k of [...this.map.keys()]) {
            if (keep.has(k)) continue;
            this.sum -= this.map.get(k)!;
            this.map.delete(k);
        }
    }
    clear(): void {
        this.map.clear();
        this.sum = 0;
    }
    get size(): number {
        return this.map.size;
    }
}
