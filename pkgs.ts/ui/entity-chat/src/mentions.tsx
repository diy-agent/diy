// mentions.tsx —— 给官方 Thread 里的 Composer 提供「本容器可 @ 的 bot」列表。
//
// 为什么用 context：thread.aui.tsx 是官方模板代码，不该直接 import 我们的 store；
// 由 ChatPanel 在 Provider 里注入当前实体的参与者。

import { createContext, useContext } from 'react';

export interface MentionBot {
    id: string;
    name: string;
    color: string;
    isOwner: boolean;
}

const MentionBotsContext = createContext<readonly MentionBot[]>([]);

export const MentionBotsProvider = MentionBotsContext.Provider;

export function useMentionBots(): readonly MentionBot[] {
    return useContext(MentionBotsContext);
}
