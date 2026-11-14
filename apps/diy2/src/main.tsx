import { EntityChatApp } from '@diy-agent/entity-chat';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// 顺序很重要：Astryx 的 CSS 用 @layer reset/astryx-base/astryx-theme，
// 层顺序由**首次声明**决定。Tailwind 的 preflight 会重置标题字号、清掉表格边框
// （border-width: 0），如果它排在 Astryx 之后，Astryx 的排版就被压掉了。
// 先加载 Tailwind，再加载 Astryx ⇒ Astryx 的层排在后面，优先级更高。
import './index.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';

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
