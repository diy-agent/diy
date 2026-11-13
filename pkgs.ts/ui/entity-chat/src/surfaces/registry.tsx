// surfaces/registry.tsx —— 表面注册表：shell 只认这个数组，不写 if (tab === …)。

import type { FC } from 'react';

import { ChatPanel } from '../components/ChatPanel';
import { AstryxSurface } from './astryx/Surface';

export interface ChatSurface {
    id: string;
    name: string;
    hint: string;
    Component: FC<{ targetId: string }>;
}

export const SURFACES: ChatSurface[] = [
    { id: 'assistant-ui', name: 'assistant-ui', hint: '官方模板 + runtime', Component: ChatPanel },
    { id: 'astryx', name: 'Astryx', hint: '设计系统 Chat 组件 + chat-core', Component: AstryxSurface },
];
