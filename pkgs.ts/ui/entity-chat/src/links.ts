// 链接策略 —— 聊天区里的链接一律新窗口打开。
//
// 为什么：工作台（dock）里 center 就是对话本身，点一条链接在原窗口导航 = 把对话顶掉，
// 回退还得靠浏览器历史。react-markdown 那边（shadcn 面，components/Markdown.tsx 的 `a`）
// 已经统一 `target="_blank"`；Astryx 的 Markdown 只给 http(s) 加 target，相对路径 /
// 绝对路径走 linkComponent（无 target）—— 那些才会在本窗口导航，交给这里补上。
//
// ⚠️ 2026-11-26 实测：这段对**裸的站内路径**其实触发不到 —— shadcn 面只挂了 remarkGfm，
// 而 GFM 的 autolink 只认带协议的 URL，`/room/proj/cops` 这种不会变成 <a>。
// 所以它现在只在两种情况有效：① astryx 面的 Markdown；② 正文里显式写的相对链接
// `[看这里](/room/x)`。要让它管裸路径，得另加 remark 插件（用户 2026-11-26 裁：暂不做）。

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
