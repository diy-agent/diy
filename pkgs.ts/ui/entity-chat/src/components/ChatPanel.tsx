// ChatPanel —— assistant-ui surface：官方模板 Thread + chat-core 的 ConversationModel。
//
// 只做两件事：把 ConversationModel 投影成 ThreadMessageLike；把 UI 意图转成 model 的 intents。

import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react';
import * as React from 'react';

import { Thread } from '../assistant-ui/components/assistant-ui/elements/thread.aui';
import { ErrorBar } from './ErrorBar';
import { MentionBotsProvider, useMentionCandidates } from '../mentions';
import { toThreadMessages } from '../projection';
import { conversationOf, useStore } from '../store';

export function ChatPanel({ targetId }: { targetId: string }) {
    const shell = useStore();
    const conversation = conversationOf(targetId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);

    const messages = React.useMemo(
        () => toThreadMessages(state.items, state.deliveries, shell.bots),
        [state.items, state.deliveries, shell.bots],
    );

    const mentionBots = useMentionCandidates(targetId);

    const runtime = useExternalStoreRuntime({
        messages,
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
        isRunning: state.running,
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
