// end-footer.ts —— 消息页脚那一行「这一轮是怎么停的」。
//
// 分工（别合并）：
//   · **页脚** = 事实的短标签，一行，稳定（`completed` 不显示 —— 正常不必说）；
//   · **notice / error 条目** = 人的解释与"该做什么"，可能多条，且会落库。
// 判据在 runtime（`entity-runtime/end-reason.ts`），这里只把判定翻成给人看的字。
//
// 放在 chat-core 而不是各 surface 里：三个 surface 显示同一句话，才谈得上"一个语义"。

import type { TurnEndReason } from './types';

export interface EndFooter {
    /** 短标签（一行内看完） */
    label: string;
    /**
     * 补一句：该做什么 / 上游原文。**不铺在页面上**，只作悬停提示 ——
     * 需要展开说的话由 notice / error 条目承担，页脚只留一行短标签。
     */
    detail?: string;
    /** 颜色语义：muted=人自己停的；warn=模型没说完；bad=不知道为什么停或真失败 */
    tone: 'muted' | 'warn' | 'bad';
}

/**
 * 这一轮要不要在页脚说话，说什么。
 *
 * `completed` 返回 `undefined`：**正常收尾不占页脚** —— 每条消息都挂一行"完成"
 * 只会变成噪声，而"没有那行"本身就是正常的信号。
 */
export function endFooterOf(reason: TurnEndReason | undefined): EndFooter | undefined {
    if (reason === undefined) return undefined;

    switch (reason.type) {
        case 'completed':
            return undefined;
        case 'interrupted':
            return { label: '本轮已停止', detail: '你按的停 —— 说「继续」接着来', tone: 'muted' };
        case 'max-tokens':
            return {
                label: '被输出上限截断',
                detail: `max_tokens=${reason.maxOutputTokens ?? '?'} —— 说「继续」可接上`,
                tone: 'warn',
            };
        case 'filtered':
            return { label: '被内容策略拦截', detail: '换个说法再问，或换个模型', tone: 'warn' };
        case 'tool-mismatch':
            return { label: '工具结果没回来', detail: '说「继续」重跑这一步', tone: 'warn' };
        // 失联：我们**知道**在等谁、空了多久（与 `unknown` 区分：那个是不知道）
        case 'stalled':
            return { label: '本轮失联', detail: stalledDetail(reason), tone: 'bad' };
        case 'error':
            return { label: '本轮失败', detail: undefined, tone: 'bad' };
        case 'unknown':
            return { label: '不明原因中断', detail: unknownDetail(reason), tone: 'bad' };
        default:
            return { label: '本轮结束（未知状态）', tone: 'bad' };
    }
}

/** 「等 X 时 N 秒没进展」——两件事都是运行时真的知道的（progress.ts） */
function stalledDetail(reason: TurnEndReason): string {
    const what = reason.awaiting === undefined ? '一路' : awaitingLabel(reason.awaiting);
    const idle = reason.idleMs === undefined ? '' : ` ${Math.round(reason.idleMs / 1000)}s`;
    return `${what}${idle} 没进展，已中止 —— 说「继续」重试；总在这一步断就查网关超时`;
}

/** 机器码 → 短标签（与 entity-runtime 的 `awaiting` 一一对应；两边不共享代码，只共享词汇） */
function awaitingLabel(awaiting: string): string {
    if (awaiting === 'model-stream') return '等模型回话';
    if (awaiting === 'compact') return '压缩上下文';
    if (awaiting.startsWith('tool:')) return `${awaiting.slice('tool:'.length)} 在跑`;
    return awaiting;
}

function unknownDetail(reason: TurnEndReason): string {
    switch (reason.note) {
        case 'no-finish':
            return '没收到结束信号（流被掐断 / 进程被杀），已按失败处理 —— 建议重试';
        case 'empty-output':
            return '模型一个字都没说就结束了，已按失败处理 —— 建议重试';
        default:
            return `上游给的收尾原因我们不认识（${reason.note ?? '无'}），已按失败处理`;
    }
}
