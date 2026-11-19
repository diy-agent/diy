// 05-board —— 「任务管理器」这类**集合页**：一个页实例对应一组对象，而不是一个对象。
//
// 三层东西，别混（这是这个例子唯一想讲清的事）：
//
//   ① 导航 / 外壳      归宿主。左边那条 rail、什么时候切页，包一概不知道。
//   ② 管理器内部的三栏   是一个 page：`{ kind: 'board', id: 'all' }` —— scope 的 id 是**集合标识**
//                      （`all` / `mine` / `project:p-1`），不是「当前选中的那条」。
//   ③ 选中项           走 `useShared('selectedTask')`（页内共享状态）。它**不进布局**：
//                      换选中项不会重编译、不会重挂 panel —— 拖过的栏宽还在，view 的挂载号也不变。
//
// 反过来做（把选中项塞进 scope.id）会怎样：`board:all` → `board:t-1` 就是换页实例 =
// 换 key = 换一份布局，用户拖出来的三栏全丢。这就是为什么要有一条共享状态通道。
//
// 另：点 rail 里的 t-1 / t-2 才是「换页」——单任务页和任务管理器是两个 pageType，
// 各自有自己的区域模板和各自的存储键。

import 'dockview/dist/styles/dockview.css';
import './style.css';

import {
    area,
    definePage,
    defineView,
    pageId,
    row,
    type PageDef,
    type Scope,
    type ViewDef,
    type ViewProps,
} from '@diy-agent/workbench-dock';
import { PageWorkbench, useShared } from '@diy-agent/workbench-dock/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

// ── 领域数据（例子写死；真宿主来自后端 / 路由）──────────────────────────────

interface Task {
    id: string;
    title: string;
    state: string;
    owner: string;
}

const TASKS: Task[] = [
    { id: 't-1', title: '抽包 workbench', state: '进行中', owner: 'ccc' },
    { id: 't-2', title: '布局持久化', state: '待办', owner: 'ccc' },
    { id: 't-3', title: '任务管理器', state: '进行中', owner: 'lin' },
    { id: 't-4', title: '旧包退役', state: '完成', owner: 'lin' },
];

/** 共享状态的 key 和缺省值：提成模块常量 —— 内联对象/每次新建的引用会让快照一直「变」 */
const SELECTED = 'selectedTask';
const FIRST_TASK = TASKS[0]!.id;

// ── ① 页模板：管理器页是「集合页」，scope.id 是集合标识 ─────────────────────

const boardPage = definePage({
    type: 'board',
    title: (scope) => scope.title ?? '任务管理器',
    icon: '🗂',
    // 三栏：列表（固定 280）/ 详情（吃剩下的）/ 属性（默认收起，展开时 260）
    areas: row([
        area('list', { size: 280, min: 200 }),
        area('detail', { size: '1fr', min: 360 }),
        area('props', { size: 260, min: 180, initial: 'collapsed' }),
    ]),
});

// ── ③ 三个 view：靠 useShared 联动，谁也不认识谁 ───────────────────────────

const boardList = defineView({
    id: 'board.list',
    title: '列表',
    placement: { board: { area: 'list', primary: true } },
    render: {
        kind: 'react',
        component: function BoardList({ api }: ViewProps) {
            const [selected, setSelected] = useShared<string>(SELECTED, FIRST_TASK);
            return (
                <div className="wb-view">
                    <div className="wb-view-head">
                        <strong>任务列表</strong>
                        <span className="wb-tag">{TASKS.length}</span>
                        <button className="wb-btn" onClick={() => api.toggleArea('props')}>
                            属性栏
                        </button>
                    </div>
                    <ul className="wb-list">
                        {TASKS.map((task) => (
                            <li key={task.id}>
                                <button
                                    className={`wb-row ${task.id === selected ? 'on' : ''}`}
                                    onClick={() => setSelected(task.id)}
                                >
                                    <span className="wb-row-title">{task.title}</span>
                                    <span className="wb-state">{task.state}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    <div className="wb-hint">
                        点一条只写 <code>{SELECTED}</code>：布局不重编，右栏拖过的宽度和详情 view 的挂载号都不变。
                    </div>
                </div>
            );
        },
    },
});

/** 挂载计数：选中的 task 变了这个号**不该**变 —— 变了就说明 panel 被重挂了 */
let detailMounts = 0;

const boardDetail = defineView({
    id: 'board.detail',
    title: '详情',
    placement: { board: { area: 'detail', primary: true } },
    render: {
        kind: 'react',
        component: function BoardDetail() {
            const [selected] = useShared<string>(SELECTED, FIRST_TASK);
            const [mount] = useState(() => ++detailMounts);
            const task = TASKS.find((candidate) => candidate.id === selected) ?? TASKS[0]!;
            return (
                <div className="wb-view">
                    <div className="wb-view-head">
                        <strong>{task.title}</strong>
                        <span className="wb-tag">{task.state}</span>
                    </div>
                    <dl className="wb-fields">
                        <dt>任务</dt>
                        <dd>
                            <code>{task.id}</code>
                        </dd>
                        <dt>负责人</dt>
                        <dd>{task.owner}</dd>
                        <dt>页实例</dt>
                        <dd>
                            <code>board@board:all</code>
                        </dd>
                    </dl>
                    <div className="wb-hint">
                        本 view 挂载 #<b>{mount}</b> —— 换选中项只重渲染，不重挂。
                    </div>
                    <div className="wb-hint">
                        注意「页实例」一直没变：选中的是<b>这一页里的哪条数据</b>，不是「打开了哪一页」。
                    </div>
                </div>
            );
        },
    },
});

const boardProps = defineView({
    id: 'board.props',
    title: '属性',
    placement: { board: { area: 'props' } },
    render: {
        kind: 'react',
        component: function BoardProps({ api }: ViewProps) {
            const [selected, setSelected] = useShared<string>(SELECTED, FIRST_TASK);
            return (
                <div className="wb-view">
                    <div className="wb-view-head">
                        <strong>共享状态</strong>
                    </div>
                    <dl className="wb-fields">
                        <dt>key</dt>
                        <dd>
                            <code>{SELECTED}</code>
                        </dd>
                        <dt>值</dt>
                        <dd>
                            <code>{selected}</code>
                        </dd>
                    </dl>
                    <div className="wb-hint">
                        同一页里所有 view 都读得到它；<b>它不落盘</b> —— 刷新 / 换页回来是缺省值，而布局还在。
                    </div>
                    <button className="wb-btn" onClick={() => setSelected(FIRST_TASK)}>
                        重置选中
                    </button>
                    <button className="wb-btn" onClick={() => api.hideArea('props')}>
                        收起本栏
                    </button>
                </div>
            );
        },
    },
});

// ── 单任务页：和 02-pages 同一个形状，用来对比「集合页 ↔ 单对象页」────────────

const taskPage = definePage({
    type: 'task',
    title: (scope) => scope.title ?? '任务',
    icon: '📋',
    areas: row([area('left', { size: 320, min: 220 }), area('center', { size: '1fr', min: 320 })]),
});

const taskDetail = defineView({
    id: 'task.detail',
    title: '详情',
    placement: { task: { area: 'left', primary: true } },
    render: {
        kind: 'react',
        component: ({ scope, page }: ViewProps) => (
            <div className="wb-view">
                <strong>{scope.title}</strong>
                <dl className="wb-fields">
                    <dt>页实例</dt>
                    <dd>
                        <code>{page.id}</code>
                    </dd>
                    <dt>scope</dt>
                    <dd>
                        <code>
                            {scope.kind}:{scope.id}
                        </code>
                    </dd>
                </dl>
                <div className="wb-hint">这一页的 scope.id 是单个任务 —— 和任务管理器是两个 pageType。</div>
            </div>
        ),
    },
});

const taskChat = defineView({
    id: 'task.chat',
    title: '对话',
    placement: { task: { area: 'center', primary: true } },
    render: {
        kind: 'react',
        component: ({ scope }: ViewProps) => (
            <div className="wb-view">
                <div className="wb-view-body">
                    <p className="wb-msg wb-msg-user">把这条分屏线拖到 1:2，再回任务管理器点另一条。</p>
                    <p className="wb-msg">
                        再点回 <b>{scope.title}</b>，比例还在 —— 布局是按<b>页实例</b>存的，和「管理器里选中了谁」无关。
                    </p>
                </div>
                <div className="wb-composer">输入…（示意，不接后端）</div>
            </div>
        ),
    },
});

const boardViews = [boardList, boardDetail, boardProps];
const taskViews = [taskDetail, taskChat];

// ── ② 宿主：有哪些页实例、当前开哪个 ────────────────────────────────────────

const boardScope: Scope = { kind: 'board', id: 'all', title: '任务管理器' };

interface Screen {
    label: string;
    hint: string;
    page: PageDef;
    views: ViewDef[];
    scope: Scope;
}

const screens: Screen[] = [
    { label: '任务管理器', hint: '一个页实例管一组任务', page: boardPage, views: boardViews, scope: boardScope },
    {
        label: 't-1 抽包 workbench',
        hint: '单任务页 · 另一份布局',
        page: taskPage,
        views: taskViews,
        scope: { kind: 'task', id: 't-1', title: '抽包 workbench' },
    },
    {
        label: 't-2 布局持久化',
        hint: '单任务页 · 另一份布局',
        page: taskPage,
        views: taskViews,
        scope: { kind: 'task', id: 't-2', title: '布局持久化' },
    },
];

function App() {
    const [at, setAt] = useState(0);
    const screen = screens[at]!;
    // 同一个表达式既是 rail 的选中判断，也是 <PageWorkbench> 的 key
    const currentId = pageId(screen.page.type, screen.scope);

    return (
        <div className="demo-root">
            <header className="demo-head">
                <span className="demo-title">05 · 管理器页</span>
                <span className="demo-note">
                    当前页实例：<code>{currentId}</code>
                </span>
            </header>
            <div className="demo-shell">
                <nav className="rail">
                    <div className="rail-group">页</div>
                    {screens.map((entry, index) => {
                        const id = pageId(entry.page.type, entry.scope);
                        return (
                            <button
                                key={id}
                                className={`rail-item ${index === at ? 'on' : ''}`}
                                onClick={() => setAt(index)}
                            >
                                <span>{entry.label}</span>
                                <span className="rail-sub">{entry.hint}</span>
                            </button>
                        );
                    })}
                    <div className="rail-foot">
                        管理器内部的列表是<b>布局里的 view</b>（能拖、能收），外面这条 rail 是<b>宿主 UI</b>
                        （包不认识）。
                    </div>
                </nav>
                <main className="demo-body">
                    {/* key = 页实例 id：换页 = 换组件实例 = 换一份独立布局（也换一份共享状态） */}
                    <PageWorkbench
                        key={currentId}
                        page={screen.page}
                        views={screen.views}
                        scope={screen.scope}
                        storage={localStorage}
                    />
                </main>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
