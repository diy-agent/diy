// main.tsx —— lab 页入口（`/dock.html`）：只负责挂载 DockApp。
//
// 主入口 `/`（src/main.tsx）挂的是**同一个组件**；这里留着是为了「工作台 vs 旧整页」
// 还能并排对比，也方便只构建工作台的产物。

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DockApp } from './App';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <DockApp />
    </StrictMode>,
);
