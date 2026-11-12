import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime } from '@assistant-ui/react';
import { ArrowUp, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as React from 'react';

import type { Author } from '../model';
import { toThreadMessages, type CustomMeta } from '../projection';
import { actions, itemsOf, useStore } from '../store';

function useMeta(): CustomMeta | undefined {
    return useAuiState((s) => (s.message.metadata as unknown as { custom?: CustomMeta } | undefined)?.custom);
}

function AuthorLine({ author }: { author: Author }) {
    return (
        <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="size-2 rounded-full" style={{ background: author.color }} />
            <span className="font-medium" style={{ color: author.color }}>
                {author.name}
            </span>
            <span className="text-muted-foreground">{author.role}</span>
        </div>
    );
}

function NoticeRow({ text }: { text: string }) {
    return (
        <div className="my-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <span>{text}</span>
            <span className="h-px flex-1 bg-border" />
        </div>
    );
}

function ChatMessage() {
    const meta = useMeta();

    if (meta?.kind === 'notice') {
        return (
            <MessagePrimitive.Root className="w-full">
                <MessagePrimitive.Parts components={{ Text: ({ text }) => <NoticeRow text={text} /> }} />
            </MessagePrimitive.Root>
        );
    }

    const isUser = meta?.author?.role === 'human';
    return (
        <MessagePrimitive.Root className={isUser ? 'flex flex-col items-end' : 'flex flex-col items-start'}>
            {meta?.author !== undefined && <AuthorLine author={meta.author} />}
            <div
                className={
                    isUser
                        ? 'max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground'
                        : 'max-w-[85%] whitespace-pre-wrap rounded-2xl border bg-card px-3 py-2 text-sm'
                }
            >
                <MessagePrimitive.Parts
                    components={{
                        Text: ({ text }) => (
                            <div className="prose-invert max-w-none text-sm leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                            </div>
                        ),
                    }}
                />
            </div>
        </MessagePrimitive.Root>
    );
}

export function ChatPanel({ targetId }: { targetId: string }) {
    const state = useStore();
    const rawItems = itemsOf(targetId);
    const items = React.useMemo(() => [...rawItems].sort((a, b) => a.seq - b.seq), [rawItems]);
    const running = state.running[targetId] === true;

    // Item → ThreadMessageLike（每次渲染重算；真实项目里按 item 引用做 memo）
    const messages = React.useMemo(() => toThreadMessages(items), [items]);

    const runtime = useExternalStoreRuntime({
        messages,
        // 真源在 store：runtime 发起的删除/编辑不接管（本 demo 只做发送）
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
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
                <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                        <ThreadPrimitive.Empty>
                            <div className="pt-16 text-center text-sm text-muted-foreground">
                                这是<strong className="text-foreground"> 项目/任务本体 </strong>的对话 —— 直接说话即可
                            </div>
                        </ThreadPrimitive.Empty>
                        <ThreadPrimitive.Messages>{() => <ChatMessage />}</ThreadPrimitive.Messages>
                    </div>
                </ThreadPrimitive.Viewport>

                <div className="border-t px-5 py-3">
                    <ComposerPrimitive.Root className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border bg-card p-2">
                        <ComposerPrimitive.Input
                            rows={2}
                            placeholder="和这个实体对话…（Enter 发送 / Shift+Enter 换行）"
                            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none"
                        />
                        <ComposerPrimitive.Send className="rounded-lg bg-primary p-2 text-primary-foreground data-[disabled]:opacity-40" aria-label="发送">
                            <ArrowUp className="size-4" />
                        </ComposerPrimitive.Send>
                        <ComposerPrimitive.Cancel className="rounded-lg border p-2" aria-label="停止">
                            <Square className="size-4" />
                        </ComposerPrimitive.Cancel>
                    </ComposerPrimitive.Root>
                </div>
            </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
    );
}
