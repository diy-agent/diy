// Astryx surface —— 用 Astryx 的 Chat 组件族渲染同一条时间线。
//
// 与 assistant-ui surface 的分工完全一致：分组在 chat-core.buildTimeline，
// 这里只做「时间线条目 → Astryx 组件」的映射，不碰状态机、不碰传输。

import { ChatComposer, ChatComposerInput, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, ChatSystemMessage, ChatToolCalls } from '@astryxdesign/core';
import { createStaticSource, type SearchableItem } from '@astryxdesign/core/Typeahead';
import { buildTimeline, type MentionCandidate, type TimelineEntry, type TimelinePart } from '@diy-agent/chat-core';
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

function DeliveryChips({ entry }: { entry: TimelineEntry }) {
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
                    <span
                        key={delivery.botId}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, opacity: 0.72 }}
                    >
                        <span style={{ width: 6, height: 6, borderRadius: 999, background: delivery.color }} />
                        {delivery.name} {label}
                    </span>
                );
            })}
        </span>
    );
}

function EntryView({ entry }: { entry: TimelineEntry }) {
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
            <ChatMessage key={entry.key} sender="user" name={entry.author?.name}>
                <ChatMessageBubble metadata={<DeliveryChips entry={entry} />}>{text}</ChatMessageBubble>
            </ChatMessage>
        );
    }

    return (
        <ChatMessage key={entry.key} sender="assistant" name={entry.author?.name}>
            {runsOf(entry.parts).map((run, index) =>
                run.kind === 'text' ? (
                    <ChatMessageBubble key={`t${index}`}>
                        <span style={{ whiteSpace: 'pre-wrap' }}>{run.text}</span>
                    </ChatMessageBubble>
                ) : (
                    <ChatToolCalls
                        key={`c${index}`}
                        calls={run.tools.map((tool) => ({
                            key: tool.id,
                            name: tool.name,
                            status: TOOL_STATUS[tool.state],
                            target: tool.args === undefined ? undefined : JSON.stringify(tool.args).slice(0, 80),
                        }))}
                    />
                ),
            )}
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
        () => buildTimeline(state.items, state.deliveries, shell.bots),
        [state.items, state.deliveries, shell.bots],
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
            <ChatLayout
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
                    isStreaming={state.running}
                    emptyState={
                        <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>还没有消息。发一句，或 @ 一个 bot。</div>
                    }
                >
                    {entries.map((entry) => (
                        <EntryView key={entry.key} entry={entry} />
                    ))}
                </ChatMessageList>
            </ChatLayout>
        </div>
    );
}
