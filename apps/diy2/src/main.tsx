// main.tsx —— 主入口：工作台（固定骨架 + 区域内可配形态）取代原来的整页 `<EntityChatApp />`。
//
// 整页形态没有消失：它还在包里，`sidebar={false} taskPanel={false}` 就是工作台 center
// 里那块。导航 / 详情 / 资产各归自己的区域（见 src/workbench/pages.tsx）。
//
// CSS 顺序由 src/workbench/App.tsx 一处维护，这里不再引 —— 入口不该各排一份。

import { MockChatClient } from '@diy-agent/chat-core';
import { bootstrapStore, setDiy2Client } from '@diy-agent/entity-chat';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { WorkbenchApp } from './workbench/App';
import { MigrationScreen } from './workbench/MigrationScreen';

// 地址同步**开着**（缺省值）：主入口是唯一的路由宿主，URL 就是「在看哪个房间」。
//   首屏 `/`               → replaceState 到 /room/<第一个房间>
//   点侧栏 / 页内跳转       → pushState
//   刷新 / 贴链接 / 前进后退 → 落到地址里那个房间（store 的 pickAddress 负责）
bootstrapStore();

// dev 专用：`?mock=1` 时把传输换成内存实现 —— 无后端、无模型也能看见工具行 /
// 作业卡片 / 待答卡 / 错误条（它们不来自文本，真实模型不便宜也不可控）。
// 生产构建里 `import.meta.env.DEV` 为 false，整段被摇掉。
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    void import('./dev-mock').then(({ MOCK_ASK, MOCK_SEED, MOCK_SCRIPT }) => {
        setDiy2Client(
            new MockChatClient({ seed: [...MOCK_SEED, { kind: 'ask', request: MOCK_ASK }], script: MOCK_SCRIPT }),
        );
    });
}

/**
 * 入口闸门：库还没迁完时，服务端装配的是「迁移态」app —— 这时候渲染迁移屏，不渲染工作台。
 *
 * 必须先问一次再渲染：工作台一挂载就会拉 rooms/bots/models，库没迁完那些请求全是错的
 * （历史上就是「一开主界面就糊屏」）。
 */
function Root(): React.JSX.Element | null {
    const [mode, setMode] = useState<'loading' | 'migrate' | 'ready'>('loading');

    useEffect(() => {
        if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
            setMode('ready');
            return;
        }
        void fetch('/api/migrate/state')
            .then((response) => (response.ok ? (response.json() as Promise<{ mode?: string }>) : { mode: 'ready' }))
            .then((state) => setMode(state.mode === 'migrate' ? 'migrate' : 'ready'))
            .catch(() => setMode('ready'));
    }, []);

    if (mode === 'loading') return null;
    if (mode === 'migrate') return <MigrationScreen />;
    return <WorkbenchApp />;
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Root />
    </StrictMode>,
);
