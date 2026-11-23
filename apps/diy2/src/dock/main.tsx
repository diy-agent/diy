// main.tsx —— lab 页入口（`/dock.html`）：只负责挂载 DockApp。
//
// 主入口 `/`（src/main.tsx）挂的是**同一个组件**；这里留着是为了「工作台 vs 旧整页」
// 还能并排对比，也方便只构建工作台的产物。

import { bootstrapStore } from '@diy-agent/entity-chat';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DockApp } from './App';

// 地址同步**关掉**：lab 页挂在 /dock.html 上，store 一旦 replaceState 就变成 /room/xxx ——
// 刷新那次就落到主入口去了（这个壳只在 lab 里存在）。主入口那边是开着的，见 src/main.tsx。
bootstrapStore({ syncAddress: false });

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <DockApp />
    </StrictMode>,
);
