import { EntityChatApp } from '@diy-agent/entity-chat';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <EntityChatApp />
    </StrictMode>,
);
