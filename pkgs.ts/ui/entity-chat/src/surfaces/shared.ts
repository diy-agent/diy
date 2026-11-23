// shared.ts —— 两个表面共用的**纯映射**：时间线 parts → 渲染块 / 工具行目标。
//
// 为什么从 `astryx/mapping.ts` 抽到这里：这些规则与框架无关，而两面各自实现过一份，
// 其中 shadcn 那份是简化版（不取首段命令、不取文件名，直接 JSON.stringify 截断）——
// 同一条时间线在两个界面显示不同的工具行，会被当成数据问题去查后端。
// 抽出来后两面行为由同一份代码 + 同一组测试保证。

import type { TimelinePart } from '@diy-agent/chat-core';

/** target 太长会把工具行撑成一条横线（一长串 bash 命令），所以压成单行并截断 */
const TOOL_TARGET_LIMIT = 60;

/** read/write/edit 的 path 只取文件名：绝对路径截断后既认不出是哪个文件，又占满一整行 */
function fileNameOf(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return base === '' ? trimmed : base;
}

/** bash 只取首段命令：`a && b && c` 里后面几段对「在干什么」没帮助 */
function shellHeadOf(command: string): string {
    const [head = command] = command
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s*(?:&&|\|\||;)\s*/);
    return head;
}

function rawTargetOf(args: unknown): string | undefined {
    if (args === undefined || args === null) return undefined;
    if (typeof args === 'string') return args;
    if (typeof args === 'object') {
        const record = args as Record<string, unknown>;
        for (const key of ['command', 'path', 'question', 'url']) {
            const value = record[key];
            if (typeof value === 'string' && value !== '') return value;
        }
    }
    try {
        return JSON.stringify(args);
    } catch {
        return undefined;
    }
}

/** 工具行的 target：命令取首段、路径取文件名、其余退化成单行 JSON，统一 60 字符截断 */
export function toolTargetOf(tool: TimelinePart & { kind: 'tool' }): string | undefined {
    const args = tool.args;
    const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : undefined;
    const command = record?.['command'];
    const path = record?.['path'];
    const raw =
        typeof command === 'string'
            ? shellHeadOf(command)
            : typeof path === 'string'
              ? fileNameOf(path)
              : rawTargetOf(args);
    if (raw === undefined) return undefined;
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    if (oneLine === '') return undefined;
    return oneLine.length <= TOOL_TARGET_LIMIT ? oneLine : `${oneLine.slice(0, TOOL_TARGET_LIMIT - 1)}…`;
}

/** 一段正文 / 一组工具 / 一个提问 / 一次失败：气泡内部按「连续同类」压成的块 */
export type Run =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; tools: (TimelinePart & { kind: 'tool' })[] }
    | { kind: 'ask'; part: TimelinePart & { kind: 'ask' } }
    | { kind: 'error'; message: string };

/**
 * 把 parts 压成连续同类块：文本一段、工具一组，保持原有先后。
 *
 * 两个不合并是**有意的**，它们有各自的理由：
 *   · `error` 自成一个块 —— 失败必须停在时间上真正发生的位置。并进相邻文本的话，
 *     「说一段 → 失败 → 再说一段」会渲染成一段连续的话，错误被排版吃掉。
 *   · `ask` 自成一个块 —— 它是需要用户动手的卡片，不能跟文本混在一个 Markdown 里。
 *
 * 放在纯函数里（而不是组件里）是因为「错误不会被排版吃掉」只能靠测试守。
 */
export function runsOf(parts: readonly TimelinePart[]): Run[] {
    const runs: Run[] = [];
    for (const part of parts) {
        const last = runs.at(-1);
        if (part.kind === 'ask') {
            runs.push({ kind: 'ask', part });
            continue;
        }
        if (part.kind === 'error') {
            runs.push({ kind: 'error', message: part.message });
            continue;
        }
        if (part.kind === 'text') {
            if (last?.kind === 'text') last.text += `\n\n${part.text}`;
            else runs.push({ kind: 'text', text: part.text });
        } else if (last?.kind === 'tool') {
            last.tools.push(part);
        } else {
            runs.push({ kind: 'tool', tools: [part] });
        }
    }
    return runs;
}

/** 一条时间线条目里可复制的正文（消息级「复制」按钮用；工具/提问不掺进去） */
export function plainTextOf(parts: readonly TimelinePart[]): string {
    return parts
        .map((part) => (part.kind === 'text' ? part.text : ''))
        .filter((text) => text !== '')
        .join('\n\n');
}
