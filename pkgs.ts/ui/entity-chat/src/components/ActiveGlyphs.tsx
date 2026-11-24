// ActiveGlyphs.tsx —— 标题栏右端的两颗**活动**图标：会话 N / 作业 M。
//
// 用户 2026-11-24 裁：**两颗并列，不合并**。它们是两种不同的活动（一轮对话 vs 一个后台进程），
// 合并成一个数之后「为什么亮」说不清，点进去也不知道该看哪儿。
//
// 为什么放在这里而不是壳（apps/diy2）：它读的是 entity-chat 的 store（全实例活动流），
// 壳不该认识「会话」这个概念 —— 壳只负责把贡献摆进标题栏（见 workbench/window.tsx）。
//
// 三件事说清：
//   · 数字 = **人/进程在动的个数**（会话数的是成员，一个房间两个 bot 抢话就是 2）
//   · 0 时**不消失**：变灰、不呼吸 —— 它同时是「现在很闲」这句话，忽隐忽现更让人以为界面在抽
//   · 呼吸只在 >0 时开（`animate-pulse`）：静态时它就是个普通图标
//
// 点击 = 会话那颗跳到第一个在跑的房间；作业那颗**打开全局面板**（`JobsPanel`）——
// 不是「跳到它所属房间」：房间删了正是「结局无人接」的现场，那时候没有房间可跳。
// 不点也行 —— 这一步只是省一次「打开侧栏找哪一行在动」。

import { MessageSquare, SquareTerminal } from 'lucide-react';
import * as React from 'react';

import { useActiveJobs, useRunningSessions } from '../store';

/** 图标 + 数字：数字只在 >0 时出现（0 已经是“灰”这件事本身） */
function Glyph({ icon, count, title }: { icon: React.ReactNode; count: number; title: string }) {
    const live = count > 0;
    return (
        <span
            className={`inline-flex items-center gap-0.5 ${live ? 'text-emerald-500' : 'text-muted-foreground/50'}`}
            title={title}
        >
            <span className={live ? 'animate-pulse' : ''}>{icon}</span>
            {live && <span className="text-[10px] tabular-nums leading-none">{count}</span>}
        </span>
    );
}

/** 「会话」那颗：现在有几个成员在跑（全实例活动流，切页 / 切房间都不重订） */
export function ActiveSessionsGlyph() {
    const count = useRunningSessions();
    return (
        <Glyph
            icon={<MessageSquare className="size-3.5" />}
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
            count={count}
            title={count === 0 ? '没有后台作业在跑' : `${count} 个后台作业在跑（点击看全部）`}
        />
    );
}
