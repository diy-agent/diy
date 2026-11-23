// views.tsx —— 两个页模板 + 全部视图（**宿主侧装配**）。
//
// 骨架差别只有一处：任务页多一个 detail 区。这就够演示「按页类型各存一份偏好」了。

import {
    EntityChatApp,
    Sidebar,
    TaskPanel,
    useBots,
    useRoomDialogsContext,
    useSelectedRoom,
    roomTitle,
    type Room,
} from '@diy-agent/entity-chat';
import { area, col, definePage, defineView, row } from './model';
import { useWb } from './AreaHost';

// ── 页模板：位置与尺寸写死，用户改不了 ──────────────────────────────────────────
//
// `modes: ['tab']` = 这个区域锁定标签页（不给切换按钮）；不写 = 三种形态都允许。

const nav = () => area('nav', { title: '导航', size: 240, min: 180, modes: ['tab'] });
const center = () => area('center', { title: '对话', size: 'fr', min: 420 });
const side = () => area('side', { title: '产出', size: 340, min: 240, mode: 'tab' });
const bottom = () => area('bottom', { title: '诊断', size: 200, min: 120, initial: 'collapsed' });

export const taskPage = definePage({
    type: 'task',
    title: '任务',
    layout: col(
        row(nav(), area('detail', { title: '任务详情', size: 320, min: 240, modes: ['tab'] }), center(), side()),
        bottom(),
    ),
});

export const projectPage = definePage({
    type: 'project',
    title: '项目',
    // 项目页没有 detail 区 —— 项目没有「任务面板」这种背景材料
    layout: col(row(nav(), center(), side()), bottom()),
});

export function pageFor(type: string) {
    return type === 'project' ? projectPage : taskPage;
}

// ── 视图 ────────────────────────────────────────────────────────────────────────

function NavAside() {
    const dialogs = useRoomDialogsContext();
    const api = useWb();
    return (
        <Sidebar
            open
            widthMode="fill"
            onToggle={() => {
                api.toggleArea('nav');
            }}
            onCreateProject={dialogs.openProject}
            onCreateTask={dialogs.openTask}
            onRequestDelete={dialogs.requestDelete}
            onOpenSettings={dialogs.openSettings}
        />
    );
}

function ChatBody() {
    return (
        <div className="wb-chat">
            <EntityChatApp sidebar={false} taskPanel={false} />
        </div>
    );
}

function TaskDetail() {
    const room = useSelectedRoom();
    const api = useWb();
    if (!room) return <Empty>没有选中房间</Empty>;
    return (
        <div className="wb-fill">
            <TaskPanel
                room={room}
                onClose={() => {
                    api.toggleArea('detail');
                }}
            />
        </div>
    );
}

function ProjectDetail() {
    const room = useSelectedRoom();
    if (!room) return <Empty>没有选中房间</Empty>;
    const data = Object.entries(room.data ?? {});
    return (
        <div className="wb-info">
            <div className="wb-info-title">项目信息</div>
            <dl>
                <dt>id</dt>
                <dd>{room.id}</dd>
                {data.map(([key, value]) => (
                    <div key={key} className="wb-info-row">
                        <dt>{key}</dt>
                        <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

function Empty({ children }: { children: string }) {
    return <div className="wb-empty">{children}</div>;
}

/**
 * 下面五个是**演示视图** —— 它们存在的意义是让「一个区域里有多个 view」这件事能看见。
 * 真接数据时它们会被真的资产 / 变更记录 / 备注面板替掉。
 */
function DemoAssets() {
    return (
        <div className="wb-demo">
            <div className="wb-demo-title">会话产出的文件</div>
            <ul>
                <li>未接数据源 —— 先把位置和形态定下来</li>
                <li>接上以后：代码片段 / 报告 / 截图 / 导出件</li>
            </ul>
        </div>
    );
}

function DemoChanges() {
    return (
        <div className="wb-demo">
            <div className="wb-demo-title">本房间的变更</div>
            <ul>
                <li>10:02 创建任务</li>
                <li>10:31 改了 data.title</li>
                <li>11:04 添加备注</li>
            </ul>
        </div>
    );
}

function DemoNotes() {
    const room = useSelectedRoom();
    return (
        <div className="wb-demo">
            <div className="wb-demo-title">备注</div>
            <p>这是同一个区域里的第三个 view：它和第两个共享这块地方，靠形态切换决定怎么摊开。</p>
            <p className="wb-dim">当前房间：{room?.id ?? '—'}</p>
        </div>
    );
}

function DemoDiag() {
    const api = useWb();
    const room = useSelectedRoom();
    return (
        <div className="wb-demo">
            <div className="wb-demo-title">工作台诊断</div>
            <dl className="wb-kv">
                <dt>页类型</dt>
                <dd>{api.page.type}</dd>
                <dt>房间</dt>
                <dd>{room?.id ?? '—'}</dd>
                <dt>存储键</dt>
                <dd>
                    <code>wb2:{api.page.type}</code>
                </dd>
            </dl>
            <p className="wb-dim">区域的开合、形态、选中的 tab 存在这个键里。尺寸与位置不在里面 —— 它们由模板写死。</p>
        </div>
    );
}

function DemoLog() {
    return (
        <div className="wb-demo">
            <div className="wb-demo-title">日志</div>
            <pre className="wb-log">{`--:--:-- 视图形态切换是纯客户端行为
--:--:-- 没有布局引擎参与
--:--:-- 所以切形态不会引发布局重排的连锁`}</pre>
        </div>
    );
}

export const wbViews = [
    defineView({
        id: 'nav',
        title: '导航',
        placement: { task: { area: 'nav' }, project: { area: 'nav' } },
        render: () => <NavAside />,
    }),
    defineView({
        id: 'task-detail',
        title: '任务详情',
        placement: { task: { area: 'detail' } },
        render: () => <TaskDetail />,
    }),
    defineView({
        id: 'project-detail',
        title: '项目详情',
        placement: { project: { area: 'detail' } },
        render: () => <ProjectDetail />,
    }),
    defineView({
        id: 'chat',
        title: '对话',
        placement: { task: { area: 'center' }, project: { area: 'center' } },
        render: () => <ChatBody />,
    }),
    defineView({
        id: 'assets',
        title: '资产',
        placement: { task: { area: 'side' }, project: { area: 'side' } },
        render: () => <DemoAssets />,
    }),
    defineView({
        id: 'changes',
        title: '变更',
        placement: { task: { area: 'side' }, project: { area: 'side' } },
        render: () => <DemoChanges />,
    }),
    defineView({
        id: 'notes',
        title: '备注',
        placement: { task: { area: 'side' }, project: { area: 'side' } },
        render: () => <DemoNotes />,
    }),
    defineView({
        id: 'diag',
        title: '诊断',
        placement: { task: { area: 'bottom' }, project: { area: 'bottom' } },
        render: () => <DemoDiag />,
    }),
    defineView({
        id: 'log',
        title: '日志',
        placement: { task: { area: 'bottom' }, project: { area: 'bottom' } },
        render: () => <DemoLog />,
    }),
];

/** 页标题（房间名），给页外那条 bar 用 */
export function usePageTitle(): string {
    const room: Room | undefined = useSelectedRoom();
    const bots = useBots();
    return room === undefined ? '' : roomTitle(room, bots);
}
