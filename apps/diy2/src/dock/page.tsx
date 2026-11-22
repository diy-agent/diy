// page.tsx —— 「房间」页的模板与视图（**宿主侧装配**，不属于 workbench-dock 包）。
//
// P0 的落位（先证明引擎能装真业务，再谈拆包内组件）：
//   left   房间导航        宿主职责：切页 = 换页实例 = 换一份布局
//   center <EntityChatApp> 只留**主区**（`sidebar={false}`）——它的侧栏和左栏重复，
//                          且自带一套宽度拖拽（localStorage `entity-chat:sidebar-width`），
//                          与 dock 的 area(size/min) 是两套真源
//   right  房间信息        收起，用来看 view 拿到的 scope / page 是什么
//   bottom 工作台诊断      收起，自解释这个页怎么拖、布局存在哪
//
// 下一刀（拆分）：把 entity-chat 的侧栏内容（项目 / 历史 / 未归属）与 TaskPanel 导出成 view，
//   left/right 换成它们，宿主就不再需要自写的 RoomsNav。

import {
    EntityChatApp,
    navigate,
    roomAddressOf,
    useAddress,
    useRooms,
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

/** 房间导航：dock 里的「切页」由宿主自己画，包不认识「导航」这个概念 */
function RoomsNav() {
    const rooms = useRooms();
    const address = useAddress();

    if (rooms.length === 0) return <div className="dock-empty">还没有房间</div>;

    return (
        <nav className="dock-nav">
            {rooms.map((room: Room) => {
                const on = room.id === address.id;
                return (
                    <button
                        key={room.id}
                        type="button"
                        className={on ? 'dock-nav-item on' : 'dock-nav-item'}
                        title={room.id}
                        onClick={() => navigate(roomAddressOf(room))}
                    >
                        <span className="dock-nav-name">{room.name}</span>
                        <span className="dock-nav-kind">{room.type}</span>
                    </button>
                );
            })}
        </nav>
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

/** 房间信息：看 view 拿到的 scope / 数据，也是「谁在读同一个 store」的验证 */
function RoomInfo() {
    const room = useSelectedRoom();
    if (!room) return <div className="dock-empty">没有选中房间</div>;
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

/** 工作台诊断：这个页实例是谁、view 在哪个区域、布局存在哪个键 */
function LabNotes({ page, areaId }: ViewProps) {
    return (
        <div className="dock-lab">
            <dl>
                <dt>页实例</dt>
                <dd>{page.id}</dd>
                <dt>本 view 区域</dt>
                <dd>{areaId}</dd>
            </dl>
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
        id: 'rooms',
        title: '房间',
        // 不标 primary：初始激活组 = 第一个**有 primary view** 的区域（workbench-dock
        // 的 primaryArea），左栏标了它就成了打开先看房间列表；打开工作台该先看对话。
        placement: { room: { area: 'left' } },
        render: { kind: 'react', component: RoomsNav },
    }),
    defineView({
        id: 'chat',
        title: '对话',
        placement: { room: { area: 'center', primary: true } },
        render: { kind: 'react', component: ChatBody },
    }),
    defineView({
        id: 'room-info',
        title: '房间信息',
        placement: { room: { area: 'right', primary: true } },
        render: { kind: 'react', component: RoomInfo },
    }),
    defineView({
        id: 'lab-notes',
        title: '工作台诊断',
        placement: { room: { area: 'bottom', primary: true } },
        render: { kind: 'react', component: LabNotes },
    }),
];
