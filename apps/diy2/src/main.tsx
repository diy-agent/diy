// main.tsx —— 主入口：工作台（固定骨架 + 区域内可配形态）取代原来的整页 `<EntityChatApp />`。
//
// 整页形态没有消失：它还在包里，`sidebar={false} taskPanel={false}` 就是工作台 center
// 里那块。导航 / 详情 / 资产各归自己的区域（见 src/workbench/pages.tsx）。
//
// CSS 顺序由 src/workbench/App.tsx 一处维护，这里不再引 —— 入口不该各排一份。
//
// 并行 lab 页仍在 /dock.html（src/dock/main.tsx，dockview 版）：留着对照，等新模型
// 稳定后删。

import { bootstrapStore } from '@diy-agent/entity-chat';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { WorkbenchApp } from './workbench/App';

// 地址同步**开着**（缺省值）：主入口是唯一的路由宿主，URL 就是「在看哪个房间」。
//   首屏 `/`               → replaceState 到 /room/<第一个房间>
//   点侧栏 / 页内跳转       → pushState
//   刷新 / 贴链接 / 前进后退 → 落到地址里那个房间（store 的 pickAddress 负责）
bootstrapStore();

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <WorkbenchApp />
    </StrictMode>,
);
