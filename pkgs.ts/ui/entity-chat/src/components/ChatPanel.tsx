// ChatPanel —— assistant-ui surface：官方模板 Thread + chat-core 的 ConversationModel。
//
// 只做两件事：把 ConversationModel 投影成 ThreadMessageLike；把 UI 意图转成 model 的 intents。

import { AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime } from '@assistant-ui/react';
import * as React from 'react';

import { Thread } from '../assistant-ui/components/assistant-ui/elements/thread.aui';
import { ErrorBar } from './ErrorBar';
import { PendingAskBar } from './PendingAskBar';
import { MentionBotsProvider, useMentionCandidates } from '../mentions';
import { toThreadMessages } from '../projection';
import { useWindowed } from './useWindowed';
import { drafts } from '../drafts';
import { conversationOf, useStore } from '../store';

/**
 * 这条消息里有没有这一问（跳转前要先把这条纳入窗口）。
 *
 * 投影层把提问塞成 `data` part（`data-ask`，见 projection.ts），所以这里按数据找，
 * 不去解析正文。
 */
function carriesAsk(message: ReturnType<typeof toThreadMessages>[number], askId: string): boolean {
    const content = message.content;
    if (typeof content === 'string' || content === undefined) return false;
    return content.some((part) => {
        if (part.type !== 'data') return false;
        const data = (part as { data?: { request?: { askId?: string } } }).data;
        return data?.request?.askId === askId;
    });
}

export function ChatPanel({ targetId }: { targetId: string }) {
    const shell = useStore();
    const conversation = conversationOf(targetId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);

    const messages = React.useMemo(
        () =>
            toThreadMessages(
                state.items,
                state.deliveries,
                shell.bots,
                targetId,
                state.speaking,
                state.asks,
                state.answered,
                state.turnEnds,
            ),
        [
            state.items,
            state.deliveries,
            shell.bots,
            targetId,
            state.speaking,
            state.asks,
            state.answered,
            state.turnEnds,
        ],
    );
    // 长会话只渲染最近 N 条（600+ 条 markdown 是切换卡顿的主因）
    const windowed = useWindowed(messages);

    /**
     * 「等你回答」条上点了某问 → 滚到那张卡。
     *
     * 两步而不是一步：卡片可能还没渲染（窗口外 / 不在 DOM 里），所以先用 `reveal`
     * 把窗口扩到它那条，等它真的出现（下一次渲染）再滚 —— 直接 querySelector 会落空。
     */
    const [jumpTo, setJumpTo] = React.useState<string | null>(null);
    const flashTimer = React.useRef<number | undefined>(undefined);
    const jumpToAsk = React.useCallback(
        (askId: string) => {
            windowed.reveal((message) => carriesAsk(message, askId));
            setJumpTo(askId);
        },
        [windowed],
    );
    React.useEffect(() => {
        if (jumpTo === null) return;
        const element = document.querySelector<HTMLElement>(`[data-ask-id="${jumpTo}"]`);
        if (element === null) return; // 还没渲染出来：等下一次窗口变化再试
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // 闪一下：跳过去之后用户得知道"是哪张卡"（一两轮之后卡片长得都一样）
        element.classList.add('ring-2', 'ring-sky-400');
        if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => {
            element.classList.remove('ring-2', 'ring-sky-400');
            flashTimer.current = undefined;
        }, 1600);
        setJumpTo(null);
    }, [jumpTo, windowed.visible]);

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

    // 发送期间不清草稿：assistant-ui 一 dispatch 就把输入框清空，但"发出去了"要等后端受理。
    // 失败时抛 MessageNotSentError，它会把这句还给输入框，草稿原样还在。
    const sendingRef = React.useRef(false);
    const runtime = useExternalStoreRuntime({
        messages: [...windowed.visible],
        setMessages: () => undefined,
        onNew: async (message) => {
            const text = message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('');
            if (text.trim() === '') return;
            sendingRef.current = true;
            try {
                await conversation.send(text);
                drafts.clearIfMatches(targetId, 'composer', text);
            } catch (error) {
                // 抛这个（而不是吞掉）才能让 assistant-ui 把文字放回输入框；
                // 草稿本来就是失败的兜底，不需要再恢复一次
                throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
            } finally {
                sendingRef.current = false;
            }
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
                {/* 有提问在等回答就常驻一条：侧栏的 ? 只说"有几个"，这里说"问的是什么" */}
                <PendingAskBar asks={state.asks} onJump={jumpToAsk} />
                <div className="min-h-0 flex-1">
                    <Thread roomId={targetId} sendingRef={sendingRef} />
                </div>
            </AssistantRuntimeProvider>
        </MentionBotsProvider>
    );
}
