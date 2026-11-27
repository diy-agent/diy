// MigrationScreen.tsx —— 库还没迁完时主 app 的那一屏。
//
// 为什么要它（2026-11-27 用户裁定：迁移页并进主 app 当路由，不再单开端口）：
// 库的迁移是同步跑的，`createDiy2App()` 一装配就会把迁移做完 —— 页面永远看不到过程。
// 所以服务端先只读探一次，有待迁移就把 app 装成「迁移态」；UI 一问就知道自己在哪种态，
// 渲染这一屏而不是工作台。迁完服务端换成真 app，这一屏收到 `ready` 就叫浏览器刷新。

import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@diy-agent/ui-shadcn';
import { Button } from '@diy-agent/ui-shadcn';
import { Card } from '@diy-agent/ui-shadcn';

/** 一条计划项（服务端 `migrationPlan()` 的输出） */
interface PlanItem {
    step: string;
    from: string;
    to: string;
    note: string;
    rows: number;
    /** 数据体检：旧资源还在不在（只用于展示，**不是**「待迁移」判据） */
    done: boolean;
    /** 版本表里有没有它 —— 这才是「迁没迁」的真源 */
    recorded: boolean;
}

/** 一步的进度事件 */
interface StepEvent {
    id: string;
    title: string;
    state: 'running' | 'done' | 'skipped' | 'failed';
    changes?: number;
    note?: string;
    durationMs?: number;
    progress?: { done: number; total: number };
}

interface MigrateState {
    mode: 'migrate';
    version?: { applied: number; total: number };
    plan?: PlanItem[];
    steps?: Array<{ id: string; title: string }>;
    /** 跑过之后文件又被改了的迁移（Flyway 式 checksum）：已迁的库不会重放它 */
    drift?: Array<{ id: string; recorded: string; current: string }>;
    error?: string;
}

type Phase = 'idle' | 'running' | 'failed' | 'done';

const STATE_LABEL: Record<StepEvent['state'], string> = {
    running: '进行中',
    done: '完成',
    skipped: '跳过',
    failed: '失败',
};

export function MigrationScreen(): React.JSX.Element {
    const [state, setState] = useState<MigrateState | null>(null);
    const [phase, setPhase] = useState<Phase>('idle');
    const [events, setEvents] = useState<StepEvent[]>([]);
    const [log, setLog] = useState<string[]>([]);
    const [openPlan, setOpenPlan] = useState(false);
    const source = useRef<EventSource | null>(null);

    // 打开页面先问「我在哪种态」：迁移态要显示计划与版本，不能先渲染工作台
    useEffect(() => {
        void fetch('/api/migrate/state')
            .then((response) => response.json() as Promise<MigrateState>)
            .then(setState)
            .catch((error: unknown) => setState({ mode: 'migrate', error: String(error) }));
    }, []);

    useEffect(() => () => source.current?.close(), []);

    // 「库已经迁完，但服务端还在装配真 app」的那段空窗：不能靠一次 reload 撞运气。
    // 迁完换 app 要重新 openStore（大库几秒），这时候 `/` 仍是迁移态 ——
    // 刷新过头会重新落回这一屏（计划全部「已完成」，按钮又是灰的），人以为卡住了。
    // 所以：状态里已经没有待迁移项时，轮询到 mode 变了再刷新。
    useEffect(() => {
        if (state === null) return;
        const plan = state.plan ?? [];
        if (plan.length === 0 || plan.some((item) => !item.done)) return;
        const timer = window.setInterval(() => {
            void fetch('/api/migrate/state')
                .then((response) => response.json() as Promise<{ mode?: string }>)
                .then((next) => {
                    if (next.mode !== 'migrate') {
                        window.clearInterval(timer);
                        location.reload();
                    }
                })
                .catch(() => {
                    /* 服务端正在换 app，稍后重试 */
                });
        }, 1000);
        return () => window.clearInterval(timer);
    }, [state]);

    const start = useCallback(() => {
        setPhase('running');
        setEvents([]);
        setLog([]);
        const stream = new EventSource('/api/migrate/events');
        source.current = stream;
        // 必须等流真的连上再让服务端起跑：子进程起不来时服务端会**立即**广播 error，
        // 先 POST 后连流就会把那条唯一的红字丢掉 —— 页面于是永远停在「迁移中…」，
        // 既没有进度也没有日志（2026-11-27 实测）。
        stream.onopen = () => {
            void fetch('/api/migrate/start', { method: 'POST' });
        };
        stream.onmessage = (message: MessageEvent<string>) => {
            const payload = JSON.parse(message.data) as Record<string, unknown>;
            const kind = payload['kind'];
            if (kind === 'step') {
                const event = payload['event'] as StepEvent;
                setEvents((previous) => {
                    const next = previous.filter((item) => item.id !== event.id);
                    return [...next, event];
                });
            } else if (kind === 'log' || kind === 'stderr') {
                setLog((previous) => [...previous.slice(-200), String(payload['text'] ?? '')]);
            } else if (kind === 'error') {
                setLog((previous) => [...previous, String(payload['message'] ?? '')]);
                setPhase('failed');
            } else if (kind === 'closed') {
                // 注意：成功后**不能**在这里关流 —— 服务端紧接着还要广播 `ready`
                //（起真 app 是异步的），关了流就永远等不到那一帧，页面就不刷新。
                const code = Number(payload['code'] ?? -1);
                if (code === 0) {
                    setPhase('done');
                    // 兵分两路：`ready` 到了立刻刷；万一错过（流断了），这里兵底
                    window.setTimeout(() => location.reload(), 1500);
                } else {
                    stream.close();
                    setPhase('failed');
                }
            } else if (kind === 'ready') {
                // 服务端已经换成真 app：刷新进工作台
                stream.close();
                location.reload();
            }
        };
        stream.onerror = () => {
            stream.close();
            // 断流同样不能静默：停留在「迁移中…」比报错还难查
            setPhase((current) => (current === 'running' ? 'failed' : current));
            setLog((previous) =>
                previous.length > 0 ? previous : [...previous, '进度流断了：服务端没有响应（迁移进程可能已退出）'],
            );
        };
    }, []);

    if (state === null) {
        return <Shell>读取库状态…</Shell>;
    }
    if (state.error !== undefined) {
        return <Shell>读不到库：{state.error}</Shell>;
    }

    const plan = state.plan ?? [];
    // 「待迁移」只认版本表（`recorded`），不认数据体检（`done`）：
    // 数据长得不像迁过了不该把人拦在迁移页 —— 那正是「迁完之后还老回迁移页」的病根。
    // 跑完了就不再信初始计划：迁完之后「待迁移」应该归零（计划是打开页面那一刻快照的）。
    const todo = phase === 'done' ? [] : plan.filter((item) => !item.recorded);
    const settled = events.filter((event) => event.state !== 'running');
    const total = state.steps?.length ?? plan.length;
    const finished = phase === 'done' ? total : settled.filter((event) => event.state !== 'failed').length;
    const percent = total === 0 ? 0 : Math.round((finished / total) * 100);
    const version = phase === 'done' ? { applied: total, total } : state.version;
    const drift = state.drift ?? [];

    const verdict =
        phase === 'running'
            ? '正在迁移…'
            : phase === 'failed'
              ? '迁移出错了'
              : phase === 'done' || todo.length === 0
                ? '✓ 这个库已经是迁移后的状态'
                : '等待开始';

    return (
        <Shell>
            <div className="w-full max-w-2xl space-y-4">
                <div>
                    <div className="text-lg font-semibold">{verdict}</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                        共 {total} 项{todo.length > 0 ? `，其中 ${String(todo.length)} 项待迁移` : '，全部已就位'}
                        {version === undefined ? '' : ` · 库版本 ${String(version.applied)} / ${String(version.total)}`}
                    </div>
                </div>

                {drift.length > 0 ? (
                    <Card className="border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                        <div className="font-medium">有 {drift.length} 条迁移在跑过之后被改过</div>
                        <div className="mt-1 text-muted-foreground">
                            {drift.map((item) => item.id).join(' · ')}
                            —— 已记账的迁移不会重放，本次改动不生效；要生效请新开一条迁移。
                        </div>
                    </Card>
                ) : null}

                {phase === 'idle' && todo.length > 0 ? (
                    <div className="text-sm text-muted-foreground">
                        待迁移 {todo.length} 项：{todo.map((item) => item.to).join(' · ')}
                    </div>
                ) : null}

                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                        className="h-full rounded-full bg-primary transition-[width] duration-300"
                        style={{ width: `${String(percent)}%` }}
                    />
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                        {finished} / {total}
                    </span>
                    <span>{phase === 'running' ? (settled.at(-1)?.title ?? '') : ''}</span>
                </div>

                <div>
                    {phase === 'idle' || phase === 'failed' ? (
                        <Button onClick={start} disabled={todo.length === 0 && phase !== 'failed'}>
                            {phase === 'failed' ? '重新迁移' : '开始迁移'}
                        </Button>
                    ) : phase === 'done' ? (
                        <Button
                            onClick={() => {
                                location.reload();
                            }}
                        >
                            打开主界面 →
                        </Button>
                    ) : (
                        <Button disabled>迁移中…</Button>
                    )}
                </div>

                {events.length > 0 ? (
                    <Card className="divide-y divide-border p-0">
                        {settled.map((event) => (
                            <div key={event.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                                <Badge variant={event.state === 'failed' ? 'destructive' : 'secondary'}>
                                    {STATE_LABEL[event.state]}
                                </Badge>
                                <span className="flex-1 truncate">{event.title}</span>
                                {event.note === undefined ? null : (
                                    <span className="max-w-60 truncate text-muted-foreground">{event.note}</span>
                                )}
                            </div>
                        ))}
                    </Card>
                ) : null}

                <Card className="p-0">
                    <button
                        type="button"
                        className="flex w-full items-center justify-between px-3 py-2 text-sm"
                        onClick={() => {
                            setOpenPlan((open) => !open);
                        }}
                    >
                        <span>迁移规划（{plan.length} 项）</span>
                        <span className="text-muted-foreground">{openPlan ? '收起' : '展开'}</span>
                    </button>
                    {openPlan ? (
                        <div className="divide-y divide-border border-t border-border">
                            {plan.map((item) => (
                                <div key={item.step} className="flex items-center gap-2 px-3 py-2 text-sm">
                                    <span className="w-40 shrink-0 truncate text-muted-foreground">{item.from}</span>
                                    <span className="text-muted-foreground">→</span>
                                    <span className="flex-1 truncate">{item.to}</span>
                                    <Badge variant={item.recorded ? 'secondary' : 'default'}>
                                        {item.recorded ? '已迁移' : '待迁移'}
                                    </Badge>
                                </div>
                            ))}
                        </div>
                    ) : null}
                </Card>

                {log.length > 0 ? (
                    <pre className="max-h-60 overflow-auto rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
                        {log.join('\n')}
                    </pre>
                ) : null}
            </div>
        </Shell>
    );
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <div className="flex min-h-screen items-center justify-center bg-background p-6">{children}</div>;
}
