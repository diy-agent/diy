// download.ts —— 把一段文本作为文件交给浏览器（「导出」的地基）。
//
// 为什么只有这一个实现：导出走的是**浏览器下载**（diy2 是网页，页面里没有写盘权限），
// 而 `<a download>` + Blob 是唯一不依赖宿主的写法。以后要换成 Electron 的原生保存框，
// 只改这一处 —— 按钮那一层只认识「给我文件名和正文」。

/**
 * 触发一次文本下载。
 *
 * `URL.revokeObjectURL` 放到 10 秒后：立刻 revoke 在部分浏览器上会把还没开始的下载掐掉
 * （Safari 实测），而放太晚又白占内存 —— 一次导出几 MB 以内，10 秒足够。
 */
export function downloadText(fileName: string, text: string, type = 'text/markdown;charset=utf-8'): void {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    // 必须挂进文档：Firefox 里游离节点的 click() 不触发下载
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
