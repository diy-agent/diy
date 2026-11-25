// CompactCutBar —— 时间线顶部那条「更早的消息已被压缩」的分隔条。
//
// 为什么要它：压缩是**悄悄发生**的 —— 房间里历史消息一条不少地还在，但 bot 的上下文里
// 早先那些已经被摘成了几十字。不标出来，用户会觉得「明明聊过，它怎么不记得」。
//
// 位置：**时间线最顶部**（第一条消息之前），滚到顶才看得见 —— 它描述的就是"更早"。
// 为什么不做在时间线中段的切点处：压缩是 **per bot** 的（每个 bot 各压各的），
// 而时间线是房间唯一的一条；多 bot 各自切在不同位置，中段切点表达不出来。
//
// 数据源是 `SessionInfo[]`（后端 `chat.sessions`），不是消息条目 —— 被压掉的消息
// 在时间线上照旧显示，这条只说「bot 那边剩什么摘要」。

import { ChevronDown, Scissors } from 'lucide-react';
import * as React from 'react';

import type { SessionInfo } from '@diy-agent/chat-core';

import { CopyButton } from './CopyButton';

export function CompactCutBar({ sessions }: { sessions: readonly SessionInfo[] }) {
    const [open, setOpen] = React.useState(false);
    const compacted = sessions.filter((session) => session.stats.compactions > 0);
    const folded = Math.max(0, ...compacted.map((session) => session.stats.collapsed));
    if (compacted.length === 0) return null;

    const summaryCount = compacted.filter((session) => session.stats.summary !== undefined).length;
    // 用「折叠 N 条」而不是折算掉的总数：只做了折叠（没整轮丢弃）时 dropped=0，
    // 写「0 条」会让人以为没压过
    const label =
        compacted.length === 1
            ? `更早的内容已压缩 · 折叠 ${folded} 条`
            : `更早的内容已压缩（${compacted.length} 个 bot 各自独立）`;

    return (
        <div className="my-2">
            <button
                onClick={() => setOpen((value) => !value)}
                title="被压缩的历史对 bot 不再可见，这里是压缩留下的摘要"
                className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
                <Scissors className="size-3" />
                <span>{label}</span>
                {summaryCount > 0 && <span className="opacity-70">· 摘要 {summaryCount}</span>}
                <ChevronDown className={`size-3 transition-transform ${open ? '' : '-rotate-90'}`} />
                <span className="mx-1 h-px flex-1 bg-border" />
            </button>
            {open && (
                <div className="mt-1 space-y-1.5 rounded border bg-muted/30 px-2 py-1.5">
                    {compacted.map((session) => (
                        <div key={session.botId}>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">{session.name}</span>
                                <span>折叠 {session.stats.collapsed} 条</span>
                                <span>压过 {session.stats.compactions} 次</span>
                                {session.stats.summary === undefined ? (
                                    <span className="text-amber-600">· 未摘要</span>
                                ) : (
                                    <CopyButton
                                        text={session.stats.summary}
                                        title="复制摘要"
                                        className="ml-auto rounded border p-0.5 hover:bg-muted"
                                    />
                                )}
                            </div>
                            <pre className="mt-0.5 max-h-32 overflow-auto text-xs leading-snug whitespace-pre-wrap text-muted-foreground">
                                {session.stats.summary ?? '（这一份上下文里没有摘要，只有折叠计数）'}
                            </pre>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
