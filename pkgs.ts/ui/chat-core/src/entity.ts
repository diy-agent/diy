// entity.ts —— 容器参与者的纯函数（委托给 protocol，前端不另写一份规则）。
//
// 词表：Room 是容器（项目/任务/股票…都行）；Bot 是身份；RoomMember 是它在这个房间里的绑定；
// BotSession 是 bot 在某个 room 里的那条原生对话（后端概念，前端不需要）。

import { botIdsOf, botsOf as botsInRoom, primaryMemberOf } from '@diy-agent/protocol';
import type { Bot, Room } from './types';

/** 默认应答的 bot：没有 @ 时只有它说话 */
export function primaryBotOf(room: Room, bots: Record<string, Bot>): Bot | undefined {
    const member = primaryMemberOf(room);
    return member === undefined ? undefined : bots[member.botId];
}

export function botsOf(room: Room, bots: Record<string, Bot>): Bot[] {
    return botsInRoom(room, bots);
}

export function memberIdsOf(room: Room): string[] {
    return botIdsOf(room);
}

/** 容器的目录：data.dir 优先，其次所属项目的 data.dir */
export function dirOf(room: Room, rooms: Room[]): string {
    const own = room.data['dir'];
    if (typeof own === 'string' && own !== '') return own;
    const projectId = room.data['projectId'];
    const parent = typeof projectId === 'string' ? rooms.find((entry) => entry.id === projectId) : undefined;
    const parentDir = parent?.data['dir'];
    return typeof parentDir === 'string' && parentDir !== '' ? parentDir : '—';
}
