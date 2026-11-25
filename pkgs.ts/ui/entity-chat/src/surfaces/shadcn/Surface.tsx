// Surface.tsx —— 第二个表面：**原生 Tailwind**，不引任何 chat 框架的 runtime。
//
// 分组语义在 chat-core.buildTimeline、状态在 ConversationStore；这里只写「怎么画」。
// 与 astryx 面的关系：两面共用 shared.ts 的纯映射（工具行 target / parts 分组）与
// components/ 里的业务件（AskCard / BotAvatar / Markdown / RunningIndicator …），
// 差别只在「用谁的组件拼外壳」——这一面全裸 Tailwind，一个组件库都不依赖。

import { AlertTriangle, ArrowDown, ChevronDown, Send, Square } from 'lucide-react';
import * as React from 'react';

import {
    buildTimeline,
    completeMention,
    filterMentionCandidates,
    jobOf,
    jobViewOfNotice,
    mentionQuery,
    moveActive,
    type MentionCandidate,
    type TimelineEntry,
    type TimelinePart,
} from '@diy-agent/chat-core';

import { AskCard } from '../../components/AskCard';
import { CopyButton } from '../../components/CopyButton';
import { BotAvatar } from '../../components/BotAvatar';
import { flashAskCardWhenRendered, registerAskJumper } from '../../askJump';
import { openLinkInNewWindow } from '../../links';
import { ErrorBar } from '../../components/ErrorBar';
import { CompactCutBar } from '../../components/CompactCutBar';
import { JobCard } from '../../components/JobCard';
import { Markdown } from '../../components/Markdown';
import { TurnFooter } from '../../components/TurnFooter';
import { useWindowed } from '../../components/useWindowed';
import { useDraft } from '../../drafts';
import { useMentionCandidates } from '../../mentions';
import { actions, conversationOf, useStore } from '../../store';
import { plainTextOf, runsOf, toolTargetOf, type Run } from '../shared';

const TOOL_STATUS = { running: 'running', ok: 'ok', error: 'error' } as const;

function timeOf(at: number): string {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function ToolGroup({ tools, live }: { tools: Array<TimelinePart & { kind: 'tool' }>; live?: boolean }) {
    const [open, setOpen] = React.useState(false);
    if (tools.length === 1) {
        const tool = tools[0]!;
        return <ToolRow tool={tool} live={live === true} />;
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
                        <ToolRow key={tool.id} tool={tool} live={live === true} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ToolRow({ tool, live }: { tool: TimelinePart & { kind: 'tool' }; live: boolean }) {
    // 后台作业（job / bash background）单独成卡：普通工具行只剩 name + 截断 target，
    // 而用户要看的是 run id / 状态 / 退出码 / 输出（判据在 chat-core 的 `jobOf`）
    const job = jobOf(tool);
    if (job !== undefined) return <JobCard view={job} live={live} />;
    const target = toolTargetOf(tool);
    const status = TOOL_STATUS[tool.state];
    const mark = status === 'running' ? '◌' : status === 'ok' ? '✓' : '✗';
    return (
        <div
            className={`flex items-center gap-1.5 py-0.5 text-[12px] ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
            <span>{mark}</span>
            <span className="font-mono">{tool.name}</span>
            {target !== undefined && <span className="truncate font-mono opacity-80">{target}</span>}
        </div>
    );
}

function ErrorBox({ text }: { text: string }) {
    return (
        <div className="my-1.5 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{text}</span>
        </div>
    );
}

/** 一个 assistant 条目内部的块（正文 / 工具组 / 提问卡 / 失败） */
function RunsView({ runs, roomId, live }: { runs: Run[]; roomId: string; live?: boolean }) {
    return (
        <>
            {runs.map((run, index) => {
                if (run.kind === 'error') return <ErrorBox key={`e${index}`} text={run.message} />;
                if (run.kind === 'ask')
                    return (
                        <AskCard
                            key={`a${index}`}
                            roomId={roomId}
                            request={run.part.request}
                            {...(run.part.answer === undefined &&
                            run.part.cancelled !== true &&
                            run.part.expired !== true
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
                    );
                if (run.kind === 'text')
                    return <Markdown key={`t${index}`} text={run.text} onLinkClick={openLinkInNewWindow} />;
                return <ToolGroup key={`c${index}`} tools={run.tools} live={live === true} />;
            })}
        </>
    );
}

function EntryView({
    entry,
    roomId,
    onStopBot,
}: {
    entry: TimelineEntry;
    roomId: string;
    onStopBot?: (botId: string) => void;
}) {
    if (entry.kind === 'notice') {
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
        // 后台作业收口：带结构化事实的画卡片（run id / 状态 / 退出码 / 输出尾部）
        if (entry.job !== undefined) return <JobCard view={jobViewOfNotice(entry.job, text)} />;
        return (
            <div className="my-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>{text}</span>
                <span className="h-px flex-1 bg-border" />
            </div>
        );
    }

    if (entry.kind === 'error') {
        // 失败是"某个 bot 的回复失败"：沿用助手消息外壳（头像 + 名字），正文换成错误框
        const text = entry.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
        return (
            <div className="my-3 flex items-start gap-2">
                <BotAvatar author={entry.author} roomId={roomId} size={22} style={{ marginTop: 2 }} />
                <div className="min-w-0 flex-1">
                    {entry.author !== undefined && (
                        <div className="mb-1 flex items-center gap-2 text-xs">
                            <span className="font-medium" style={{ color: entry.author.color }}>
                                {entry.author.name}
                            </span>
                            <span className="text-muted-foreground">{entry.author.role}</span>
                        </div>
                    )}
                    <ErrorBox text={text} />
                </div>
            </div>
        );
    }

    if (entry.kind === 'typing') {
        // 和正式回复同一套外壳（头像 + 名字），第一段内容到达时原地替换
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
                        <span className="text-[10px] text-muted-foreground">
                            {timeOf(entry.turn?.startedAt ?? entry.at)}
                        </span>
                    </div>
                    <TurnFooter entry={entry} roomId={roomId} {...(onStopBot === undefined ? {} : { onStopBot })} />
                </div>
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
                    {failed.length > 0 && (
                        <span className="text-destructive">{failed.map((d) => `${d.name} 未送达`).join('、')}</span>
                    )}
                    <span>{timeOf(entry.at)}</span>
                </div>
            </div>
        );
    }

    // assistant：头像 + 名字一行，内容按「连续同类块」渲染（与 astryx 面同一份 runsOf）
    const runs = runsOf(entry.parts);
    const copyable = plainTextOf(entry.parts);
    return (
        <div className="group my-4 flex gap-2.5">
            <div className="flex w-[26px] shrink-0 justify-center pt-0.5">
                <BotAvatar author={entry.author} roomId={roomId} size={26} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-2 text-[12px]">
                    <span className="font-medium" style={{ color: entry.author?.color }}>
                        {entry.author?.name ?? 'bot'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                        {timeOf(entry.turn?.startedAt ?? entry.at)}
                    </span>
                    {copyable !== '' && (
                        // 悬停才浮现：常驻的复制按钮会让每条回复都多一行视觉噪音
                        <CopyButton
                            text={copyable}
                            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
                        />
                    )}
                </div>
                <RunsView runs={runs} roomId={roomId} live={entry.waiting === true} />
                {/* 轮次最下面一行：运行中「正在调用 bash… 44s / 已用 2m44s」，结束换成结算
                    （`EndFooterLine` 的「这一轮是怎么停的」已并进 TurnFooter 的 settle 标签，
                    见 `chat-core/end-footer` 的 `endFooterOf`） */}
                <TurnFooter entry={entry} roomId={roomId} {...(onStopBot === undefined ? {} : { onStopBot })} />
            </div>
        </div>
    );
}

/**
 * 消息列表单独 memo：输入框每敲一个字都会让 Surface 重渲染，
 * 但整棵消息树（含 Markdown 解析）不该跟着重算 —— 不 memo 的话长会话里输入会明显卡。
 */
const MessageList = React.memo(function MessageList({
    entries,
    roomId,
    onStopBot,
}: {
    entries: readonly TimelineEntry[];
    roomId: string;
    onStopBot?: (botId: string) => void;
}) {
    return (
        <>
            {entries.map((entry) => (
                // content-visibility：离开视口的条目跳过布局/绘制
                <div key={entry.key} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}>
                    <EntryView entry={entry} roomId={roomId} {...(onStopBot === undefined ? {} : { onStopBot })} />
                </div>
            ))}
        </>
    );
});

/** @ 候选浮层：键盘可达（上下选、Enter/Tab 确认、Esc 关），鼠标也能点 */
function MentionMenu({
    candidates,
    activeIndex,
    onPick,
    onHover,
}: {
    candidates: readonly MentionCandidate[];
    activeIndex: number;
    onPick: (name: string) => void;
    onHover: (index: number) => void;
}) {
    if (candidates.length === 0) {
        return (
            <div className="absolute bottom-full left-0 mb-1 rounded-md border bg-popover px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-md">
                没有匹配的成员
            </div>
        );
    }
    return (
        <ul
            role="listbox"
            className="absolute bottom-full left-0 mb-1 max-h-56 w-56 overflow-y-auto rounded-md border bg-popover py-1 shadow-md"
        >
            {candidates.map((candidate, index) => (
                <li key={candidate.id}>
                    <button
                        role="option"
                        aria-selected={index === activeIndex}
                        onMouseEnter={() => onHover(index)}
                        // mousedown 而不是 click：click 之前 textarea 会先失焦，光标位置就丢了
                        onMouseDown={(event) => {
                            event.preventDefault();
                            onPick(candidate.name);
                        }}
                        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] ${
                            index === activeIndex ? 'bg-accent text-foreground' : 'hover:bg-muted/60'
                        }`}
                    >
                        <span className="size-1.5 rounded-full" style={{ background: candidate.color }} />
                        <span className="truncate">{candidate.name}</span>
                        {candidate.isOwner && (
                            <span className="ml-auto text-[10px] text-muted-foreground">owner</span>
                        )}
                    </button>
                </li>
            ))}
        </ul>
    );
}

function Composer({
    conversation,
    roomId,
    running,
    extras,
}: {
    conversation: ReturnType<typeof conversationOf>;
    roomId: string;
    running: boolean;
    /** 输入框底栏那一行（上下文 / 模型 / 作业）—— 壳层给，surface 只负责摆位置 */
    extras?: React.ReactNode;
}) {
    const draft = useDraft(roomId, 'composer');
    const [submitting, setSubmitting] = React.useState(false);
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const candidates = useMentionCandidates(roomId);

    /**
     * @ 补全的规则全在 chat-core（`mentionQuery` / `filterMentionCandidates` / `completeMention` /
     * `moveActive`）—— 那里是**单一真源**，因为两面必须给出同样的候选与同样的补全结果。
     * 这里只留两件 UI 自己的事：高亮第几个、以及「用户按过 Esc 就先别弹了」。
     */
    const query = mentionQuery(draft.text);
    const matches = React.useMemo(
        () => (query === null ? [] : filterMentionCandidates(candidates, query)),
        [candidates, query],
    );
    const [active, setActive] = React.useState(0);
    const [dismissed, setDismissed] = React.useState(false);
    const menuOpen = query !== null && !dismissed;

    // query 一变（继续打字 / 重打一个 @）高亮回到第一个
    React.useEffect(() => {
        setActive(0);
    }, [query]);

    const pick = (name: string) => {
        const next = completeMention(draft.text, name);
        draft.setText(next);
        setDismissed(false);
        setActive(0);
        // 补全插在末尾，光标跟过去；命令式的选区要等受控 value 落到 DOM 之后再设
        requestAnimationFrame(() => {
            const element = textareaRef.current;
            if (element === null) return;
            element.focus();
            element.setSelectionRange(next.length, next.length);
        });
    };

    const send = () => {
        const text = draft.text.trim();
        if (text === '' || submitting) return;
        setSubmitting(true);
        // 发送成功才清草稿；失败保留输入框里的字
        void conversation
            .send(text)
            .then(() => draft.clearIfMatches(text))
            .catch(() => undefined)
            .finally(() => setSubmitting(false));
    };

    return (
        <div className="border-t bg-background px-4 py-3">
            {draft.status === 'error' && (
                <div className="pb-1 text-[10px] text-destructive">
                    草稿未保存：{draft.error ?? '网络错误'}（重试中，内容还在）
                </div>
            )}
            {/* 大框 = 输入行 + 底栏一行（上下文 / 模型 / 作业）。底栏在大框**内部**，
                与「其他 agent」同一个形状：写字的地方和这轮用什么在一起，不再另占一条。 */}
            <div className="relative rounded-xl border bg-card px-3 pb-1.5 pt-2">
                {menuOpen && (
                    <MentionMenu
                        candidates={matches}
                        activeIndex={active}
                        onPick={pick}
                        onHover={setActive}
                    />
                )}
                {/* 输入行：写字 + 发送键在右上（文字框自己撑高） */}
                <div className="flex items-end gap-2">
                <textarea
                    ref={textareaRef}
                    value={draft.text}
                    onChange={(event) => {
                        draft.setText(event.target.value);
                        setDismissed(false);
                    }}
                    onKeyDown={(event) => {
                        // 浮层开着时：上下选、Enter/Tab 确认、Esc 关。这几键不能落到「发送」上。
                        if (menuOpen) {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                setDismissed(true);
                                return;
                            }
                            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                if (matches.length === 0) return;
                                event.preventDefault();
                                setActive((current) => moveActive(current, event.key === 'ArrowDown' ? 1 : -1, matches.length));
                                return;
                            }
                            if (event.key === 'Enter' || event.key === 'Tab') {
                                const picked = matches[active];
                                if (picked !== undefined) {
                                    event.preventDefault();
                                    pick(picked.name);
                                    return;
                                }
                            }
                        }
                        // IME 组字中的 Enter 是上屏，不是发送
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            send();
                        }
                    }}
                    rows={1}
                    placeholder="和这个实体对话…（@ 选 bot，Enter 发送，Shift+Enter 换行）"
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
                        disabled={draft.text.trim() === '' || submitting}
                        title="发送"
                        className="rounded-lg p-1.5 hover:bg-muted disabled:opacity-40"
                    >
                        <Send className="size-4" />
                    </button>
                )}
                </div>
                {extras !== undefined && <div className="mt-1.5 border-t pt-1.5">{extras}</div>}
            </div>
        </div>
    );
}

export function ShadcnSurface({ targetId, composerExtras }: { targetId: string; composerExtras?: React.ReactNode }) {
    const shell = useStore();
    const conversation = conversationOf(targetId);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);

    // 停某个成员：入口在「那一轮的底行」（房间状态条不再重复谁在跑）
    const stopBot = React.useCallback((botId: string) => conversation.stop(botId), [conversation]);

    const entries = React.useMemo(
        () =>
            buildTimeline(state.items, state.deliveries, shell.bots, {
                speaking: state.speaking,
                asks: state.asks,
                answered: state.answered,
                turns: state.turns,
            }),
        [
            state.items,
            state.deliveries,
            shell.bots,
            state.speaking,
            state.asks,
            state.answered,
            // 轮次时刻 / 结算随 turns 变化：漏了它，收尾时底部行不会从「已用」换成结算
            state.turns,
        ],
    );

    const windowed = useWindowed(entries);

    // 上下文概况：时间线顶部那条「已压缩」框要的折叠数 / 摘要正文。
    // 只在一轮跑完时拉一次（自动压缩发生在那一步），不开轮询。
    const sessions = shell.sessions[targetId] ?? [];
    const running = state.running;
    React.useEffect(() => {
        actions.refreshSessions(targetId);
    }, [targetId, running]);

    /**
     * 壳层待答条的跳转入口：这套表面自己也窗口化（只渲染最近 N 条 + 滑到顶部补一窗），
     * 所以先 reveal 把那条纳入窗口，再等它真渲染出来闪一下。
     */
    React.useEffect(() => {
        registerAskJumper('shadcn', (askId) => {
            windowed.reveal((entry) => entry.parts.some((part) => part.kind === 'ask' && part.request.askId === askId));
            flashAskCardWhenRendered(askId);
        });
        return () => registerAskJumper('shadcn', undefined);
    }, [windowed]);

    // 贴底跟随：只有"本来就在底部"时才自动滚，用户上翻就不打扰
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const stickRef = React.useRef(true);
    const [atBottom, setAtBottom] = React.useState(true);
    React.useEffect(() => {
        const element = scrollRef.current;
        if (element === null || !stickRef.current) return;
        element.scrollTop = element.scrollHeight;
    }, [entries]);

    const scrollToBottom = React.useCallback(() => {
        const element = scrollRef.current;
        if (element === null) return;
        element.scrollTop = element.scrollHeight;
        stickRef.current = true;
        setAtBottom(true);
    }, []);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {state.error !== undefined && state.error !== '' && (
                <ErrorBar error={state.error} onRetry={conversation.reload} />
            )}
            {/* 顶部常驻：描述的是「更早」，不跟消息一起滚走 —— 也免得干扰“滑到顶补一窗”的边界 */}
            <div className="px-6 pt-2">
                <CompactCutBar sessions={sessions} />
            </div>
            <div className="relative min-h-0 flex-1">
                <div
                    ref={scrollRef}
                    onScroll={(event) => {
                        const element = event.currentTarget;
                        const stuck = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                        stickRef.current = stuck;
                        setAtBottom(stuck);
                        // 滑到顶部就补一窗（保持视口位置：把新增内容的高度加回 scrollTop）
                        if (element.scrollTop < 48 && windowed.hidden > 0) {
                            const before = element.scrollHeight;
                            windowed.showMore();
                            requestAnimationFrame(() => {
                                element.scrollTop += element.scrollHeight - before;
                            });
                        }
                    }}
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions text"
                    className="h-full overflow-y-auto px-6 py-4"
                >
                    {entries.length === 0 ? (
                        <div className="mt-16 text-center text-[13px] text-muted-foreground">
                            还没有消息。发一句，或 @ 一个 bot。
                        </div>
                    ) : (
                        <MessageList entries={windowed.visible} roomId={targetId} onStopBot={stopBot} />
                    )}
                </div>
                {!atBottom && entries.length > 0 && (
                    // 上翻看历史时「回到底部」：新消息不断到达却没有入口，只能拖滚动条
                    <button
                        onClick={scrollToBottom}
                        title="回到最新"
                        aria-label="回到最新"
                        className="absolute right-5 bottom-3 rounded-full border bg-background p-1.5 text-muted-foreground shadow-md hover:text-foreground"
                    >
                        <ArrowDown className="size-3.5" />
                    </button>
                )}
            </div>
            <Composer
                conversation={conversation}
                roomId={targetId}
                running={state.running}
                extras={composerExtras}
            />
        </div>
    );
}
