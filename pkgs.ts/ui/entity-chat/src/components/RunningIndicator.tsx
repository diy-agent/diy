// RunningIndicator —— "这个 bot 正在跑"的唯一表达，两个 surface 共用。
//
// 为什么带秒数：占位消失就等于执行结束，只有三个点时用户分不清"跑完了"
// 和"卡住了"。秒数一直在涨 = 还在推进。
// 为什么用 Spinner：Astryx 的官方 loading 件（Feedback & Status 分类）；
// assistant-ui 没有对应组件，共用它才能让两个 surface 视觉一致。

import { Spinner } from '@astryxdesign/core';
import * as React from 'react';

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

export function RunningIndicator({ name, since }: { name?: string; since?: number }) {
    const elapsed = useElapsedSeconds(since);
    const who = name === undefined || name === '' ? '' : `${name} `;
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
            }}
        >
            <Spinner size="sm" shade="inherit" />
            <span>{`${who}${elapsed === undefined ? '执行中' : `执行中 ${elapsed}s`}`}</span>
        </span>
    );
}
