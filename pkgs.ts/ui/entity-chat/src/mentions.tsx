// mentions.tsx —— @ 候选在这层组装：容器参与者 + 会话状态 → MentionCandidate[]。
//
// 候选计算/补全规则在 chat-core 的 mention.ts（surface 无关：mentionQuery /
// filterMentionCandidates / completeMention / moveActive 全在那里，口头注释就一句
// “两面必须给出同样的候选与同样的补全结果”）；这里只负责"当前实体有哪些 bot"。
// 两个表面都直接调这个 hook（Astryx 面喂它自己的触发器菜单，shadcn 面喂自己的浮层）——
// 原先还有一层 React context 给 assistant-ui 的模板代码取值，那一面删掉后成了死件。

import { mentionCandidatesOf, type MentionCandidate } from '@diy-agent/chat-core';
import { useMemo } from 'react';

import { useStore } from './store';

export type MentionBot = MentionCandidate;

/** 当前容器里可 @ 的 bot（第一个是 owner） */
export function useMentionCandidates(roomId: string): MentionCandidate[] {
    const shell = useStore();
    const room = shell.rooms.find((entry) => entry.id === roomId);
    const botIds = useMemo(() => (room === undefined ? [] : room.members.map((member) => member.botId)), [room]);
    return useMemo(() => mentionCandidatesOf(botIds, shell.bots), [botIds, shell.bots]);
}
