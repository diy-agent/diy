// RunningIndicator —— "这个 bot 正在跑"的唯一表达，两个 surface 共用。
//
// 秒数怎么算，2026-11-24 改过一次（刀 3）：
//   旧：`执行中 1847s` —— 从条目创建算起，永远在涨。12 分钟的 bash 和卡死的模型流长得一样。
//   新：有 `progress` 事实时（服务端每 tick 给「在等谁 / 多久没动 / 有没有心跳」）：
//     · quiet   `<Spinner> 执行中 12s`              （与旧行为逐像素一致，正常思考不该变跳动）
//     · slow    `<Spinner> 等待模型响应 · 已 1m03s` （秒数从"等了多久"换成"多久没动"）
//     · stalled `<Spinner> 失联 2m05s（等模型响应）`
//     · alive   `<Spinner> bash 运行中 · 有进展 3s前`（有心跳永不报警）
//   没有 progress（刚刷新、还没到第一条 tick）时退回旧显示 —— 至少不会更差。
//
// 为什么用 Spinner：Astryx 的官方 loading 件（Feedback & Status 分类）；
// 两面共用它才能视觉一致（shadcn 面没有自己的 loading 件）。

import { progressLineOf } from '@diy-agent/chat-core';
import { Spinner } from '@astryxdesign/core';
import * as React from 'react';

import { useBotProgress } from './useBotProgress';
import { useNow } from './useNow';

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

export function RunningIndicator({
    name,
    since,
    roomId,
    botId,
}: {
    name?: string;
    since?: number;
    /** 两个 surface 都传：进展事实按 (房间, 成员) 取 */
    roomId?: string;
    botId?: string;
}) {
    const progress = useBotProgress(roomId, botId);
    const now = useNow(progress !== undefined);
    const elapsed = useElapsedSeconds(progress === undefined ? since : undefined);
    const who = name === undefined || name === '' ? '' : `${name} `;

    const line =
        progress === undefined
            ? `${who}${elapsed === undefined ? '执行中' : `执行中 ${elapsed}s`}`
            : `${who}${progressLineOf(progress, now)}`;
    // 只在真卡住时变红；slow 只是"比平时慢"，不要用颜色吓人
    const color = progress?.stage === 'stalled' ? 'var(--destructive, #dc2626)' : undefined;

    return (
        <span
            // 装饰性指示器：秒数每秒都变，`role="status"` 会让读屏每秒播报一次。
            // 真正的进展由 ChatMessageList 的 aria-live 在消息完成时播报。
            aria-hidden="true"
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
            <Spinner size="sm" shade="inherit" />
            <span>{line}</span>
        </span>
    );
}
