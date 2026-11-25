// ConversationAreaBar.tsx —— 对话区标题栏右端的宿主扩展：表面切换 + 房间菜单。
//
// 用户 2026-11-24 的原话：「Astryx、shadcn 这俩 tab 上移为 view 级别，再缩小一行空白行」。
// 也就是说它们该长在**区域标题栏**（`wb-area-bar` 那张「对话」条）上，而不是对话内容顶上
// 再占一行。
//
// 分工：`SurfaceTabs` / `RoomMenu` 是 entity-chat 导出的无状态件（选中状态在它的
// `surface.ts` 模块 store 里；房间能力由这里从 `RoomDialogsProvider` 取），
// 这一层只负责「摆到 bar 里去」。对话区自己那一行因此可以整条不画（`bar="host"`）。

import { RoomMenu, SurfaceTabs, useRoomDialogsContext, useSelectedRoom } from '@diy-agent/entity-chat';

export function ConversationAreaBar() {
    const room = useSelectedRoom();
    const dialogs = useRoomDialogsContext();
    if (room === undefined) return null;
    return (
        <>
            <SurfaceTabs />
            <RoomMenu room={room} onAddMember={dialogs.openMember} onOpenSettings={dialogs.openSettings} />
        </>
    );
}
