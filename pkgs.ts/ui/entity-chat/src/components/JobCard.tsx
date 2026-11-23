// JobCard —— 后台作业的**专属卡片**（run id / 状态 / 命令 / 结局 / 输出尾部）。
//
// 为什么不能再用普通工具行：`job` 的 args 里只有一个 action + id，`toolTargetOf` 的兜底
// 会把它画成 `{"action":"wait","id":"r-mwtf…` 这样的截断 JSON —— run id 认不全、状态看不见、
// 退出码和输出彻底没有，而 `job wait` 恰恰是"用户在等一件事"的时候（2026-11-23 实测：
// 用户问「job 卡住了？」，界面上什么线索都没有）。
//
// 判据全在 chat-core 的 `jobOf`（纯函数、有测试）；这里只画。

import type { JobView } from '@diy-agent/chat-core';
import * as React from 'react';

/** 这次调用在干什么（`start` = 把命令转到后台，其余与 job 的 action 同名） */
const ACTION_LABEL: Record<JobView['action'], string> = {
    start: '转到后台',
    done: '作业结束',
    list: '列作业',
    status: '查状态',
    output: '取输出',
    kill: '停止',
    wait: '等结束',
};

type Tone = 'running' | 'ok' | 'bad' | 'muted';

const TONE_TEXT: Record<Tone, string> = {
    running: 'text-amber-500',
    ok: 'text-emerald-500',
    bad: 'text-red-400',
    muted: 'text-muted-foreground',
};

/** 状态 → 语气。「结束了」与「成功了」是两件事（退出码单独判定），所以这里看 outcome */
function toneOf(view: JobView): Tone {
    if (view.error !== undefined) return 'bad';
    if (view.state === 'running') return 'running';
    if (view.state === 'killed' || view.state === 'failed') return 'bad';
    if (view.state === 'exited') return /退出码 0$/.test(view.outcome ?? '') ? 'ok' : 'bad';
    return view.state === undefined ? 'running' : 'muted';
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{label}</span>
            <span className={`min-w-0 break-all ${mono === true ? 'font-mono' : ''}`} title={value}>
                {value}
            </span>
        </div>
    );
}

export function JobCard({ view }: { view: JobView }) {
    const tone = toneOf(view);
    const running = view.state === 'running' || view.state === undefined;
    return (
        <div className="my-1.5 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-[12px] leading-5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {/* 收口通知本身就是“作业”这件事，不用再说一次动作 */}
                {view.action === 'done' ? null : (
                    <span className="rounded bg-foreground/8 px-1.5 py-px text-[11px] text-muted-foreground">
                        {ACTION_LABEL[view.action]}
                    </span>
                )}
                {view.id !== undefined ? (
                    <code className="font-mono text-[12px]">{view.id}</code>
                ) : (
                    <span className="text-muted-foreground">作业</span>
                )}
                <span className={`inline-flex items-center gap-1 ${TONE_TEXT[tone]}`}>
                    <span
                        className={`inline-block size-1.5 rounded-full bg-current ${running ? 'animate-pulse' : ''}`}
                        aria-hidden="true"
                    />
                    {view.label ?? (running ? '进行中' : '已结束')}
                </span>
                {view.duration !== undefined && <span className="text-muted-foreground tabular-nums">{view.duration}</span>}
                {view.outcome !== undefined && <span className={TONE_TEXT[tone]}>{view.outcome}</span>}
            </div>

            {view.command !== undefined && (
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={view.command}>
                    {view.command}
                </div>
            )}

            {view.error !== undefined && <div className="mt-1 text-red-400">{view.error}</div>}

            {view.state !== undefined || view.cwd !== undefined ? (
                <div className="mt-1 space-y-0.5 text-[11px]">
                    {view.cwd !== undefined && <Meta label="目录" value={view.cwd} mono />}
                    {view.logPath !== undefined && <Meta label="日志" value={view.logPath} mono />}
                    {view.origin !== undefined && <Meta label="来源" value={view.origin} />}
                </div>
            ) : null}

            {view.rows !== undefined && view.rows.length > 0 && (
                <div className="mt-1 space-y-0.5">
                    {view.rows.map((row) => (
                        <div key={row.id} className="flex items-baseline gap-2">
                            <span
                                className={`w-14 shrink-0 ${
                                    row.state === 'running'
                                        ? 'text-amber-500'
                                        : row.state === 'exited'
                                          ? 'text-muted-foreground'
                                          : 'text-red-400'
                                }`}
                            >
                                {row.state === 'running' ? '运行中' : row.state === 'exited' ? '已结束' : '已停止'}
                            </span>
                            <code className="shrink-0 font-mono text-[11px]">{row.id}</code>
                            <span className="shrink-0 tabular-nums text-muted-foreground">{row.duration}</span>
                            <span className="min-w-0 truncate text-muted-foreground" title={row.command}>
                                {row.command}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {view.tail !== undefined && view.tail !== '' && (
                <details className="mt-1">
                    <summary className="cursor-pointer select-none text-[11px] text-muted-foreground">
                        输出尾部
                        {view.tailDroppedBytes !== undefined && view.tailDroppedBytes > 0
                            ? `（前 ${view.tailDroppedBytes} 字节已截断）`
                            : ''}
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-foreground/5 p-2 font-mono text-[11px] leading-4">
                        {view.tail}
                    </pre>
                </details>
            )}

            {view.note !== undefined && <div className="mt-1 text-[11px] text-muted-foreground">{view.note}</div>}
        </div>
    );
}
