// main.tsx —— 主入口：工作台（dock）取代原来的整页 `<EntityChatApp />`。
//
// 整页形态没有消失：它还在包里，`sidebar={false} taskPanel={false}` 就是工作台 center
// 里那块；侧栏 / 任务详情 / 资产各归 dock 的 area（见 src/dock/page.tsx）。
// CSS 顺序也由 src/dock/App.tsx 一处维护，这里不再引 —— 两个入口不该各排一份。
//
// 并行 lab 页仍在 /dock.html（src/dock/main.tsx），用来对比工作台与旧整页。

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DockApp } from './dock/App';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <DockApp />
    </StrictMode>,
);
