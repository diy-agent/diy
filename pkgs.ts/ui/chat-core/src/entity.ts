// entity.ts —— 容器参与者的纯函数（不依赖 UI）。
//
// 词表：Room 是容器（项目/任务/股票…都行）；Bot 是身份；BotSession 是
// bot 在某个 room 里的那条原生对话（后端概念，前端不需要）。

import type { Bot, Room } from './types';

/** 默认应答的 bot：没有 @ 时只有它说话 */
export function primaryBotOf(room: Room, bots: Record<string, Bot>): Bot | undefined {
    return bots[room.primaryBotId] ?? bots[room.botIds[0] ?? ''];
}

export function botsOf(room: Room, bots: Record<string, Bot>): Bot[] {
    return room.botIds.map((id) => bots[id]).filter((bot): bot is Bot => bot !== undefined);
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
