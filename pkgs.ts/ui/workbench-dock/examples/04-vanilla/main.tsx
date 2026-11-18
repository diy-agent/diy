// 04-vanilla —— 同一个页里，一个 React view + 一个手写 DOM 的 view。
//
// 一个点：**render.kind 是显式取舍，不是静默降级。**
//
//   kind: 'react'    component                        宿主渲染，hooks / Provider 随便用
//   kind: 'vanilla'  create(props) → { element, update, dispose }
//                                                     自己造 DOM，宿主只做这三件事
//
// vanilla view 拿到的东西和 React view **完全一样**（scope / page / areaId / api），
// 少的只是框架。什么时候值得：已有非 React 的渲染器（canvas / 编辑器 / 一段老代码）。
//
// 代价（包不打算用 adapter 去救）：
//   · 子树里拿不到 usePage()，props 得自己往下传
//   · 没有错误边界 / Suspense，失败态自己画

import 'dockview/dist/styles/dockview.css';
import './style.css';

import { area, definePage, defineView, row, type Scope, type ViewProps } from '@diy-agent/workbench-dock';
import { PageWorkbench } from '@diy-agent/workbench-dock/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const taskPage = definePage({
    type: 'task',
    title: '混用两种渲染',
    icon: '📋',
    areas: row([area('center', { size: '1fr', min: 320 }), area('right', { size: 300, min: 220 })]),
});

// ── React view：正常写 ──────────────────────────────────────────────────────
const chatView = defineView({
    id: 'chat',
    title: '对话（React）',
    placement: { task: { area: 'center', primary: true } },
    render: {
        kind: 'react',
        component: ({ scope }: ViewProps) => (
            <div className="wb-view">
                <div className="wb-view-head">
                    <strong>{scope.title}</strong>
                    <span className="wb-tag">react</span>
                </div>
                <p className="wb-msg">
                    右边那个 view 一行 React 都没有，但它在这个页里和这个 view 地位完全一样： 同一个区域树、同一套
                    frame、同一个 api。
                </p>
                <p className="wb-msg wb-msg-user">
                    切「动态」tab 看看它的 create 计数 —— 拖 tab 换区，计数不变 = DOM 被移动。
                </p>
            </div>
        ),
    },
});

// ── vanilla view：create 一次，props 变了 update，销毁 dispose ──────────────
/** 累计 create 次数：每次 panel 被重建就 +1，被移动则不变 */
let created = 0;

const activityView = defineView({
    id: 'activity',
    title: '动态（手写 DOM）',
    placement: { task: { area: 'right', primary: true } },
    render: {
        kind: 'vanilla',
        create(props) {
            const mount = (created += 1);
            // props 会变（切 scope / 重渲染），所以回调里读最新的，别捕获首次的那份
            let latest = props;
            let updates = 0;

            const root = document.createElement('div');
            root.className = 'wb-view';

            const head = document.createElement('div');
            head.className = 'wb-view-head';
            const title = document.createElement('strong');
            const badge = document.createElement('span');
            badge.className = 'wb-tag';
            badge.textContent = `create #${mount}`;
            head.append(title, badge);

            const hint = document.createElement('div');
            hint.className = 'wb-hint';

            const button = document.createElement('button');
            button.textContent = '收起本区域';
            const onClick = (): void => latest.api.hideArea('right');
            button.addEventListener('click', onClick);

            root.append(head, hint, button);

            const paint = (next: ViewProps): void => {
                title.textContent = `动态 · ${next.scope.title}`;
                hint.textContent = `区域 ${next.areaId} · update ${updates} 次`;
            };
            // create 之后宿主不会立刻调 update，所以首屏自己画
            paint(props);

            return {
                element: root,
                update(next) {
                    latest = next;
                    updates += 1;
                    paint(next);
                },
                // 必须幂等：StrictMode 会 mount → unmount → mount，每次都真的调到这里
                dispose() {
                    button.removeEventListener('click', onClick);
                },
            };
        },
    },
});

const views = [chatView, activityView];
const scope: Scope = { kind: 'task', id: 't-1', title: '混用两种渲染' };

function App() {
    return (
        <div className="demo-root">
            <header className="demo-head">
                <span className="demo-title">04 · 非 React view</span>
                <span className="demo-note">dev 下 StrictMode 会把首次 create 主动丢一次（计数 +2），生产不会</span>
            </header>
            <main className="demo-body">
                <PageWorkbench page={taskPage} views={views} scope={scope} storage={localStorage} editable />
            </main>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
