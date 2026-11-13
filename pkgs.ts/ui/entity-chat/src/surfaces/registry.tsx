// surfaces/registry.tsx —— 表面注册表：shell 只认这个数组，不写 if (tab === …)。

import type { FC } from 'react';

import { ChatPanel } from '../components/ChatPanel';

export interface ChatSurface {
    id: string;
    name: string;
    hint: string;
    Component: FC<{ targetId: string }>;
}

function ComingSoon({ name }: { name: string }) {
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            {name} 表面待接入（下一刀：用 Astryx 的 Chat* 组件 + chat-core 同一 model）
        </div>
    );
}

export const SURFACES: ChatSurface[] = [
    { id: 'assistant-ui', name: 'assistant-ui', hint: '官方模板 + runtime', Component: ChatPanel },
    { id: 'astryx', name: 'Astryx', hint: '设计系统 Chat 组件（待接入）', Component: () => <ComingSoon name="Astryx" /> },
];
