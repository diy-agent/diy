// ContextPanel —— 每个 bot 的上下文占了多少、什么时候压过、现在压一次。
//
// 位置：2026-11-24 起在**输入框底栏**（`ComposerBar`，与模型 / 作业同一行）——
// 用户要的是其他 agent 那种形状：上下文、模型、作业都在输入框大框的最底下一行。
// 因此chip 的弹层默认**向上**开（`side="up"`）：底栏在屏幕底部，向下开没有位置。
//
// 同一个组件给两个 surface 用（壳层，不在 surface 里）。

import { Gauge, Scissors } from 'lucide-react';
import * as React from 'react';

import type { CompactEventInfo, CompactionProgress, Room, SessionInfo } from '@diy-agent/chat-core';

import { Button } from '@diy-agent/ui-shadcn';

import { contextWindowOf } from '../models';
import { actions, conversationOf, useProviders, useStore } from '../store';
import { CopyButton } from './CopyButton';
import { PendingTable } from './PendingTable';

/** 策略名 → 人话。后端枚举值不该原样进 UI */
const STRATEGY_LABEL: Record<string, string> = {
    'summary-fold-drop': 'LLM 摘要',
    'simple-fold-drop': '折叠丢弃',
};

function strategyLabel(name: string): string {
    return STRATEGY_LABEL[name] ?? name;
}

/** 摘要也是 LLM 调用，要几秒；纯折叠是毫秒级 —— 按钮文案得说实话 */
function isSummaryStrategy(name: string): boolean {
    return name.includes('summary');
}

/** 一条压缩事件的摘要状态（新生成 / 沿用旧的 / 没生成） */
function summaryStateOf(event: CompactEventInfo | undefined): string | undefined {
    if (event === undefined) return undefined;
    if (event.summaryError !== undefined) return `未摘要（${event.summaryError}）`;
    if (event.summarized) return `摘要 ${fmt((event.summary ?? '').length)} 字`;
    if (event.summary !== undefined) return `沿用上次摘要 ${fmt(event.summary.length)} 字`;
    return undefined;
}

function fmt(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function timeOf(at: number | undefined): string {
    if (at === undefined) return '—';
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function Row({
    session,
    busy,
    progress,
    now,
    onCompact,
    onCancel,
}: {
    session: SessionInfo;
    /** RPC 还没返回（很短，只防连点） */
    busy: boolean;
    /** 这个 bot 正在跑的手动压缩（来自 `compact` 事件） */
    progress?: CompactionProgress;
    now: number;
    onCompact: () => void;
    onCancel?: () => void;
}) {
    const { stats } = session;
    const used = stats.tokens;
    const lastEvent = session.compactions.at(-1);
    const summaryState = summaryStateOf(lastEvent);
    const [showSummary, setShowSummary] = React.useState(false);
    const runningProgress = progress?.state === 'running' ? progress : undefined;
    const running = runningProgress !== undefined;
    const active = busy || running;
    const elapsed =
        runningProgress === undefined ? 0 : Math.max(0, Math.round((now - runningProgress.startedAt) / 1000));
    return (
        <div className="border-t px-3 py-2 first:border-t-0">
            <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{session.name}</span>
                <span className="text-xs text-muted-foreground">
                    {stats.entries} 条 · ≈{fmt(used)} tok
                </span>
                <Button variant="outline" size="xs" onClick={onCompact} disabled={active} className="ml-auto gap-1">
                    <Scissors className={`size-3 ${running ? 'animate-pulse' : ''}`} />
                    {active ? (isSummaryStrategy(stats.strategy) ? '摘要中…' : '压缩中…') : '压缩'}
                </Button>
                {running && onCancel !== undefined && (
                    <Button
                        variant="ghost"
                        size="xs"
                        onClick={onCancel}
                        title="撤掉这次压缩（已折叠的部分不生效）"
                        className="text-muted-foreground"
                    >
                        取消
                    </Button>
                )}
            </div>
            {runningProgress !== undefined && (
                <div className="mt-0.5 text-xs text-amber-600">
                    摘要中… 已跑 {elapsed}s · 保留最近 {runningProgress.budget.keepTurns} 轮
                </div>
            )}
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span>策略 {strategyLabel(stats.strategy)}</span>
                <span>压过 {stats.compactions} 次</span>
                {stats.collapsed > 0 && <span>已折叠 {stats.collapsed} 条</span>}
                {stats.lastCompactAt !== undefined && <span>上次 {timeOf(stats.lastCompactAt)}</span>}
                {stats.usage !== undefined && <span>上轮实测 {fmt(stats.usage.inputTokens)} tok</span>}
            </div>
            {(summaryState !== undefined || stats.summary !== undefined) && (
                <div className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                    {summaryState !== undefined && (
                        <span className={lastEvent?.summaryError === undefined ? '' : 'text-amber-600'}>
                            · {summaryState}
                        </span>
                    )}
                    {stats.summary !== undefined && (
                        <>
                            <Button
                                variant="outline"
                                size="xs"
                                onClick={() => setShowSummary((value) => !value)}
                                className="ml-auto shrink-0"
                            >
                                {showSummary ? '收起摘要' : '看摘要'}
                            </Button>
                            <CopyButton
                                text={stats.summary}
                                title="复制摘要"
                                className="shrink-0 rounded border p-0.5 hover:bg-muted"
                            />
                        </>
                    )}
                </div>
            )}
            {showSummary && stats.summary !== undefined && (
                <pre className="mt-1 max-h-40 overflow-auto rounded border bg-muted/40 p-1.5 text-xs leading-snug whitespace-pre-wrap">
                    {stats.summary}
                </pre>
            )}
        </div>
    );
}

export function ContextPanel({ room, side = 'up' }: { room: Room; side?: 'up' | 'down' }) {
    const state = useStore();
    const providers = useProviders();
    const sessions = state.sessions[room.id] ?? [];
    const [open, setOpen] = React.useState(false);
    const [showPending, setShowPending] = React.useState(false);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [note, setNote] = React.useState<string | null>(null);
    /**
     * 手动压缩用：**只调「保留最近几轮」**（2026-11-25 对齐 diy1 的 keepRounds）。
     * 上限是全局常量，面板上只展示不可改 —— 两个旋钮各自能动时组合没有意义。
     */
    const [keepTurns, setKeepTurns] = React.useState<number | null>(null);
    const serverBudget = sessions[0]?.stats.budget;
    const keep = keepTurns ?? serverBudget?.keepTurns ?? 2;

    const windowTokens = contextWindowOf(providers, room.modelKey);
    const used = sessions.reduce((sum, session) => sum + session.stats.tokens, 0);
    const ratio = windowTokens === undefined || windowTokens === 0 ? undefined : used / windowTokens;

    // 压缩进度来自事件流（不是 RPC）：点下去同一帧内就能亮起来
    const conversation = conversationOf(room.id);
    const conv = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);
    const compactions = Object.values(conv.compactions);
    const runningBy = (botId: string): CompactionProgress | undefined =>
        compactions.find((entry) => entry.botId === botId && entry.state === 'running');
    const runningCount = compactions.filter((entry) => entry.state === 'running').length;

    // 秒表：只在有压缩在跑时每秒重渲（平时这条面板不因为时间流逝而重渲染）
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (runningCount === 0) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [runningCount]);

    // 压缩一结束立刻刷一次概况（不等那 4 秒的轮询）：占条数 / 摘要字数要马上对上
    const settled = compactions
        .filter((entry) => entry.state !== 'running')
        .map((entry) => entry.compactId)
        .join(',');
    React.useEffect(() => {
        if (settled !== '') actions.refreshSessions(room.id);
    }, [settled]);

    // 打开面板时拉一次，**只在展开时**定时刷（关着不轮询）：以前 4s 一次在面板关着也照跑，
    // 每次刷新都会 emit 整壳快照 ⇒ 所有订阅 shell 的地方跟着重渲（「聊天性能」那批问题的源头之一）。
    React.useEffect(() => {
        actions.refreshSessions(room.id);
        if (!open) return;
        const timer = setInterval(() => actions.refreshSessions(room.id), 4000);
        return () => clearInterval(timer);
    }, [room.id, open]);

    /**
     * 压缩是**受理即返**：这一下只负责把请求发出去。
     *
     * 进展与结果全部看 `compact` 事件（`state: running` → 终态），所以这里不再 setNote：
     * 登录框里那行“已完成 12 → 4 条”如果也走 RPC，就得等好几秒才出现 —— 正是 2026-11-25
     * 那次“点了没反应”的肇因。RPC 只剩两个用处：拿到可取消的 compactId、报发送失败。
     */
    const compress = async (botId: string) => {
        setBusy(botId);
        setNote(null);
        const outcome = await actions.compactSession(room.id, botId, { keepTurns: keep });
        setBusy(null);
        if (outcome === null) setNote('压缩没发出去（后端未响应）');
    };

    // 各自受理即返，不必串行：同时压几个 bot 本来就是互不相干的
    const compressAll = () => {
        for (const session of sessions) void compress(session.botId);
    };

    const cancelCompact = async (compactId: string) => {
        const ok = await actions.cancelCompact(room.id, compactId);
        if (!ok) setNote('这次压缩已经结束了，撤不回来');
    };

    return (
        <span className="relative inline-flex">
            <Button
                variant="outline"
                size="xs"
                onClick={() => setOpen((value) => !value)}
                title="查看每个 bot 的上下文占用，手动压缩"
                className="gap-1 text-muted-foreground"
            >
                <Gauge className={`size-3 ${runningCount > 0 ? 'animate-pulse text-amber-600' : ''}`} />
                {runningCount > 0 ? (
                    // 压缩要等好几秒：chip 是底栏里最显眼的那块，得在这里就说“在压”
                    <span className="text-amber-600">压缩中 {runningCount}</span>
                ) : (
                    <>
                        上下文 {fmt(used)}
                        {windowTokens !== undefined && <span className="opacity-60">/ {fmt(windowTokens)}</span>}
                        {ratio !== undefined && <span className="opacity-60">({Math.round(ratio * 100)}%)</span>}
                    </>
                )}
            </Button>

            {open && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div
                        className={`absolute left-0 z-50 w-[360px] rounded-md border bg-background shadow-lg ${
                            side === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
                        }`}
                    >
                        <div className="flex items-center gap-2 px-3 py-2">
                            <span className="text-xs font-medium">上下文</span>
                            <span className="text-xs text-muted-foreground">
                                {windowTokens === undefined ? '窗口未知' : `窗口 ${fmt(windowTokens)} tok`} · 各 bot
                                独立压缩
                            </span>
                            <Button
                                variant="outline"
                                size="xs"
                                onClick={compressAll}
                                disabled={busy !== null || runningCount > 0 || sessions.length === 0}
                                className="ml-auto"
                            >
                                全部压缩
                            </Button>
                        </div>

                        <div className="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs text-muted-foreground">
                            <span>保留最近</span>
                            <input
                                type="number"
                                min={0}
                                value={keep}
                                onChange={(event) => setKeepTurns(Number(event.target.value))}
                                className="w-12 rounded border bg-transparent px-1 text-right"
                            />
                            <span>轮 · 自动压缩按窗口水位触发</span>
                        </div>

                        {sessions.length === 0 ? (
                            <p className="border-t px-3 py-3 text-xs text-muted-foreground">
                                还没有会话（发一条消息再回来看）
                            </p>
                        ) : (
                            sessions.map((session) => {
                                const progress = runningBy(session.botId);
                                return (
                                    <Row
                                        key={session.botId}
                                        session={session}
                                        busy={busy === session.botId}
                                        {...(progress === undefined ? {} : { progress })}
                                        now={now}
                                        onCompact={() => void compress(session.botId)}
                                        {...(progress === undefined
                                            ? {}
                                            : { onCancel: () => void cancelCompact(progress.compactId) })}
                                    />
                                );
                            })
                        )}

                        {/*
                          诊断面：默认折叠 —— 「一眼答出卡在哪」，不是日常信息（计划 5.3）。
                          用按钮而不是 <details>：details 折叠时**内容仍然挂载**，那份订阅会继续
                          每次 state 变化重渲（正是这个任务要治的病）。按钮控制才会真的卸载。
                        */}
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setShowPending((value) => !value)}
                            className="w-full justify-start gap-1 border-t px-3 text-muted-foreground"
                        >
                            {showPending ? '▾' : '▸'} 进展（谁卡在哪）
                        </Button>
                        {showPending && <PendingTable roomId={room.id} />}

                        {note !== null && <p className="border-t px-3 py-2 text-xs text-muted-foreground">{note}</p>}
                    </div>
                </>
            )}
        </span>
    );
}
