// 把合并后的发现结果排成「列给用户选」的文本（##479 判据 4：**列出来让人选，不自动连**）。
//
// 形态（与任务 body 的样例一致）：
//   发现到的 diy 实例：
//      [1] c-mac 的 lab 实例     http://192.168.1.5:9400    (mdns + local)
//      [2] 服务器 prod           http://srv.tailnet:9400    (tailscale)
//      [3] 手动输入 URL...

import type { MergedInstance } from './types.js';

/** 终端显示宽度：CJK / 全角字符占 2 列（否则中文名字一多列就歪） */
export function displayWidth(text: string): number {
    let width = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        const wide =
            (code >= 0x1100 && code <= 0x115f) ||
            (code >= 0x2e80 && code <= 0xa4cf) ||
            (code >= 0xac00 && code <= 0xd7a3) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xfe30 && code <= 0xfe6f) ||
            (code >= 0xff00 && code <= 0xff60) ||
            (code >= 0xffe0 && code <= 0xffe6) ||
            (code >= 0x1f300 && code <= 0x1f64f) ||
            (code >= 0x1f900 && code <= 0x1f9ff) ||
            (code >= 0x20000 && code <= 0x3fffd);
        width += wide ? 2 : 1;
    }
    return width;
}

function padTo(text: string, width: number): string {
    const gap = width - displayWidth(text);
    return gap > 0 ? text + ' '.repeat(gap) : text;
}

/** 一行里「谁」的展示名：displayName → id → endpoint（都可能缺，故兜到 endpoint 为止） */
export function labelOf(row: MergedInstance): string {
    return row.displayName ?? row.id ?? row.endpoint;
}

/** 来源串：`mdns + local` */
export function describeSources(row: MergedInstance): string {
    const sources = row.sources.length > 0 ? row.sources : [row.source];
    return sources.join(' + ');
}

/**
 * 渲染选择列表。`manualOption` = 是否在末尾保留「手动输入 URL...」一项（缺省保留）。
 * 空结果也给一行「没有发现」，而不是空字符串 —— 调用方（CLI / UI）不需要再判空。
 */
export function formatDiscoveryList(rows: readonly MergedInstance[], opts: { manualOption?: boolean } = {}): string {
    const manualOption = opts.manualOption ?? true;
    const lines: string[] = [];
    lines.push(rows.length > 0 ? '发现到的 diy 实例：' : '没有发现任何 diy 实例（可以手动输入 URL）。');

    const labels = rows.map(labelOf);
    const labelWidth = Math.max(0, ...labels.map(displayWidth));
    const endpointWidth = Math.max(0, ...rows.map((r) => displayWidth(r.endpoint)));
    const indexWidth = String(rows.length + (manualOption ? 1 : 0)).length;

    rows.forEach((row, i) => {
        const index = `[${String(i + 1).padStart(indexWidth)}]`;
        const parts = [`  ${index} ${padTo(labels[i] ?? '', labelWidth)}`];
        if (row.endpoint !== '') parts.push(padTo(row.endpoint, endpointWidth));
        const tail = `(${describeSources(row)})`;
        lines.push(`${parts.join('  ')}  ${tail}`.trimEnd());
    });

    if (manualOption) {
        const index = `[${String(rows.length + 1).padStart(indexWidth)}]`;
        lines.push(`  ${index} 手动输入 URL...`);
    }
    return lines.join('\n');
}
