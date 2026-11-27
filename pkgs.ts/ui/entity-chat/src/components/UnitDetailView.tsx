// UnitDetailView —— 一条需求的详情（**独立的视图**，2026-11-27 用户裁）。
//
// 原来它是「目标」视图的右栏；用户要它变成与「对话」平行的 tab：点左边一条需求，
// 中间开一个 tab 放这条的详情。理由是想边聊边看，而不是在一块地方左看右看。
//
// 四块（就是用户对根需求的定义）：做什么（人的原话）｜决策（谁定的、为什么）｜
// 任务分解与进度（怎么做、到哪了）｜做得好不好（验收口径 + 过程记录）。
//
// 再带一个「数据」开关：显示**库里存的那几行**（`task_units` 行 + 步骤 + 挂它的 journal），
// 免得「界面上少了什么」只能靠猜 —— 投影与真源之间得有一条能当场核对的通道。
import { Braces, X } from 'lucide-react';
import * as React from 'react';

import type { JournalLineView, UnitItem } from '@diy-agent/chat-transport-rpc';
import { jumpToMessage } from '../askJump';
import type { Room } from '../model';
import { useUnitDetail } from '../useUnitDetail';
import { useUnitBoard } from '../useUnitBoard';
import { diy2 } from '../store';

function fmtTime(at: number): string {
    const date = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function stepMark(status: UnitItem['status']): string {
    if (status === 'done') return '✓';
    if (status === 'doing') return '◐';
    return '○';
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
    hint,
    children,
}: {
    title: string;
    hint?: string;
    children: React.ReactNode;
}): React.JSX.Element {
    return (
        <div className="rounded border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                {title}
                {hint !== undefined && <span className="ml-auto">{hint}</span>}
            </div>
            <div className="px-2 py-1.5">{children}</div>
        </div>
    );
}

export function UnitDetailView({
    room,
    unitId,
    onClose,
}: {
    room: Room;
    unitId: string;
    /** 有关闭按钮时给：动态 tab 要能关掉（静态视图不给，见 workbench 的「不可关闭」公理） */
    onClose?: () => void;
}): React.JSX.Element {
    const { board } = useUnitBoard(room.id);
    const { detail, error } = useUnitDetail(room.id, unitId);
    const [raw, setRaw] = React.useState<string | null>(null);
    const [rawError, setRawError] = React.useState<string | null>(null);
    const [showRaw, setShowRaw] = React.useState(false);

    const need = board?.rows.find((row) => row.id === unitId) ?? detail?.need ?? null;

    React.useEffect(() => {
        if (!showRaw || raw !== null) return;
        let alive = true;
        void diy2.units
            .raw(room.id, unitId)
            .then((view) => {
                if (alive) setRaw(JSON.stringify(view, null, 2));
            })
            .catch((err: unknown) => {
                if (alive) setRawError(err instanceof Error ? err.message : String(err));
            });
        return () => {
            alive = false;
        };
    }, [showRaw, raw, room.id, unitId]);

    if (need === null) {
        return <div className="p-3 text-xs text-muted-foreground">{error ?? '读取中…'}</div>;
    }

    return (
        <div className="flex h-full min-w-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="text-[10px] text-muted-foreground">需求</span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{need.title}</span>
                <span
                    className={`shrink-0 text-[10px] ${
                        need.status === 'done'
                            ? 'text-emerald-500'
                            : need.status === 'doing'
                              ? 'text-sky-500'
                              : 'text-muted-foreground'
                    }`}
                >
                    {need.status === 'done' ? '已完成' : need.status === 'doing' ? '在做' : '未开始'}
                </span>
                <button
                    type="button"
                    onClick={() => setShowRaw((prev) => !prev)}
                    title="看库里存的那几行（真源，不加工）"
                    aria-pressed={showRaw}
                    className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                        showRaw
                            ? 'border-sky-500/40 bg-sky-500/10 text-sky-500'
                            : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                >
                    <Braces className="size-3" />
                    数据
                </button>
                {onClose !== undefined && (
                    <button
                        type="button"
                        onClick={onClose}
                        title="关掉这个详情"
                        className="shrink-0 rounded border border-border px-1 py-0.5 text-muted-foreground hover:bg-muted"
                    >
                        <X className="size-3" />
                    </button>
                )}
            </div>

            {showRaw ? (
                <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
                    <div className="text-[10px] text-muted-foreground">
                        库里存的原样（SQLite：`task_units` 一行 + 步骤行 + `events` 里挂这条的 journal）
                    </div>
                    {rawError !== null ? (
                        <div className="text-[11px] text-red-500">{rawError}</div>
                    ) : raw === null ? (
                        <div className="text-[11px] text-muted-foreground">读取中…</div>
                    ) : (
                        <pre className="min-h-0 flex-1 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground">
                            {raw}
                        </pre>
                    )}
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2.5">
                    {/* 做什么：人的原话 */}
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

                    {/* 决策 */}
                    <Block title="决策" hint="谁定的 · 为什么">
                        {detail === null ? (
                            <div className="text-[11px] text-muted-foreground">{error ?? '读取中…'}</div>
                        ) : detail.decisions.length === 0 ? (
                            <div className="text-[11px] text-muted-foreground">
                                还没有决策 —— 这条还停在「要做什么」。
                            </div>
                        ) : (
                            <ul className="flex flex-col gap-1.5">
                                {detail.decisions.map((line) => (
                                    <Line key={line.seq} line={line} />
                                ))}
                            </ul>
                        )}
                    </Block>

                    {/* 任务分解与进度 */}
                    <Block title="任务分解与进度" hint="怎么做 · 不进需求层">
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
                        {need.progress !== undefined && (
                            <div className="mt-1 text-[10px] text-muted-foreground">
                                {need.progress.done}/{need.progress.total} 步
                            </div>
                        )}
                    </Block>

                    {/* 做得好不好 */}
                    <Block title="做得好不好">
                        <div className={`text-[11px] ${need.accept.trim() === '' ? 'text-amber-600' : 'text-foreground'}`}>
                            {need.accept.trim() === '' ? '还没写「怎么算做完」' : need.accept}
                        </div>
                        {detail !== null && detail.notes.length > 0 && (
                            <ul className="mt-1.5 flex flex-col gap-1">
                                {detail.notes.slice(-8).map((line) => (
                                    <Line key={line.seq} line={line} />
                                ))}
                            </ul>
                        )}
                        {need.body.trim() !== '' && (
                            <div className="mt-1.5 text-[10px] text-muted-foreground">背景：{need.body}</div>
                        )}
                    </Block>
                </div>
            )}
        </div>
    );
}
