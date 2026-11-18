// 01-basic —— 最小可用：一个页，三个 view。
//
// 这个例子只说一件事：**页是区域树，view 声明自己落哪个区域；用户的改动会被记住。**
//
//   page  areas: col([ row([center, right]), bottom ])   ← 树，不是网格
//   view  placement: { task: { area: 'center', primary: true } }   ← view 认识页，页不认识 view
//   <PageWorkbench /> 做四件事：编译布局 → 灌 dockview → 存盘 → 把 api 递给 view
//
// 试这几步：拖分屏线、点「成员」展开右区、关掉一个 tab —— 然后刷新，都还在。

import 'dockview/dist/styles/dockview.css';
import './style.css';

import { area, col, definePage, defineView, row, type Scope, type ViewProps } from '@diy-agent/workbench-dock';
import { PageWorkbench } from '@diy-agent/workbench-dock/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

// ── 页：一棵区域树。底栏要横跨两列，所以它必须是 col 的第二个孩子 ────────────
const taskPage = definePage({
    type: 'task',
    title: '布局示例',
    icon: '📋',
    areas: col([
        row([area('center', { size: '1fr', min: 320 }), area('right', { size: 260, initial: 'collapsed' })]),
        area('bottom', { size: 150, initial: 'collapsed' }),
    ]),
});

// ── view：只声明「我能进哪个页的哪个区域」，一行 dockview 代码都没有 ─────────
const chatView = defineView({
    id: 'chat',
    title: '对话',
    placement: { task: { area: 'center', primary: true } },
    render: {
        kind: 'react',
        // api 从 props 拿（深层子组件才需要 usePageApi()）
        component: ({ scope, api }: ViewProps) => (
            <div className="wb-view">
                <div className="wb-view-head">
                    <strong>{scope.title}</strong>
                    <button onClick={() => api.toggleArea('right')}>成员</button>
                    <button onClick={() => api.toggleArea('bottom')}>作业</button>
                </div>
                <div className="wb-view-body">
                    <p className="wb-msg wb-msg-user">中心区是核心 view：这个页围绕什么展开就看它。</p>
                    <p className="wb-msg">右区和底栏初始是收起的 —— 点上面两个按钮展开，开合状态也会被记住。</p>
                </div>
                <div className="wb-composer">输入…（示意，不接后端）</div>
            </div>
        ),
    },
});

const membersView = defineView({
    id: 'members',
    title: '成员',
    placement: { task: { area: 'right' } },
    render: {
        kind: 'react',
        component: ({ api }: ViewProps) => (
            <div className="wb-view">
                <ul className="wb-list">
                    <li>🙂 ccc</li>
                    <li>🤖 bot:diya</li>
                </ul>
                <button onClick={() => api.hideArea('right')}>收起本区域</button>
            </div>
        ),
    },
});

const runsView = defineView({
    id: 'runs',
    title: '作业',
    placement: { task: { area: 'bottom' } },
    render: {
        kind: 'react',
        component: () => (
            <div className="wb-view">
                <table className="wb-table">
                    <tbody>
                        <tr>
                            <td>抽包 workbench-dock</td>
                            <td>✅</td>
                        </tr>
                        <tr>
                            <td>写四个例子</td>
                            <td>🚧</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        ),
    },
});

const views = [chatView, membersView, runsView];

// ── 渲染：一个页实例 = 一个 <PageWorkbench> ────────────────────────────────
const scope: Scope = { kind: 'task', id: 't-1', title: '布局示例' };

function App() {
    // L0（缺省）= 结构锁死：只能拖分屏线 + 收起/展开 + 开关 tab
    // L1 = 还允许把 tab 拖到别的区域
    const [editable, setEditable] = useState(false);

    return (
        <div className="demo-root">
            <header className="demo-head">
                <span className="demo-title">01 · 一个页实例</span>
                <label className="demo-switch">
                    <input type="checkbox" checked={editable} onChange={(e) => setEditable(e.target.checked)} />
                    L1：允许拖动换区
                </label>
                <span className="demo-note">布局改动会存进 localStorage，刷新还在</span>
            </header>
            <main className="demo-body">
                <PageWorkbench page={taskPage} views={views} scope={scope} storage={localStorage} editable={editable} />
            </main>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
