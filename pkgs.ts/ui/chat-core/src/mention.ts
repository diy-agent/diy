// mention.ts —— @ 提及的纯逻辑（surface 无关）。
//
// 两个表面必须给出同样的候选、同样的补全结果，所以查询解析/过滤/补全只写一遍。
// 键盘选择（↑↓/Enter/Esc）由各表面用自己的输入框实现，规则一致。

import type { Bot } from './types';

export interface MentionCandidate {
    id: string;
    name: string;
    color: string;
    isOwner: boolean;
}

/** 当前正在输入的 @ 查询；不在 mention 状态返回 null。规则：行首或空白后的 @，且其后无空白 */
export function mentionQuery(text: string): string | null {
    const match = /(^|\s)@([^\s@]*)$/.exec(text);
    return match === null ? null : (match[2] ?? '');
}

/** 候选过滤：名字子串匹配（不区分大小写），空查询返回全部 */
export function filterMentionCandidates(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
    const lower = query.toLowerCase();
    return candidates.filter((candidate) => candidate.name.toLowerCase().includes(lower));
}

/** 把末尾的 @query 替换成 @name （补一个空格） */
export function completeMention(text: string, name: string): string {
    return text.replace(/@([^\s@]*)$/, `@${name} `);
}

/** 取消 mention（删掉末尾的 @query） */
export function dismissMention(text: string): string {
    return text.replace(/@([^\s@]*)$/, '');
}

/** ↑↓ 循环移动选中项 */
export function moveActive(active: number, delta: number, length: number): number {
    if (length <= 0) return 0;
    return (active + delta + length) % length;
}

/** 实体参与者 → 候选（第一个是 owner） */
export function mentionCandidatesOf(botIds: readonly string[], bots: Record<string, Bot>): MentionCandidate[] {
    return botIds
        .map((id, index) => {
            const bot = bots[id];
            return bot === undefined
                ? undefined
                : { id: bot.id, name: bot.name, color: bot.color, isOwner: index === 0 };
        })
        .filter((candidate): candidate is MentionCandidate => candidate !== undefined);
}
