// ChatPanel —— assistant-ui surface：官方模板 Thread + chat-core 的 ConversationModel。
//
// 只做两件事：把 ConversationModel 投影成 ThreadMessageLike；把 UI 意图转成 model 的 intents。

import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react';
import * as React from 'react';

import { Thread } from '../assistant-ui/components/assistant-ui/elements/thread.aui';
import { ErrorBar } from './ErrorBar';
import { MentionBotsProvider, useMentionCandidates } from '../mentions';
import { toThreadMessages } from '../projection';
import { useWindowed } from './useWindowed';
import { conversationOf, useStore } from '../store';

export function ChatPanel({ targetId }: { targetId: string }) {
    const shell = useStore();
    const conversation = conversationOf(targetId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);

    const messages = React.useMemo(
        () => toThreadMessages(state.items, state.deliveries, shell.bots, targetId, state.speaking, state.asks),
        [state.items, state.deliveries, shell.bots, targetId, state.speaking, state.asks],
    );
    // 长会话只渲染最近 N 条（600+ 条 markdown 是切换卡顿的主因）
    const windowed = useWindowed(messages);

    // 滑到顶部自动补一窗（官方是无限滚动，不放"显示更早"按钮）
    React.useEffect(() => {
        const viewport = document.querySelector('[data-slot="aui_thread-viewport"]');
        if (viewport === null) return;
        const onScroll = () => {
            if (viewport.scrollTop > 48) return;
            const before = viewport.scrollHeight;
            windowed.showMore();
            requestAnimationFrame(() => {
                viewport.scrollTop += viewport.scrollHeight - before;
            });
        };
        viewport.addEventListener('scroll', onScroll, { passive: true });
        return () => viewport.removeEventListener('scroll', onScroll);
    }, [windowed]);

    const mentionBots = useMentionCandidates(targetId);

    const runtime = useExternalStoreRuntime({
        messages: [...windowed.visible],
        setMessages: () => undefined,
        onNew: async (message) => {
            const text = message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('');
            conversation.send(text);
        },
        onCancel: async () => {
            conversation.cancel();
        },
        // 不把"有人在跑"映射成 composer 的 running 态：那会禁用输入并把发送换成停止，
        // 而插话是正常操作。停止在 SpeakingBar（按成员）和这里不用管。
        isRunning: false,
        convertMessage: (message) => message,
    });

    return (
        <MentionBotsProvider value={mentionBots}>
            <AssistantRuntimeProvider runtime={runtime}>
                <ErrorBar error={state.error} onRetry={conversation.reload} />
                <div className="min-h-0 flex-1">
                    <Thread />
                </div>
            </AssistantRuntimeProvider>
        </MentionBotsProvider>
    );
}
