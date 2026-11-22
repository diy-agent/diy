// PendingAskBar —— 房间里还有提问等你答：线程上方常驻一条，点了跳过去。
//
// 为什么需要：提问卡挂在**触发它的那一轮**里（位置准确，而且答完要留在那儿供核对），
// 代价是几轮之后它就沉到上面去了。侧栏只有一个 `?`，进房间后还得自己翻。
// 这条只做两件事：说清还欠几个、问的是什么，并给一个跳转入口 —— **卡不搬走**。
//
// 与 dsh / opencode 的取舍：它们把待答卡搬进 composer 下方的 dock（一次显示一个），
// 那是因为它们的提问**阻塞 run**，卡片就是那个 run 的唯一出口。diy 的提问不阻塞，
// 卡片属于"当时那一轮"，搬走会让它和上下文脱节；只补入口更合适。

import { HelpCircle } from 'lucide-react';

import type { AskRequest } from '@diy-agent/chat-core';

import { askChipOf, askChipTitleOf } from '../pendingAsk';

export function PendingAskBar({ asks, onJump }: { asks: readonly AskRequest[]; onJump: (askId: string) => void }) {
    if (asks.length === 0) return null;
    return (
        // 不 sticky：它在线程滚动区**外面**，本来就不跟着滚走（比 sticky 少一堆层叠上下文）
        <div className="flex shrink-0 items-center gap-2 border-b border-sky-500/25 bg-sky-500/5 px-2 py-1">
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-sky-500">
                <HelpCircle className="size-3" />
                等你回答 · {asks.length}
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {asks.map((request) => (
                    <button
                        key={request.askId}
                        onClick={() => onJump(request.askId)}
                        title={askChipTitleOf(request.questions)}
                        className="max-w-[16rem] shrink-0 truncate rounded-full border border-sky-500/30 px-2 py-0.5 text-[11px] text-foreground hover:bg-sky-500/10"
                    >
                        {askChipOf(request.questions)}
                    </button>
                ))}
            </div>
        </div>
    );
}
