import { EntityChatApp } from '@diy-agent/entity-chat';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {/*
         * Astryx 需要 Theme provider：它负责设 data-theme（驱动 color-scheme / light-dark()）
         * 和 data-astryx-theme（@scope 组件覆盖）。没有它，组件会用 light 色板渲染在暗色壳上。
         * mode="dark"：本应用是暗色；LayerProvider 给 portal / toast 提供层级上下文。
         */}
        <Theme theme={neutralTheme} mode="dark">
            <LayerProvider>
                <EntityChatApp />
            </LayerProvider>
        </Theme>
    </StrictMode>,
);
