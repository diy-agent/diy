// useWindowed —— 长会话只渲染最近 N 条（"显示更早"按需展开）。
//
// proj:diy 已经有 600+ 条 item / 1MB：一次性渲染所有 markdown 是切换卡顿的主因。
// 这里只做分页窗口，不改时间线语义。

import * as React from 'react';

export const WINDOW_STEP = 30;

export function useWindowed<T>(
    list: readonly T[],
    step = WINDOW_STEP,
): {
    visible: readonly T[];
    hidden: number;
    showMore: () => void;
    /**
     * 把第一个满足条件的条目纳入窗口（跳到时间线深处的某条时要它）。
     *
     * 为什么不能只调 showMore 几次：窗口是"按步长往后扩"，而目标可能在几十条之前，
     * 扩到哪次才够全是猜的。这里直接算出需要的条数，一次到位。
     */
    reveal: (predicate: (item: T) => boolean) => void;
} {
    const [limit, setLimit] = React.useState(step);
    const visible = list.length > limit ? list.slice(-limit) : list;
    return {
        visible,
        hidden: Math.max(0, list.length - visible.length),
        showMore: () => setLimit((current) => current + step),
        reveal: (predicate) => {
            const index = list.findIndex(predicate);
            if (index < 0) return;
            // +1 留一点余量：目标紧贴窗口上沿时，用户看不到它上方的上下文
            setLimit((current) => Math.max(current, list.length - index + 1));
        },
    };
}
