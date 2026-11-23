// main.tsx —— 原型入口（`/wb2.html`）：只负责挂载 Wb2App。

import { bootstrapStore } from '@diy-agent/entity-chat';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Wb2App } from './App';

// 与 lab 页同一条理由：/wb2.html 不能被改写成 /room/xxx，否则刷新就掉进主入口。
bootstrapStore({ syncAddress: false });

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Wb2App />
    </StrictMode>,
);
