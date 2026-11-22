// PendingAskStrip —— 壳层的待答条：一个房间一条，**三个表面共用**。
//
// 为什么在壳层而不是各自表面里：条说的是「这个房间还欠几个问题的答案」，那是房间的事实，
// 不是某个表面的渲染细节。第一版挂在 assistant-ui 的 ChatPanel 里，lab 实机发现默认表面
// 是 astryx（App.tsx 的 surfaceId 缺省值）⇒ 条在用户实际看的那一屏上根本不存在。
//
// 跳转入口也不再由表面自己绑定：壳层调 `jumpToAsk(surfaceId, …)`，表面注册它自己的
// 「怎么把那张卡滚进视口」（窗口化的要 reveal、astryx 要 anchorToKey）。

import * as React from 'react';

import { jumpToAsk } from '../askJump';
import { conversationOf } from '../store';
import { PendingAskBar } from './PendingAskBar';

export function PendingAskStrip({ roomId, surfaceId }: { roomId: string; surfaceId: string }) {
    const conversation = conversationOf(roomId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);
    const onJump = React.useCallback((askId: string) => jumpToAsk(surfaceId, askId), [surfaceId]);
    return <PendingAskBar asks={state.asks} onJump={onJump} />;
}
