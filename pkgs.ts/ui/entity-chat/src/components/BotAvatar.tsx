// BotAvatar —— 发言人头像：按"项目 / 任务 / 其他"分别用不同图标。
//
// 为什么不用字母或纯色点：房间里同时有项目 bot 和任务 bot，光靠颜色分不清
// 它属于哪类容器；图标能一眼看出来（folder = 项目，list = 任务，bot = 其他）。
// 颜色仍然用 bot 自己的色，保证同一个人跨消息可辨认。

import { Bot, Folder, ListTodo, User } from 'lucide-react';
import type { CSSProperties } from 'react';

import type { Author } from '@diy-agent/chat-core';

import { roomOf, useStore } from '../store';

export function BotAvatar({
    author,
    /** 当前房间：优先按它取图标（同一个 bot 借到任务房间时显示任务图标） */
    roomId,
    size = 22,
    style,
}: {
    author?: Author;
    roomId?: string;
    size?: number;
    style?: CSSProperties;
}) {
    const shell = useStore();
    const color = author?.color ?? '#9ca3af';

    const room = roomId === undefined ? undefined : roomOf(roomId);
    const home = author === undefined ? undefined : shell.bots[author.id]?.homeRoomId;
    const type = room?.type ?? (home === undefined ? undefined : shell.rooms.find((entry) => entry.id === home)?.type);

    const Icon = author?.role === 'human' ? User : type === 'project' ? Folder : type === 'task' ? ListTodo : Bot;

    return (
        <span
            aria-hidden
            className="inline-flex shrink-0 items-center justify-center rounded-full"
            style={{
                width: size,
                height: size,
                color,
                background: `color-mix(in oklab, ${color} 22%, transparent)`,
                ...style,
            }}
        >
            <Icon style={{ width: size * 0.58, height: size * 0.58 }} strokeWidth={2.2} />
        </span>
    );
}
