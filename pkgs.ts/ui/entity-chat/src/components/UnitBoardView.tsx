// UnitBoardView —— 任务页「目标」视图：需求账本树的**只读**投影，带一个「看源码」开关。
//
// 为什么把「分解」和「文本」合成一个 tab（2026-11-25 用户裁）：它们是同一份数据的两种读法 ——
// 缩进树给人扫一眼，YAML 原文给「模型到底读到了什么」这种核对用。摆成两个并列的 tab，
// 等于让人以为有两份东西；合成一个、源码作为第二形态，语义才对得上。
//
// 名字用「目标」而不是「分解」：这一页回答的是「这件事要做成哪些东西」，
// 「分解」描述的是动作（我们做过什么），不是被看的东西。
//
// 为什么是树而不是图（2026-11-24 裁，2026-11-25 再收窄）：账本不记执行规划，
// 「先做哪个、一次做几条」由 bot 每轮自己挑 —— 没有排期就没有画图的数据来源。
//
// 为什么只读：writer 只有 agent 的 `unit_*` 工具。人在界面上直接勾选会立刻产生
// 「两边同时改树」的冲突语义（谁赢 / 怎么合并 / 撤销给谁看），目前没有这个需求。
import { Code2, ListTree } from 'lucide-react';
import * as React from 'react';

import { roomTitle, type Room } from '../model';
import { useUnitBoard } from '../useUnitBoard';
import { useUnitText } from '../useUnitText';
import type { UnitItem } from '@diy-agent/chat-transport-rpc';

/** 与服务端同一口径的粗略估算（中文 + 结构下约 0.78 tok / 字符，见 ContextPanel） */
const TOKENS_PER_CHAR = 0.78;

/** 状态符号：done 打勾、doing 半实心、母项 ▾、open 空心（能挑的是实心） */
function markOf(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return '✓';
    if (unit.status === 'doing') return '◐';
    if (unit.group) return '▾';
    return ready.has(unit.id) ? '●' : '○';
}

function rowClass(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return 'text-muted-foreground/60';
    if (unit.status === 'doing') return 'text-sky-500';
    if (unit.group) return 'text-foreground';
    return ready.has(unit.id) ? 'text-emerald-500' : 'text-muted-foreground';
}

export function UnitBoardView({ room }: { room: Room }) {
    const [source, setSource] = React.useState(false);
    const { board, error } = useUnitBoard(room.id);
    // 源码只在切过去时才拉：树每 5 秒轮询一次已经够，没必要每次多打一个 RPC
    const { view: textView, error: textError } = useUnitText(room.id, source);

    if (room.type !== 'task') {
        return <div className="p-3 text-xs text-muted-foreground">只有任务有内部拆分。</div>;
    }

    const loading = board === null;
    const ready = new Set(board?.ready ?? []);
    const tokens = textView === null ? 0 : Math.round(textView.chars * TOKENS_PER_CHAR);

    return (
        <div className="flex h-full min-w-0 flex-col">
            {/* 标题栏：任务名 + 计数 + 源码开关。这一页的「头」只该有一个，所以不再嵌第二层标题 */}
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="min-w-0 truncate text-[12px] font-medium text-foreground">{roomTitle(room)}</span>
                {board !== null && (
                    <span className="flex shrink-0 items-baseline gap-x-2 text-[11px] text-muted-foreground">
                        <span className="text-emerald-500">能挑 {board.ready.length}</span>
                        <span className="text-sky-500">在做 {board.doing.length}</span>
                        <span className="text-muted-foreground/70">完成 {board.done.length}</span>
                        {board.groups.length > 0 && (
                            <span className="text-muted-foreground/70">母项 {board.groups.length}</span>
                        )}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => setSource((prev) => !prev)}
                    title={source ? '回到树（缩进列表）' : '看源码（模型读到的 YAML 原文）'}
                    aria-pressed={source}
                    className={`ml-auto flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                        source
                            ? 'border-sky-500/40 bg-sky-500/10 text-sky-500'
                            : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                >
                    {source ? <ListTree className="size-3" /> : <Code2 className="size-3" />}
                    {source ? '树' : '源码'}
                </button>
            </div>

            {source ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 p-2 text-xs">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-[10px] text-muted-foreground">
                        <span>注入 system 的 units 节原文</span>
                        {textView !== null && <span>{textView.chars} 字 · ≈{tokens} tok</span>}
                        {textView?.mode === 'full' && <span>{textView.treeLines} 行树</span>}
                        {textView?.mode === 'summary' && (
                            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-amber-600">
                                已退化成摘要（树太大）
                            </span>
                        )}
                    </div>
                    {textView === null ? (
                        <div className="text-muted-foreground">{textError ?? '读取中…'}</div>
                    ) : textView.text === '' ? (
                        <div className="text-muted-foreground">还没有拆分：这一节不注入（整段缺席，不是空节）。</div>
                    ) : (
                        // 源码不折行：YAML 的缩进是结构，折行就看不出层级了；宽了就横向滚
                        <pre className="min-h-0 flex-1 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground">
                            {textView.text}
                        </pre>
                    )}
                </div>
            ) : (
                <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
                    {loading ? (
                        <div className="text-muted-foreground">{error ?? '读取中…'}</div>
                    ) : board.rows.length === 0 ? (
                        <div className="flex flex-col gap-2 text-muted-foreground">
                            <div className="font-medium text-foreground">还没有目标</div>
                            <p className="leading-relaxed">
                                跟 agent 说「把这件事拆成几步」，树会长在这里：缩进是母项 → 可验收的产出。
                                它每轮自己从「能挑的」里挑几条做，不用你排顺序。
                            </p>
                        </div>
                    ) : (
                        <div className="flex w-max min-w-full flex-col gap-0.5">
                            {board.rows.map((unit) => (
                                // 不显示 id：u9a 这种短名在树上只是噪音，需要时看 tooltip / 源码
                                <div
                                    key={unit.id}
                                    title={[
                                        unit.id,
                                        unit.title,
                                        (unit.body ?? '').trim() === '' ? '' : `背景：${unit.body}`,
                                        (unit.accept ?? '').trim() === '' ? '还没写「怎么算做完」' : `验收：${unit.accept}`,
                                    ]
                                        .filter((part) => part !== '')
                                        .join('\n')}
                                    className={`flex items-baseline gap-1.5 whitespace-nowrap ${rowClass(unit, ready)}`}
                                    style={{ paddingLeft: `${unit.depth * 14}px` }}
                                >
                                    <span className="w-3 shrink-0 text-center">{markOf(unit, ready)}</span>
                                    <span
                                        className={[
                                            unit.status === 'done' ? 'line-through decoration-border' : '',
                                            unit.group ? 'font-medium' : '',
                                        ]
                                            .join(' ')
                                            .trim()}
                                    >
                                        {unit.title}
                                    </span>
                                    {/* 缺「怎么算做完」= 这条没法被验收：标出来，别让人以为它是完整的
                                        （用户 2026-11-26：「需求是可以验收的，步骤很难验收」）。
                                        母项不标 —— 它的验收由子派生。 */}
                                    {!unit.group && (unit.accept ?? '').trim() === '' && (
                                        <span
                                            className="shrink-0 rounded border border-amber-500/30 px-1 text-[10px] text-amber-600"
                                            title="这条还没写「怎么算做完」：一句话能判断完/未完的判据"
                                        >
                                            未写验收
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                    {board !== null && board.danglingParents.length > 0 && (
                        <div className="mt-2 text-[11px] text-amber-500">
                            悬空母项（数据异常，这些条目暂按顶层显示）：{board.danglingParents.join(' ')}
                        </div>
                    )}
                    {error !== null && <div className="mt-2 text-[11px] text-red-500">{error}</div>}
                </div>
            )}
        </div>
    );
}
