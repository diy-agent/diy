// store.tsx —— 真实后端 store：snapshot + 历史 + SSE 流。
//
// 规则：Item 由后端投影（server 侧 Projector），前端只 upsert；不再有本地 delta 拼接。

import * as React from 'react';

import * as api from './api';
import type { Bot, Entity, Item } from './model';

const DEFAULT_MODEL = 'chen56@opencode-go/deepseek-v4.1-flash';

interface State {
    entities: Entity[];
    bots: Record<string, Bot>;
    items: Record<string, Item[]>;
    running: Record<string, boolean>;
    selectedId: string;
    defaultModelKey: string;
    loaded: boolean;
    error?: string;
}

let state: State = {
    entities: [],
    bots: {},
    items: {},
    running: {},
    selectedId: '',
    defaultModelKey: loadDefaultModel(),
    loaded: false,
};
const listeners = new Set<() => void>();

function emit(next: State): void {
    state = next;
    for (const listener of listeners) listener();
}

export function useStore(): State {
    return React.useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => state,
        () => state,
    );
}

export function itemsOf(entityId: string): Item[] {
    return state.items[entityId] ?? [];
}

export function entityOf(id: string): Entity | undefined {
    return state.entities.find((entity) => entity.id === id);
}

function upsertItem(entityId: string, item: Item): void {
    const list = state.items[entityId] ?? [];
    const index = list.findIndex((existing) => existing.id === item.id);
    const next = index < 0 ? [...list, item] : list.map((existing) => (existing.id === item.id ? item : existing));
    emit({ ...state, items: { ...state.items, [entityId]: next } });
}

async function refresh(): Promise<void> {
    const snapshot = await api.fetchSnapshot();
    const selectedId = state.selectedId === '' ? (snapshot.entities[0]?.id ?? '') : state.selectedId;
    emit({
        ...state,
        entities: snapshot.entities,
        bots: snapshot.bots,
        loaded: true,
        selectedId,
        error: undefined,
    });
    // 首屏（或切换后）把当前实体的历史拉回来
    if (selectedId !== '' && (state.items[selectedId] ?? []).length === 0) {
        await loadHistory(selectedId);
    }
}

async function loadHistory(entityId: string): Promise<void> {
    const items = await api.fetchHistory(entityId);
    emit({ ...state, items: { ...state.items, [entityId]: items } });
}

// ─── 命令 ─────────────────────────────────────────────────────────

export const actions = {
    bootstrap(): void {
        void refresh().catch((error: unknown) => emit({ ...state, loaded: true, error: String(error) }));
    },

    select(id: string): void {
        emit({ ...state, selectedId: id });
        if ((state.items[id] ?? []).length === 0) void loadHistory(id).catch(() => undefined);
    },

    send(targetId: string, text: string): void {
        const trimmed = text.trim();
        if (trimmed === '' || state.running[targetId] === true) return;
        emit({ ...state, running: { ...state.running, [targetId]: true } });
        void api
            .streamChat(targetId, trimmed, (event) => {
                if (event.kind === 'item') upsertItem(targetId, event.item);
                if (event.kind === 'error') emit({ ...state, error: event.message });
            })
            .catch((error: unknown) => emit({ ...state, error: String(error) }))
            .finally(() => emit({ ...state, running: { ...state.running, [targetId]: false } }));
    },

    renameEntity(id: string, name: string): void {
        if (name.trim() === '') return;
        void api.patchEntity(id, { name: name.trim() }).then(refresh).catch(() => undefined);
    },

    setEntityModel(id: string, modelKey: string): void {
        void api.patchEntity(id, { modelKey }).then(refresh).catch(() => undefined);
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
        void api
            .createEntity({ kind: 'project', name: input.name, dir: input.dir })
            .then((entity) => refresh().then(() => emit({ ...state, selectedId: entity.id })))
            .catch(() => undefined);
    },

    createTask(projectId: string): void {
        const project = entityOf(projectId);
        const count = state.entities.filter((entity) => entity.projectId === projectId).length + 1;
        void api
            .createEntity({ kind: 'task', name: `新任务 ${count}`, projectId, dir: project?.dir })
            .then((entity) => refresh().then(() => emit({ ...state, selectedId: entity.id })))
            .catch(() => undefined);
    },

    addBot(entityId: string, name: string): void {
        if (name.trim() === '') return;
        void api
            .createBot({ name: name.trim(), homeEntityId: entityId })
            .then((bot) => api.addBotToEntity(entityId, bot.id))
            .then(refresh)
            .catch(() => undefined);
    },

    addExistingBot(entityId: string, botId: string): void {
        void api.addBotToEntity(entityId, botId).then(refresh).catch(() => undefined);
    },

    setBotModel(botId: string, modelKey: string): void {
        // 切片：bot 的模型暂时落在它自己的实体上
        const bot = state.bots[botId];
        if (bot === undefined) return;
        void api.patchEntity(`bot:${botId}`, { modelKey }).then(refresh).catch(() => undefined);
    },
};

// ─── 内部 ─────────────────────────────────────────────────────────

function loadDefaultModel(): string {
    try {
        return localStorage.getItem('entity-chat:default-model') ?? DEFAULT_MODEL;
    } catch {
        return DEFAULT_MODEL;
    }
}
