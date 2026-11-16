// Astryx surface —— 用 Astryx 的 Chat 组件族渲染同一条时间线。
//
// 与 assistant-ui surface 的分工完全一致：分组在 chat-core.buildTimeline，
// 这里只做「时间线条目 → Astryx 组件」的映射，不碰状态机、不碰传输。

import {
    Banner,
    Button,
    ChatComposer,
    ChatComposerInput,
    ChatMessage,
    ChatMessageBubble,
    ChatMessageMetadata,
    ChatSystemMessage,
    ChatToolCalls,
    Markdown,
    Timestamp,
    type ChatMessageStatus,
} from '@astryxdesign/core';
import { createStaticSource, type SearchableItem } from '@astryxdesign/core/Typeahead';
import { ChatVirtualizer } from '@astryxdesign/lab';
import { buildTimeline, type MentionCandidate, type TimelineEntry, type TimelinePart } from '@diy-agent/chat-core';
import { AskCard } from '../../components/AskCard';
import { BotAvatar } from '../../components/BotAvatar';
import { EndFooterLine } from '../../components/EndFooterLine';
import { deliveryFooterOf, deliveryStatusOf, TOOL_STATUS, toolTargetOf } from './mapping';
import { RunningIndicator } from '../../components/RunningIndicator';
import * as React from 'react';

import { useMentionCandidates } from '../../mentions';
import { conversationOf, useStore } from '../../store';

type AskPart = Extract<TimelinePart, { kind: 'ask' }>;
type Run =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; tools: Extract<TimelinePart, { kind: 'tool' }>[] }
    | { kind: 'ask'; part: AskPart };

/** 把 parts 压成连续同类块：文本一段、工具一组，保持原有先后 */
function runsOf(parts: TimelinePart[]): Run[] {
    const runs: Run[] = [];
    for (const part of parts) {
        const last = runs.at(-1);
        if (part.kind === 'ask') {
            runs.push({ kind: 'ask', part });
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
    if (entry.kind === 'notice') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
        return (
            <ChatSystemMessage key={entry.key} variant="divider">
                {text}
            </ChatSystemMessage>
        );
    }

    if (entry.kind === 'error') {
        // 失败是"某个 bot 的回复失败"：走和普通回复同一条消息外壳（头像 + 名字），
        // 只是正文换成错误框 —— 归属清楚，又和系统提示（分隔线）区分开。
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
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
                    <Banner status="error" container="section" collapsible={false} title={text} />
                </ChatMessageBubble>
            </ChatMessage>
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
        // 还没产出任何内容：用和正式回复一样的消息外壳（头像 + 名字），
        // 第一段内容到达时只是"同一个位置换了内容"，不会跳。
        return (
            <ChatMessage
                key={entry.key}
                sender="assistant"
                avatar={<BotAvatar author={entry.author} roomId={roomId} size={24} />}
                {...(entry.author === undefined ? {} : { name: entry.author.name })}
                metadata={<ChatMessageMetadata timestamp={<TimeOf at={entry.at} />} />}
            >
                <div style={{ paddingBlock: 2 }}>
                    <RunningIndicator since={entry.at} />
                </div>
            </ChatMessage>
        );
    }

    // 一条 entry 只用一个气泡：名字永远在气泡第一行，工具行和正文依次往下。
    // 拆成「工具行一个兄弟 + 正文一个气泡」会让名字落到第二行，而 Astryx 的头像偏移
    // 是按「消息里有没有 data-chat-name」算的，名字一旦不在首行，头像就开始漂。
    const runs = runsOf(entry.parts);
    // 同一轮的续段：不重复头像与名字，左侧用一条细线接上，视觉上仍属于这一轮。
    const continued = entry.continued === true;
    return (
        <ChatMessage
            key={entry.key}
            sender="assistant"
            avatar={
                continued ? (
                    <div
                        style={{
                            width: 24,
                            alignSelf: 'stretch',
                            display: 'flex',
                            justifyContent: 'center',
                            paddingBlock: 4,
                        }}
                    >
                        <div style={{ width: 1, minHeight: 22, background: 'currentColor', opacity: 0.18, borderRadius: 1 }} />
                    </div>
                ) : (
                    <BotAvatar author={entry.author} roomId={roomId} size={24} />
                )
            }
        >
            <ChatMessageBubble
                variant="ghost"
                {...(continued || entry.author === undefined ? {} : { name: entry.author.name })}
                {...(continued ? {} : { metadata: <ChatMessageMetadata timestamp={<TimeOf at={entry.at} />} /> })}
            >
                {runs.map((run, index) =>
                    run.kind === 'ask' ? (
                        <AskCard
                            key={`a${index}`}
                            roomId={roomId}
                            request={run.part.request}
                            {...(run.part.answer === undefined && run.part.cancelled !== true
                                ? {}
                                : {
                                      resolved: {
                                          ...(run.part.answer === undefined ? {} : { answer: run.part.answer }),
                                          ...(run.part.cancelled === true ? { cancelled: true } : {}),
                                          ...(run.part.reason === undefined ? {} : { reason: run.part.reason }),
                                      },
                                  })}
                        />
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
                {/* 还在跑但没有流式内容（工具刚结束 / 等待下一段）：挂在正文末尾，
                    不再单独占列表底部一行 */}
                {entry.waiting === true && (
                    <div style={{ paddingTop: 6 }}>
                        <RunningIndicator since={entry.at} />
                    </div>
                )}
                {/* 这一轮是怎么停的：正常收尾不占页脚（endFooterOf 对 completed 返回 undefined） */}
                <EndFooterLine reason={entry.endReason} />
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
                // content-visibility：离开视口的条目跳过布局/绘制（assistant-ui 模板同款）
                <div key={entry.key} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}>
                    <EntryView entry={entry} roomId={roomId} />
                </div>
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

/** ChatVirtualizer 的行高估值：偏低无妨（内容长出来时位置仍然有效） */
function estimateRowHeight(entry: TimelineEntry): number {
    if (entry.kind === 'user') return 64;
    if (entry.kind === 'typing' || entry.kind === 'notice') return 48;
    if (entry.kind === 'error') return 96;
    return 180;
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
                answered: state.answered,
                endReasons: state.turnEnds,
            }),
        [state.items, state.deliveries, shell.bots, state.speaking, state.asks, state.answered],
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
            {/* 长会话用官方 ChatVirtualizer：只渲染视口附近的条目（1 万条的 story 也是它） */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingInline: 24 }}>
                <ChatVirtualizer
                    data={entries}
                    getRowKey={(entry) => entry.key}
                    getItemType={(entry) => entry.kind}
                    estimatedItemSize={estimateRowHeight}
                    renderItem={({ item }) => (
                        // 行距必须放在 renderItem 内部（容器 gap 不会被测量，行高会累计漂移）
                        <div style={{ paddingBlock: 6 }}>
                            <EntryView entry={item} roomId={targetId} />
                        </div>
                    )}
                />
                <div style={{ flex: '0 0 auto', paddingBlock: 12 }}>
                    {/* astryx 的 composer 关掉了自己的停止按钮（isStopShown=false），
                        原本指望 SpeakingBar 兜底，但这套布局没渲染它 ⇒ 运行中完全找不到停的地方 */}
                    {state.speaking.length > 0 && (
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                paddingBottom: 8,
                                fontSize: 11,
                                opacity: 0.85,
                            }}
                        >
                            <span className="size-2 animate-pulse rounded-full bg-current" />
                            <span>{state.speaking.map((id) => shell.bots[id]?.name ?? id).join('、')} 正在说话…</span>
                            <Button size="sm" label="停止" onClick={() => conversation.cancel()} />
                        </div>
                    )}
                    <AstryxComposer
                        conversation={conversation}
                        triggers={triggers}
                        placeholder="和这个实体对话…（@ 选 bot）"
                    />
                </div>
            </div>
        </div>
    );
}
