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
} {
    const [limit, setLimit] = React.useState(step);
    const visible = list.length > limit ? list.slice(-limit) : list;
    return {
        visible,
        hidden: Math.max(0, list.length - visible.length),
        showMore: () => setLimit((current) => current + step),
    };
}
