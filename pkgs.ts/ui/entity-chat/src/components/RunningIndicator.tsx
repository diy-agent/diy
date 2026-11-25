// RunningIndicator —— "这个 bot 正在跑"的唯一表达，两个 surface 共用。
//
// 为什么带秒数：占位消失就等于执行结束，只有三个点时用户分不清"跑完了"
// 和"卡住了"。秒数一直在涨 = 还在推进。
// 为什么用 Spinner：Astryx 的官方 loading 件（Feedback & Status 分类）；
// 两面共用它才能视觉一致（shadcn 面没有自己的 loading 件）。
//
// 为什么要报「疑似卡住」：秒数只说明"还在等"，不说明"在推进"。等上游首个字时
// 一分钟一个字都不出，界面上和"正常在跑"一模一样 —— ##560 那次卡了 15 分钟，
// 没有任何一处说"这不太对"。看门狗（entity-runtime/stall-watchdog）30 分钟才动手，
// 中间这段至少要让人知道：可以停，而且停得掉（停止按钮在 SpeakingBar / composer 上）。

import { Spinner } from '@astryxdesign/core';
import * as React from 'react';

/** 多少秒没有任何产出就报一声。比看门狗的 30 分钟早得多 —— 这条是给人看的，不是判定 */
const STUCK_AFTER_SECONDS = 180;

/**
 * 报不报「疑似卡住 · 可中止」。
 *
 * `stallable` = 这里的秒数能不能当"多久没产出"用（**不能一律按秒数报**）：
 *
 *  - **typing 可以**：它的 `at` 是本轮起点（timeline.ts 的 `startedAt`），而 typing
 *    本身就是"还没产出任何内容" ⇒ 秒数 = 纯净的无产出时长，只增不减，不会误报。
 *  - **waiting 不行**：它挂在回复条目上，`at` 是**这条回复的起点**（含中间所有流式
 *    推进）。一条跑了 4 分钟、刚推进完 5 秒就进入段间等待的回复会立刻被判卡住，
 *    而且每次段间空隙都会闪一下。waiting 没有"从什么时候开始等"这个事实 ⇒ 不报
 *    （那条路要先在 store 里记 lastProgress，不是这个组件能补的）。
 */
export function stuckHintOf(elapsed: number | undefined, stallable?: boolean): string | undefined {
    if (stallable !== true) return undefined;
    if (elapsed === undefined || elapsed < STUCK_AFTER_SECONDS) return undefined;
    return '疑似卡住 · 可中止';
}

function useElapsedSeconds(since: number | undefined): number | undefined {
    const [elapsed, setElapsed] = React.useState<number | undefined>(undefined);

    React.useEffect(() => {
        if (since === undefined) return;
        const compute = () => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)));
        compute();
        const timer = setInterval(compute, 1000);
        return () => clearInterval(timer);
    }, [since]);

    return since === undefined ? undefined : elapsed;
}

export function RunningIndicator({ name, since, stallable }: { name?: string; since?: number; stallable?: boolean }) {
    const elapsed = useElapsedSeconds(since);
    const hint = stuckHintOf(elapsed, stallable);
    const who = name === undefined || name === '' ? '' : `${name} `;
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                fontSize: 13,
                opacity: 0.72,
            }}
        >
            {/* 装饰性指示器：秒数每秒都变，`role="status"` 会让读屏每秒播报一次。
                真正的进展由 ChatMessageList 的 aria-live 在消息完成时播报。 */}
            <span
                aria-hidden="true"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
                <Spinner size="sm" shade="inherit" />
                <span>{`${who}${elapsed === undefined ? '执行中' : `执行中 ${elapsed}s`}`}</span>
            </span>
            {/* 只在真卡住时才进 DOM ⇒ 读屏播一次，不随秒数重复 */}
            {hint === undefined ? null : (
                <span role="status" style={{ color: '#b45309', fontWeight: 500 }}>
                    · {hint}
                </span>
            )}
        </span>
    );
}
