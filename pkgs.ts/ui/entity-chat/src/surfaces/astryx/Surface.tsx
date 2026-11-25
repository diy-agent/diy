// Astryx surface —— 用 Astryx 的 Chat 组件族渲染同一条时间线。
//
// 与 shadcn surface 的分工完全一致：分组在 chat-core.buildTimeline，
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
import type { ChatVirtualizerHandle } from '@astryxdesign/lab';
import {
    buildTimeline,
    jobOf,
    jobViewOfNotice,
    type MentionCandidate,
    type TimelineEntry,
    type TimelinePart,
} from '@diy-agent/chat-core';
import { ArrowDown } from 'lucide-react';
import { flashAskCardWhenRendered, registerAskJumper } from '../../askJump';
import { AskCard } from '../../components/AskCard';
import { CompactCutBar } from '../../components/CompactCutBar';
import { CopyButton } from '../../components/CopyButton';
import { JobCard } from '../../components/JobCard';
import { openLinkInNewWindow } from '../../links';
import { BotAvatar } from '../../components/BotAvatar';
import { EndFooterLine } from '../../components/EndFooterLine';
import { plainTextOf } from '../shared';
import { deliveryFooterOf, deliveryStatusOf, runsOf, TOOL_STATUS, toolTargetOf } from './mapping';
import { RunningIndicator } from '../../components/RunningIndicator';
import * as React from 'react';

import { useMentionCandidates } from '../../mentions';
import { useDraft } from '../../drafts';
import { actions, conversationOf, useStore } from '../../store';

/** 时间戳（Astryx Timestamp 收秒或 ISO；我们的 at 是毫秒） */
function TimeOf({ at }: { at: number }) {
    return <Timestamp value={Math.floor(at / 1000)} format="time" />;
}

/**
 * 一组连续的工具调用：**后台作业单独成卡**（`job` / `bash(background)`），其余仍走工具行。
 *
 * 为什么不干脆全塞进 `ChatToolCalls`：`job` 的 args 里没有 command / path，只能退化成截断的
 * JSON target —— run id、状态、退出码、输出全丢，而那些正是“它到底啥情况”的全部答案。
 * 分组顺序不动（卡插在它原来那一格），所以「说一段 → 跑作业 → 再说一段」的时间顺序不变。
 */
function ToolRun({ tools, live }: { tools: (TimelinePart & { kind: 'tool' })[]; live?: boolean }) {
    const blocks: React.ReactNode[] = [];
    let pending: (TimelinePart & { kind: 'tool' })[] = [];
    const flush = (): void => {
        if (pending.length === 0) return;
        blocks.push(
            <ChatToolCalls
                key={`g${blocks.length}`}
                calls={pending.map((tool) => {
                    const target = toolTargetOf(tool);
                    return {
                        key: tool.id,
                        name: tool.name,
                        status: TOOL_STATUS[tool.state],
                        ...(target === undefined ? {} : { target }),
                    };
                })}
            />,
        );
        pending = [];
    };
    for (const tool of tools) {
        const job = jobOf(tool);
        if (job === undefined) {
            pending.push(tool);
            continue;
        }
        flush();
        blocks.push(<JobCard key={tool.id} view={job} live={live === true} />);
    }
    flush();
    return <>{blocks}</>;
}

function EntryView({ entry, roomId }: { entry: TimelineEntry; roomId: string }) {
    if (entry.kind === 'notice') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
        // 后台作业收口：带结构化事实的当卡片画（run id / 状态 / 退出码 / 输出尾部）。
        // 分隔线上那一段人话里三者都读不出来，而且 tail 还带着 ANSI 色码。
        if (entry.job !== undefined) {
            return (
                <div key={entry.key} style={{ paddingBlock: 2 }}>
                    <JobCard view={jobViewOfNotice(entry.job, text)} />
                </div>
            );
        }
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
                    {/* 用户自己发的多行消息（多行文本、贴的代码、ask 的整批回答）：
                        不 pre-wrap 的话换行会被折叠成空格，一屏列表挤成一行 */}
                    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</span>
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
    const copyable = plainTextOf(entry.parts);
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
                {runs.map((run, index) => {
                    if (run.kind === 'error')
                        return (
                            <Banner
                                key={`e${index}`}
                                status="error"
                                container="section"
                                collapsible={false}
                                title={run.message}
                            />
                        );
                    return run.kind === 'ask' ? (
                        <AskCard
                            key={`a${index}`}
                            roomId={roomId}
                            request={run.part.request}
                            {...(run.part.answer === undefined && run.part.cancelled !== true && run.part.expired !== true
                                ? {}
                                : {
                                      resolved: {
                                          ...(run.part.answer === undefined ? {} : { answer: run.part.answer }),
                                          ...(run.part.cancelled === true ? { cancelled: true } : {}),
                                          ...(run.part.expired === true ? { expired: true } : {}),
                                          ...(run.part.reason === undefined ? {} : { reason: run.part.reason }),
                                      },
                                  })}
                        />
                    ) : run.kind === 'text' ? (
                        <Markdown key={`t${index}`} density="compact" onLinkClick={openLinkInNewWindow}>
                            {run.text}
                        </Markdown>
                    ) : (
                        <ToolRun key={`c${index}`} tools={run.tools} live={entry.waiting === true} />
                    );
                })}
                {/* 还在跑但没有流式内容（工具刚结束 / 等待下一段）：挂在正文末尾，
                    不再单独占列表底部一行 */}
                {entry.waiting === true && (
                    <div style={{ paddingTop: 6 }}>
                        <RunningIndicator since={entry.at} />
                    </div>
                )}
                {/* 这一轮是怎么停的：正常收尾不占页脚（endFooterOf 对 completed 返回 undefined） */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <EndFooterLine reason={entry.endReason} />
                    {/* 复制这条回复的正文：与 shadcn 面同一个共用件（那一面是悬停浮现，
                        这里没有 group-hover 的容器，用低对比常驻） */}
                    {copyable !== '' && (
                        <CopyButton
                            text={copyable}
                            className="rounded p-0.5 text-muted-foreground opacity-50 transition-opacity hover:bg-muted hover:text-foreground hover:opacity-100"
                        />
                    )}
                </div>
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
                // content-visibility：离开视口的条目跳过布局/绘制
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
    roomId,
    triggers,
    placeholder,
    extras,
}: {
    conversation: ReturnType<typeof conversationOf>;
    roomId: string;
    triggers: React.ComponentProps<typeof ChatComposerInput>['triggers'];
    placeholder: string;
    /** 底栏那一行（上下文 / 模型 / 作业）：壳层给，摆进设计系统 composer 的 footer 左侧 */
    extras?: React.ReactNode;
}) {
    const draft = useDraft(roomId, 'composer');
    const [submitting, setSubmitting] = React.useState(false);
    return (
        <>
            {draft.status === 'error' && (
                <div style={{ fontSize: 11, opacity: 0.8, paddingBottom: 4 }}>
                    草稿未保存：{draft.error ?? '网络错误'}（重试中，内容还在）
                </div>
            )}
            <ChatComposer
                value={draft.text}
                onChange={draft.setText}
                placeholder={placeholder}
                onSubmit={(value) => {
                    const text = value.trim();
                    if (text === '' || submitting) return;
                    setSubmitting(true);
                    // 发送成功才清草稿；失败保留输入框里的字（错误条由 store 显示）
                    void conversation
                        .send(text)
                        .then(() => draft.clearIfMatches(text))
                        .catch(() => undefined)
                        .finally(() => setSubmitting(false));
                }}
                // 运行中也保持"发送"态：插话是正常操作，停止在 SpeakingBar 上
                onStop={() => conversation.cancel()}
                isStopShown={false}
                // 底栏左侧：上下文 / 模型 / 作业（发送键由设计系统摆在右侧）
                footerActions={extras}
                input={<ChatComposerInput triggers={triggers} label="Message input" placeholder={placeholder} />}
            />
        </>
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

export function AstryxSurface({ targetId, composerExtras }: { targetId: string; composerExtras?: React.ReactNode }) {
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

    // 上下文概况：顶部「已压缩」框要的折叠数 / 摘要正文。
    // 只在一轮跑完时拉一次（自动压缩发生在那一步），不开轮询。
    const sessions = shell.sessions[targetId] ?? [];
    const running = state.running;
    React.useEffect(() => {
        actions.refreshSessions(targetId);
    }, [targetId, running]);

    /**
     * 壳层待答条的跳转入口：astryx 长会话用的是 ChatVirtualizer（只渲染视口附近的行），
     * 所以「滚过去」= `anchorToKey` 把那一行钉到视口顶 —— 它只认**在当前 data 里的 key**，
     * 而提问行的 key 就是 chat-core 的 `ask:<askId>`（见 timeline.ts）。
     */
    const virtualizer = React.useRef<ChatVirtualizerHandle>(null);
    React.useEffect(() => {
        registerAskJumper('astryx', (askId) => {
            virtualizer.current?.anchorToKey(`ask:${askId}`, 0);
            flashAskCardWhenRendered(askId);
        });
        return () => registerAskJumper('astryx', undefined);
    }, []);

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

    /**
     * 滚动容器改由我们自己持有（ChatVirtualizer 的 attach 模式）：own-container 模式下它
     * 不暴露滚动元素，我们既监听不到「用户上翻了」，也给不出「回到底部」的入口 ——
     * 而 shadcn 面有那个按钮，两个表面在这一点上应当一致。
     *
     * 代价：attach 模式下 follow-at-end 也归我们（官方文档明确说这个模式要求调用方的
     * 容器「不自己跑 follow」，否则两个写入者抢同一个位置）。
     */
    const [scrollElement, setScrollElement] = React.useState<HTMLDivElement | null>(null);
    const stickRef = React.useRef(true);
    const [atBottom, setAtBottom] = React.useState(true);
    React.useEffect(() => {
        if (scrollElement === null || !stickRef.current) return;
        scrollElement.scrollTop = scrollElement.scrollHeight;
    }, [scrollElement, entries]);

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
            {/* 顶部常驻：描述的是「更早」，不跟消息一起滚走。
                放在虚拟滚动容器**外面** —— ChatVirtualizer 的 attach 模式按 scrollTop 推算行位置，
                在它前面插普通块会算错行。 */}
            <div style={{ paddingInline: 24, paddingTop: 8 }}>
                <CompactCutBar sessions={sessions} />
            </div>
            {/* 长会话用官方 ChatVirtualizer：只渲染视口附近的条目（1 万条的 story 也是它） */}
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <div
                    ref={setScrollElement}
                    onScroll={(event) => {
                        const element = event.currentTarget;
                        const stuck = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                        stickRef.current = stuck;
                        setAtBottom(stuck);
                    }}
                    style={{ height: '100%', overflowY: 'auto', paddingInline: 24 }}
                >
                    {entries.length === 0 ? (
                        // 空房间不能只是一片空白：得告诉人「能干什么」（与 shadcn 面同一句）
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: 13,
                                opacity: 0.6,
                                paddingBlock: 64,
                            }}
                        >
                            还没有消息。发一句，或 @ 一个 bot。
                        </div>
                    ) : (
                        <ChatVirtualizer
                            // null（不是 undefined）= attach 模式的「等待」态：否则第一帧就把所有行挂上
                            // 再拆掉，2000 条时实测要 10s
                            scrollElement={scrollElement}
                            handleRef={virtualizer}
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
                    )}
                </div>
                {!atBottom && entries.length > 0 && (
                    <button
                        onClick={() => virtualizer.current?.scrollToDistanceFromBottomPx(0)}
                        title="回到最新"
                        aria-label="回到最新"
                        style={{
                            position: 'absolute',
                            right: 20,
                            bottom: 12,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 26,
                            height: 26,
                            borderRadius: 999,
                            border: '1px solid var(--border)',
                            background: 'var(--background)',
                            color: 'var(--muted-foreground)',
                            boxShadow: '0 2px 8px rgba(0,0,0,.12)',
                            cursor: 'pointer',
                        }}
                    >
                        <ArrowDown style={{ width: 14, height: 14 }} />
                    </button>
                )}
            </div>
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
                        roomId={targetId}
                        triggers={triggers}
                        placeholder="和这个实体对话…（@ 选 bot）"
                        extras={composerExtras}
                    />
                </div>
        </div>
    );
}
