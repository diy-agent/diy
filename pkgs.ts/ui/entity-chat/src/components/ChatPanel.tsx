import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react';
import * as React from 'react';

import { Thread } from '../assistant-ui/components/assistant-ui/elements/thread.aui';
import { toThreadMessages } from '../projection';
import { actions, itemsOf, useStore } from '../store';

/**
 * 官方组件版：直接用 assistant-ui 模板里的 <Thread />（消息/输入/工具卡/自动滚动/无障碍）。
 * 我们的 Item → ThreadMessageLike 仍是唯一投影出口；作者行在 thread.aui 的 AssistantMessage 里读 metadata.custom。
 */
export function ChatPanel({ targetId }: { targetId: string }) {
    const state = useStore();
    const rawItems = itemsOf(targetId);
    const items = React.useMemo(() => [...rawItems].sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0) || a.seq - b.seq), [rawItems]);
    const running = state.running[targetId] === true;

    const messages = React.useMemo(() => toThreadMessages(items), [items]);

    const runtime = useExternalStoreRuntime({
        messages,
        setMessages: () => undefined,
        onNew: async (message) => {
            const text = message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('');
            actions.send(targetId, text);
        },
        isRunning: running,
        convertMessage: (message) => message,
    });

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="min-h-0 flex-1">
                <Thread />
            </div>
        </AssistantRuntimeProvider>
    );
}
