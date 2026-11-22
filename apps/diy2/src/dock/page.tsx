// page.tsx —— 「房间」页的模板与视图（**宿主侧装配**，不属于 workbench-dock 包）。
//
// 落位（外壳拆给 dock 的 area，一个布局只有一个真源）：
//   left   真侧栏           entity-chat 的 `<Sidebar widthMode="fill">`：项目 / 历史 / 未归属 + 新建 / 设置
//   detail 任务详情         task 房间 = 真 `<TaskPanel>`；其它房间 = 信息卡
//   center 对话主区         `<EntityChatApp sidebar={false} taskPanel={false}>`：只剩对话本身
//   assets 会话资产（预留）  会话生成的资产文件 —— 位置先定，数据源后接（现在只有空态）
//   bottom 工作台诊断       页实例是谁 / 区域开关 / 布局存在哪
//
// 两个「不给」很有必要：Sidebar 自带宽度拖拽（localStorage `entity-chat:sidebar-width`）
// 与 TaskPanel 的固定 `w-[340px]` 都由 dock 的 `area(size/min)` 接管 —— 两边都管就是两个真源。
//
// 弹窗（新建项目 / 建任务 / 删房间 / 设置 / 换模型）由宿主挂一次 `useRoomDialogs()`，
// 经 context 传给左栏（见 App.tsx）—— 和整页 App 同一套状态，不抄第二份。

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
// 两轴都用 col/row 表达（区域是树，不是网格）。left / detail / assets 用 px（有固定参照），
// center 用 1fr（只记比例）；assets / bottom 初始收起 —— 收起态是模板的一部分，
// 用户的展开状态和尺寸由布局快照覆盖。
//
// 为什么任务详情在**对话左边**：它是聊天的背景材料，读消息和读正文要能同时看见；
// 右边留给「这一轮聊出来的东西」（资产文件），左右分工 = 输入资料 / 产出物。
export const roomPage = definePage({
    type: 'room',
    title: (scope) => scope.title ?? scope.id,
    icon: '💬',
    areas: col([
        row([
            area('left', { size: 240, min: 180 }),
            area('detail', { size: 320, min: 240 }),
            area('center', { size: '1fr', min: 420 }),
            area('assets', { size: 300, min: 220, initial: 'collapsed' }),
        ]),
        area('bottom', { size: 180, min: 100, initial: 'collapsed' }),
    ]),
});

/** 模板里的五个区域，顺序与上面的 `area` 声明一致（页外浮层照它排） */
export const DOCK_AREAS = ['left', 'detail', 'center', 'assets', 'bottom'] as const;

// ── 视图 ──────────────────────────────────────────────────────────────────────

/**
 * 左栏：entity-chat 的真侧栏（项目 / 历史 / 未归属 + 新建 / 设置）。
 *
 * `widthMode="fill"`：宽度归 dock 的 area，它不再自带手柄与 localStorage 宽度。
 * 收起按钮 = 收起这个区域；展开入口在页外那条「区域」浮层（见 App.tsx）——
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

/** 对话：只留主区。侧栏 / 任务详情 / 资产都交给 dock 的 area —— 一个布局只该有一个真源 */
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
 * 对话左边：task 房间给真任务面板（关掉 = 收起这个区域），其它房间给一张信息卡。
 *
 * TaskPanel 自己带 `w-[340px]`，在 area 里换成 100%（见 dock.css 的 `.dock-aside`）：
 * 固定宽度 + 可拖的 area 会互相置气 —— 拖窄了它溢出，拖宽了它留白。
 */
function DetailAside({ api }: ViewProps) {
    const room = useSelectedRoom();
    if (!room) return <div className="dock-empty">没有选中房间</div>;
    if (room.type !== 'task') return <RoomInfo room={room} />;
    return (
        <div className="dock-aside">
            <TaskPanel room={room} onClose={() => api.hideArea('detail')} />
        </div>
    );
}

/**
 * 对话右边：会话生成的资产文件（**预留**）。
 *
 * 这里现在只有空态 —— agent 侧还没有「资产」这一层（工具产出全在会话流水里）。
 * 先把位置定下来，等有了产出协议（写哪、怎么列）再填内容，省得以后又挪一次布局。
 */
function AssetsAside() {
    return (
        <div className="dock-assets">
            <div className="dock-info-title">会话资产</div>
            <div className="dock-empty">（暂无）</div>
            <p className="dock-hint">
                这一栏留给<b>会话生成的资产文件</b>：代码片段、报告、截图、导出件…
                数据源还没接（agent 侧尚无「资产」协议），位置先定。
            </p>
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
                {DOCK_AREAS.map((id) => (
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
                拖分隔线、收起 / 展开 tab、刷新页面 —— 布局按<b>页实例</b>存在
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
        id: 'detail',
        title: '任务详情',
        // 同样不标 primary：它排在 center 前面，标了就会把激活组抢到详情上。
        placement: { room: { area: 'detail' } },
        render: { kind: 'react', component: DetailAside },
    }),
    defineView({
        id: 'chat',
        title: '对话',
        placement: { room: { area: 'center', primary: true } },
        render: { kind: 'react', component: ChatBody },
    }),
    defineView({
        id: 'assets',
        title: '资产',
        placement: { room: { area: 'assets' } },
        render: { kind: 'react', component: AssetsAside },
    }),
    defineView({
        id: 'lab-notes',
        title: '工作台诊断',
        placement: { room: { area: 'bottom', primary: true } },
        render: { kind: 'react', component: LabNotes },
    }),
];
