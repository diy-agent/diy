// mapping.ts —— Astryx 面的**纯映射**：时间线条目 → 组件 props。
//
// 抽出来是为了可测：这些规则（工具行怎么显示、投递状态怎么降级）以前写在组件里，
// 只能靠肉眼看界面验证。

import type { ChatMessageStatus } from '@astryxdesign/core';
import type { TimelineEntry, TimelinePart } from '@diy-agent/chat-core';

export const TOOL_STATUS = { running: 'running', ok: 'complete', error: 'error' } as const;

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

type Delivery = TimelineEntry['deliveries'][number];

/**
 * 只表达"出问题了"。
 * queued/delivering 是 bot 正在执行，界面上已经有执行中指示器 —— 再标一个
 * "发送中"会让用户以为消息还没出去，和执行中重复。
 */
export function deliveryStatusOf(deliveries: readonly Delivery[]): ChatMessageStatus | undefined {
    return deliveries.some((delivery) => delivery.state === 'failed') ? 'error' : undefined;
}

/** 同理：只在真出问题时才占一行说明是谁失败了 */
export function deliveryFooterOf(deliveries: readonly Delivery[]): string | undefined {
    const failed = deliveries.filter((delivery) => delivery.state === 'failed');
    if (failed.length === 0) return undefined;
    return failed.map((delivery) => `${delivery.name} 未送达`).join('、');
}
