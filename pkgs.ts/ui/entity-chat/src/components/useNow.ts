// useNow —— 每秒一次的本地时钟，只在真需要它时跑。
//
// 谁需要：要把「多久没动」显示出来的小组件（RunningIndicator / RoomStatusBar）。
// 谁不需要：消息列表 —— 一个每秒变的值顺着 props 传下去，整棵时间线会每秒重渲。
//
// `active=false` 时**不起定时器**，也不故意把值冻住：调用方在这种情况下不显示秒数，
// 值是多少都无所谓，省掉一个空转的 interval 更划算。

import * as React from 'react';

export function useNow(active: boolean): number {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}
