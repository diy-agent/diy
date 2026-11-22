// page.tsx —— 「房间」页的模板与视图（**宿主侧装配**，不属于 workbench-dock 包）。
//
// 落位（外壳拆给 dock 的 area，一个布局只有一个真源）：
//   left   真侧栏           entity-chat 的 `<Sidebar widthMode="fill">`：项目 / 历史 / 未归属 + 新建 / 设置
//   center 对话主区         `<EntityChatApp sidebar={false} taskPanel={false}>`：只剩对话本身
//   right  任务 / 信息      task 房间 = 真 `<TaskPanel>`（关掉 = 收起本区域），其它房间 = 信息卡
//   bottom 工作台诊断       页实例是谁 / 区域开关 / 布局存在哪
//
// 两个「不给」很有必要：Sidebar 自带宽度拖拽（localStorage `entity-chat:sidebar-width`）
// 与 TaskPanel 的固定 `w-[340px]` 都由 dock 的 `area(size/min)` 接管 —— 两边都管就是两个真源。
//
// 弹窗（新建项目 / 建任务 / 删房间 / 设置 / 换模型）由宿主挂一次 `useRoomDialogs()`，
// 经 context 传给左栏（见 main.tsx）—— 和整页 App 同一套状态，不抄第二份。

import {
    EntityChatApp,
    Sidebar,
    TaskPanel,
    useRoomDialogsContext,
    useSelectedRoom,
    type Room,
} from '@diy-agent/entity-chat';
import { area, col, definePage, defineView, row, type ViewProps } from '@diy-agent/workbench-dock';

// ── 页模板 ────────────────────────────────────────────────────────────────────
//
// 两轴都用 col/row 表达（区域是树，不是网格）。left/right 用 px（有固定参照），
// center 用 1fr（只记比例）；right / bottom 初始收起 —— 收起态是模板的一部分，
// 用户的展开状态和尺寸由布局快照覆盖。
export const roomPage = definePage({
    type: 'room',
    title: (scope) => scope.title ?? scope.id,
    icon: '💬',
    areas: col([
        row([
            area('left', { size: 240, min: 180 }),
            area('center', { size: '1fr', min: 480 }),
            area('right', { size: 300, min: 220, initial: 'collapsed' }),
        ]),
        area('bottom', { size: 180, min: 100, initial: 'collapsed' }),
    ]),
});

// ── 视图 ──────────────────────────────────────────────────────────────────────

/**
 * 左栏：entity-chat 的真侧栏（项目 / 历史 / 未归属 + 新建 / 设置）。
 *
 * `widthMode="fill"`：宽度归 dock 的 area，它不再自带手柄与 localStorage 宽度。
 * 收起按钮 = 收起这个区域；展开入口在页外那条「区域」浮层（见 main.tsx）——
 * 区域里的按钮跟着区域一起消失，恢复入口不能住在布局里。
 */
function NavAside({ api }: ViewProps) {
    const dialogs = useRoomDialogsContext();
    return (
        <Sidebar
            open
            widthMode="fill"
            onToggle={() => api.toggleArea('left')}
            onCreateProject={dialogs.openProject}
            onCreateTask={dialogs.openTask}
            onRequestDelete={dialogs.requestDelete}
            onOpenSettings={dialogs.openSettings}
        />
    );
}

/** 对话：只留主区。侧栏 / 任务面板交给 dock 的 left、right 区域 —— 一个布局只该有一个真源 */
function ChatBody() {
    return (
        <div className="dock-chat">
            <EntityChatApp sidebar={false} taskPanel={false} />
        </div>
    );
}

/** 房间信息：scope / 数据长什么样（也是「谁在读同一个 store」的验证） */
function RoomInfo({ room }: { room: Room }) {
    const data = Object.entries(room.data ?? {});
    return (
        <div className="dock-info">
            <dl>
                <dt>id</dt>
                <dd>{room.id}</dd>
                <dt>type</dt>
                <dd>{room.type}</dd>
                <dt>name</dt>
                <dd>{room.name}</dd>
            </dl>
            <div className="dock-info-title">data</div>
            {data.length === 0 ? (
                <div className="dock-empty">（空）</div>
            ) : (
                <dl>
                    {data.map(([key, value]) => (
                        <div key={key} className="dock-info-row">
                            <dt>{key}</dt>
                            <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    );
}

/**
 * 右栏：task 房间给真任务面板（关掉 = 收起这个区域），其它房间给一张信息卡。
 *
 * TaskPanel 自己带 `w-[340px]`，在 area 里换成 100%（见 dock.css 的 `.dock-aside`）：
 * 固定宽度 + 可拖的 area 会互相置气 —— 拖窄了它溢出，拖宽了它留白。
 */
function RoomAside({ api }: ViewProps) {
    const room = useSelectedRoom();
    if (!room) return <div className="dock-empty">没有选中房间</div>;
    if (room.type !== 'task') return <RoomInfo room={room} />;
    return (
        <div className="dock-aside">
            <TaskPanel room={room} onClose={() => api.hideArea('right')} />
        </div>
    );
}

/** 工作台诊断：页实例是谁、区域能不能开、布局存在哪 */
function LabNotes({ page, areaId, api }: ViewProps) {
    return (
        <div className="dock-lab">
            <dl>
                <dt>页实例</dt>
                <dd>{page.id}</dd>
                <dt>本 view 区域</dt>
                <dd>{areaId}</dd>
            </dl>
            <div className="dock-area-toggles">
                {['left', 'center', 'right', 'bottom'].map((id) => (
                    <button
                        key={id}
                        type="button"
                        className={api.isAreaVisible(id) ? 'on' : undefined}
                        onClick={() => api.toggleArea(id)}
                    >
                        {id}
                    </button>
                ))}
            </div>
            <p>
                拖两根分隔线、收起 / 展开 tab、刷新页面 —— 布局按<b>页实例</b>存在
                <code>localStorage</code>（键 <code>workbench-dock:&lt;页实例&gt;</code>），
                切到别的房间再切回来还是你摆的样子。
            </p>
            <p>
                区域模板在 <code>src/dock/page.tsx</code>：px 值记 px、<code>1fr</code> 记比例。
            </p>
        </div>
    );
}

export const roomViews = [
    defineView({
        id: 'nav',
        title: '导航',
        // 不标 primary：初始激活组 = 第一个**有 primary view** 的区域（workbench-dock
        // 的 primaryArea），左栏标了它就成了打开先看房间列表；打开工作台该先看对话。
        placement: { room: { area: 'left' } },
        render: { kind: 'react', component: NavAside },
    }),
    defineView({
        id: 'chat',
        title: '对话',
        placement: { room: { area: 'center', primary: true } },
        render: { kind: 'react', component: ChatBody },
    }),
    defineView({
        id: 'aside',
        title: '任务 / 信息',
        placement: { room: { area: 'right', primary: true } },
        render: { kind: 'react', component: RoomAside },
    }),
    defineView({
        id: 'lab-notes',
        title: '工作台诊断',
        placement: { room: { area: 'bottom', primary: true } },
        render: { kind: 'react', component: LabNotes },
    }),
];
