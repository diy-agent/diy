// ConversationBar.tsx —— 对话区那一条「表面切换 + 房间能力」。
//
// 原来它是 `App` 里的一行（`RoomHeader` + `SurfaceTabs` 两行合并来的）。2026-11-24 用户
// 要求「Astryx / shadcn 这俩 tab 上移为 view 级别」—— 于是这一条不再必然画在对话内容上方：
// 工作台把 `SurfaceTabs` / `RoomMenu` 摆进自己的区域标题栏（`wb-area-bar`），
// 整页形态（`EntityChatApp` 单独挂）仍然由 `App` 自己摆一行。
//
// 两个组件无状态、无副作用：tab 选中在 `surface.ts` 的模块 store 里，房间能力由调用方给
// （整页形态来自 `useRoomDialogs()`，工作台来自 `RoomDialogsProvider`）。

import { CheckCircle2, Plus, Settings } from 'lucide-react';
import * as React from 'react';

import { taskStatusOf, type Room } from '../model';
import { actions } from '../store';
import { useSurfaceId } from '../surface';
import { SURFACES } from '../surfaces/registry';
import { MenuButton } from './Menu';

/** 表面切换：只是几颗 tab（壳 / 边框 / 内边距归调用方那一行）。 */
export function SurfaceTabs() {
    const [value, set] = useSurfaceId();
    return (
        <div className="flex items-center gap-1">
            {SURFACES.map((surface) => (
                <button
                    key={surface.id}
                    onClick={() => set(surface.id)}
                    title={surface.hint}
                    className={`rounded-md px-2.5 py-0.5 text-xs ${
                        value === surface.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                    }`}
                >
                    {surface.name}
                </button>
            ))}
        </div>
    );
}

/**
 * 房间级能力：加成员 / 房间设置 / 关闭任务。
 *
 * 原来这些还有一颗「任务面板」按钮 —— 它只在「本层自己画右侧面板」时才有意义，
 * 而工作台把面板放进 dock 的右区（有它自己的开关），所以那颗留在 `App` 里，不下沉到这。
 */
export function RoomMenu({
    room,
    onAddMember,
    onOpenSettings,
}: {
    room: Room;
    /** BotRole 下成员从角色派生，没有「加成员」动作 —— 不传就不画那一项 */
    onAddMember?: (() => void) | undefined;
    onOpenSettings: () => void;
}) {
    const openTask = room.type !== 'project' && taskStatusOf(room) === 'open';
    return (
        <MenuButton
            title="房间操作"
            items={[
                ...(onAddMember === undefined
                    ? []
                    : [{ key: 'member', label: '加成员', icon: <Plus className="size-3.5" />, onClick: onAddMember }]),
                { key: 'settings', label: '房间设置', icon: <Settings className="size-3.5" />, onClick: onOpenSettings },
                ...(openTask
                    ? [
                          {
                              key: 'close',
                              label: '关闭任务',
                              icon: <CheckCircle2 className="size-3.5" />,
                              onClick: () => void actions.setRoomStatus(room.id, 'closed'),
                          },
                      ]
                    : []),
            ]}
        />
    );
}
