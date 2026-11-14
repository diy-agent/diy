// Astryx surface —— 用 Astryx 的 Chat 组件族渲染同一条时间线。
//
// 与 assistant-ui surface 的分工完全一致：分组在 chat-core.buildTimeline，
// 这里只做「时间线条目 → Astryx 组件」的映射，不碰状态机、不碰传输。

import {
    Banner,
    Button,
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
    type ChatMessageStatus,
} from '@astryxdesign/core';
import { createStaticSource, type SearchableItem } from '@astryxdesign/core/Typeahead';
import { buildTimeline, type MentionCandidate, type TimelineEntry, type TimelinePart } from '@diy-agent/chat-core';
import { AskCard } from '../../components/AskCard';
import { BotAvatar } from '../../components/BotAvatar';
import { deliveryFooterOf, deliveryStatusOf, TOOL_STATUS, toolTargetOf } from './mapping';
import { RunningIndicator } from '../../components/RunningIndicator';
import * as React from 'react';

import { useMentionCandidates } from '../../mentions';
import { conversationOf, useStore } from '../../store';

type Run =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; tools: Extract<TimelinePart, { kind: 'tool' }>[] }
    | { kind: 'ask'; request: Extract<TimelinePart, { kind: 'ask' }>['request'] };

/** 把 parts 压成连续同类块：文本一段、工具一组，保持原有先后 */
function runsOf(parts: TimelinePart[]): Run[] {
    const runs: Run[] = [];
    for (const part of parts) {
        const last = runs.at(-1);
        if (part.kind === 'ask') {
            runs.push({ kind: 'ask', request: part.request });
            continue;
        }
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
            <ChatMessage
                key={entry.key}
                sender="user"
                avatar={<BotAvatar author={entry.author} roomId={roomId} size={24} />}
            >
                <ChatMessageBubble
                    metadata={
                        <ChatMessageMetadata
                            timestamp={<TimeOf at={entry.at} />}
                            footer={deliveryFooterOf(entry.deliveries)}
                            status={deliveryStatusOf(entry.deliveries)}
                        />
                    }
                >
                    {text}
                </ChatMessageBubble>
            </ChatMessage>
        );
    }

    if (entry.kind === 'typing') {
        // 占位不是一条消息：用 ChatSystemMessage（Astryx 的"sender 之外的状态行"），
        // 没有头像也没有气泡，就不会抢先占掉第一条真正 assistant 消息的位置。
        return (
            <ChatSystemMessage key={entry.key}>
                <RunningIndicator
                    {...(entry.author === undefined ? {} : { name: entry.author.name })}
                    since={entry.at}
                />
            </ChatSystemMessage>
        );
    }

    // 一条 entry 只用一个气泡：名字永远在气泡第一行，工具行和正文依次往下。
    // 拆成「工具行一个兄弟 + 正文一个气泡」会让名字落到第二行，而 Astryx 的头像偏移
    // 是按「消息里有没有 data-chat-name」算的，名字一旦不在首行，头像就开始漂。
    const runs = runsOf(entry.parts);
    return (
        <ChatMessage
            key={entry.key}
            sender="assistant"
            avatar={<BotAvatar author={entry.author} roomId={roomId} size={24} />}
        >
            <ChatMessageBubble
                variant="ghost"
                {...(entry.author === undefined ? {} : { name: entry.author.name })}
                metadata={<ChatMessageMetadata timestamp={<TimeOf at={entry.at} />} />}
            >
                {runs.map((run, index) =>
                    run.kind === 'ask' ? (
                        <AskCard key={`a${index}`} roomId={roomId} request={run.request} />
                    ) : run.kind === 'text' ? (
                        <Markdown key={`t${index}`} density="compact">
                            {run.text}
                        </Markdown>
                    ) : (
                        <ChatToolCalls
                            key={`c${index}`}
                            calls={run.tools.map((tool) => {
                                const target = toolTargetOf(tool);
                                return {
                                    key: tool.id,
                                    name: tool.name,
                                    status: TOOL_STATUS[tool.state],
                                    ...(target === undefined ? {} : { target }),
                                };
                            })}
                        />
                    ),
                )}
            </ChatMessageBubble>
        </ChatMessage>
    );
}

/**
 * 消息列表单独 memo：输入框每敲一个字都会让 Surface 重渲染，
 * 但整棵消息树（含 Markdown 解析）不该跟着重算 —— 不 memo 的话长会话里输入会明显卡。
 */
const MessageList = React.memo(function MessageList({ entries, roomId }: { entries: TimelineEntry[]; roomId: string }) {
    return (
        <>
            {entries.map((entry) => (
                <EntryView key={entry.key} entry={entry} roomId={roomId} />
            ))}
        </>
    );
});

/** 输入框独立成组件：draft 状态关在里面，敲字只重渲染输入框本身 */
function AstryxComposer({
    conversation,
    triggers,
    placeholder,
}: {
    conversation: ReturnType<typeof conversationOf>;
    triggers: React.ComponentProps<typeof ChatComposerInput>['triggers'];
    placeholder: string;
}) {
    const [draft, setDraft] = React.useState('');
    return (
        <ChatComposer
            value={draft}
            onChange={setDraft}
            placeholder={placeholder}
            onSubmit={(value) => {
                conversation.send(value);
                setDraft('');
            }}
            // 运行中也保持"发送"态：插话是正常操作，停止在 SpeakingBar 上
            onStop={() => conversation.cancel()}
            isStopShown={false}
            input={<ChatComposerInput triggers={triggers} label="Message input" placeholder={placeholder} />}
        />
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

    const entries = React.useMemo(
        () =>
            buildTimeline(state.items, state.deliveries, shell.bots, {
                speaking: state.speaking,
                asks: state.asks,
            }),
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
                            <span
                                style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 999,
                                    background: candidate?.color ?? '#9ca3af',
                                }}
                            />
                            <span>{item.label}</span>
                            {candidate?.isOwner === true && (
                                <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>owner</span>
                            )}
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
            {state.error === undefined || state.error === '' ? null : (
                <div style={{ paddingInline: 24, paddingBlock: 8 }}>
                    <Banner
                        status="error"
                        container="section"
                        collapsible={false}
                        title={state.error}
                        endContent={<Button size="sm" label="重试" onClick={() => conversation.reload()} />}
                    />
                </div>
            )}
            {/* 100% 宽 + 内边距：spacious 的 800px 上限叠在外层 880 壳里会左右不对称 */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingInline: 24 }}>
                <ChatLayout
                    density="balanced"
                    composer={
                        <AstryxComposer
                            conversation={conversation}
                            triggers={triggers}
                            placeholder="和这个实体对话…（@ 选 bot）"
                        />
                    }
                >
                    <ChatMessageList
                        density="balanced"
                        isStreaming={state.running}
                        emptyState={<EmptyState title="还没有消息" description="发一句，或 @ 一个 bot。" />}
                    >
                        <MessageList entries={entries} roomId={targetId} />
                    </ChatMessageList>
                </ChatLayout>
            </div>
        </div>
    );
}
