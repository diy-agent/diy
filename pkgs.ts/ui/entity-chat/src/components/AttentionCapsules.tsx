// AttentionCapsules.tsx —— 标题栏那排**分类计数徽标**（2026-11-25 用户报的红 7）。
//
// 以前是一颗总数染红：`attention = rows.filter(needsYou).length`，而当时的 `needsYou`
// 是 `state !== 'idle'` —— 出错、等你回答、在跑全算进一个数。于是「标题栏红 7，
// 点开是 4 错 + 2 等 + 1 跑」。互斥单值被当汇总计数用，这是模型错，不是样式错。
//
// 现在按关注度**分类各一颗**，只有「出错」用红；为 0 的类不显示（不是灰着写 0）；
// 全 0 时给一个灰点「都闲着」，仍然点得开（全表在浮层里）。
//
// 数字与浮层、筛选 tab 同源（`countByAttention`）—— 三处读一份，点开一定对得上。

import type { AttentionCounts, AttentionKind } from '../bots';
import { ATTENTION_DOT, ATTENTION_INK, ATTENTION_TEXT } from '../bots';

/** 会出现在徽标上的四类：`idle` 不占位（空闲不是“状态”，是“没有状态”） */
const COUNTED: readonly AttentionKind[] = ['broken', 'blocked', 'queued', 'live'];

export interface AttentionCapsulesProps {
    counts: AttentionCounts;
    /** 点某一颗 → 打开浮层并**预选这一类**（点「出错 4」就直接看到那 4 个） */
    onPick: (kind: AttentionKind) => void;
    /** 点间隙 / 全空闲时 → 打开浮层（默认筛选 = 非空闲） */
    onOpen: () => void;
}

export function AttentionCapsules({ counts, onPick, onOpen }: AttentionCapsulesProps) {
    const live = COUNTED.filter((kind) => counts[kind] > 0);
    if (live.length === 0) {
        return (
            <button
                type="button"
                onClick={onOpen}
                title="Bot 状态：都闲着（点开看全表）"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/60"
            >
                <span className="size-1.5 rounded-full bg-zinc-600" />
                都闲着
            </button>
        );
    }
    return (
        <span
            onClick={onOpen}
            title="Bot 状态（点间隙看全部）"
            className="flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 hover:bg-muted/60"
        >
            {live.map((kind) => (
                <button
                    key={kind}
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onPick(kind);
                    }}
                    title={`${ATTENTION_TEXT[kind]} ${counts[kind]} 个 —— 点开只看这一类`}
                    className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] ${ATTENTION_INK[kind]}`}
                >
                    <span className={`size-1.5 rounded-full ${ATTENTION_DOT[kind]}`} />
                    <span className="tabular-nums">{counts[kind]}</span>
                    <span className="text-muted-foreground">{ATTENTION_TEXT[kind]}</span>
                </button>
            ))}
        </span>
    );
}
