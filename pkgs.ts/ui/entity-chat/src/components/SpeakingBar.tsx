// SpeakingBar —— 谁在说话。
//
// 房间里有多个 bot，随时可能有一个或几个在跑。sender 是"每条消息的身份"，
// 而"现在谁在生成"是房间级状态（服务端 running 事件），两者不能混。
// 这里给每个在说话的成员一个独立的停止按钮；composer 的停止按钮仍然是"全停"。

import { Square } from 'lucide-react';
import * as React from 'react';

import { conversationOf, useStore } from '../store';

export function SpeakingBar({ roomId }: { roomId: string }) {
    const shell = useStore();
    const conversation = conversationOf(roomId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);

    if (state.speaking.length === 0) return null;

    return (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-[11px] text-muted-foreground">
            {state.speaking.map((botId) => {
                const bot = shell.bots[botId];
                return (
                    <span key={botId} className="flex items-center gap-1.5 rounded-full border px-2 py-0.5">
                        <span className="size-2 animate-pulse rounded-full" style={{ background: bot?.color ?? '#9ca3af' }} />
                        <span>{bot?.name ?? botId}</span>
                        <span>正在说话…</span>
                        <button
                            onClick={() => conversation.stop(botId)}
                            title={`只停 ${bot?.name ?? botId}`}
                            className="ml-0.5 flex items-center gap-0.5 rounded px-1 hover:bg-muted"
                        >
                            <Square className="size-2.5" />
                            停
                        </button>
                    </span>
                );
            })}
        </div>
    );
}
