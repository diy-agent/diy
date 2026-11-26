// JobsChip —— 「后台作业」的三级披露（2026-11-24 用户定 A 方案 + 要求照 diy1 的 hover 设计）。
//
// 用户原话：tokenwindow / 模型 / 花费「都是通过 3 级窗口的实现那种卡片，即 hover 展示一个
// 简要卡，点开摘要可以看更细的半屏详情列表」。作业沿用同一套：
//
//   L1 收起态（就在输入框底栏，与 上下文 / 模型 同一行）：`◔ 作业 2 · 3m20s`
//      —— 只给「有几条在跑、最久那条多久」。**跑完的那一刻只失去「在动」，不失去位置**
//         （2026-11-24 用户裁）：chip 常驻，0 条在跑时退化成空状态 `◔ 作业`（灰点、不跳、
//         不写数字不写时长）—— 理由是「位置不跳」+「本进程内刚结束的还看得见」，**不是**
//         「进历史账本」：那张表的真源是内存 Map，重启即空是设计（2026-10-23 口径，
//         2026-11-25 用户再裁一次）；要翻旧账去 `log/job/runs/` 看产物。
//   L2 hover 简要卡：每条约一行（状态点 · 标题 · 时长 · 短 id），卡顶右侧「明细 ›」。
//      卡**向上**开（chip 在屏幕底部），鼠标从 chip 移到卡上不会关（160ms 宽限 + 指入取消）。
//   L3 半屏抽屉：全宽贴顶、默认 2/3 屏、底边可拖动改高、可最大化、点遮罩 / ✕ 关。
//      一行一条，点开那一行看**输出尾巴**（`jobs.tail`，与 agent 的 `job output` 同一份）。
//
// 数据只有一条来源：`diy2.jobs.list` / `jobs.tail` / `jobs.kill` —— 与 agent 的
// `job list` / `job output` / `job kill` 同属 run 账本，界面不另算一套。
//
// 为什么轮询而不是事件：job 结束本来就是**插话**（`job-done`）—— 那是给 agent 的唤醒，
// 不是给「界面上这枚秒表」的。秒表要跳，就按时间拉一次（在跑 1.2s / 闲时 5s）。

import { ChevronUp, ListTree, Maximize2, Minimize2, Square, X } from 'lucide-react';
import * as React from 'react';

import type { JobRunRow } from '@diy-agent/chat-transport-rpc';

import { diy2, useActiveJobs, useAddress } from '../store';

/** 在跑时的轮询间隔：秒表要跳得像个秒表，但也不必每帧拉一次 */
const POLL_RUNNING_MS = 1200;
/**
 * 闲时（只看得到历史）慢一点。
 *
 * **有推送来源了**（2026-11-25）：activity 流报的「在跑作业数」一变，`JobsChip` 立刻
 * `reload()` 一次 —— 轮询因此退化成兕底（首屏 / 断流 / 本地改状态），不再是唯一通路。
 * 秒表本来就是本地 `setInterval` 跳的，不靠这个间隔。
 */
const POLL_IDLE_MS = 5000;
/** 指针离开 chip 到移进卡的宽限（照 diy1 `armHoverClose` 的 160ms） */
const HOVER_CLOSE_MS = 160;
/** 悬停卡宽（diy1 的 `CARD_W` 是 448，这里一行更短，够放「标题 + 时长 + id」） */
const CARD_W = 380;

const isRunning = (row: JobRunRow): boolean => row.state === 'running';

/**
 * 这条作业是不是**本房间**起的 —— 房间入口（chip / 抽屉的 `scope="room"`）按它收窄，
 * 标题栏那个 `JobsPanel` 不滤（它要看全实例，包括「结局无人接」那条）。
 *
 * 判据是 `origin.taskUri` 的首段：它是 `<房间id>#<botid>`，两种 id 形态都是房间 id
 * （旧 `task-mwjddcy0` / 新 `01a2091d-…`，前者在 `rooms_v0` 里查得到）。
 *
 * 两个「不过滤」的兜底，都是为了不把历史藏起来：
 *   · `roomId` 还是空（首屏还没定位到房间）—— 此时滤 = 全滤掉；
 *   · 这条没有 `origin`（老数据 / 前台命令）—— 归属未知时宁可多显示。
 * 实测 308 条 meta.json 全部带 `origin`，第二条分支基本不会走到。
 */
export function belongsToRoom(row: JobRunRow, roomId: string): boolean {
    if (roomId === '') return true;
    const uri = row.origin?.taskUri;
    if (uri === undefined) return true;
    return uri.split('#')[0] === roomId;
}

/**
 * run 账本的入口。**可能是空的**：老服务端没有 `jobs.*`，测试里的假客户端也只实现实际用到的几项。
 * 缺了就当「这台实例没有作业表」—— 不画 chip、不抛错；界面不该因为一个可选能力而白屏。
 */
function jobsApi(): typeof diy2.jobs | undefined {
    return (diy2 as { jobs?: typeof diy2.jobs }).jobs;
}

/** `3m20s` / `1h04m` / `12s` —— 作业看的是量级，不看到毫秒 */
function fmtDur(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function fmtAt(at: number): string {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 标题：服务端给的人话标题，缺省退回命令首行 */
function titleOf(row: JobRunRow): string {
    const title = row.title ?? row.command.split('\n')[0] ?? row.command;
    return title.trim() === '' ? row.id : title.trim();
}

/** 状态观感：运行中不写「运行中」（idle 的绿点是「活着」，与「在动」是两件事） */
function stateOf(row: JobRunRow): { label: string; dot: string; text: string } {
    if (row.state === 'running') return { label: '在跑', dot: 'bg-emerald-500', text: 'text-emerald-600' };
    if (row.state === 'exited' && (row.exitCode ?? 0) === 0)
        return { label: '退出码 0', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' };
    if (row.state === 'killed') return { label: '被停掉', dot: 'bg-amber-500', text: 'text-amber-600' };
    if (row.state === 'failed')
        return {
            label: row.exitCode === null || row.exitCode === undefined ? '失败' : `失败（${row.exitCode}）`,
            dot: 'bg-destructive',
            text: 'text-destructive',
        };
    return {
        label: row.exitCode === null || row.exitCode === undefined ? row.state : `退出码 ${row.exitCode}`,
        dot: 'bg-muted-foreground/40',
        text: 'text-muted-foreground',
    };
}

/**
 * run 账本的界面副本。轮询间隔按「有没有在跑的」切换，开着明细时更快一档
 * （展开输出尾巴时要能追着长）。
 */
function useJobs(active: boolean): { rows: JobRunRow[]; error: string | null; reload: () => void } {
    const [rows, setRows] = React.useState<JobRunRow[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [tick, setTick] = React.useState(0);
    const running = rows.some(isRunning);

    React.useEffect(() => {
        let alive = true;
        const pull = () => {
            const api = jobsApi();
            if (api === undefined) return;
            void api
                .list()
                .then((back) => {
                    if (!alive) return;
                    setRows(back.rows);
                    setError(null);
                })
                .catch((err: unknown) => {
                    if (!alive) return;
                    setError(err instanceof Error ? err.message : String(err));
                });
        };
        pull();
        const every = active || running ? POLL_RUNNING_MS : POLL_IDLE_MS;
        const timer = setInterval(pull, every);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [active, running, tick]);

    const reload = React.useCallback(() => setTick((value) => value + 1), []);
    return { rows, error, reload };
}

// ─── L2：hover 简要卡 ─────────────────────────────────────────────

function BriefRow({ row, now }: { row: JobRunRow; now: number }) {
    const state = stateOf(row);
    const dur = isRunning(row) ? Math.max(0, now - row.startedAt) : row.durationMs;
    return (
        <div className="flex items-center gap-2 px-3 py-1">
            <span className={`size-1.5 shrink-0 rounded-full ${state.dot}`} />
            <span className="truncate font-mono text-[11px]" title={row.command}>
                {titleOf(row)}
            </span>
            {/* 结局无人接：房间删了 / 成员退了，通知落空（run 目录里的 done.json 写着） */}
            {row.delivered === false && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="结局无人接" />}
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{fmtDur(dur)}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70" title={row.id}>
                {row.id.slice(-4)}
            </span>
        </div>
    );
}

function HoverCard({
    rows,
    now,
    rect,
    onEnter,
    onLeave,
    onDetail,
}: {
    rows: JobRunRow[];
    now: number;
    rect: DOMRect;
    onEnter: () => void;
    onLeave: () => void;
    onDetail: () => void;
}) {
    const running = rows.filter(isRunning);
    const finished = rows.filter((row) => !isRunning(row)).slice(0, 3);
    // 卡开在 chip **上方**（chip 在输入框底栏，下面没地方）；左边夹进视口
    const width = Math.min(CARD_W, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    return (
        <div
            className="fixed z-50 overflow-hidden rounded-lg border bg-background shadow-xl"
            style={{ left, bottom: window.innerHeight - rect.top + 6, width }}
            onPointerEnter={onEnter}
            onPointerLeave={onLeave}
        >
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
                <ListTree className="size-3 text-muted-foreground" />
                <span className="text-[11px] font-medium">后台任务</span>
                <span className="text-[10px] text-muted-foreground">
                    本房间 · {running.length === 0 ? '没有在跑的' : `${running.length} 个在跑`}
                </span>
                <button
                    onClick={onDetail}
                    className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                >
                    明细 ›
                </button>
            </div>
            <div className="py-1">
                {running.map((row) => (
                    <BriefRow key={row.id} row={row} now={now} />
                ))}
                {running.length === 0 && (
                    <p className="px-3 py-2 text-[11px] text-muted-foreground">
                        {finished.length === 0 ? '还没有后台任务记录' : '现在没有在跑的（下面是最近结束的）'}
                    </p>
                )}
                {finished.length > 0 && (
                    <>
                        <div className="mt-1 border-t px-3 pb-0.5 pt-1 text-[10px] text-muted-foreground">
                            最近结束
                        </div>
                        {finished.map((row) => (
                            <BriefRow key={row.id} row={row} now={now} />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

// ─── L3：半屏明细抽屉 ─────────────────────────────────────────────

function OutputTail({ row }: { row: JobRunRow }) {
    const [tail, setTail] = React.useState<{ text: string; droppedBytes: number } | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let alive = true;
        const pull = () => {
            const api = jobsApi();
            if (api === undefined) return;
            void api
                .tail(row.id, 60)
                .then((back) => {
                    if (!alive) return;
                    setTail(back.found && back.tail !== undefined
                        ? { text: back.tail.text, droppedBytes: back.tail.droppedBytes }
                        : { text: '', droppedBytes: 0 });
                    setError(null);
                })
                .catch((err: unknown) => {
                    if (!alive) return;
                    setError(err instanceof Error ? err.message : String(err));
                });
        };
        pull();
        // 在跑的那条输出还在长：跟着拉；终态拉一次就够
        if (!isRunning(row)) return () => { alive = false; };
        const timer = setInterval(pull, 2000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [row.id, row.state]);

    if (error !== null) return <p className="px-3 py-2 text-[11px] text-destructive">读输出失败：{error}</p>;
    if (tail === null) return <p className="px-3 py-2 text-[11px] text-muted-foreground">读输出…</p>;
    return (
        <div className="px-3 pb-2">
            <pre className="max-h-56 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
                {tail.text === '' ? '（没有输出）' : tail.text}
            </pre>
            {tail.droppedBytes > 0 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                    尾部之前还有 {tail.droppedBytes} 字节没显示（只留末尾 60 行）
                </p>
            )}
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">日志 {row.logPath}</p>
        </div>
    );
}

function DetailRow({ row, now, onKilled }: { row: JobRunRow; now: number; onKilled: () => void }) {
    const [open, setOpen] = React.useState(false);
    const [killing, setKilling] = React.useState(false);
    const state = stateOf(row);
    const running = isRunning(row);
    const dur = running ? Math.max(0, now - row.startedAt) : row.durationMs;
    const kill = () => {
        setKilling(true);
        const api = jobsApi();
        if (api === undefined) {
            setKilling(false);
            return;
        }
        void api
            .kill(row.id)
            .then(() => onKilled())
            .catch(() => undefined)
            .finally(() => setKilling(false));
    };
    return (
        <div className="border-b last:border-b-0">
            <div
                role="button"
                tabIndex={0}
                onClick={() => setOpen((value) => !value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setOpen((value) => !value);
                    }
                }}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/40"
            >
                <span className={`size-1.5 shrink-0 rounded-full ${state.dot}`} />
                <span className={`w-[86px] shrink-0 text-[11px] ${state.text}`}>{state.label}</span>
                <span className="truncate font-mono text-[11px]" title={row.command}>
                    {titleOf(row)}
                </span>
                {/* 结局无人接：这条跑完了，但起它的房间已不在 —— 没人被叫醒，日志只能自己来翻 */}
                {row.delivered === false && (
                    <span
                        title="结局无人接：起它的房间已删或成员已退 —— 后台任务跑完了，但没人收到通知（日志仍在）"
                        className="shrink-0 rounded border border-amber-500/40 px-1 text-[10px] text-amber-600"
                    >
                        无人接
                    </span>
                )}
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {fmtDur(dur)}
                    <span className="ml-1 opacity-60">{fmtAt(row.startedAt)}</span>
                </span>
                <span className="w-[64px] shrink-0 truncate text-right font-mono text-[10px] text-muted-foreground/80" title={row.id}>
                    {row.id}
                </span>
                {running ? (
                    <button
                        onClick={(event) => {
                            event.stopPropagation();
                            kill();
                        }}
                        disabled={killing}
                        title="按进程组停止（与 agent 的 job kill 同一入口）"
                        className="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
                    >
                        <Square className="size-2.5" />
                        {killing ? '停止中' : '停止'}
                    </button>
                ) : (
                    <span className="w-[42px] shrink-0" />
                )}
                <ChevronUp className={`size-3 shrink-0 text-muted-foreground ${open ? '' : 'rotate-180'}`} />
            </div>
            {open && (
                <div className="border-t bg-muted/20">
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 px-3 py-1.5 text-[10px] text-muted-foreground">
                        <span>命令</span>
                        <span className="font-mono">{row.command}</span>
                        <span>目录</span>
                        <span className="font-mono">{row.cwd}</span>
                        {row.pid !== undefined && (
                            <>
                                <span>进程组</span>
                                <span className="font-mono">{row.pid}</span>
                            </>
                        )}
                        {row.error !== undefined && (
                            <>
                                <span>错误</span>
                                <span className="text-destructive">{row.error}</span>
                            </>
                        )}
                    </div>
                    <OutputTail row={row} />
                </div>
            )}
        </div>
    );
}

function JobsDrawer({ rows, now, onClose, onKilled, scope = 'room' }: {
    rows: JobRunRow[];
    now: number;
    onClose: () => void;
    onKilled: () => void;
    /**
     * 这份表说的是谁的后台任务。
     *
     * `room` = 从房间输入框底栏那颗 chip 打开（房间内入口）；
     * `instance` = 从标题栏那颗「后台任务 N」打开 —— 数据本来就同源（`jobs.list` 一张表），
     * 但**口径必须在标题上写清**：用户在 demo 里点出的就是这两个概念不能混。
     */
    scope?: 'room' | 'instance';
}) {
    const [height, setHeight] = React.useState(66.666);
    const [max, setMax] = React.useState(false);
    const running = rows.filter(isRunning);

    const startDrag = (event: React.PointerEvent) => {
        event.preventDefault();
        const startY = event.clientY;
        const startH = height;
        const onMove = (ev: PointerEvent) => {
            const delta = ((startY - ev.clientY) / window.innerHeight) * 100;
            setMax(false);
            setHeight(Math.min(100, Math.max(12, startH + delta)));
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    React.useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // 贴顶全宽（diy1 TrafficDrawer / UsageDrawer 同款）：抽屉不挡输入框与刚发的那条消息
    return (
        <div className="fixed inset-0 z-50 flex flex-col" onClick={onClose}>
            <div className="absolute inset-0 bg-black/30" />
            <div
                className="relative flex min-h-0 flex-col overflow-hidden border-b bg-background shadow-2xl"
                style={{ height: max ? '100vh' : `${height}vh` }}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
                    <ListTree className="size-3.5 text-muted-foreground" />
                    <span className="text-[12px] font-medium">后台任务</span>
                    <span className="text-[11px] text-muted-foreground">
                        {/* 口径写在标题上：房间内 = 本房间；标题栏那颗 = 本实例全部 */}
                        {scope === 'instance' ? '本实例全部' : '本房间'} ·{' '}
                        {running.length === 0 ? '没有在跑的' : `${running.length} 个在跑`} · 共 {rows.length} 条
                    </span>
                    <button
                        onClick={() => setMax((value) => !value)}
                        title={max ? '还原高度' : '最大化'}
                        className="ml-auto rounded p-1 hover:bg-muted"
                    >
                        {max ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                    </button>
                    <button onClick={onClose} title="关闭" className="rounded p-1 hover:bg-muted">
                        <X className="size-3.5" />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {rows.length === 0 ? (
                        <p className="px-4 py-6 text-[11px] text-muted-foreground">
                            这张表还是空的 —— agent 起过 `bash` 的后台任务才会出现
                        </p>
                    ) : (
                        rows.map((row) => <DetailRow key={row.id} row={row} now={now} onKilled={onKilled} />)
                    )}
                </div>
                {/* 底边拖拽手柄：向上拖更高（与 diy1 的抽屉同一手势） */}
                <div
                    className="absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize hover:bg-primary/40"
                    title="拖动调整高度"
                    onPointerDown={startDrag}
                />
            </div>
        </div>
    );
}

// ─── L1：chip（放进输入框底栏，与 上下文 / 模型 同行）────────────────

export function JobsChip() {
    const [drawerOpen, setDrawerOpen] = React.useState(false);
    const [rect, setRect] = React.useState<DOMRect | null>(null);
    const [now, setNow] = React.useState(() => Date.now());
    const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const { rows: allRows, error, reload } = useJobs(drawerOpen || rect !== null);
    const activeJobs = useActiveJobs();
    const { id: roomId } = useAddress();

    // activity 流报的「在跑作业数」变了 ⇒ 立刻拉一次，别等轮询（1.2s / 5s 是兕底，不是主路）。
    // 只在**真的变了**时拉：首帧与 useJobs 自己的首次 pull 重合时没必要多打一发。
    const lastJobs = React.useRef(activeJobs);
    React.useEffect(() => {
        if (lastJobs.current === activeJobs) return;
        lastJobs.current = activeJobs;
        reload();
    }, [activeJobs, reload]);

    // 房间入口只看本房间起的（标题栏的 JobsPanel 不滤，它要看全实例）
    const rows = React.useMemo(
        () => allRows.filter((row) => belongsToRoom(row, roomId)),
        [allRows, roomId],
    );

    // 秒表：只在本机跳（服务端给的 durationMs 是「拉的那一刻」，两次拉之间靠它补）
    React.useEffect(() => {
        if (!rows.some(isRunning)) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [rows]);

    React.useEffect(() => () => {
        if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    }, []);

    const cancelClose = () => {
        if (closeTimer.current !== undefined) {
            clearTimeout(closeTimer.current);
            closeTimer.current = undefined;
        }
    };
    const openTip = (element: HTMLElement) => {
        cancelClose();
        setRect(element.getBoundingClientRect());
    };
    const closeSoon = () => {
        cancelClose();
        closeTimer.current = setTimeout(() => {
            closeTimer.current = undefined;
            setRect(null);
        }, HOVER_CLOSE_MS);
    };

    const running = rows.filter(isRunning);
    const oldest = running.reduce<number>((longest, row) => Math.max(longest, now - row.startedAt), 0);

    // 这台实例没有作业账本（老服务端）⇒ 整枚 chip 不出现；有账本就一直占着位置，
    // 0 条在跑时是空状态（用户 2026-11-24：跑完别消失，留着能点进去看历史）
    if (jobsApi() === undefined) return null;
    const idle = running.length === 0;

    return (
        <>
            <button
                onPointerEnter={(event) => openTip(event.currentTarget)}
                onPointerLeave={closeSoon}
                onClick={() => {
                    setRect(null);
                    setDrawerOpen(true);
                }}
                title={
                    error !== null
                        ? `后台任务账本拉取失败：${error}`
                        : idle
                          ? `后台任务（本房间）：现在没有在跑的，点开看历史（共 ${rows.length} 条）`
                          : '后台任务（本房间）：悬停看简要，点开看明细'
                }
                className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            >
                <span className="relative flex size-2 items-center justify-center">
                    {!idle && <span className="absolute size-2 animate-ping rounded-full bg-emerald-500/60" />}
                    <span
                        className={
                            idle ? 'size-1.5 rounded-full bg-muted-foreground/40' : 'size-1.5 rounded-full bg-emerald-500'
                        }
                    />
                </span>
                后台任务{idle ? '' : ` ${running.length}`}
                {!idle && <span className="tabular-nums opacity-60">{fmtDur(oldest)}</span>}
            </button>

            {rect !== null && (
                <HoverCard
                    rows={rows}
                    now={now}
                    rect={rect}
                    onEnter={cancelClose}
                    onLeave={closeSoon}
                    onDetail={() => {
                        setRect(null);
                        setDrawerOpen(true);
                    }}
                />
            )}

            {drawerOpen && (
                <JobsDrawer
                    rows={rows}
                    now={now}
                    onClose={() => setDrawerOpen(false)}
                    onKilled={reload}
                />
            )}
        </>
    );
}

/**
 * 全局作业面板：**不挂在输入框上**，由外壳（标题栏那颗「作业 N」）打开。
 *
 * 为什么需要第二个入口：抽屉里的表本来就是实例级的（`jobs.list` 一个实例一张表），
 * 但入口只在房间的输入框底栏 —— 而「结局无人接」恰恰发生在**房间被删之后**，
 * 那时那个房间的会话面根本不存在，`delivered:false` 的标记就永远没人看见。
 * 这份只负责「没有房间也能打开」，数据与抽屉组件和 chip 共用（不另算一套）。
 *
 * **由宿主条件挂载**（`{open && <JobsPanel … />}`）而不是自带 `open` 开关：`useJobs` 的
 * 轮询是「拉了就一直拉」，关着不卸载就等于每 5s 白跑一趟 —— 账本不该为一张看不见的面板买账。
 */
export function JobsPanel({ onClose }: { onClose: () => void }) {
    const { rows, reload } = useJobs(true);
    const [now, setNow] = React.useState(() => Date.now());

    // 秒表：与 chip 同一条规则（只在本机跳）
    React.useEffect(() => {
        if (!rows.some(isRunning)) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [rows]);

    // 标题栏入口 = 本实例全部（房间被删了也看得到，包括「结局无人接」）
    return <JobsDrawer rows={rows} now={now} onClose={onClose} onKilled={reload} scope="instance" />;
}
