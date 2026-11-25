// JobCard —— 后台作业的**专属卡片**：**默认缩成一行**，点开才摊明细。
//
// 为什么不能再用普通工具行：`job` 的 args 里只有一个 action + id，`toolTargetOf` 的兜底
// 会把它画成 `{"action":"wait","id":"r-mwtf…` 这样的截断 JSON —— run id 认不全、状态看不见、
// 退出码和输出彻底没有，而 `job wait` 恰恰是"用户在等一件事"的时候（2026-11-23 实测：
// 用户问「job 卡住了？」，界面上什么线索都没有）。
//
// 为什么还要缩起来（2026-11-24 用户口径）：
//   · 一条 `job wait` 能占半屏，而它九成时间只是一句"等它结束"，把对话挤没了；
//   · 与 bash 工具行保持一致 —— 工具调用的默认形态是**一行**，明细是被点开的。
//
// 三条措辞纪律（都来自用户 2026-11-24 的实测误解）：
//   ① 「运行中」不能说给历史消息听 —— 事后看到这四个字会以为还在跑。所以只有**这一轮
//      真还挂着**（`live`）才写「在跑」；其余写「没等到结束」，并留时长。
//   ② 动作（转到后台 / 查状态 …）**不是按钮**：它是"这次调用在干什么"的说明，所以只在
//      展开后以一行灰字出现，不做成圆角 chip —— 长得像按钮却点不动是最贵的误会。
//   ③ 结局单列（退出码 / 信号）：结束了 ≠ 成功了。
//
// 判据全在 chat-core 的 `jobOf`（纯函数、有测试）；这里只画。

import { ChevronRight } from 'lucide-react';
import * as React from 'react';

import type { JobView } from '@diy-agent/chat-core';

/** 这次调用在干什么（`start` = 把命令转到后台，`done` = 收口通知，其余与 job 的 action 同名） */
const ACTION_LABEL: Record<JobView['action'], string> = {
    start: '转到后台',
    done: '收口通知',
    list: '列后台任务',
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

/**
 * 这一行该说什么。
 *
 * `live` = 这一轮**还挂在这次调用上**（由 surface 从 `entry.waiting` 传下来）。它决定
 * `running` 的说法：真在跑才写「在跑」，否则「没等到结束」—— 后者是历史事实，不是状态。
 */
function headOf(view: JobView, live: boolean): { tone: Tone; text: string } {
    if (view.error !== undefined) return { tone: 'bad', text: '失败' };
    if (view.state === undefined) return { tone: live ? 'running' : 'muted', text: live ? '在跑' : '无状态' };
    switch (view.state) {
        case 'running':
            return live ? { tone: 'running', text: '在跑' } : { tone: 'muted', text: '没等到结束' };
        case 'exited':
            return { tone: /退出码 0$/.test(view.outcome ?? '') ? 'ok' : 'bad', text: '已结束' };
        case 'killed':
            return { tone: 'bad', text: '已被杀' };
        case 'failed':
            return { tone: 'bad', text: '启动失败' };
    }
}

export function JobCard({
    view,
    live = false,
    defaultOpen = false,
}: {
    view: JobView;
    live?: boolean;
    /** 初始展开（渲染测试 / 实验台用；产品里一律从**收起**开始） */
    defaultOpen?: boolean;
}) {
    // 缺省收起：明细（命令 / 目录 / 日志 / 输出）是"要查的时候"才看的东西
    const [open, setOpen] = React.useState(defaultOpen);
    const head = headOf(view, live);
    // 收起行只放两样：**跑了多久**、以及（终态时）**怎么结束的**。
    // 运行中的「（未结束）」不用写 —— 「在跑」/「没等到结束」已经把这件事说了。
    const outcome = view.state === undefined || view.state === 'running' ? undefined : view.outcome;

    return (
        <div className="my-1.5 rounded-md border border-border/60 bg-muted/25 text-xs leading-5">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-foreground/5"
            >
                <ChevronRight
                    className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <span
                    className={`inline-block size-1.5 shrink-0 rounded-full bg-current ${head.tone === 'running' ? 'animate-pulse' : ''} ${TONE_TEXT[head.tone]}`}
                    aria-hidden="true"
                />
                <span className="shrink-0 text-xs text-muted-foreground">后台任务</span>
                {view.id !== undefined && <code className="shrink-0 font-mono text-xs">{view.id}</code>}
                <span className={TONE_TEXT[head.tone]}>{head.text}</span>
                {view.duration !== undefined && (
                    <span className="shrink-0 tabular-nums text-muted-foreground">{view.duration}</span>
                )}
                {outcome !== undefined && <span className={`shrink-0 ${TONE_TEXT[head.tone]}`}>{outcome}</span>}
                {view.command !== undefined && (
                    // 收起时也留一点"这条在干什么"的线索，但不给按钮形状
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/80">
                        {view.command}
                    </span>
                )}
                {view.tail !== undefined && view.tail !== '' && !open && (
                    <span className="shrink-0 text-xs text-muted-foreground/70">有输出</span>
                )}
            </button>

            {open && (
                <div className="space-y-1 border-t border-border/50 px-2 py-1.5">
                    {/* 动作是**说明**，不是控件（用户点过它）——一行灰字 */}
                    <div className="text-xs text-muted-foreground">
                        这次：job {ACTION_LABEL[view.action]}
                        {view.cwd !== undefined && <span className="ml-2 font-mono">{view.cwd}</span>}
                        {view.logPath !== undefined && (
                            <span className="ml-2 truncate font-mono" title={view.logPath}>
                                {view.logPath}
                            </span>
                        )}
                        {view.origin !== undefined && <span className="ml-2">来源 {view.origin}</span>}
                    </div>

                    {view.command !== undefined && (
                        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-foreground/5 px-2 py-1 font-mono text-xs">
                            {view.command}
                        </pre>
                    )}

                    {view.error !== undefined && <div className="text-red-400">{view.error}</div>}

                    {view.rows !== undefined && view.rows.length > 0 && (
                        <div className="space-y-0.5">
                            {view.rows.map((row) => (
                                <div key={row.id} className="flex items-baseline gap-2 text-xs">
                                    <span
                                        className={`w-14 shrink-0 ${
                                            row.state === 'running'
                                                ? 'text-amber-500'
                                                : row.state === 'exited'
                                                  ? 'text-muted-foreground'
                                                  : 'text-red-400'
                                        }`}
                                    >
                                        {row.state === 'running' ? '在跑' : row.state === 'exited' ? '已结束' : '已停止'}
                                    </span>
                                    <code className="shrink-0 font-mono">{row.id}</code>
                                    <span className="shrink-0 tabular-nums text-muted-foreground">{row.duration}</span>
                                    <span className="min-w-0 truncate text-muted-foreground" title={row.command}>
                                        {row.command}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {view.tail !== undefined && view.tail !== '' && (
                        <div>
                            <div className="text-xs text-muted-foreground">
                                输出尾部
                                {view.tailDroppedBytes !== undefined && view.tailDroppedBytes > 0
                                    ? `（前 ${view.tailDroppedBytes} 字节已截断）`
                                    : ''}
                            </div>
                            <pre className="mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-foreground/5 p-2 font-mono text-xs leading-4">
                                {view.tail}
                            </pre>
                        </div>
                    )}

                    {view.note !== undefined && <div className="text-xs text-muted-foreground">{view.note}</div>}

                    <details>
                        <summary className="cursor-pointer select-none text-xs text-muted-foreground">原文</summary>
                        <pre className="mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-foreground/5 p-2 font-mono text-xs leading-4">
                            {view.raw}
                        </pre>
                    </details>
                </div>
            )}
        </div>
    );
}
