// ActiveGlyphs.tsx —— 标题栏右端的两颗**活动**图标：会话 N / 作业 M。
//
// 用户 2026-11-24 裁：**两颗并列，不合并**。它们是两种不同的活动（一轮对话 vs 一个后台进程），
// 合并成一个数之后「为什么亮」说不清，点进去也不知道该看哪儿。
//
// 为什么放在这里而不是壳（apps/diy2）：它读的是 entity-chat 的 store（全实例活动流），
// 壳不该认识「会话」这个概念 —— 壳只负责把贡献摆进标题栏（见 workbench/window.tsx）。
//
// 标题栏里要一眼可认：不用 hover 才知道这是什么，也不用看空图标猜它是不是坏了。
// 所以两颗都带固定文字与数字（包括 0）；有活动时亮绿并呼吸，无活动时灰显。
//
// 点击 = 会话那颗跳到第一个在跑的房间；作业那颗**打开全局面板**（`JobsPanel`）——
// 不是「跳到它所属房间」：房间删了正是「结局无人接」的现场，那时候没有房间可跳。
// 不点也行 —— 这一步只是省一次「打开侧栏找哪一行在动」。

import { MessageSquare, SquareTerminal } from 'lucide-react';
import * as React from 'react';

import { useActiveJobs, useRunningSessions } from '../store';

/** 图标、类别与总数都常显；视觉状态只表达是否正在活动 */
function Glyph({ icon, label, count, title }: { icon: React.ReactNode; label: string; count: number; title: string }) {
    const live = count > 0;
    return (
        <span
            className={`inline-flex items-center gap-1 whitespace-nowrap ${live ? 'text-emerald-400' : 'text-muted-foreground/70'}`}
            title={title}
        >
            <span className={live ? 'animate-pulse' : ''}>{icon}</span>
            <span className="text-[10px] leading-none">{label}</span>
            <span className="text-[10px] tabular-nums leading-none">{count}</span>
        </span>
    );
}

/** 「会话」那颗：现在有几个成员在跑（全实例活动流，切页 / 切房间都不重订） */
export function ActiveSessionsGlyph() {
    const count = useRunningSessions();
    return (
        <Glyph
            icon={<MessageSquare className="size-3.5" />}
            label="会话"
            count={count}
            title={count === 0 ? '没有会话在跑' : `${count} 个会话在跑（点击跳到第一个）`}
        />
    );
}

/** 「作业」那颗：实例账本里有几条后台 run 还活着 */
export function ActiveJobsGlyph() {
    const count = useActiveJobs();
    return (
        <Glyph
            icon={<SquareTerminal className="size-3.5" />}
            label="后台任务"
            count={count}
            title={
                count === 0
                    ? '没有后台任务在跑'
                    : `${count} 个后台任务在跑（本实例全部，点击看全部）`
            }
        />
    );
}
