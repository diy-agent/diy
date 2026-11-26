// Surface.tsx —— shadcn 面：**不引 chat 框架的 runtime**，只用 @diy-agent/ui-shadcn 的组件层。
//
// 分组语义在 chat-core.buildTimeline、状态在 ConversationStore；这里只写「怎么画」。
// 与 astryx 面的关系：两面共用 shared.ts 的纯映射（工具行 target / parts 分组）与
// components/ 里的业务件（AskCard / BotAvatar / Markdown / RunningIndicator …），
// 差别只在「用谁的组件拼外壳」。
//
// 2026-11-25：从「全裸 Tailwind」收敛到官方会话形态 ——
//   · 消息 → `Message` / `MessageAvatar` / `MessageHeader`，气泡 → `Bubble`；
//   · 输入区 → `InputGroup` / `InputGroupTextarea` / `InputGroupAddon`；
//   · 滚动 → `MessageScroller`（autoScroll + scrollAnchor），**不再是手写的贴底跟随 + 补窗**；
//   · 字号回到 `text-xs` / `text-sm` 两档（不再 `text-[13px]` 这种任意值）。
// 规范见仓根 `DESIGN.md`；改这里之前先看它。
//
// 唯一保留的手写元素是 `MentionMenu` 的 `<ul>/<li>/<button role="option">`：
// 它是 listbox 语义（role=option + aria-selected + 键盘上下选），而 `Button` 自带 role/样式
// 会与 option 语义打架；这里手写是为了可访问性，不是因为组件层不够用。

import { AlertTriangle, ChevronDown, Loader2, Send, Square, Terminal as TerminalIcon, X as XIcon } from 'lucide-react';
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

import {
    Alert,
    AlertDescription,
    Bubble,
    BubbleContent,
    Button,
    CodeBlock,
    CodeBlockContent,
    CodeBlockHeader,
    CodeBlockTitle,
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupTextarea,
    Trace,
    TraceCollapsible,
    TraceCollapsibleContent,
    TraceCollapsibleTrigger,
    TraceIcon,
    TraceLine,
    TraceTitle,
    Message,
    MessageAvatar,
    MessageContent,
    MessageHeader,
    MessageScroller,
    MessageScrollerButton,
    MessageScrollerContent,
    MessageScrollerItem,
    MessageScrollerProvider,
    MessageScrollerViewport,
    useMessageScroller,
} from '@diy-agent/ui-shadcn';

import { AskCard } from '../../components/AskCard';
import { CopyButton } from '../../components/CopyButton';
import { BotAvatar } from '../../components/BotAvatar';
import { flashAskCardWhenRendered, registerAskJumper } from '../../askJump';
import { openLinkInNewWindow } from '../../links';
import { formatAtAbsolute, formatClock } from '../../model';
import { ErrorBar } from '../../components/ErrorBar';
import { CompactCutBar } from '../../components/CompactCutBar';
import { JobCard } from '../../components/JobCard';
import { Markdown } from '../../components/Markdown';
import { TurnFooter } from '../../components/TurnFooter';
import { useDraft } from '../../drafts';
import { useMentionCandidates } from '../../mentions';
import { actions, conversationOf, useStore } from '../../store';
import { plainTextOf, runsOf, toolTargetOf, type Run } from '../shared';

const TOOL_STATUS = { running: 'running', ok: 'ok', error: 'error' } as const;

// 时间显示与 astryx 面共用同一份口径（model.ts）：
// 看得见的是 `formatClock`（今天 HH:mm / 跨天带日期），悬停给 `formatAtAbsolute` 的完整版。
// 之前这里自己写了一个只吐 HH:mm 的 timeOf —— 跨天对话分不清是哪天，也没有悬停提示。
function Time({ at }: { at: number | undefined }) {
    if (at === undefined) return null;
    return (
        <span title={formatAtAbsolute(at)} className="tabular-nums">
            {formatClock(at)}
        </span>
    );
}

function ToolGroup({ tools, live }: { tools: Array<TimelinePart & { kind: 'tool' }>; live?: boolean }) {
    const [open, setOpen] = React.useState(false);
    if (tools.length === 1) {
        const tool = tools[0]!;
        return <ToolRow tool={tool} live={live === true} />;
    }
    return (
        <div className="my-1">
            <Button
                variant="ghost"
                size="xs"
                className="text-xs text-muted-foreground"
                onClick={() => setOpen((value) => !value)}
            >
                <ChevronDown className={`size-3 transition-transform ${open ? '' : '-rotate-90'}`} />
                工具调用 <span className="tabular-nums">({tools.length})</span>
            </Button>
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
    // 后台作业（job / bash background）单独成卡：普通工具行只剩 name + target，而用户要看的
    // 是 run id / 状态 / 退出码 / 输出（判据在 chat-core 的 `jobOf`）
    const job = jobOf(tool);
    if (job !== undefined) return <JobCard view={job} live={live} />;

    const target = toolTargetOf(tool);
    const status = TOOL_STATUS[tool.state];
    const failed = status === 'error';
    const asText = (value: unknown): string | undefined => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'string') return value === '' ? undefined : value;
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    };
    const input = asText(tool.args);
    const output = asText(tool.result);
    // 官方 ai-elements 的 Tool 就是「Trace 里一行 + 有输出时套一层 Collapsible」：
    // 标题说清发生了什么（Running / Ran / Failed），展开体分 Input / Output 两块。
    const title =
        status === 'running'
            ? written('正在运行', tool.name, target)
            : failed
              ? written('失败', tool.name, target)
              : written('已运行', tool.name, target);

    const head = (
        <TraceLine>
            <TraceIcon>{failed ? <XIcon /> : <TerminalIcon />}</TraceIcon>
            <TraceTitle className="truncate">{title}</TraceTitle>
            {live && status === 'running' && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        </TraceLine>
    );

    // 没有 args / result 就没什么可展开的 —— 保持纯一行（官方也是这个规则：
    // 「a plain TraceLine while it runs, a TraceCollapsible once its output arrives」）
    if (input === undefined && output === undefined) {
        return <Trace className={`my-1 ${failed ? 'text-destructive' : ''}`}>{head}</Trace>;
    }

    return (
        <Trace className={`my-1 ${failed ? 'text-destructive' : ''}`}>
            <TraceCollapsible defaultOpen={failed}>
                <TraceCollapsibleTrigger>{head}</TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                    {input !== undefined && (
                        <CodeBlock size="sm" className="mb-1.5">
                            <CodeBlockHeader>
                                <CodeBlockTitle>入参</CodeBlockTitle>
                            </CodeBlockHeader>
                            <CodeBlockContent wrap className="max-h-48">
                                {input}
                            </CodeBlockContent>
                        </CodeBlock>
                    )}
                    {output !== undefined && (
                        <CodeBlock size="sm" variant={failed ? 'destructive' : 'default'}>
                            <CodeBlockHeader>
                                <CodeBlockTitle>{failed ? '错误' : '输出'}</CodeBlockTitle>
                            </CodeBlockHeader>
                            <CodeBlockContent wrap className="max-h-64">
                                {output}
                            </CodeBlockContent>
                        </CodeBlock>
                    )}
                </TraceCollapsibleContent>
            </TraceCollapsible>
        </Trace>
    );
}

/** 「动词 + 工具名 + 目标」拼成一行标题：目标太长时由外层 truncate 收尾 */
function written(verb: string, name: string, target: string | undefined): string {
    return target === undefined ? `${verb} ${name}` : `${verb} ${name} ${target}`;
}

function ErrorBox({ text }: { text: string }) {
    return (
        <Alert variant="destructive" className="my-1.5 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <AlertDescription className="min-w-0 break-words text-xs">{text}</AlertDescription>
        </Alert>
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
            <div className="my-1 flex items-center gap-3 text-xs text-muted-foreground">
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
                    <div className="mb-0.5 flex items-center gap-2 text-xs">
                        <span className="font-medium" style={{ color: entry.author?.color }}>
                            {entry.author?.name ?? 'bot'}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            <Time at={entry.turn?.startedAt ?? entry.at} />
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
            <Message align="end" className="my-3">
                <MessageContent>
                    {/* 投递失败时整条气泡走 destructive —— 与 astryx 面的
                        deliveryStatusOf(deliveries) 同一个判据（failed 才算，queued/delivering 不算：
                        那时 bot 正在执行，界面上已经有执行中指示器，再标一次会重复） */}
                    <Bubble align="end" variant={failed.length > 0 ? 'destructive' : 'muted'}>
                        <BubbleContent className="whitespace-pre-wrap break-words">{text}</BubbleContent>
                    </Bubble>
                    <div className="flex items-center gap-2 self-end pr-1 text-xs text-muted-foreground">
                        {failed.length > 0 && (
                            <span className="text-destructive">{failed.map((d) => `${d.name} 未送达`).join('、')}</span>
                        )}
                        <Time at={entry.at} />
                    </div>
                </MessageContent>
            </Message>
        );
    }

    // assistant：头像 + 名字一行，内容按「连续同类块」渲染（与 astryx 面同一份 runsOf）
    const runs = runsOf(entry.parts);
    const copyable = plainTextOf(entry.parts);
    return (
        <Message className="group my-4">
            <MessageAvatar className="size-[26px]">
                <BotAvatar author={entry.author} roomId={roomId} size={26} />
            </MessageAvatar>
            <MessageContent>
                <MessageHeader className="mb-0.5">
                    <span className="font-medium" style={{ color: entry.author?.color }}>
                        {entry.author?.name ?? 'bot'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        <Time at={entry.turn?.startedAt ?? entry.at} />
                    </span>
                    {copyable !== '' && (
                        // 悬停才浮现：常驻的复制按钮会让每条回复都多一行视觉噪音
                        <CopyButton
                            text={copyable}
                            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
                        />
                    )}
                </MessageHeader>
                <RunsView runs={runs} roomId={roomId} live={entry.waiting === true} />
                {/* 轮次最下面一行：运行中「正在调用 bash… 44s / 已用 2m44s」，结束换成结算
                    （`EndFooterLine` 的「这一轮是怎么停的」已并进 TurnFooter 的 settle 标签，
                    见 `chat-core/end-footer` 的 `endFooterOf`） */}
                <TurnFooter entry={entry} roomId={roomId} {...(onStopBot === undefined ? {} : { onStopBot })} />
            </MessageContent>
        </Message>
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
                // scrollAnchor 挂在用户回合：新问题落在顶部、回复在它下面流式长出
                <MessageScrollerItem key={entry.key} messageId={entry.key} scrollAnchor={entry.kind === 'user'}>
                    {/* content-visibility：离开视口的条目跳过布局/绘制 */}
                    {/* data-message-id：账本条目上的「来自哪句话」靠它滚过来（见 askJump.ts::jumpToMessage） */}
                    <div
                        data-message-id={entry.key}
                        style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
                    >
                        <EntryView entry={entry} roomId={roomId} {...(onStopBot === undefined ? {} : { onStopBot })} />
                    </div>
                </MessageScrollerItem>
            ))}
        </>
    );
});

/**
 * 视口 + 内容。必须在 MessageScrollerProvider 内部才拿得到 useMessageScroller。
 *
 * 「跳到某条待答卡」以前靠窗口化的 reveal（先把那条纳入窗口再闪一下）；
 * 现在直接 scrollToMessage —— 消息全在 DOM 里，不需要先让它存在。
 */
function ThreadViewport({
    entries,
    roomId,
    onStopBot,
}: {
    entries: readonly TimelineEntry[];
    roomId: string;
    onStopBot?: (botId: string) => void;
}) {
    const scroller = useMessageScroller();

    React.useEffect(() => {
        registerAskJumper('shadcn', (askId) => {
            const hit = entries.find((entry) =>
                entry.parts.some((part) => part.kind === 'ask' && part.request.askId === askId),
            );
            if (hit !== undefined) scroller.scrollToMessage(hit.key, { align: 'center' });
            flashAskCardWhenRendered(askId);
        });
        return () => registerAskJumper('shadcn', undefined);
    }, [entries, scroller]);

    return (
        <MessageScrollerViewport
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            preserveScrollOnPrepend
            className="px-6 py-4"
        >
            <MessageScrollerContent>
                {entries.length === 0 ? (
                    <div className="mt-16 text-center text-sm text-muted-foreground">
                        还没有消息。发一句，或 @ 一个 bot。
                    </div>
                ) : (
                    <MessageList entries={entries} roomId={roomId} onStopBot={onStopBot} />
                )}
            </MessageScrollerContent>
        </MessageScrollerViewport>
    );
}

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
            <div className="absolute bottom-full left-0 mb-1 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-muted-foreground shadow-md">
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
                        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                            index === activeIndex ? 'bg-accent text-foreground' : 'hover:bg-muted/60'
                        }`}
                    >
                        <span className="size-1.5 rounded-full" style={{ background: candidate.color }} />
                        <span className="truncate">{candidate.name}</span>
                        {candidate.isOwner && <span className="ml-auto text-xs text-muted-foreground">owner</span>}
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
            .finally(() => {
                setSubmitting(false);
                // 发完把焦点还给输入框。点发送键会让它变成 disabled，焦点掉到 <body>；
                // 之后按方向键/空格/PageDown 就不再滚消息区，而是滚整个页面 ——
                // 用户报的「发言后焦点跳到历史最上面」就是这一步丢的。
                textareaRef.current?.focus();
            });
    };

    return (
        <div className="border-t bg-background px-4 py-3">
            {draft.status === 'error' && (
                <div className="pb-1 text-xs text-destructive">
                    草稿未保存：{draft.error ?? '网络错误'}（重试中，内容还在）
                </div>
            )}
            {/*
             * 官方 prompt-input 的形状（2026-11-26 对齐 docs/ai-elements/base/prompt-input）：
             * 一个 InputGroup 就是整个输入区 —— 文本域 + 底栏（工具与发送都在框内）。
             * 之前是「手写圆角大框 + 里面再套一个 InputGroup + 外面再接一条 ComposerBar」，
             * 于是有两层边框，而工具条其实落在框外，看起来就还是个单行输入框。
             */}
            <div className="relative">
                {menuOpen && (
                    <MentionMenu candidates={matches} activeIndex={active} onPick={pick} onHover={setActive} />
                )}
                <InputGroup>
                    <InputGroupTextarea
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
                                    setActive((current) =>
                                        moveActive(current, event.key === 'ArrowDown' ? 1 : -1, matches.length),
                                    );
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
                        placeholder="和这个实体对话…（@ 选 bot）"
                        className="max-h-40 flex-none p-3 text-sm"
                    />
                    {/* 底栏：工具在左、发送在右（官方 prompt-input 的摆法）。
                    工具条原先在框外单独一行，现在回到框内 —— 这也是用户 2026-11-24 的原话。 */}
                    <InputGroupAddon align="block-end" className="gap-1 pr-1.5 pb-1">
                        {extras}
                        {running ? (
                            <InputGroupButton
                                size="icon-sm"
                                className="ml-auto"
                                title="停止生成"
                                onClick={() => conversation.cancel()}
                            >
                                <Square className="size-4" />
                            </InputGroupButton>
                        ) : (
                            <InputGroupButton
                                size="icon-sm"
                                className="ml-auto"
                                title="发送"
                                disabled={draft.text.trim() === '' || submitting}
                                onClick={send}
                            >
                                <Send className="size-4" />
                            </InputGroupButton>
                        )}
                    </InputGroupAddon>
                </InputGroup>
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

    // 上下文概况：时间线顶部那条「已压缩」框要的折叠数 / 摘要正文。
    // 只在一轮跑完时拉一次（自动压缩发生在那一步），不开轮询。
    const sessions = shell.sessions[targetId] ?? [];
    const running = state.running;
    React.useEffect(() => {
        actions.refreshSessions(targetId);
    }, [targetId, running]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {state.error !== undefined && state.error !== '' && (
                <ErrorBar error={state.error} onRetry={conversation.reload} />
            )}
            {/* 顶部常驻：描述的是「更早」，不跟消息一起滚走 —— 也免得干扰“滑到顶补一窗”的边界 */}
            <div className="px-6 pt-2">
                <CompactCutBar sessions={sessions} />
            </div>
            {/*
             * 滚动的「谁说了算」交给 MessageScroller：
             *   · autoScroll —— 人在底部时跟随新内容，上翻就不打扰；
             *   · defaultScrollPosition="last-anchor" —— 进来先定位到最后一条用户消息；
             *   · scrollAnchor 挂在用户回合上（见 MessageList）—— 新问题落顶部、回复在它下面长。
             * 以前这套（贴底跟随 + 回底按钮 + 补窗）是手写的 40 行 state + ref。
             */}
            <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
                <MessageScroller className="relative min-h-0 flex-1">
                    <ThreadViewport entries={entries} roomId={targetId} onStopBot={stopBot} />
                    {/* 上翻看历史时的「回到最新」：显隐与位移动画自己管（data-active） */}
                    <MessageScrollerButton className="rounded-full" />
                </MessageScroller>
            </MessageScrollerProvider>
            <Composer conversation={conversation} roomId={targetId} running={state.running} extras={composerExtras} />
        </div>
    );
}
