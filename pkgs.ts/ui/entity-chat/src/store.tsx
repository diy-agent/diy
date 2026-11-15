// store.tsx —— React 适配层：room / 选择（本包）+ 会话状态（chat-core 的 ConversationStore）。
//
// 词表：Room = 容器（项目/任务/股票…），Bot = 身份，BotSession = bot 在某个 room 里的对话（后端概念）。

import { ConversationStore, type Bot, type CompactOutcome, type Room, type SessionInfo } from '@diy-agent/chat-core';
import { HttpChatClient } from '@diy-agent/chat-transport-http';
import * as React from 'react';

const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';

// ─── 会话（chat-core）─────────────────────────────────────────────

// 传输层唯一注入点：换 diy-rpc 时只改这一行
const client = new HttpChatClient({ base: '/api' });
const conversations = new Map<string, ConversationStore>();

/** 回答一次挂起的提问（选项 / 表单）。失败会抛，由界面显示原因。 */
export async function answerAsk(
    roomId: string,
    askId: string,
    answer: { values?: string[]; fields?: Record<string, string>; text?: string },
): Promise<void> {
    if (client.answerAsk === undefined) throw new Error('当前传输不支持回答提问');
    await client.answerAsk(roomId, askId, answer);
}

export function conversationOf(roomId: string): ConversationStore {
    let store = conversations.get(roomId);
    if (store === undefined) {
        store = new ConversationStore(client, roomId);
        conversations.set(roomId, store);
        store.reload();
    } else {
        // 切走时释放过常驻流，回来要重新挂上
        store.attach();
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
    /** 各房间的上下文概况（每个 bot 的会话 + 最近压缩事件） */
    sessions: Record<string, SessionInfo[]>;
    error?: string;
}

let state: ShellState = {
    rooms: [],
    bots: {},
    selectedId: '',
    defaultModelKey: loadDefaultModel(),
    loaded: false,
    sessions: {},
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
    const res = await fetch(`/api${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
}

async function refresh(): Promise<void> {
    const [rooms, bots] = await Promise.all([jsonFetch<Room[]>('/rooms'), jsonFetch<Bot[]>('/bots')]);
    const selectedId = state.selectedId === '' ? (rooms[0]?.id ?? '') : state.selectedId;
    emit({
        ...state,
        rooms,
        bots: Object.fromEntries(bots.map((bot) => [bot.id, bot])),
        loaded: true,
        selectedId,
        error: undefined,
    });
}

// ─── 首屏连接：失败就一直退避重试 ────────────────────────────────────
//
// 之前只试一次：dev 脚本先起 UI、后起 API（tsx 冷启动要几秒），页面先加载就
// 永久停在"连接 diy2 后端…"，后端起来了也不会自己接上，只能手动刷新。
//
// 重试策略：0.5s 起步翻倍、5s 封顶；另外窗口重新可见 / 网络恢复时立刻补一次
// （最常见的就是切回标签页时后端已经重启完了）。
let bootTimer: ReturnType<typeof setTimeout> | undefined;
let bootAttempt = 0;

function scheduleBootstrapRetry(delayMs?: number): void {
    if (bootTimer !== undefined) return;
    const delay = delayMs ?? Math.min(5_000, 500 * 2 ** Math.min(bootAttempt, 4));
    bootAttempt += 1;
    bootTimer = setTimeout(() => {
        bootTimer = undefined;
        void runBootstrap();
    }, delay);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function runBootstrap(): Promise<void> {
    try {
        await refresh();
        bootAttempt = 0;
    } catch (error) {
        // loaded 保持 false：界面继续显示"连接中"并带上失败原因，而不是变成半死的空壳
        emit({ ...state, error: messageOf(error) });
        scheduleBootstrapRetry();
    }
}

/** 已经连上之后再失败（后端重启）：留着现有界面，同样排队重试 */
function bootstrapIfNeeded(): void {
    if (bootTimer !== undefined) return;
    if (state.loaded) return;
    void runBootstrap();
}

let hooksInstalled = false;

/** 事件兜底：切回标签页 / 网络恢复时补一次（后端重启最常见的就是这两种时机） */
function installBootstrapHooks(): void {
    if (hooksInstalled || typeof window === 'undefined') return;
    hooksInstalled = true;
    window.addEventListener('online', bootstrapIfNeeded);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') bootstrapIfNeeded();
    });
}

export const actions = {
    bootstrap(): void {
        // 首屏：连不上后端就一直退避重试，直到成功（见 runBootstrap）
        if (bootTimer !== undefined) return;
        void runBootstrap();
        installBootstrapHooks();
    },

    select(id: string): void {
        // 只让当前房间挂常驻 SSE，其余释放（否则看过的房间各留一条，永远不断）
        for (const [roomId, store] of conversations) {
            if (roomId !== id) store.dispose();
        }
        emit({ ...state, selectedId: id });
        conversationOf(id);
    },

    renameRoom(id: string, name: string): void {
        if (name.trim() === '') return;
        void jsonFetch(`/rooms/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: name.trim() }),
        })
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
            // 带上默认模型：SettingsDialog 里"新建的都继承它"才成立
            body: JSON.stringify({
                type: 'project',
                name: input.name,
                modelKey: state.defaultModelKey,
                data: { dir: input.dir },
            }),
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
                modelKey: state.defaultModelKey,
                data: { projectId, dir: project?.data['dir'] },
            }),
        })
            .then((room) => refresh().then(() => emit({ ...state, selectedId: room.id })))
            .catch(() => undefined);
    },

    addBot(roomId: string, name: string): void {
        if (name.trim() === '') return;
        void jsonFetch<Bot>('/bots', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim(), homeRoomId: roomId, modelKey: state.defaultModelKey }),
        })
            .then((bot) =>
                jsonFetch(`/rooms/${encodeURIComponent(roomId)}/bots`, {
                    method: 'POST',
                    body: JSON.stringify({ botId: bot.id }),
                }),
            )
            .then(refresh)
            .catch(() => undefined);
    },

    /** 拉一次某个房间的上下文概况（面板打开 / 定时刷新时用） */
    refreshSessions(roomId: string): void {
        if (client.sessions === undefined) return;
        void client
            .sessions(roomId)
            .then((list) => emit({ ...state, sessions: { ...state.sessions, [roomId]: list } }))
            .catch(() => undefined);
    },

    /** 手动压一个 bot 的上下文：只影响它自己，不触发运行 */
    compactSession(
        roomId: string,
        botId: string,
        options: { keepLast?: number; maxChars?: number } = {},
    ): Promise<CompactOutcome | null> {
        if (client.compact === undefined) return Promise.resolve(null);
        return client
            .compact(roomId, botId, options)
            .then((outcome) => {
                actions.refreshSessions(roomId);
                return outcome;
            })
            .catch(() => null);
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
