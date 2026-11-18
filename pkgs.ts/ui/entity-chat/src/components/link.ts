// link.ts —— 侧栏导航项是真正的 <a>：这里只有一个判断「这次点击该不该由我们接管」。
//
// 为什么值得单独一个函数：同一段判断在名字链接、rail 图标行、历史行三处都要用，而每处
// 各写一遍的结果是「有一处忘了 ctrl」，表现是 ⌘+点击打开新标签页**同时**把当前页也切走。

import type * as React from 'react';

/**
 * 普通左键单击（没有修饰键）= 我们接管；其余（⌘/Ctrl/Shift/Alt/中键/右键）交给浏览器，
 * 让它去开新标签页、新窗口、复制链接 —— 这些能力用 `<button>` 是拿不到的。
 */
export function isPlainLeftClick(event: React.MouseEvent): boolean {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
