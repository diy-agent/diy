// main.tsx —— 主入口：工作台（dock）取代原来的整页 `<EntityChatApp />`。
//
// 整页形态没有消失：它还在包里，`sidebar={false} taskPanel={false}` 就是工作台 center
// 里那块；侧栏 / 任务详情 / 资产各归 dock 的 area（见 src/dock/page.tsx）。
// CSS 顺序也由 src/dock/App.tsx 一处维护，这里不再引 —— 两个入口不该各排一份。
//
// 并行 lab 页仍在 /dock.html（src/dock/main.tsx），用来对比工作台与旧整页。

import { bootstrapStore } from '@diy-agent/entity-chat';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DockApp } from './dock/App';

// 地址同步**开着**（缺省值）：主入口是唯一的路由宿主，URL 就是「在看哪个房间」。
//   首屏 `/`               → replaceState 到 /room/<第一个房间>
//   点侧栏 / 页内跳转       → pushState
//   刷新 / 贴链接 / 前进后退 → 落到地址里那个房间（store 的 pickAddress 负责）
bootstrapStore();

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <DockApp />
    </StrictMode>,
);
