// store.tsx —— React 适配层：实体/选择（本包）+ 会话状态（chat-core 的 ConversationStore）。
//
// 原则：业务状态在 chat-core，React 只负责订阅；surface 只拿 ConversationModel。

import { ConversationStore, HttpChatClient, type Bot, type Entity } from '@diy-agent/chat-core';
import * as React from 'react';

const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';

// ─── 会话（chat-core）─────────────────────────────────────────────

const client = new HttpChatClient('/api');
const conversations = new Map<string, ConversationStore>();

export function conversationOf(entityId: string): ConversationStore {
    let store = conversations.get(entityId);
    if (store === undefined) {
        store = new ConversationStore(client, entityId);
        conversations.set(entityId, store);
        store.reload();
    }
    return store;
}

// ─── 实体/选择（这一层只做导航，属于 UI 壳）────────────────────────

interface ShellState {
    entities: Entity[];
    bots: Record<string, Bot>;
    selectedId: string;
    defaultModelKey: string;
    loaded: boolean;
    error?: string;
}

let state: ShellState = {
    entities: [],
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

export function entityOf(id: string): Entity | undefined {
    return state.entities.find((entity) => entity.id === id);
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
}

async function refresh(): Promise<void> {
    const [entities, bots] = await Promise.all([jsonFetch<Entity[]>('/entities'), jsonFetch<Bot[]>('/bots')]);
    const selectedId = state.selectedId === '' ? (entities[0]?.id ?? '') : state.selectedId;
    emit({ ...state, entities, bots: Object.fromEntries(bots.map((bot) => [bot.id, bot])), loaded: true, selectedId, error: undefined });
}

export const actions = {
    bootstrap(): void {
        void refresh().catch((error: unknown) => emit({ ...state, loaded: true, error: String(error) }));
    },

    select(id: string): void {
        emit({ ...state, selectedId: id });
        conversationOf(id);
    },

    renameEntity(id: string, name: string): void {
        if (name.trim() === '') return;
        void jsonFetch(`/entities/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) })
            .then(refresh)
            .catch(() => undefined);
    },

    setEntityModel(id: string, modelKey: string): void {
        void jsonFetch(`/entities/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ modelKey }) })
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
        void jsonFetch<Entity>('/entities', { method: 'POST', body: JSON.stringify({ kind: 'project', name: input.name, dir: input.dir }) })
            .then((entity) => refresh().then(() => emit({ ...state, selectedId: entity.id })))
            .catch(() => undefined);
    },

    createTask(projectId: string): void {
        const project = entityOf(projectId);
        const count = state.entities.filter((entity) => entity.projectId === projectId).length + 1;
        void jsonFetch<Entity>('/entities', {
            method: 'POST',
            body: JSON.stringify({ kind: 'task', name: `新任务 ${count}`, projectId, dir: project?.dir }),
        })
            .then((entity) => refresh().then(() => emit({ ...state, selectedId: entity.id })))
            .catch(() => undefined);
    },

    addBot(entityId: string, name: string): void {
        if (name.trim() === '') return;
        void jsonFetch<Bot>('/bots', { method: 'POST', body: JSON.stringify({ name: name.trim(), homeEntityId: entityId }) })
            .then((bot) => jsonFetch(`/entities/${encodeURIComponent(entityId)}/bots`, { method: 'POST', body: JSON.stringify({ botId: bot.id }) }))
            .then(refresh)
            .catch(() => undefined);
    },

    addExistingBot(entityId: string, botId: string): void {
        void jsonFetch(`/entities/${encodeURIComponent(entityId)}/bots`, { method: 'POST', body: JSON.stringify({ botId }) })
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
