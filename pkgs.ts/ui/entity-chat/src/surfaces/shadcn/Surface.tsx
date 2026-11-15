// Surface.tsx —— 第三个表面：**原生 shadcn/Tailwind**，不用任何 chat 库。
//
// 目的：验证"这套时间线 + chat-core 状态，自己拿 Tailwind 拼一遍"能不能达到同样的效果。
// 只用最普通的 div/button + 我们自己的共享件（BotAvatar / AskCard / RunningIndicator / Markdown），
// 不引入 assistant-ui 的 runtime，也不用 Astryx 的 Chat 组件。
//
// 与另外两面的关系：三面共用 buildTimeline（分组语义唯一）和 ConversationStore（状态唯一），
// 这里只写"怎么画"。

import { ChevronDown, Send, Square } from 'lucide-react';
import * as React from 'react';

import { buildTimeline, type TimelineEntry, type TimelinePart } from '@diy-agent/chat-core';

import { AskCard } from '../../components/AskCard';
import { BotAvatar } from '../../components/BotAvatar';
import { ErrorBar } from '../../components/ErrorBar';
import { Markdown } from '../../components/Markdown';
import { RunningIndicator } from '../../components/RunningIndicator';
import { ShowEarlier } from '../../components/ShowEarlier';
import { useWindowed } from '../../components/useWindowed';
import { conversationOf, useStore } from '../../store';

const TOOL_STATUS = { running: 'running', ok: 'ok', error: 'error' } as const;

function toolTargetOf(tool: TimelinePart & { kind: 'tool' }): string | undefined {
    const args = tool.args;
    if (args === undefined || args === null) return undefined;
    if (typeof args === 'object') {
        const record = args as Record<string, unknown>;
        for (const key of ['command', 'path', 'question', 'url']) {
            const value = record[key];
            if (typeof value === 'string' && value !== '') return value.length > 60 ? `${value.slice(0, 59)}…` : value;
        }
    }
    try {
        const text = JSON.stringify(args);
        return text.length > 60 ? `${text.slice(0, 59)}…` : text;
    } catch {
        return undefined;
    }
}

function timeOf(at: number): string {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function ToolGroup({ tools }: { tools: Array<TimelinePart & { kind: 'tool' }> }) {
    const [open, setOpen] = React.useState(false);
    if (tools.length === 1) {
        const tool = tools[0]!;
        return <ToolRow tool={tool} />;
    }
    return (
        <div className="my-1">
            <button
                onClick={() => setOpen((value) => !value)}
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
            >
                <ChevronDown className={`size-3 transition-transform ${open ? '' : '-rotate-90'}`} />
                工具调用 <span className="tabular-nums">({tools.length})</span>
            </button>
            {open && (
                <div className="mt-1 border-l border-border pl-3">
                    {tools.map((tool) => (
                        <ToolRow key={tool.id} tool={tool} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ToolRow({ tool }: { tool: TimelinePart & { kind: 'tool' } }) {
    const target = toolTargetOf(tool);
    const status = TOOL_STATUS[tool.state];
    const mark = status === 'running' ? '◌' : status === 'ok' ? '✓' : '✗';
    return (
        <div className={`flex items-center gap-1.5 py-0.5 text-[12px] ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
            <span>{mark}</span>
            <span className="font-mono">{tool.name}</span>
            {target !== undefined && <span className="truncate font-mono opacity-80">{target}</span>}
        </div>
    );
}

function EntryView({ entry, roomId }: { entry: TimelineEntry; roomId: string }) {
    if (entry.kind === 'notice' || entry.kind === 'error') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
        return (
            <div className="my-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>{text}</span>
                <span className="h-px flex-1 bg-border" />
            </div>
        );
    }

    if (entry.kind === 'typing') {
        return (
            <div className="my-2">
                <RunningIndicator name={entry.author?.name} since={entry.at} />
            </div>
        );
    }

    if (entry.kind === 'user') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
        const failed = entry.deliveries.filter((delivery) => delivery.state === 'failed');
        return (
            <div className="my-3 flex flex-col items-end gap-1">
                <div className="max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-[13px] whitespace-pre-wrap break-words">
                    {text}
                </div>
                <div className="flex items-center gap-2 pr-1 text-[10px] text-muted-foreground">
                    {failed.length > 0 && <span className="text-destructive">{failed.map((d) => `${d.name} 未送达`).join('、')}</span>}
                    <span>{timeOf(entry.at)}</span>
                </div>
            </div>
        );
    }

    // assistant：头像 + 名字一行，内容按 parts 顺序渲染
    const parts = entry.parts;
    return (
        <div className="my-4 flex gap-2.5">
            <div className="pt-0.5">
                <BotAvatar author={entry.author} roomId={roomId} size={26} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-2 text-[12px]">
                    <span className="font-medium" style={{ color: entry.author?.color }}>
                        {entry.author?.name ?? 'bot'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{timeOf(entry.at)}</span>
                </div>
                {parts.map((part, index) => {
                    if (part.kind === 'text') return <Markdown key={`t${index}`} text={part.text} />;
                    if (part.kind === 'ask') return <AskCard key={`a${index}`} roomId={roomId} request={part.request} />;
                    // 连续的 tool 合并成一组
                    const previous = parts[index - 1];
                    if (previous?.kind === 'tool') return null;
                    const tools = [] as Array<TimelinePart & { kind: 'tool' }>;
                    for (let cursor = index; cursor < parts.length; cursor += 1) {
                        const next = parts[cursor];
                        if (next?.kind !== 'tool') break;
                        tools.push(next);
                    }
                    return <ToolGroup key={`g${index}`} tools={tools} />;
                })}
            </div>
        </div>
    );
}

function Composer({
    conversation,
    running,
}: {
    conversation: ReturnType<typeof conversationOf>;
    running: boolean;
}) {
    const [draft, setDraft] = React.useState('');
    const send = () => {
        const text = draft.trim();
        if (text === '') return;
        conversation.send(text);
        setDraft('');
    };
    return (
        <div className="border-t bg-background px-4 py-3">
            <div className="flex items-end gap-2 rounded-xl border bg-card px-3 py-2">
                <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        // IME 组字中的 Enter 是上屏，不是发送
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            send();
                        }
                    }}
                    rows={1}
                    placeholder="和这个实体对话…（Enter 发送，Shift+Enter 换行）"
                    className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-[13px] outline-none"
                />
                {running ? (
                    <button
                        onClick={() => conversation.cancel()}
                        title="停止生成"
                        className="rounded-lg p-1.5 hover:bg-muted"
                    >
                        <Square className="size-4" />
                    </button>
                ) : (
                    <button
                        onClick={send}
                        disabled={draft.trim() === ''}
                        title="发送"
                        className="rounded-lg p-1.5 hover:bg-muted disabled:opacity-40"
                    >
                        <Send className="size-4" />
                    </button>
                )}
            </div>
        </div>
    );
}

export function ShadcnSurface({ targetId }: { targetId: string }) {
    const shell = useStore();
    const conversation = conversationOf(targetId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);

    const entries = React.useMemo(
        () => buildTimeline(state.items, state.deliveries, shell.bots, { speaking: state.speaking, asks: state.asks }),
        [state.items, state.deliveries, shell.bots, state.speaking, state.asks],
    );

    const windowed = useWindowed(entries);

    // 贴底跟随：只有"本来就在底部"时才自动滚，用户上翻就不打扰
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const stickRef = React.useRef(true);
    React.useEffect(() => {
        const element = scrollRef.current;
        if (element === null || !stickRef.current) return;
        element.scrollTop = element.scrollHeight;
    }, [entries]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {state.error !== undefined && state.error !== '' && (
                <ErrorBar error={state.error} onRetry={conversation.reload} />
            )}
            <div
                ref={scrollRef}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                }}
                role="log"
                aria-live="polite"
                aria-relevant="additions text"
                className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
            >
                {entries.length === 0 ? (
                    <div className="mt-16 text-center text-[13px] text-muted-foreground">
                        还没有消息。发一句，或 @ 一个 bot。
                    </div>
                ) : (
                    <>
                        <ShowEarlier hidden={windowed.hidden} onClick={windowed.showMore} />
                        {windowed.visible.map((entry) => (
                            <EntryView key={entry.key} entry={entry} roomId={targetId} />
                        ))}
                    </>
                )}
            </div>
            <Composer conversation={conversation} running={state.running} />
        </div>
    );
}
