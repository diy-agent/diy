// model.ts —— 领域模型（实验版）
//
// 关键约定：
//   · 项目 / 任务：图标不同、名字可改；
//   · bot 是**实体专属**的：项目有项目的 bot，任务有任务的 bot，互不共享，也没有全局 bot 池；
//   · bot 名字默认 = 实体名（owner）；再加的 bot 用用户输入的名字；
//   · 每个实体和 bot 都有自己的 modelKey（默认取全局默认模型）；
//   · Item 用 `type` + `data`，UI 只吃投影。

import { DEFAULT_MODEL_KEY } from './models';

export type EntityKind = 'project' | 'task';

export interface Bot {
    id: string;
    /** 属于哪个实体（项目或任务）—— 没有全局 bot */
    entityId: string;
    name: string;
    color: string;
    persona: string;
    /** 三段式：account@provider/model */
    modelKey: string;
}

export interface Entity {
    id: string;
    kind: EntityKind;
    name: string;
    /** 项目：本机目录；任务继承项目 */
    dir?: string;
    /** 任务所属项目 */
    projectId?: string;
    /** 第一个是 owner */
    botIds: string[];
    /** 实体自己的默认模型（新 bot 继承它） */
    modelKey: string;
}

export interface Author {
    id: string;
    name: string;
    color: string;
    role: 'human' | 'bot';
}

interface ItemBase {
    id: string;
    seq: number;
    turnId: string;
    at: number;
    status: 'pending' | 'streaming' | 'done' | 'failed';
    author?: Author;
}

export type Item =
    | (ItemBase & { type: 'chat'; data: { text: string } })
    | (ItemBase & { type: 'notice'; data: { text: string; kind: string } });

export const HUMAN: Author = { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' };

export const BOT_COLORS = ['#7cc4ff', '#f7b267', '#a3e635', '#f472b6', '#c084fc', '#38bdf8'];

export const DIR_SUGGESTIONS = ['~/git/diy/diy', '~/git/diy/diy-research', '~/git/cops', '~/git/sha'];

export function ownerOfBot(entity: Entity, bots: Record<string, Bot>): Bot | undefined {
    return bots[entity.botIds[0] ?? ''];
}

export function botsOf(entity: Entity, bots: Record<string, Bot>): Bot[] {
    return entity.botIds.map((id) => bots[id]).filter((bot): bot is Bot => bot !== undefined);
}

export function dirOf(entity: Entity, entities: Entity[]): string {
    if (entity.dir !== undefined) return entity.dir;
    const project = entities.find((e) => e.id === entity.projectId);
    return project?.dir ?? '—';
}

export interface Seed {
    entities: Entity[];
    bots: Record<string, Bot>;
}

export function seed(): Seed {
    const bots: Record<string, Bot> = {
        // owner bot 的名字 = 实体名
        'bot:alan': {
            id: 'bot:alan',
            entityId: 'proj:diy',
            name: 'diy',
            color: '#7cc4ff',
            persona: '项目 bot：工程视角，先结论后理由。',
            modelKey: DEFAULT_MODEL_KEY,
        },
        'bot:xiaoman': {
            id: 'bot:xiaoman',
            entityId: 'proj:cops',
            name: 'cops',
            color: '#f7b267',
            persona: '项目 bot：产品视角，拆需求、写验收。',
            modelKey: DEFAULT_MODEL_KEY,
        },
        'bot:laozhou': {
            id: 'bot:laozhou',
            entityId: 'task:t-001',
            name: '任务树与多会话',
            color: '#a3e635',
            persona: '任务 bot：运维视角，可观测性与回滚。',
            modelKey: DEFAULT_MODEL_KEY,
        },
    };
    const entities: Entity[] = [
        { id: 'proj:diy', kind: 'project', name: 'diy', dir: '~/git/diy/diy', botIds: ['bot:alan'], modelKey: DEFAULT_MODEL_KEY },
        { id: 'proj:cops', kind: 'project', name: 'cops', dir: '~/git/cops', botIds: ['bot:xiaoman'], modelKey: DEFAULT_MODEL_KEY },
        {
            id: 'task:t-001',
            kind: 'task',
            name: '任务树与多会话',
            projectId: 'proj:diy',
            dir: '~/git/diy/diy',
            botIds: ['bot:laozhou'],
            modelKey: DEFAULT_MODEL_KEY,
        },
    ];
    return { entities, bots };
}
