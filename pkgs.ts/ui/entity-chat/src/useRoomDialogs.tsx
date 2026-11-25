// useRoomDialogs.tsx —— 「新建项目 / 新建任务 / 设置 / 删房间 / 换模型」这一组弹窗。
//
// 「加成员」不在这里了（2026-11-24 角色改成类型级）：成员是派生的，没有「拉一个人进这间房」，
// 那是设置页「角色」那一段的事（房间头的「角色」按钮导航过去，见 App.tsx 的 onManageRoles）。
//
// 为什么抽成 hook：这些弹窗**挂在哪由宿主决定**。整页 App 挂在根上，工作台挂在骨架
// 外面 —— 两边的状态与动作都只来自 store（`rooms` / `selected` /
// `actions`），所以一份实现、两个宿主各调一次：
//
//     const dialogs = useRoomDialogs();
//     <Sidebar onCreateProject={dialogs.openProject} … />
//     {dialogs.element}
//
// 不抽的代价：工作台想用真侧栏，就得把这一整套状态再抄一遍 —— 两份必然走散（抄的那份
// 迟早漏掉「建任务时记住在哪个项目下」这类细节）。

import * as React from 'react';

import {
    ConfirmDeleteDialog,
    CreateProjectDialog,
    CreateTaskDialog,
    ModelDialog,
    SettingsDialog,
} from './components/Dialogs';
import { roomTitle, type Room } from './model';
import { actions, useDefaultModelKey, useRooms } from './store';

type Dialog =
    | null
    | { kind: 'project' }
    | { kind: 'settings' }
    | { kind: 'task'; projectId: string }
    | { kind: 'delete'; roomId: string };

export interface RoomDialogs {
    /** 弹窗集合（自身不渲染任何壳：宿主决定挂在 DOM 的哪里） */
    element: React.ReactElement;
    openProject: () => void;
    /** 在指定项目下建任务（侧栏项目行的「+」用它） */
    openTask: (projectId: string) => void;
    openSettings: () => void;
    requestDelete: (room: Room) => void;
    /** 换某个房间的模型（房间级覆盖）。房间头胶囊改成开只读配置面板后 UI 暂不触发，能力保留给宿主 */
    openModel: (roomId: string) => void;
}

/**
 * 六个动作全部 `useCallback` 且依赖为空：侧栏把它们放进 `useMemo` 的 `host` 再传给每一行，
 * 每次渲染新建一个函数，行上的 `React.memo` 就永远拦不住（props 比不等）。
 */
export function useRoomDialogs(): RoomDialogs {
    const rooms = useRooms();
    const defaultModelKey = useDefaultModelKey();
    const [dialog, setDialog] = React.useState<Dialog>(null);
    const [modelTarget, setModelTarget] = React.useState<string | null>(null);

    const openProject = React.useCallback(() => setDialog({ kind: 'project' }), []);
    const openTask = React.useCallback((projectId: string) => setDialog({ kind: 'task', projectId }), []);
    const openSettings = React.useCallback(() => setDialog({ kind: 'settings' }), []);
    const requestDelete = React.useCallback((target: Room) => setDialog({ kind: 'delete', roomId: target.id }), []);
    const openModel = React.useCallback((roomId: string) => setModelTarget(roomId), []);

    const taskProject = dialog?.kind === 'task' ? rooms.find((item) => item.id === dialog.projectId) : undefined;
    const deleteTarget = dialog?.kind === 'delete' ? rooms.find((item) => item.id === dialog.roomId) : undefined;
    const modelRoom = modelTarget === null ? undefined : rooms.find((item) => item.id === modelTarget);

    const element = (
        <>
            {dialog?.kind === 'project' && (
                <CreateProjectDialog
                    onClose={() => setDialog(null)}
                    onSubmit={(input) => actions.createProject(input)}
                />
            )}
            {dialog?.kind === 'task' && taskProject !== undefined && (
                <CreateTaskDialog
                    project={taskProject}
                    suggestedName={`新任务 ${
                        rooms.filter((item) => item.data['projectId'] === dialog.projectId).length + 1
                    }`}
                    onClose={() => setDialog(null)}
                    // 不 void：对话框要等"建成了"才关（失败留在对话框里重试）
                    onSubmit={(input) => actions.createTask(dialog.projectId, input.name)}
                />
            )}
            {dialog?.kind === 'delete' && deleteTarget !== undefined && (
                <ConfirmDeleteDialog
                    room={deleteTarget}
                    taskCount={rooms.filter((item) => item.data['projectId'] === dialog.roomId).length}
                    onClose={() => setDialog(null)}
                    onConfirm={() => void actions.deleteRoom(dialog.roomId)}
                />
            )}
            {dialog?.kind === 'settings' && (
                <SettingsDialog
                    defaultModelKey={defaultModelKey}
                    onChangeDefault={(key) => actions.setDefaultModel(key)}
                    onClose={() => setDialog(null)}
                />
            )}
            {modelTarget !== null && (
                <ModelDialog
                    title={`「${modelRoom === null || modelRoom === undefined ? '' : roomTitle(modelRoom)}」的模型`}
                    value={modelRoom?.modelKey ?? defaultModelKey}
                    onChange={(key) => {
                        if (modelTarget !== null) actions.setRoomModel(modelTarget, key);
                    }}
                    onClose={() => setModelTarget(null)}
                />
            )}
        </>
    );

    return { element, openProject, openTask, openSettings, requestDelete, openModel };
}

/**
 * 宿主把 `useRoomDialogs()` 的结果放进 context，深层 view（dock 的左栏 / 房间头）
 * 就不用一路透传。
 *
 * 为什么是 context 而不是模块单例：弹窗是 React 状态（哪个弹窗开着），单例没法参与渲染。
 */
const RoomDialogsContext = React.createContext<RoomDialogs | null>(null);

export const RoomDialogsProvider = RoomDialogsContext.Provider;

export function useRoomDialogsContext(): RoomDialogs {
    const value = React.useContext(RoomDialogsContext);
    if (value === null) throw new Error('useRoomDialogsContext 必须在 <RoomDialogsProvider> 里调用');
    return value;
}
