// dock-demo.tsx —— workbench-dock 的范例页：一个「任务」页 + 四个 view。
//
// 打开：`./sha.sh lab` 后访问 /dock.html
//
// 演示的 API（全部在下面用到）：
//   definePage / area / row / col   页的区域模板（区域树，不是网格）
//   defineView                      一个 view + 它能进哪个页的哪个区域
//   <PageWorkbench page views scope />          一个 page 实例
//   <PageWorkbench storage={localStorage} />    布局持久化（关掉就每次回模板）
//   <PageWorkbench editable />                  L1：允许拖 view 换区域（缺省 L0）
//   usePageApi()                    在 view 里开关区域 / 最大化 / 关 view / 重置

// dockview 的结构样式（必须）：主题变量在 dock-demo.css 里按暗色覆盖
import 'dockview/dist/styles/dockview.css';
import './dock-demo.css';

import { PageWorkbench, usePageApi } from '@diy-agent/workbench-dock/react';
import { area, col, definePage, defineView, row, type Scope, type ViewProps } from '@diy-agent/workbench-dock';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

// ── 1. 页的核心对象（一个任务）────────────────────────────────────────────────

interface TaskScope extends Scope {
    title: string;
    status: '进行中' | '已完成';
}

// ── 2. 页：区域模板 ──────────────────────────────────────────────────────────
//
//   ┌─────────┬────────────────────┬─────────┐
//   │ 详情    │ 对话（核心）        │ 成员    │  ← 收起
//   ├─────────┴────────────────────┴─────────┤
//   │ 作业                                    │  ← 收起
//   └─────────────────────────────────────────┘
//
// 注意是**树**：底栏要跨三列，只能靠 col([row(...), area('bottom')])。
const taskPage = definePage<TaskScope>({
    type: 'task-run',
    title: (scope) => scope.title,
    icon: '📋',
    areas: col([
        row([
            area('left', { size: 280, min: 200 }),
            area('center', { size: '1fr', min: 380 }),
            area('right', { size: 280, min: 200, initial: 'collapsed' }),
        ]),
        area('bottom', { size: 220, min: 120, initial: 'collapsed' }),
    ]),
});

// ── 3. 四个 view ─────────────────────────────────────────────────────────────

const chatView = defineView<TaskScope>({
    id: 'chat',
    title: '对话',
    placement: { 'task-run': { area: 'center', primary: true } },
    component: function Chat({ scope }: ViewProps<TaskScope>) {
        const api = usePageApi();
        return (
            <div className="wb-view">
                <div className="wb-view-head">
                    <strong>{scope.title}</strong>
                    <span className="wb-tag">{scope.status}</span>
                    <button onClick={() => api.toggleArea('right')}>成员</button>
                    <button onClick={() => api.toggleArea('bottom')}>作业</button>
                    <button onClick={() => api.maximizeArea('center')}>最大化</button>
                </div>
                <div className="wb-view-body">
                    <p className="wb-msg wb-msg-user">把 workbench 拆成独立包，先跑通一个任务页。</p>
                    <p className="wb-msg">
                        中心区是「核心 view」：这个页围绕什么展开，就看它。左右和底栏是附加值 ——
                        成员、作业详情、子任务，各自一个 view，按需展开。
                    </p>
                </div>
                <div className="wb-composer">输入…（示意，不接后端）</div>
            </div>
        );
    },
});

const detailView = defineView<TaskScope>({
    id: 'task.detail',
    title: '详情',
    placement: { 'task-run': { area: 'left' } },
    component: function Detail({ scope }: ViewProps<TaskScope>) {
        const api = usePageApi();
        return (
            <div className="wb-view">
                <dl className="wb-fields">
                    <dt>任务</dt>
                    <dd>{scope.title}</dd>
                    <dt>状态</dt>
                    <dd>{scope.status}</dd>
                    <dt>页实例</dt>
                    <dd>
                        <code>task-run@{scope.kind}:{scope.id}</code>
                    </dd>
                </dl>
                <div className="wb-hint">view 不认识布局：想展开成员就调 api.showArea('right')，不碰 dockview。</div>
                <button onClick={() => api.showArea('right')}>展开成员区</button>
            </div>
        );
    },
});

const membersView = defineView<TaskScope>({
    id: 'room.members',
    title: '成员',
    placement: { 'task-run': { area: 'right' } },
    component: function Members() {
        const api = usePageApi();
        return (
            <div className="wb-view">
                <ul className="wb-list">
                    <li>🙂 ccc（我）</li>
                    <li>🤖 bot:diya</li>
                    <li>🤖 bot:reviewer</li>
                </ul>
                <button onClick={() => api.hideArea('right')}>收起本区域</button>
            </div>
        );
    },
});

const runsView = defineView<TaskScope>({
    id: 'job.runs',
    title: '作业',
    placement: { 'task-run': { area: 'bottom', order: 10 } },
    component: function Runs() {
        const api = usePageApi();
        return (
            <div className="wb-view">
                <table className="wb-table">
                    <thead>
                        <tr>
                            <th>作业</th>
                            <th>状态</th>
                            <th>用时</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>抽包 workbench-dock</td>
                            <td>✅</td>
                            <td>12s</td>
                        </tr>
                        <tr>
                            <td>接入范例页</td>
                            <td>🔄</td>
                            <td>—</td>
                        </tr>
                    </tbody>
                </table>
                <button onClick={() => api.toggleArea('bottom')}>收起作业区</button>
            </div>
        );
    },
});

const views = [chatView, detailView, membersView, runsView];

// ── 4. 外壳：两个任务实例 + L0/L1 开关 ───────────────────────────────────────

const tasks: TaskScope[] = [
    { kind: 'task', id: 't-1', title: 'workbench 抽包', status: '进行中' },
    { kind: 'task', id: 't-2', title: '布局持久化', status: '已完成' },
];

function Demo() {
    const [taskId, setTaskId] = useState('t-1');
    const [editable, setEditable] = useState(false);
    const scope = tasks.find((task) => task.id === taskId)!;

    return (
        <div className="demo-root">
            <header className="demo-head">
                <span className="demo-title">页 / 区域 / 视图</span>
                {tasks.map((task) => (
                    <button
                        key={task.id}
                        className={task.id === taskId ? 'on' : ''}
                        onClick={() => setTaskId(task.id)}
                    >
                        {task.title}
                    </button>
                ))}
                <label className="demo-switch">
                    <input type="checkbox" checked={editable} onChange={(e) => setEditable(e.target.checked)} />
                    L1：允许拖动换区
                </label>
                <span className="demo-note">
                    切换任务 = 换 page 实例（布局各存各的）；拖动分屏线 / 收起区域 / 关 tab 都会被记住
                </span>
            </header>
            <main className="demo-body">
                {/* key = page 实例 id：切任务就是换一个页实例，各自一套布局 */}
                <PageWorkbench
                    key={scope.id}
                    page={taskPage}
                    views={views}
                    scope={scope}
                    storage={localStorage}
                    editable={editable}
                />
            </main>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Demo />
    </StrictMode>,
);
