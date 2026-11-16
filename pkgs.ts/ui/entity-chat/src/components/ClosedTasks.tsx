// ClosedTasks.tsx —— 「已关闭任务」表。
//
// 树里只放未关闭的任务（用户：closed 的从项目树隐藏掉），但如果关掉就等于消失，
// 那就没法回头复查 —— 所以关掉的任务集中到这一张表里：按关闭时间倒序，
// 第一列是它属于哪个项目（跨项目的表，不写项目就分不清两个同名任务）。
//
// 打开入口在侧栏（`已关闭任务 N`），弹窗放在 App 层：它是跨项目的，不属于任何一行。

import { ArchiveRestore, Folder } from 'lucide-react';

import { closedAtOf, closedTasksOf, type Room } from '../model';
import { actions, useStore } from '../store';
import { Modal } from './Dialogs';

/** 关闭时刻：绝对时间（表里对齐、能扫）；没有 closedAt 的老数据（三态时代的 done）显示「—」 */
function whenText(ms: number | undefined): string {
    if (ms === undefined) return '—';
    const at = new Date(ms);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function projectNameOf(room: Room, rooms: Room[]): string | undefined {
    const projectId = room.data['projectId'];
    if (typeof projectId !== 'string') return undefined;
    return rooms.find((item) => item.id === projectId)?.name;
}

export function ClosedTasksDialog({ onClose }: { onClose: () => void }) {
    const state = useStore();
    // 倒序：最近关掉的在最上面（排序规则在 model.closedTasksOf，树侧用的是同一个“已关闭”判据）
    const closed = closedTasksOf(state.rooms);

    return (
        <Modal title="已关闭任务" onClose={onClose} size="wide">
            {closed.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                    还没有关闭的任务。任务行上的状态图标点一下就是关闭。
                </p>
            ) : (
                <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground">
                            <tr>
                                <th className="px-3 py-1.5 text-left font-normal">项目</th>
                                <th className="px-3 py-1.5 text-left font-normal">任务</th>
                                <th className="px-3 py-1.5 text-left font-normal">关闭时间</th>
                                <th className="px-3 py-1.5" />
                            </tr>
                        </thead>
                        <tbody>
                            {closed.map((room) => {
                                const project = projectNameOf(room, state.rooms);
                                return (
                                    <tr key={room.id} className="border-t hover:bg-muted/40">
                                        <td className="max-w-[10rem] truncate px-3 py-1.5 text-muted-foreground">
                                            <span className="flex items-center gap-1">
                                                <Folder className="size-3 shrink-0 text-sky-400" />
                                                {project ?? '未归属'}
                                            </span>
                                        </td>
                                        <td className="max-w-[16rem] truncate px-3 py-1.5">
                                            <button
                                                onClick={() => {
                                                    actions.select(room.id);
                                                    onClose();
                                                }}
                                                title="打开这个任务（已关闭的也能进来看/继续说）"
                                                className="truncate rounded text-left hover:underline"
                                            >
                                                {room.name}
                                            </button>
                                        </td>
                                        <td
                                            className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
                                            title={closedAtOf(room) === undefined ? '这条是老数据，没有记录关闭时刻' : undefined}
                                        >
                                            {whenText(closedAtOf(room))}
                                        </td>
                                        <td className="px-3 py-1.5 text-right">
                                            <button
                                                onClick={() => void actions.setRoomStatus(room.id, 'open')}
                                                title="重新打开：回到项目树里（状态变回 open）"
                                                className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                                            >
                                                <ArchiveRestore className="size-3" />
                                                重开
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>共 {closed.length} 个；重开后回到项目树，状态变回 open</span>
                <button onClick={onClose} className="rounded-lg border px-3 py-1 text-xs">
                    关闭
                </button>
            </div>
        </Modal>
    );
}
