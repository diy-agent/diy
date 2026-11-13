// mentions.tsx —— @ 候选在这层组装：容器参与者 + 会话状态 → MentionCandidate[]。
//
// 候选计算/补全规则在 chat-core（surface 无关）；这里只负责"当前实体有哪些 bot"。
// assistant-ui 的模板代码通过 context 取值，Astryx 表面直接调 hook。

import { mentionCandidatesOf, type MentionCandidate } from '@diy-agent/chat-core';
import { createContext, useContext, useMemo } from 'react';

import { useStore } from './store';

export type MentionBot = MentionCandidate;

const MentionBotsContext = createContext<readonly MentionBot[]>([]);

export const MentionBotsProvider = MentionBotsContext.Provider;

export function useMentionBots(): readonly MentionBot[] {
    return useContext(MentionBotsContext);
}

/** 当前容器里可 @ 的 bot（第一个是 owner） */
export function useMentionCandidates(roomId: string): MentionCandidate[] {
    const shell = useStore();
    const botIds = shell.rooms.find((room) => room.id === roomId)?.botIds;
    return useMemo(() => (botIds === undefined ? [] : mentionCandidatesOf(botIds, shell.bots)), [botIds, shell.bots]);
}
