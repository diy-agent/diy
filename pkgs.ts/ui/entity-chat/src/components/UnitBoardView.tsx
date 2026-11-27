// UnitBoardView —— 任务页「目标」视图：**左需求列表 + 右需求全貌**的只读投影。
//
// 2026-11-27 用户裁（demo v2）：目标与任务分解要分层。
//   · 左边只列**需求**（要做什么）：一条一个关注点，带进度与缺口标记。
//   · 右边是点开的那条：做什么（人的原话）｜决策（谁定的、为什么）｜任务分解与进度（怎么做）
//     ｜做得好不好（验收口径 + 过程记录）。
// 依据是体检数据（12 任务 125 条）：0 条被当 log 刷，但工程类任务 43~67% 的条目是
// 「改哪个文件 / 加字段 / 透传 / 提 PR」——它们本来该是**步骤**，却挤进了需求层。
//
// 为什么还留「源码」开关：这一页所有形态都从同一份数据算，但「模型到底读到了什么」只能看原文
// （`units.text` = 注入 system 的那一节），核对上下文预算时离不开它。
//
// 为什么只读：writer 只有 agent 的 `unit_*` / `journal` 工具。界面直接改会引出
// 「两边同时改、谁赢」的语义，目前没有这个需求。
import { Code2, ListTree } from 'lucide-react';
import * as React from 'react';

import type { JournalLineView, UnitItem } from '@diy-agent/chat-transport-rpc';
import { jumpToMessage } from '../askJump';
import { roomTitle, type Room } from '../model';
import { useUnitBoard } from '../useUnitBoard';
import { useUnitDetail } from '../useUnitDetail';
import { useUnitText } from '../useUnitText';

/** 与服务端同一口径的粗略估算（中文 + 结构下约 0.78 tok / 字符，见 ContextPanel） */
const TOKENS_PER_CHAR = 0.78;

/** 需求行的状态点：done 绿、doing 蓝、open 灰（能挑的加一圈亮边） */
function dotClass(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return 'bg-emerald-500';
    if (unit.status === 'doing') return 'bg-sky-500 shadow-[0_0_0_3px] shadow-sky-500/20';
    return ready.has(unit.id) ? 'bg-emerald-500/70' : 'bg-muted-foreground/40';
}

function stepMark(status: UnitItem['status']): string {
    if (status === 'done') return '✓';
    if (status === 'doing') return '◐';
    return '○';
}

function fmtTime(at: number): string {
    const date = new Date(at);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
}

/** 一条 journal 记录：决策在后面单独一栏，这里只当「过程记录」用 */
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

export function UnitBoardView({ room }: { room: Room }): React.JSX.Element {
    const [source, setSource] = React.useState(false);
    const [selected, setSelected] = React.useState<string | null>(null);
    const { board, error } = useUnitBoard(room.id);
    // 源码只在切过去时才拉：列表每 5 秒轮询一次已经够，没必要每次多打一个 RPC
    const { view: textView, error: textError } = useUnitText(room.id, source);
    const { detail, error: detailError } = useUnitDetail(room.id, source ? null : selected);

    if (room.type !== 'task') {
        return <div className="p-3 text-xs text-muted-foreground">只有任务有内部拆分。</div>;
    }

    const loading = board === null;
    const ready = new Set(board?.ready ?? []);
    const needs = board?.rows ?? [];
    const missingAccept = needs.filter((row) => !row.group && row.accept.trim() === '').length;
    const tokens = textView === null ? 0 : Math.round(textView.chars * TOKENS_PER_CHAR);
    const current = needs.find((row) => row.id === selected) ?? null;

    return (
        <div className="flex h-full min-w-0 flex-col">
            {/* 标题栏：任务名 + 计数 + 源码开关（这一页的「头」只该有一个） */}
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="min-w-0 truncate text-[12px] font-medium text-foreground">{roomTitle(room)}</span>
                {board !== null && (
                    <span className="flex shrink-0 items-baseline gap-x-2 text-[11px] text-muted-foreground">
                        <span>需求 {needs.length}</span>
                        <span className="text-sky-500">在做 {board.doing.length}</span>
                        {missingAccept > 0 && <span className="text-amber-500">缺验收 {missingAccept}</span>}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => setSource((prev) => !prev)}
                    title={source ? '回到目标（需求列表）' : '看源码（模型读到的 YAML 原文）'}
                    aria-pressed={source}
                    className={`ml-auto flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                        source
                            ? 'border-sky-500/40 bg-sky-500/10 text-sky-500'
                            : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                >
                    {source ? <ListTree className="size-3" /> : <Code2 className="size-3" />}
                    {source ? '目标' : '源码'}
                </button>
            </div>

            {source ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 p-2 text-xs">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-[10px] text-muted-foreground">
                        <span>注入 system 的 units 节原文</span>
                        {textView !== null && (
                            <span>
                                {textView.chars} 字 · ≈{tokens} tok
                            </span>
                        )}
                        {textError !== null && <span className="text-red-500">{textError}</span>}
                    </div>
                    {textView === null ? (
                        <div className="text-muted-foreground">读取中…</div>
                    ) : textView.text === '' ? (
                        <div className="text-muted-foreground">还没有拆分：这一节不注入（整段缺席，不是空节）。</div>
                    ) : (
                        <pre className="min-h-0 flex-1 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground">
                            {textView.text}
                        </pre>
                    )}
                </div>
            ) : loading ? (
                <div className="p-3 text-xs text-muted-foreground">读取中…</div>
            ) : needs.length === 0 ? (
                <div className="flex flex-col gap-2 p-3 text-xs text-muted-foreground">
                    <div className="font-medium text-foreground">还没有需求</div>
                    <p className="leading-relaxed">
                        跟 agent 说一句「这件事要解决成什么样」，需求会长在这里：一条一个关注点，
                        点开能看到它的决策、步骤与验收。
                    </p>
                </div>
            ) : (
                <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(240px,0.85fr)_minmax(280px,1.15fr)]">
                    {/* ── 左：需求列表（只列 need；步骤在右边）── */}
                    <div className="min-h-0 overflow-auto border-b border-border p-1.5 md:border-r md:border-b-0">
                        {needs.map((unit) => {
                            const progress = unit.progress;
                            const pct = progress === undefined ? 0 : Math.round((100 * progress.done) / progress.total);
                            return (
                                <button
                                    key={unit.id}
                                    type="button"
                                    onClick={() => setSelected(unit.id)}
                                    aria-selected={unit.id === selected}
                                    className={`w-full rounded px-1.5 py-1 text-left hover:bg-muted ${
                                        unit.id === selected ? 'bg-sky-500/10 ring-1 ring-sky-500/30' : ''
                                    }`}
                                    style={{ paddingLeft: `${6 + unit.depth * 12}px` }}
                                >
                                    <span className="flex items-baseline gap-1.5">
                                        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${dotClass(unit, ready)}`} />
                                        <span
                                            className={`min-w-0 flex-1 truncate text-[12px] ${
                                                unit.status === 'done' ? 'text-muted-foreground' : 'text-foreground'
                                            } ${unit.group ? 'font-medium' : ''}`}
                                            title={unit.title}
                                        >
                                            {unit.title}
                                        </span>
                                    </span>
                                    <span className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[10px] text-muted-foreground">
                                        {progress !== undefined && (
                                            <>
                                                <span className="h-[3px] w-14 overflow-hidden rounded bg-border">
                                                    <span
                                                        className={`block h-full ${unit.status === 'done' ? 'bg-emerald-500' : 'bg-sky-500'}`}
                                                        style={{ width: `${pct}%` }}
                                                    />
                                                </span>
                                                <span>
                                                    {progress.done}/{progress.total} 步
                                                </span>
                                            </>
                                        )}
                                        {!unit.group && unit.accept.trim() === '' && (
                                            <span className="rounded border border-amber-500/30 px-1 text-amber-600">
                                                未写验收
                                            </span>
                                        )}
                                        {unit.sourceQuote !== undefined && (
                                            <span className="min-w-0 truncate">
                                                ↩ {unit.sourceQuote.author || '有人'}：{unit.sourceQuote.text}
                                            </span>
                                        )}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* ── 右：这条需求的全貌 ── */}
                    <div className="min-h-0 overflow-auto p-2.5">
                        {current === null ? (
                            <div className="text-xs text-muted-foreground">点左边任一条需求，看它下面挂的决策与步骤。</div>
                        ) : (
                            <div className="flex flex-col gap-2.5">
                                <div>
                                    <div className="text-[10px] text-muted-foreground">
                                        需求 · {current.status === 'done' ? '已完成' : current.status === 'doing' ? '在做' : '未开始'}
                                    </div>
                                    <div className="text-[13px] leading-snug font-medium text-foreground">{current.title}</div>
                                </div>

                                {/* 做什么：人的原话 */}
                                <div className="rounded border border-border">
                                    <div className="border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                                        做什么（人的原话）
                                    </div>
                                    <div className="px-2 py-1.5">
                                        {current.sourceQuote === undefined ? (
                                            <div className="text-[11px] text-muted-foreground">
                                                不知道是哪句话提的（老数据 / 消息已被剪 / 非人类触发）
                                            </div>
                                        ) : (
                                            <>
                                                <div className="text-[10px] text-sky-500">
                                                    {current.sourceQuote.author || '有人'}
                                                </div>
                                                <div className="text-[11px] text-foreground">
                                                    {current.sourceQuote.text}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => jumpToMessage(current.source)}
                                                    className="mt-1 text-[10px] text-sky-500 hover:underline"
                                                >
                                                    跳到那条消息 →
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* 决策 */}
                                <div className="rounded border border-border">
                                    <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                                        决策
                                        <span className="ml-auto">谁定的 · 为什么</span>
                                    </div>
                                    <div className="px-2 py-1.5">
                                        {detail === null ? (
                                            <div className="text-[11px] text-muted-foreground">
                                                {detailError ?? '读取中…'}
                                            </div>
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
                                    </div>
                                </div>

                                {/* 任务分解与进度 */}
                                <div className="rounded border border-border">
                                    <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                                        任务分解与进度
                                        <span className="ml-auto">怎么做 · 不进需求层</span>
                                    </div>
                                    <div className="px-2 py-1.5">
                                        {current.steps.length === 0 ? (
                                            <div className="text-[11px] text-muted-foreground">
                                                还没有步骤 —— 这条还没开始动。
                                            </div>
                                        ) : (
                                            <ul className="flex flex-col">
                                                {current.steps.map((step) => (
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
                                    </div>
                                </div>

                                {/* 做得好不好 */}
                                <div className="rounded border border-border">
                                    <div className="border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                                        做得好不好
                                    </div>
                                    <div className="flex flex-col gap-1.5 px-2 py-1.5">
                                        <div
                                            className={`text-[11px] ${current.accept.trim() === '' ? 'text-amber-600' : 'text-foreground'}`}
                                        >
                                            {current.accept.trim() === '' ? '还没写「怎么算做完」' : current.accept}
                                        </div>
                                        {detail !== null && detail.notes.length > 0 && (
                                            <ul className="flex flex-col gap-1">
                                                {detail.notes.slice(-6).map((line) => (
                                                    <Line key={line.seq} line={line} />
                                                ))}
                                            </ul>
                                        )}
                                        {current.body.trim() !== '' && (
                                            <div className="text-[10px] text-muted-foreground">背景：{current.body}</div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {error !== null && <div className="px-3 py-1 text-[11px] text-red-500">{error}</div>}
        </div>
    );
}
