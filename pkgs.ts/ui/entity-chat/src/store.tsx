// store.tsx —— React 适配层：room / 选择（本包）+ 会话状态（chat-core 的 ConversationStore）。
//
// 词表：Room = 容器（项目/任务/股票…），Bot = 身份，BotSession = bot 在某个 room 里的对话（后端概念）。

import { ConversationStore, type Bot, type Room } from '@diy-agent/chat-core';
import { HttpChatClient } from '@diy-agent/chat-transport-http';
import * as React from 'react';

const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';

// ─── 会话（chat-core）─────────────────────────────────────────────

// 传输层唯一注入点：换 diy-rpc 时只改这一行
const client = new HttpChatClient({ base: '/api' });
const conversations = new Map<string, ConversationStore>();

export function conversationOf(roomId: string): ConversationStore {
    let store = conversations.get(roomId);
    if (store === undefined) {
        store = new ConversationStore(client, roomId);
        conversations.set(roomId, store);
        store.reload();
    }
    return store;
}

// ─── room / 选择（这一层只做导航，属于 UI 壳）──────────────────────

interface ShellState {
    rooms: Room[];
    bots: Record<string, Bot>;
    selectedId: string;
    defaultModelKey: string;
    loaded: boolean;
    error?: string;
}

let state: ShellState = {
    rooms: [],
    bots: {},
    selectedId: '',
    defaultModelKey: loadDefaultModel(),
    loaded: false,
};
const listeners = new Set<() => void>();

function emit(next: ShellState): void {
    state = next;
    for (const listener of listeners) listener();
}

export function useShell(): ShellState {
    return React.useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => state,
        () => state,
    );
}

export const useStore = useShell;

export function roomOf(id: string): Room | undefined {
    return state.rooms.find((room) => room.id === id);
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
}

async function refresh(): Promise<void> {
    const [rooms, bots] = await Promise.all([jsonFetch<Room[]>('/rooms'), jsonFetch<Bot[]>('/bots')]);
    const selectedId = state.selectedId === '' ? (rooms[0]?.id ?? '') : state.selectedId;
    emit({ ...state, rooms, bots: Object.fromEntries(bots.map((bot) => [bot.id, bot])), loaded: true, selectedId, error: undefined });
}

export const actions = {
    bootstrap(): void {
        void refresh().catch((error: unknown) => emit({ ...state, loaded: true, error: String(error) }));
    },

    select(id: string): void {
        emit({ ...state, selectedId: id });
        conversationOf(id);
    },

    renameRoom(id: string, name: string): void {
        if (name.trim() === '') return;
        void jsonFetch(`/rooms/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) })
            .then(refresh)
            .catch(() => undefined);
    },

    setRoomModel(id: string, modelKey: string): void {
        void jsonFetch(`/rooms/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ modelKey }) })
            .then(refresh)
            .catch(() => undefined);
    },

    setDefaultModel(modelKey: string): void {
        try {
            localStorage.setItem('entity-chat:default-model', modelKey);
        } catch {
            /* 忽略 */
        }
        emit({ ...state, defaultModelKey: modelKey });
    },

    createProject(input: { name: string; dir: string }): void {
        void jsonFetch<Room>('/rooms', {
            method: 'POST',
            body: JSON.stringify({ type: 'project', name: input.name, data: { dir: input.dir } }),
        })
            .then((room) => refresh().then(() => emit({ ...state, selectedId: room.id })))
            .catch(() => undefined);
    },

    createTask(projectId: string): void {
        const project = roomOf(projectId);
        const count = state.rooms.filter((room) => room.data['projectId'] === projectId).length + 1;
        void jsonFetch<Room>('/rooms', {
            method: 'POST',
            body: JSON.stringify({
                type: 'task',
                name: `新任务 ${count}`,
                data: { projectId, dir: project?.data['dir'] },
            }),
        })
            .then((room) => refresh().then(() => emit({ ...state, selectedId: room.id })))
            .catch(() => undefined);
    },

    addBot(roomId: string, name: string): void {
        if (name.trim() === '') return;
        void jsonFetch<Bot>('/bots', { method: 'POST', body: JSON.stringify({ name: name.trim(), homeRoomId: roomId }) })
            .then((bot) => jsonFetch(`/rooms/${encodeURIComponent(roomId)}/bots`, { method: 'POST', body: JSON.stringify({ botId: bot.id }) }))
            .then(refresh)
            .catch(() => undefined);
    },

    addExistingBot(roomId: string, botId: string): void {
        void jsonFetch(`/rooms/${encodeURIComponent(roomId)}/bots`, { method: 'POST', body: JSON.stringify({ botId }) })
            .then(refresh)
            .catch(() => undefined);
    },
};

function loadDefaultModel(): string {
    try {
        return localStorage.getItem('entity-chat:default-model') ?? DEFAULT_MODEL;
    } catch {
        return DEFAULT_MODEL;
    }
}
