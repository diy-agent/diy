// store.tsx —— 无框架 store：实体表 + 实体专属 bot + 每个实体的 Item 队列。
//
// 注意：bot 没有全局池；每个 bot 都带 entityId，只属于创建它的项目/任务。

import * as React from 'react';

import { BOT_COLORS, HUMAN, seed, type Bot, type Entity, type EntityKind, type Item } from './model';
import { DEFAULT_MODEL_KEY, modelLabel, parseModelKey } from './models';

interface State {
    entities: Entity[];
    bots: Record<string, Bot>;
    items: Record<string, Item[]>;
    running: Record<string, boolean>;
    selectedId: string;
    /** 新建任务/项目/bot 的默认模型 */
    defaultModelKey: string;
}

let seq = 0;
let botSeq = 0;
const nextId = (): string => `i-${++seq}`;

const initial = seed();

let state: State = {
    entities: initial.entities,
    bots: initial.bots,
    items: {},
    running: {},
    selectedId: initial.entities[0]!.id,
    defaultModelKey: loadDefaultModel(),
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
    return state.entities.find((e) => e.id === id);
}

// ─── 命令 ─────────────────────────────────────────────────────────

export const actions = {
    select(id: string): void {
        emit({ ...state, selectedId: id });
    },

    setDefaultModel(modelKey: string): void {
        try {
            localStorage.setItem('entity-chat:default-model', modelKey);
        } catch {
            /* 忽略 */
        }
        emit({ ...state, defaultModelKey: modelKey });
    },

    setEntityModel(id: string, modelKey: string): void {
        emit({ ...state, entities: state.entities.map((e) => (e.id === id ? { ...e, modelKey } : e)) });
    },

    setBotModel(id: string, modelKey: string): void {
        const bot = state.bots[id];
        if (bot === undefined) return;
        emit({ ...state, bots: { ...state.bots, [id]: { ...bot, modelKey } } });
    },

    renameEntity(id: string, name: string): void {
        const trimmed = name.trim();
        if (trimmed === '') return;
        const entity = state.entities.find((e) => e.id === id);
        const ownerId = entity?.botIds[0];
        const bots = { ...state.bots };
        // owner bot 就是实体本身：改名时跟着改
        if (ownerId !== undefined && bots[ownerId] !== undefined) {
            bots[ownerId] = { ...bots[ownerId], name: trimmed };
        }
        emit({
            ...state,
            entities: state.entities.map((e) => (e.id === id ? { ...e, name: trimmed } : e)),
            bots,
        });
    },

    createProject(input: { name: string; dir: string }): string {
        const id = `proj:${input.name}-${state.entities.length + 1}`;
        // 项目 bot 的名字 = 项目名；模型取默认模型
        const bot = makeBot(id, input.name, state.defaultModelKey);
        const entity: Entity = {
            id,
            kind: 'project',
            name: input.name,
            dir: input.dir,
            botIds: [bot.id],
            modelKey: state.defaultModelKey,
        };
        emit({
            ...state,
            entities: [...state.entities, entity],
            bots: { ...state.bots, [bot.id]: bot },
            selectedId: id,
            items: { ...state.items, [id]: [notice(id, `项目已创建：${input.dir}`)] },
        });
        return id;
    },

    /** 项目行上的 ＋ 图标：直接建一个任务并进入对话（不弹窗） */
    createTask(projectId: string): string {
        const parent = state.entities.find((e) => e.id === projectId);
        const id = `task:new-${state.entities.length + 1}`;
        const count = state.entities.filter((e) => e.projectId === projectId).length + 1;
        const taskName = `新任务 ${count}`;
        // 任务 bot 的名字 = 任务名；模型取默认模型
        const bot = makeBot(id, taskName, state.defaultModelKey);
        const entity: Entity = {
            id,
            kind: 'task',
            name: taskName,
            projectId,
            dir: parent?.dir,
            botIds: [bot.id],
            modelKey: state.defaultModelKey,
        };
        emit({
            ...state,
            entities: [...state.entities, entity],
            bots: { ...state.bots, [bot.id]: bot },
            selectedId: id,
            items: { ...state.items, [id]: [notice(id, `任务已创建，owner = ${bot.name}（本任务专属）`)] },
        });
        return id;
    },

    /** 从现有 bot 里选一个加入实体（bot 的归属仍是它原来的实体） */
    addExistingBot(entityId: string, botId: string): void {
        const bot = state.bots[botId];
        const entity = state.entities.find((e) => e.id === entityId);
        if (bot === undefined || entity === undefined || entity.botIds.includes(botId)) return;
        const home = state.entities.find((e) => e.id === bot.entityId);
        emit({
            ...state,
            entities: state.entities.map((e) => (e.id === entityId ? { ...e, botIds: [...e.botIds, botId] } : e)),
            items: {
                ...state.items,
                [entityId]: [
                    ...(state.items[entityId] ?? []),
                    notice(entityId, `${bot.name} 加入了对话（来自${home?.kind === 'project' ? '项目' : '任务'}「${home?.name ?? '?'}」）`),
                ],
            },
        });
    },

    addBot(entityId: string, name: string): void {
        const trimmed = name.trim();
        if (trimmed === '') return;
        const ownerModel = state.entities.find((e) => e.id === entityId)?.modelKey ?? state.defaultModelKey;
        const bot = makeBot(entityId, trimmed, ownerModel);
        emit({
            ...state,
            entities: state.entities.map((entity) =>
                entity.id === entityId ? { ...entity, botIds: [...entity.botIds, bot.id] } : entity,
            ),
            bots: { ...state.bots, [bot.id]: bot },
            items: { ...state.items, [entityId]: [...(state.items[entityId] ?? []), notice(entityId, `${bot.name} 加入了对话`)] },
        });
    },

    removeBot(entityId: string, botId: string): void {
        emit({
            ...state,
            entities: state.entities.map((entity) =>
                entity.id === entityId && entity.botIds[0] !== botId
                    ? { ...entity, botIds: entity.botIds.filter((id) => id !== botId) }
                    : entity,
            ),
        });
    },

    /** bot 也可以作为独立对话目标（selectedId = bot.id） */
    send(targetId: string, text: string): void {
        if (state.running[targetId] === true) return;
        const trimmed = text.trim();
        if (trimmed === '') return;

        const botTarget = state.bots[targetId];
        const entity = entityOf(targetId);
        if (botTarget === undefined && entity === undefined) return;

        const bots = botTarget !== undefined
            ? [botTarget]
            : (entity?.botIds ?? []).map((id) => state.bots[id]).filter((bot): bot is Bot => bot !== undefined);
        if (bots.length === 0) return;
        const targetKind: EntityKind | 'bot' = botTarget !== undefined ? 'bot' : entity!.kind;

        const turnId = `turn-${Date.now().toString(36)}`;
        appendItem(targetId, {
            id: nextId(),
            seq: ++seq,
            turnId,
            at: Date.now(),
            status: 'done',
            author: HUMAN,
            type: 'chat',
            data: { text: trimmed },
        });
        setRunning(targetId, true);

        let pending = bots.length;
        bots.forEach((bot, index) => {
            setTimeout(() => {
                streamReply(targetId, turnId, bot, replyText(bot.name, targetKind, trimmed, bot.modelKey), () => {
                    pending -= 1;
                    if (pending === 0) setRunning(targetId, false);
                });
            }, index * 320);
        });
    },
};

// ─── 内部 ─────────────────────────────────────────────────────────

function loadDefaultModel(): string {
    try {
        const saved = localStorage.getItem('entity-chat:default-model');
        if (saved !== null && parseModelKey(saved).model !== '') return saved;
    } catch {
        /* 忽略 */
    }
    return DEFAULT_MODEL_KEY;
}

function makeBot(entityId: string, name: string, modelKey: string): Bot {
    const n = ++botSeq;
    return {
        id: `bot:${entityId}:${n}`,
        entityId,
        name,
        color: BOT_COLORS[n % BOT_COLORS.length]!,
        persona: '实体专属 bot（不与其他项目/任务共享）',
        modelKey,
    };
}

function notice(entityId: string, text: string): Item {
    return {
        id: nextId(),
        seq: ++seq,
        turnId: `notice-${entityId}`,
        at: Date.now(),
        status: 'done',
        type: 'notice',
        data: { text, kind: 'system' },
    };
}

function appendItem(entityId: string, item: Item): void {
    emit({
        ...state,
        items: { ...state.items, [entityId]: [...(state.items[entityId] ?? []), item] },
    });
}

function setRunning(entityId: string, running: boolean): void {
    emit({ ...state, running: { ...state.running, [entityId]: running } });
}

function patchItem(entityId: string, itemId: string, patch: Partial<Item>): void {
    emit({
        ...state,
        items: {
            ...state.items,
            [entityId]: (state.items[entityId] ?? []).map((item) =>
                item.id === itemId ? ({ ...item, ...patch } as Item) : item,
            ),
        },
    });
}

function replyText(name: string, kind: EntityKind | 'bot', prompt: string, modelKey: string): string {
    const role = kind === 'project' ? '项目 owner' : kind === 'task' ? '任务 bot' : '独立 bot';
    return [
        `${name}（${role} · ${modelLabel(modelKey)}）：收到「${prompt}」。`,
        '',
        '我是这个实体专属的 bot，只服务当前项目/任务；其他实体有它们自己的 bot。',
        '',
        '下一步：① 确认目标；② 拆步骤；③ 标出需要 approval 的动作。',
    ].join('\n');
}

function streamReply(entityId: string, turnId: string, bot: Bot, text: string, done: () => void): void {
    const id = nextId();
    appendItem(entityId, {
        id,
        seq: ++seq,
        turnId,
        at: Date.now(),
        status: 'streaming',
        author: { id: bot.id, name: bot.name, color: bot.color, role: 'bot' },
        type: 'chat',
        data: { text: '' },
    });

    let cursor = 0;
    const timer = setInterval(() => {
        cursor = Math.min(text.length, cursor + 3);
        patchItem(entityId, id, {
            data: { text: text.slice(0, cursor) },
            status: cursor >= text.length ? 'done' : 'streaming',
        } as Partial<Item>);
        if (cursor >= text.length) {
            clearInterval(timer);
            done();
        }
    }, 22);
}
