// ActiveGlyphs.tsx —— 标题栏右端的两颗**活动**图标：Bot N / 作业 M。
//
// 用户 2026-11-24 裁：**两颗并列，不合并**。它们是两种不同的活动（一轮对话 vs 一个后台进程），
// 合并成一个数之后「为什么亮」说不清，点进去也不知道该看哪儿。
//
// 为什么放在这里而不是壳（apps/diy2）：它读的是 entity-chat 的 store（全实例活动流），
// 壳不该认识「Bot」这个概念 —— 壳只负责把贡献摆进标题栏（见 workbench/window.tsx）。
//
// 标题栏里要一眼可认：不用 hover 才知道这是什么，也不用看空图标猜它是不是坏了。
// 所以两颗都带固定文字与数字（包括 0）；有活动时亮绿并呼吸，无活动时灰显。
// Bot 入口弹出运行中房间列表；后台任务入口打开全局面板。

import { MessageSquare, SquareTerminal } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@diy-agent/ui-shadcn';

import { roomTitle } from '../model';
import { actions, useActiveJobs, useRunningOf, useRunningSessionRooms } from '../store';

/** 图标、类别与总数都常显；视觉状态只表达是否正在活动 */
function Glyph({ icon, label, count, title }: { icon: React.ReactNode; label: string; count: number; title: string }) {
    const live = count > 0;
    return (
        <span
            className={`inline-flex items-center gap-1 whitespace-nowrap ${live ? 'text-emerald-400' : 'text-muted-foreground/70'}`}
            title={title}
        >
            <span className={live ? 'animate-pulse' : ''}>{icon}</span>
            <span className="text-xs leading-none">{label}</span>
            <span className="text-xs tabular-nums leading-none">{count}</span>
        </span>
    );
}

function RunningRoomRow({ room, onSelect }: { room: ReturnType<typeof useRunningSessionRooms>[number]; onSelect: () => void }) {
    const count = useRunningOf(room.id);
    if (count === 0) return null;
    return (
        <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onSelect}
            className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left text-xs"
        >
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
            <span className="min-w-0 flex-1 truncate">{roomTitle(room)}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count} 个成员在跑</span>
        </Button>
    );
}

/**
 * 「Bot」入口：点击弹出正在运行的房间列表。
 *
 * 数字与列表**同源**（`useRunningSessionRooms`）——各算一份就会出现「Bot 1、点开是空的」。
 */
export function ActiveSessionsGlyph() {
    const runningRooms = useRunningSessionRooms();
    const count = runningRooms.length;
    const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
    const close = React.useCallback(() => setAnchor(null), []);
    React.useEffect(() => {
        if (anchor === null) return;
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [anchor, close]);
    const title = count === 0 ? '没有 Bot 在跑' : `${count} 个 Bot 在跑，点击查看列表`;
    return (
        <>
            {/* 保留手写 button：22px 高是为了与壳里那颗「后台任务」逐像素对齐，
                Button 的尺寸阶梯从 h-6(24) 起，套上去会差 2px */}
            <button
                type="button"
                className={[
                    // 尺寸与左侧那颗「后台任务」（壳的 22px 按钮）逐像素对齐：高度 22、左右 padding 6
                    'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded border border-transparent px-1.5 leading-none hover:bg-muted',
                    count > 0 ? 'text-emerald-400' : 'text-muted-foreground/70',
                ].join(' ')}
                title={title}
                aria-label={`Bot ${count}，查看正在运行的 Bot`}
                onClick={(event) => {
                    event.stopPropagation();
                    // 必须在这里就把 rect 取出来：updater 是在**下次渲染时**才执行的，
                    // 那时 React 已把事件对象的 currentTarget 置空 → 取矩形会抛
                    // 「null.getBoundingClientRect」→ 整棵组件树崩掉（2026-11-25 实测：点一下黑屏）。
                    const rect = event.currentTarget.getBoundingClientRect();
                    setAnchor((current) => (current === null ? rect : null));
                }}
            >
                <span className={count > 0 ? 'animate-pulse' : ''}><MessageSquare className="size-3.5" /></span>
                <span className="text-xs leading-none">Bot</span>
                <span className="text-xs tabular-nums leading-none">{count}</span>
            </button>
            {anchor !== null && createPortal(
                <>
                    <button aria-label="关闭 Bot 列表" className="fixed inset-0 z-[999] cursor-default" onClick={close} />
                    <div role="dialog" aria-label="正在运行的 Bot" className="fixed z-[1000] w-72 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg" style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 296)), top: anchor.bottom + 4 }}>
                        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">正在运行的 Bot · {count}</div>
                        {runningRooms.map((room) => <RunningRoomRow key={room.id} room={room} onSelect={() => { actions.select(room.id); close(); }} />)}
                        {count === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">当前没有运行中的 Bot</p>}
                    </div>
                </>,
                document.body,
            )}
        </>
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
