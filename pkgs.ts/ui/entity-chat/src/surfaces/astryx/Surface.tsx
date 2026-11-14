// Astryx surface —— 用 Astryx 的 Chat 组件族渲染同一条时间线。
//
// 与 assistant-ui surface 的分工完全一致：分组在 chat-core.buildTimeline，
// 这里只做「时间线条目 → Astryx 组件」的映射，不碰状态机、不碰传输。

import {
    ChatComposer,
    ChatComposerInput,
    ChatLayout,
    ChatMessage,
    ChatMessageBubble,
    ChatMessageList,
    ChatMessageMetadata,
    ChatSystemMessage,
    ChatToolCalls,
    EmptyState,
    Markdown,
    Timestamp,
    Token,
} from '@astryxdesign/core';
import { createStaticSource, type SearchableItem } from '@astryxdesign/core/Typeahead';
import { buildTimeline, type MentionCandidate, type TimelineEntry, type TimelinePart } from '@diy-agent/chat-core';
import { BotAvatar } from '../../components/BotAvatar';
import { TypingDots } from '../../components/TypingDots';
import * as React from 'react';

import { ErrorBar } from '../../components/ErrorBar';
import { useMentionCandidates } from '../../mentions';
import { conversationOf, useStore } from '../../store';

type Run = { kind: 'text'; text: string } | { kind: 'tool'; tools: Extract<TimelinePart, { kind: 'tool' }>[] };

/** 把 parts 压成连续同类块：文本一段、工具一组，保持原有先后 */
function runsOf(parts: TimelinePart[]): Run[] {
    const runs: Run[] = [];
    for (const part of parts) {
        const last = runs.at(-1);
        if (part.kind === 'text') {
            if (last?.kind === 'text') last.text += `\n\n${part.text}`;
            else runs.push({ kind: 'text', text: part.text });
        } else if (last?.kind === 'tool') {
            last.tools.push(part);
        } else {
            runs.push({ kind: 'tool', tools: [part] });
        }
    }
    return runs;
}

const TOOL_STATUS = { running: 'running', ok: 'complete', error: 'error' } as const;

/** 工具调用的"目标"：path / command 优先，其他参数退化成一行 JSON */
function toolTargetOf(tool: TimelinePart & { kind: 'tool' }): string | undefined {
    const args = tool.args;
    if (args === undefined || args === null) return undefined;
    if (typeof args === 'object') {
        const record = args as Record<string, unknown>;
        for (const key of ['path', 'command', 'question', 'url']) {
            const value = record[key];
            if (typeof value === 'string' && value !== '') return value;
        }
    }
    try {
        return JSON.stringify(args).slice(0, 80);
    } catch {
        return undefined;
    }
}

function DeliveryChips({ entry, roomId }: { entry: TimelineEntry; roomId: string }) {
    if (entry.deliveries.length === 0) return null;
    return (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {entry.deliveries.map((delivery) => {
                const label =
                    delivery.state === 'delivered'
                        ? '已收到'
                        : delivery.state === 'failed'
                          ? '失败'
                          : delivery.state === 'delivering'
                            ? '发送中'
                            : '排队';
                return (
                    <Token
                        key={delivery.botId}
                        size="sm"
                        label={`${delivery.name} ${label}`}
                        icon={
                            <BotAvatar
                                author={{ id: delivery.botId, name: delivery.name, color: delivery.color, role: 'bot' }}
                                roomId={roomId}
                                size={14}
                            />
                        }
                    />
                );
            })}
        </span>
    );
}

/** 时间戳（Astryx Timestamp 收秒或 ISO；我们的 at 是毫秒） */
function TimeOf({ at }: { at: number }) {
    return <Timestamp value={Math.floor(at / 1000)} format="time" />;
}

function EntryView({ entry, roomId }: { entry: TimelineEntry; roomId: string }) {
    if (entry.kind === 'notice' || entry.kind === 'error') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
        return (
            <ChatSystemMessage key={entry.key} variant={entry.kind === 'notice' ? 'divider' : 'default'}>
                {text}
            </ChatSystemMessage>
        );
    }

    if (entry.kind === 'user') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
        return (
            <ChatMessage key={entry.key} sender="user" name={entry.author?.name} avatar={<BotAvatar author={entry.author} roomId={roomId} size={24} />}>
                <ChatMessageBubble
                    metadata={
                        <>
                            <DeliveryChips entry={entry} roomId={roomId} />
                            <TimeOf at={entry.at} />
                        </>
                    }
                >
                    {text}
                </ChatMessageBubble>
            </ChatMessage>
        );
    }

    if (entry.kind === 'typing') {
        return (
            <ChatMessage key={entry.key} sender="assistant" name={entry.author?.name} avatar={<BotAvatar author={entry.author} roomId={roomId} size={24} />}>
                <ChatMessageBubble>
                    <TypingDots />
                </ChatMessageBubble>
            </ChatMessage>
        );
    }

    return (
        <ChatMessage key={entry.key} sender="assistant" name={entry.author?.name} avatar={<BotAvatar author={entry.author} roomId={roomId} size={24} />}>
            {runsOf(entry.parts).map((run, index) => {
                const isLast = index === runsOf(entry.parts).length - 1;
                if (run.kind === 'text') {
                    return (
                        <ChatMessageBubble
                            key={`t${index}`}
                            variant="ghost"
                            metadata={
                                isLast ? (
                                    <ChatMessageMetadata timestamp={<TimeOf at={entry.at} />} />
                                ) : undefined
                            }
                        >
                            <Markdown density="compact">{run.text}</Markdown>
                        </ChatMessageBubble>
                    );
                }
                return (
                    <ChatToolCalls
                        key={`c${index}`}
                        calls={run.tools.map((tool) => ({
                            key: tool.id,
                            name: tool.name,
                            status: TOOL_STATUS[tool.state],
                            ...(toolTargetOf(tool) === undefined ? {} : { target: toolTargetOf(tool)! }),
                        }))}
                    />
                );
            })}
        </ChatMessage>
    );
}

/** 候选 → Astryx 触发器菜单的条目 */
function toSearchItems(candidates: MentionCandidate[]): SearchableItem<MentionCandidate>[] {
    return candidates.map((candidate) => ({ id: candidate.id, label: candidate.name, auxiliaryData: candidate }));
}

export function AstryxSurface({ targetId }: { targetId: string }) {
    const shell = useStore();
    const conversation = conversationOf(targetId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);
    const [draft, setDraft] = React.useState('');

    const entries = React.useMemo(
        () => buildTimeline(state.items, state.deliveries, shell.bots, { speaking: state.speaking }),
        [state.items, state.deliveries, shell.bots, state.speaking],
    );

    const candidates = useMentionCandidates(targetId);
    const triggers = React.useMemo(
        () => [
            {
                character: '@',
                searchSource: createStaticSource(toSearchItems(candidates)),
                renderItem: (item: SearchableItem) => {
                    const candidate = item.auxiliaryData as MentionCandidate | undefined;
                    return (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: 999, background: candidate?.color ?? '#9ca3af' }} />
                            <span>{item.label}</span>
                            {candidate?.isOwner === true && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>owner</span>}
                        </span>
                    );
                },
                onSelect: (item: SearchableItem) => `@${item.label} `,
            },
        ],
        [candidates],
    );

    return (
        <div data-astryx-theme="neutral" style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <ErrorBar error={state.error} onRetry={conversation.reload} />
            {/* 100% 宽 + 内边距：spacious 的 800px 上限叠在外层 880 壳里会左右不对称 */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingInline: 24 }}>
            <ChatLayout
                density="balanced"
                composer={
                    <ChatComposer
                        value={draft}
                        onChange={setDraft}
                        placeholder="和这个实体对话…（@ 选 bot）"
                        onSubmit={(value) => {
                            conversation.send(value);
                            setDraft('');
                        }}
                        // 运行中也保持"发送"态：插话是正常操作，停止在 SpeakingBar 上
                        onStop={() => conversation.cancel()}
                        isStopShown={false}
                        input={<ChatComposerInput triggers={triggers} label="Message input" placeholder="和这个实体对话…（@ 选 bot）" />}
                    />
                }
            >
                <ChatMessageList
                    density="balanced"
                    isStreaming={state.running}
                    emptyState={<EmptyState title="还没有消息" description="发一句，或 @ 一个 bot。" />}
                >
                    {entries.map((entry) => (
                        <EntryView key={entry.key} entry={entry} roomId={targetId} />
                    ))}
                </ChatMessageList>
            </ChatLayout>
            </div>
        </div>
    );
}
