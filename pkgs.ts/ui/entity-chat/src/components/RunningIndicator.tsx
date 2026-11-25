// RunningIndicator —— "这个 bot 正在跑"的唯一表达，两个 surface 共用。
//
// 秒数怎么算，2026-11-24 改过一次（刀 3）：
//   旧：`执行中 1847s` —— 从条目创建算起，永远在涨。12 分钟的 bash 和卡死的模型流长得一样。
//   新：有 `progress` 事实时（服务端每 tick 给「在等谁 / 多久没动 / 有没有心跳」）：
//     · quiet   `<Spinner> 执行中 12s`              （与旧行为逐像素一致，正常思考不该变跳动）
//     · slow    `<Spinner> 等待模型响应 · 已 1m03s` （秒数从"等了多久"换成"多久没动"）
//     · stalled `<Spinner> 失联 2m05s（等模型响应）`
//     · alive   `<Spinner> bash 运行中 · 有进展 3s前`（有心跳永不报警）
//   没有 progress（刚刷新、还没到第一条 tick）时只留「执行中」四个字 —— **不带秒**：
//   轮次底行右侧已经有「已用 1m42s」，同一个时长说两遍就是两个数字在跳。
//
// 为什么用 Spinner：Astryx 的官方 loading 件（Feedback & Status 分类）；
// 两面共用它才能视觉一致（shadcn 面没有自己的 loading 件）。
//
// 为什么要报「疑似卡住」：秒数只说明"还在等"，不说明"在推进"。等上游首个字时
// 一分钟一个字都不出，界面上和"正常在跑"一模一样 —— ##560 那次卡了 15 分钟，
// 没有任何一处说"这不太对"。看门狗（entity-runtime/stall-watchdog）30 分钟才动手，
// 中间这段至少要让人知道：可以停，而且停得掉（停止按钮在 SpeakingBar / composer 上）。
//
// 两条判定并存（2026-11-25 合 main 时定的分工，**别让它们叠加**）：
//   · 有 `progress`（服务端每个 tick 给的事实）⇒ 用它的 `stage`：`stalled` 就变红说失联。
//     这是权威判定 —— 服务端知道"在等谁、多久没动、有没有心跳"。
//   · 没有 `progress`（刚刷新 / 老服务端）⇒ 退回 `since` 秒数判 `stuckHintOf`（180s）。
//     这条只是兜底：它只能看"这一轮开始多久了"，分不清"在跑"和"卡住"。

import { progressLineOf } from '@diy-agent/chat-core';
import { Spinner } from '@astryxdesign/core';
import * as React from 'react';

import { useBotProgress } from './useBotProgress';
import { useNow } from './useNow';

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
        if (since === undefined) {
            setElapsed(undefined);
            return;
        }
        const tick = (): void => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)));
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [since]);

    return since === undefined ? undefined : elapsed;
}

export function RunningIndicator({
    name,
    roomId,
    botId,
    since,
    stallable,
}: {
    name?: string;
    /** 两个 surface 都传：进展事实按 (房间, 成员) 取 */
    roomId?: string;
    botId?: string;
    /** 没有 progress 时的兜底秒数起点（见文件头「两条判定」） */
    since?: number;
    stallable?: boolean;
}) {
    const progress = useBotProgress(roomId, botId);
    const now = useNow(progress !== undefined);
    const elapsed = useElapsedSeconds(progress === undefined ? since : undefined);

    const who = name === undefined || name === '' ? '' : `${name} `;

    // 秒数只在一处：「已用」（右侧，整轮时长）由 TurnFooter 画；这里没有 progress 时
    // 连算术都不做 —— 两个计时器同时跑，一定会有一个看起来“不跟手”。
    const line =
        progress !== undefined
            ? `${who}${progressLineOf(progress, now)}`
            : `${who}${elapsed === undefined ? '执行中' : `执行中 ${elapsed}s`}`;
    // 只在真卡住时变红；slow 只是"比平时慢"，不要用颜色吓人
    const color = progress?.stage === 'stalled' ? 'var(--destructive, #dc2626)' : undefined;
    // progress 在时它说了算（stage 已经是服务端判定）；不在时才用 180s 兜底
    const hint = progress === undefined ? stuckHintOf(elapsed, stallable) : undefined;

    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                fontSize: 13,
                opacity: 0.72,
                ...(color === undefined ? {} : { color }),
            }}
        >
            {/* 装饰性指示器：秒数每秒都变，`role="status"` 会让读屏每秒播报一次。
                真正的进展由 ChatMessageList 的 aria-live 在消息完成时播报。 */}
            <span
                aria-hidden="true"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
                <Spinner size="sm" shade="inherit" />
                <span>{line}</span>
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
