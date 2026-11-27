// UnitBoardView —— 任务页「目标」视图：**只列需求**的左侧清单。
//
// 2026-11-27 用户裁（demo v2 → 实装）：
//   · 这里只回答「这件事要做成哪些东西」—— 一条需求一行，带进度与缺口标记。
//   · 点一条**不在原地展开**，而是由宿主打开一个并列的 view tab（`onOpenUnit`）：
//     需求详情是「和对话平行的一块内容」，不该挤在左侧窄栏里，也不该让左栏在
//     「列表 / 详情」两种形态间来回切（看列表和看详情是两件同时想做的事）。
//
// 为什么还留「源码」开关：这一页所有形态都从同一份数据算，但「模型到底读到了什么」只能看原文
// （`units.text` = 注入 system 的那一节），核对上下文预算时离不开它。
//
// 为什么只读：writer 只有 agent 的 `unit_*` / `journal` 工具。界面直接改会引出
// 「两边同时改、谁赢」的语义，目前没有这个需求。
import { Code2, ListTree } from 'lucide-react';
import * as React from 'react';

import type { UnitItem } from '@diy-agent/chat-transport-rpc';
import { roomTitle, type Room } from '../model';
import { ListRow } from './ListRow';
import { UnitNeedDetail } from './UnitNeedDetail';
import { useUnitBoard } from '../useUnitBoard';
import { useUnitText } from '../useUnitText';

/** 与服务端同一口径的粗略估算（中文 + 结构下约 0.78 tok / 字符，见 ContextPanel） */
const TOKENS_PER_CHAR = 0.78;

/** 需求行的状态点：done 绿、doing 蓝（带光晕）、open 灰（能挑的偏绿） */
function dotClass(unit: UnitItem, ready: Set<string>): string {
    if (unit.status === 'done') return 'bg-emerald-500';
    if (unit.status === 'doing') return 'bg-sky-500 shadow-[0_0_0_3px] shadow-sky-500/20';
    return ready.has(unit.id) ? 'bg-emerald-500/70' : 'bg-muted-foreground/40';
}

/**
 * 需求清单（左栏的主体）—— **拍平的**，不画缩进树。
 *
 * 2026-11-27 用户：「需求是否可以扁平化？不要有父子关系是否简单点？外面是目标，里面是小目标」。
 * 我们只把**表现**拍平：左栏只列根需求，小目标 / 步骤点开才看到（数据仍留一层 parent，
 * 否则「这条属于哪个目标」无处可放）。理由：之前的病不是「有父子」，是父子被画成缩进树 +
 * 步骤挤进需求层 —— 一屏 125 条，扫不出「现在在做哪几件」。
 *
 * 当前 / 历史分开也是同一刀：默认只看 open / doing，done 收进一行「历史 N」，
 * 展开后一条不少（历史是证据，不是噪音）。
 */
function NeedsList({
    needs,
    ready,
    selected,
    onSelect,
}: {
    needs: readonly UnitItem[];
    ready: Set<string>;
    selected: string | null;
    onSelect: (unit: UnitItem) => void;
}): React.JSX.Element {
    // 只列根需求：子项（小目标）在详情里出现，不铺在左栏
    const roots = needs.filter((unit) => unit.parent === null);
    const current = roots.filter((unit) => unit.status !== 'done');
    const history = roots.filter((unit) => unit.status === 'done');
    const [historyOpen, setHistoryOpen] = React.useState(false);

    const row = (unit: UnitItem): React.JSX.Element => {
        const progress = unit.progress;
        const pct = progress === undefined ? 0 : Math.round((100 * progress.done) / progress.total);
        return (
            <ListRow
                key={unit.id}
                leading={<span className={`size-2 rounded-full ${dotClass(unit, ready)}`} />}
                title={unit.title}
                active={unit.id === selected}
                onSelect={() => onSelect(unit)}
                trailing={
                    progress === undefined ? undefined : (
                        <span className="flex items-center gap-1">
                            <span className="h-[3px] w-10 overflow-hidden rounded bg-border">
                                <span
                                    className={`block h-full ${unit.status === 'done' ? 'bg-emerald-500' : 'bg-sky-500'}`}
                                    style={{ width: `${pct}%` }}
                                />
                            </span>
                            <span className="text-[10px] tabular-nums text-muted-foreground">
                                {progress.done}/{progress.total}
                            </span>
                        </span>
                    )
                }
                meta={
                    <>
                        {!unit.group && unit.accept.trim() === '' && (
                            <span className="rounded border border-amber-500/30 px-1 text-amber-600">未写验收</span>
                        )}
                        {unit.group && <span>{unit.children.length} 个小目标</span>}
                        {unit.sourceQuote !== undefined && (
                            <span className="min-w-0 truncate">
                                ↩ {unit.sourceQuote.author || '有人'}：{unit.sourceQuote.text}
                            </span>
                        )}
                    </>
                }
            />
        );
    };

    return (
        <>
            {current.map(row)}
            {history.length > 0 && (
                <>
                    <button
                        type="button"
                        onClick={() => setHistoryOpen((prev) => !prev)}
                        aria-expanded={historyOpen}
                        className="mt-1 flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-muted"
                    >
                        <span className={`transition-transform ${historyOpen ? 'rotate-90' : ''}`}>▶</span>
                        历史 {history.length}
                    </button>
                    {historyOpen && history.map(row)}
                </>
            )}
        </>
    );
}

export function UnitBoardView({
    room,
    onOpenUnit,
}: {
    room: Room;
    /**
     * 点一条需求时交给宿主 —— 由它开一个并列的 view tab 放详情。
     * 不传就退化成「原地展开右栏」（单视图场景 / 测试里方便）。
     */
    onOpenUnit?: (unitId: string, title: string) => void;
}): React.JSX.Element {
    const [source, setSource] = React.useState(false);
    const [selected, setSelected] = React.useState<string | null>(null);
    const { board, error } = useUnitBoard(room.id);
    // 源码只在切过去时才拉：列表每 5 秒轮询一次已经够，没必要每次多打一个 RPC
    const { view: textView, error: textError } = useUnitText(room.id, source);

    if (room.type !== 'task') {
        return <div className="p-3 text-xs text-muted-foreground">只有任务有内部拆分。</div>;
    }

    const loading = board === null;
    const ready = new Set(board?.ready ?? []);
    const needs = board?.rows ?? [];
    const missingAccept = needs.filter((row) => !row.group && row.accept.trim() === '').length;
    const tokens = textView === null ? 0 : Math.round(textView.chars * TOKENS_PER_CHAR);

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
            ) : onOpenUnit === undefined ? (
                // 没有宿主（单视图场景）：左边列表 + 右栏详情，两栏原地并排
                <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-2">
                    <NeedsList
                        needs={needs}
                        ready={ready}
                        selected={selected}
                        onSelect={(unit) => setSelected(unit.id)}
                    />
                    <div className="min-h-0 overflow-auto border-t border-border md:border-t-0 md:border-l">
                        {selected === null ? (
                            <div className="p-2.5 text-xs text-muted-foreground">点左边任一条需求看详情。</div>
                        ) : (
                            <UnitNeedDetail roomId={room.id} unitId={selected} />
                        )}
                    </div>
                </div>
            ) : (
                <div className="min-h-0 flex-1 overflow-auto p-1.5">
                    <NeedsList
                        needs={needs}
                        ready={ready}
                        selected={null}
                        onSelect={(unit) => onOpenUnit(unit.id, unit.title)}
                    />
                </div>
            )}

            {error !== null && <div className="px-3 py-1 text-[11px] text-red-500">{error}</div>}
        </div>
    );
}
