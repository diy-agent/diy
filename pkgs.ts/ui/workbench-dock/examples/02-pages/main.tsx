// 02-pages —— 同一份页模板开两份实例，切着看。
//
// 一个点：**包只管「一个 page 的布局」；「有几个页、怎么切」是宿主的事。**
// 所以左边这条 rail 是例子代码（十来行 JSX），不是包里的 <PageShell> ——
// 宿主想用顶栏页签 / 命令面板 / 从对话里开新页，都是它的自由，包不该替它定死。
//
//   页实例身份 = pageId(page.type, scope)   →   'task@task:t-1'（也是布局存储键）
//   切页 = 换 <PageWorkbench> 的 key。**key 必须有**：不带 key 就是在同一个组件实例上
//          换 props，dockview 会试图「合并」两份布局 —— 结果不是你要的。
//
// 真宿主会把当前页写进 URL（hash / 路由），刷新和分享链接就都对了；例子不掺这一层。

import 'dockview/dist/styles/dockview.css';
import './style.css';

import { area, definePage, defineView, pageId, row, type Scope, type ViewProps } from '@diy-agent/workbench-dock';
import { PageWorkbench } from '@diy-agent/workbench-dock/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

// ── 一份模板：title 可以读 scope，于是每个实例的 tab 标题各是各的 ────────────
const taskPage = definePage({
    type: 'task',
    title: (scope) => scope.title ?? '任务',
    icon: '📋',
    areas: row([area('left', { size: 220, min: 160 }), area('center', { size: '1fr', min: 320 })]),
});

// ── 两个 view：左边的负责显示「我在哪个实例」，中间的负责说明怎么试 ──────────
const detailView = defineView({
    id: 'detail',
    title: '详情',
    placement: { task: { area: 'left', primary: true } },
    render: {
        kind: 'react',
        component: ({ page, scope }: ViewProps) => (
            <div className="wb-view">
                <strong>{scope.title}</strong>
                <dl className="wb-fields">
                    <dt>页实例</dt>
                    <dd>
                        <code>{page.id}</code>
                    </dd>
                </dl>
                <div className="wb-hint">这个 id 由 (页类型, scope) 决定，不是随机数。</div>
            </div>
        ),
    },
});

const chatView = defineView({
    id: 'chat',
    title: '对话',
    placement: { task: { area: 'center', primary: true } },
    render: {
        kind: 'react',
        component: ({ scope }: ViewProps) => (
            <div className="wb-view">
                <div className="wb-view-head">
                    <strong>{scope.title}</strong>
                    <span className="wb-tag">{scope.id}</span>
                </div>
                <div className="wb-view-body">
                    <p className="wb-msg wb-msg-user">把左区的「详情」拖宽一点，再切到另一个任务。</p>
                    <p className="wb-msg">
                        切回来宽度还在 —— 布局是按 <b>页实例</b> 存的，同一个模板开两份就是两份布局。
                    </p>
                </div>
                <div className="wb-composer">输入…（示意，不接后端）</div>
            </div>
        ),
    },
});

const views = [detailView, chatView];

// ── 宿主这边：有哪些实例（例子写死，真宿主来自路由 / 会话 / 后端列表）────────
const scopes: Scope[] = [
    { kind: 'task', id: 't-1', title: '抽包 workbench' },
    { kind: 'task', id: 't-2', title: '布局持久化' },
];

function App() {
    const [current, setCurrent] = useState<Scope>(scopes[0]!);
    // 同一个表达式既当 rail 的选中判断、又当 <PageWorkbench> 的 key
    const currentId = pageId(taskPage.type, current);

    return (
        <div className="demo-root">
            <header className="demo-head">
                <span className="demo-title">02 · 多页实例</span>
                <span className="demo-note">
                    当前：<code>{currentId}</code>
                </span>
            </header>
            <div className="demo-shell">
                <nav className="rail">
                    <div className="rail-group">任务</div>
                    {scopes.map((scope) => {
                        const id = pageId(taskPage.type, scope);
                        return (
                            <button
                                key={id}
                                className={`rail-item ${id === currentId ? 'on' : ''}`}
                                onClick={() => setCurrent(scope)}
                            >
                                <span>{scope.title}</span>
                            </button>
                        );
                    })}
                    <div className="rail-foot">rail 是宿主代码：包不知道「导航」这个概念。</div>
                </nav>
                <main className="demo-body">
                    {/* key = 页实例 id：换页 = 换组件实例 = 换一份独立布局 */}
                    <PageWorkbench
                        key={currentId}
                        page={taskPage}
                        views={views}
                        scope={current}
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
