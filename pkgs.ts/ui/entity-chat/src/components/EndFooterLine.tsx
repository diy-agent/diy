// EndFooterLine —— 消息页脚那一行「这一轮是怎么停的」，三个 surface 共用。
//
// 三个决定：
//   1. **正常收尾不渲染**（`endFooterOf` 对 `completed` 返回 undefined）：
//      每条消息挂一行"完成"只是噪声，而"没有那行"本身才是"正常"的信号。
//   2. **只渲染短标签**，细节（该做什么 / 上游原文）放 `title`。
//      为什么不把细节也铺在页脚：`max-tokens` 那几种在时间线上已有 notice 条目解释了
//      同样的话 —— 页脚再抄一遍就是同一条信息出现两次。页脚负责"一句话说清结局"。
//   3. tone 只决定颜色，不决定文案 —— 文案在 chat-core，这里只画。

import { endFooterOf } from '@diy-agent/chat-core';
import * as React from 'react';

import type { TurnEndReason } from '../model';

const TONE_CLASS: Record<'muted' | 'warn' | 'bad', string> = {
    muted: 'text-muted-foreground',
    warn: 'text-amber-500',
    bad: 'text-red-400',
};

const TONE_DOT: Record<'muted' | 'warn' | 'bad', string> = {
    muted: 'bg-current opacity-60',
    warn: 'bg-current',
    bad: 'bg-current',
};

export function EndFooterLine({ reason }: { reason: TurnEndReason | undefined }) {
    const footer = endFooterOf(reason);
    if (footer === undefined) return null;

    return (
        <div
            className={`flex items-center gap-1.5 pt-1.5 text-[12px] leading-4 ${TONE_CLASS[footer.tone]}`}
            title={footer.detail ?? footer.label}
        >
            <span className={`inline-block size-1.5 rounded-full ${TONE_DOT[footer.tone]}`} aria-hidden="true" />
            <span>{footer.label}</span>
        </div>
    );
}
