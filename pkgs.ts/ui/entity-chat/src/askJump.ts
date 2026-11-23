// askJump —— 「跳到某张提问卡」的**壳层通道**。
//
// 为什么要有这一层：待答条属于壳层（一个房间一条、两个表面共用），但「怎么把一张卡滚进
// 视口」只有表面自己知道 —— shadcn 面是窗口化（卡片可能还没渲染，要先 reveal），
// astryx 是 ChatVirtualizer（只有 anchorToKey）。壳层直接 querySelector 在窗口化表面上会落空。
//
// 第一版把条加在某个表面自己的组件里，lab 实机一看：默认表面是 **astryx**，
// 条根本不出现 —— 表面私有的入口 = 用户看不到的入口（见 docs/plans/2026-11-22-ask-lifecycle.md）。

export type AskJumper = (askId: string) => void;

const jumpers = new Map<string, AskJumper>();
const flashTimers = new WeakMap<HTMLElement, number>();

/** 表面 mount 时注册；卸载传 undefined 注销（换房间会重挂，必须成对） */
export function registerAskJumper(surfaceId: string, jumper: AskJumper | undefined): void {
    if (jumper === undefined) jumpers.delete(surfaceId);
    else jumpers.set(surfaceId, jumper);
}

/** 壳层的待答条点了某问：交给当前表面的 jumper；没注册就按 DOM 兜底 */
export function jumpToAsk(surfaceId: string, askId: string): void {
    const jumper = jumpers.get(surfaceId);
    if (jumper !== undefined) {
        jumper(askId);
        return;
    }
    flashAskCard(askId, { scroll: true });
}

/**
 * 闪一下：一两轮之后卡片长得都一样，跳过去得让人知道「是哪张」。
 *
 * 找不到元素返回 false，交给调用方重试 —— 窗口化表面上「刚 reveal」到「真渲染」之间
 * 隔着一次提交。
 */
export function flashAskCard(askId: string, opts: { scroll?: boolean } = {}): boolean {
    // 表面切换后**三个表面同时挂在 DOM 里**（App.tsx 的 SurfaceHost 用 `hidden` 保持挂载），
    // 同一个 askId 会出现两三次 —— 只认可见的那一份，否则会闪在看不见的表面上（用户看不到反馈）
    const element = [...document.querySelectorAll<HTMLElement>(`[data-ask-id="${askId}"]`)].find(
        (candidate) => candidate.getClientRects().length > 0,
    );
    if (element === undefined) return false;
    if (opts.scroll === true) element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element.classList.add('ring-2', 'ring-sky-400');
    const previous = flashTimers.get(element);
    if (previous !== undefined) window.clearTimeout(previous);
    flashTimers.set(
        element,
        window.setTimeout(() => {
            element.classList.remove('ring-2', 'ring-sky-400');
            flashTimers.delete(element);
        }, 1600),
    );
    return true;
}

/**
 * 等卡片真的出现再闪（最多 1 秒）。
 *
 * 用在「已经让表面扩了窗口」之后：扩窗是状态更新，DOM 要下一次提交才有。
 */
export function flashAskCardWhenRendered(askId: string, tries = 20): void {
    const attempt = (left: number): void => {
        if (flashAskCard(askId, { scroll: true })) return;
        if (left <= 0) return;
        window.setTimeout(() => attempt(left - 1), 50);
    };
    attempt(tries);
}
