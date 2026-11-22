// 链接策略 —— 聊天区里的链接一律新窗口打开。
//
// 为什么：工作台（dock）里 center 就是对话本身，点一条链接在原窗口导航 = 把对话顶掉，
// 回退还得靠浏览器历史。react-markdown 那边（shadcn 面，components/Markdown.tsx 的 `a`）
// 已经统一 `target="_blank"`；Astryx 的 Markdown 只给 http(s) 加 target，相对路径 /
// 绝对路径走 linkComponent（无 target）—— 那些才会在本窗口导航，交给这里补上。

import type { MouseEvent } from 'react';

/** 原样交给浏览器：已自带新窗口 / 该由系统接手 / 不是导航 */
const LEAVE_ALONE = ['http://', 'https://', 'mailto:', 'tel:', '#'];

/**
 * Astryx Markdown 的 `onLinkClick`：`false` = 拦掉默认导航。
 *
 * - http(s)：Astryx 已加 `target="_blank" rel="noopener noreferrer"`，不重复开
 * - mailto: / tel:：交给系统
 * - `#anchor`：页内跳转，不是导航
 * - 其它（`/proj:diy/14`、相对路径）：新标签打开，当前页（对话）不动
 */
export function openLinkInNewWindow(href: string, event: MouseEvent<HTMLAnchorElement>): false | void {
    if (LEAVE_ALONE.some((prefix) => href.startsWith(prefix))) return;
    event.preventDefault();
    window.open(href, '_blank', 'noopener');
    return false;
}
