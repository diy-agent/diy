// UnitNeedDetail —— 一条需求的**全貌**：做什么 / 决策 / 任务分解与进度 / 做得好不好 / 源码。
//
// 用户 2026-11-27：「把需求的右边列做成单独的一个 view，放到对话平行的 view tab 里」——
// 所以它既要能当「目标」页的右栏，也要能独立成一个 tab。两种用法共用这一个组件：
// 派生两份就会出现「tab 里少了某一块」这种说不清的分叉。
//
// 「源码」开关给的是**库里的原始存储**（`units.raw`：`task_units` 那几行 + 挂它的 journal 事件），
// 不是视图投影 —— 投影会补缺省值、换字段名，拿它当「原文」等于让人以为库里就长这样。
import { Code2, ListTree } from 'lucide-react';
import * as React from 'react';

import type { JournalLineView, UnitDetailView, UnitRawView } from '@diy-agent/chat-transport-rpc';
import { jumpToMessage } from '../askJump';
import { useUnitDetail } from '../useUnitDetail';
import { useUnitRaw } from '../useUnitRaw';

function stepMark(status: 'open' | 'doing' | 'done'): string {
    if (status === 'done') return '✓';
    if (status === 'doing') return '◐';
    return '○';
}

function fmtTime(at: number): string {
    const date = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Line({ line }: { line: JournalLineView }): React.JSX.Element {
    return (
        <li className="flex gap-2 border-l border-border pl-2">
            <span className="shrink-0 text-[10px] text-muted-foreground/70">{fmtTime(line.at)}</span>
            <span className="min-w-0">
                <span className="mr-1 rounded border border-border px-1 text-[10px] text-muted-foreground">
                    {line.kind}
                </span>
                <span className="text-[11px] text-foreground">{line.text}</span>
            </span>
        </li>
    );
}

function Block({
    title,
    right,
    children,
}: {
    title: string;
    right?: React.ReactNode;
    children: React.ReactNode;
}): React.JSX.Element {
    return (
        <div className="rounded border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                {title}
                {right !== undefined && <span className="ml-auto">{right}</span>}
            </div>
            <div className="px-2 py-1.5">{children}</div>
        </div>
    );
}

/** 源码：库里存的东西原样（JSON）—— 一行一字段，长文本不换行好复制 */
function RawPanel({ raw, error }: { raw: UnitRawView | null; error: string | null }): React.JSX.Element {
    if (error !== null) return <div className="text-[11px] text-red-500">{error}</div>;
    if (raw === null) return <div className="text-[11px] text-muted-foreground">读取中…</div>;
    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-[10px] text-muted-foreground">
                表 <code className="text-foreground">{raw.table}</code>（列名 → 值，NULL 也在）
            </div>
            <pre className="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-foreground">
                {JSON.stringify(raw.row, null, 2)}
            </pre>
            {raw.steps.length > 0 && (
                <>
                    <div className="text-[10px] text-muted-foreground">
                        步骤行（同表，<code className="text-foreground">kind = 'step'</code>）
                    </div>
                    <pre className="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-foreground">
                        {JSON.stringify(raw.steps, null, 2)}
                    </pre>
                </>
            )}
            // 服务端这个键叫 `events`（`journal` 在传输层已经是任务日志列表，同名会打架）
            {raw.events.length > 0 && (
                <>
                    <div className="text-[10px] text-muted-foreground">
                        挂它的 journal 事件（<code className="text-foreground">events</code> 表）
                    </div>
                    <pre className="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-foreground">
                        {JSON.stringify(raw.events, null, 2)}
                    </pre>
                </>
            )}
        </div>
    );
}

export function UnitNeedDetail({
    roomId,
    unitId,
    initialSource = false,
}: {
    roomId: string;
    unitId: string;
    /** 打开时直接看源码（tab 形态默认看内容；这一条留给「我想核对库里的值」的场景） */
    initialSource?: boolean;
}): React.JSX.Element {
    const [source, setSource] = React.useState(initialSource);
    const { detail, error } = useUnitDetail(roomId, unitId);
    const { raw, error: rawError } = useUnitRaw(roomId, unitId, source);

    const need = detail?.need ?? null;

    return (
        <div className="flex min-h-0 flex-col gap-2 overflow-auto p-2.5">
            <div className="flex items-start gap-2">
                <div className="min-w-0">
                    <div className="text-[10px] text-muted-foreground">
                        需求 ·{' '}
                        {need === null
                            ? '读取中…'
                            : need.status === 'done'
                              ? '已完成'
                              : need.status === 'doing'
                                ? '在做'
                                : '未开始'}
                    </div>
                    <div className="text-[13px] leading-snug font-medium text-foreground">
                        {need?.title ?? unitId}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => setSource((prev) => !prev)}
                    title={source ? '回到内容（做了什么 / 决策 / 步骤）' : '看源码（库里存的原样 JSON）'}
                    aria-pressed={source}
                    className={`ml-auto flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                        source
                            ? 'border-sky-500/40 bg-sky-500/10 text-sky-500'
                            : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                >
                    {source ? <ListTree className="size-3" /> : <Code2 className="size-3" />}
                    {source ? '内容' : '源码'}
                </button>
            </div>

            {error !== null && <div className="text-[11px] text-red-500">{error}</div>}

            {source ? (
                <RawPanel raw={raw} error={rawError} />
            ) : detail === null ? (
                <div className="text-[11px] text-muted-foreground">读取中…</div>
            ) : (
                (({ need, decisions, notes }: UnitDetailView) => (
                    <>
                        <Block title="做什么（人的原话）">
                            {need.sourceQuote === undefined ? (
                                <div className="text-[11px] text-muted-foreground">
                                    不知道是哪句话提的（老数据 / 消息已被剪 / 非人类触发）
                                </div>
                            ) : (
                                <>
                                    <div className="text-[10px] text-sky-500">{need.sourceQuote.author || '有人'}</div>
                                    <div className="text-[11px] text-foreground">{need.sourceQuote.text}</div>
                                    <button
                                        type="button"
                                        onClick={() => jumpToMessage(need.source)}
                                        className="mt-1 text-[10px] text-sky-500 hover:underline"
                                    >
                                        跳到那条消息 →
                                    </button>
                                </>
                            )}
                        </Block>

                        <Block title="决策" right="谁定的 · 为什么">
                            {decisions.length === 0 ? (
                                <div className="text-[11px] text-muted-foreground">
                                    还没有决策 —— 这条还停在「要做什么」。
                                </div>
                            ) : (
                                <ul className="flex flex-col gap-1.5">
                                    {decisions.map((line) => (
                                        <Line key={line.seq} line={line} />
                                    ))}
                                </ul>
                            )}
                        </Block>

                        <Block title="任务分解与进度" right="怎么做 · 不进需求层">
                            {need.steps.length === 0 ? (
                                <div className="text-[11px] text-muted-foreground">还没有步骤 —— 这条还没开始动。</div>
                            ) : (
                                <ul className="flex flex-col">
                                    {need.steps.map((step) => (
                                        <li
                                            key={step.id}
                                            className="flex items-baseline gap-1.5 border-b border-border/60 py-1 last:border-b-0"
                                        >
                                            <span
                                                className={`w-3 shrink-0 text-center text-[11px] ${
                                                    step.status === 'done'
                                                        ? 'text-emerald-500'
                                                        : step.status === 'doing'
                                                          ? 'text-sky-500'
                                                          : 'text-muted-foreground/60'
                                                }`}
                                            >
                                                {stepMark(step.status)}
                                            </span>
                                            <span
                                                className={`min-w-0 flex-1 text-[11px] ${
                                                    step.status === 'done'
                                                        ? 'text-muted-foreground line-through decoration-border'
                                                        : 'text-foreground'
                                                }`}
                                            >
                                                {step.title}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Block>

                        <Block title="做得好不好">
                            <div className="flex flex-col gap-1.5">
                                <div
                                    className={`text-[11px] ${
                                        need.accept.trim() === '' ? 'text-amber-600' : 'text-foreground'
                                    }`}
                                >
                                    {need.accept.trim() === '' ? '还没写「怎么算做完」' : need.accept}
                                </div>
                                {notes.length > 0 && (
                                    <ul className="flex flex-col gap-1">
                                        {notes.slice(-6).map((line) => (
                                            <Line key={line.seq} line={line} />
                                        ))}
                                    </ul>
                                )}
                                {need.body.trim() !== '' && (
                                    <div className="text-[10px] text-muted-foreground">背景：{need.body}</div>
                                )}
                            </div>
                        </Block>
                    </>
                ))(detail)
            )}
        </div>
    );
}

/** 一个示例需求的全貌（给 tab 之外的场景留同一份渲染，避免两处各拼一遍） */
export type { UnitDetailView };
