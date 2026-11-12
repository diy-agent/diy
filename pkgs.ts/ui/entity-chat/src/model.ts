// model.ts —— 领域类型（切片：实体 / bot / Item）。数据来自后端，不再有 seed。

export type EntityKind = 'project' | 'task' | 'bot';

export const DIR_SUGGESTIONS = ['~/git/diy/diy', '~/git/diy/diy-research', '~/git/cops', '~/git/sha'];

export interface Bot {
    id: string;
    name: string;
    color: string;
    persona: string;
    homeEntityId: string;
    homeDir?: string;
    modelKey: string;
}

export interface Entity {
    id: string;
    kind: EntityKind;
    name: string;
    dir?: string;
    projectId?: string;
    botIds: string[];
    modelKey: string;
}

export interface Author {
    id: string;
    name: string;
    color: string;
    role: 'human' | 'bot' | 'system';
}

interface ItemBase {
    id: string;
    seq: number;
    /** 会话内的轮次序号（后端在发送时分配；老数据可能没有） */
    turn?: number;
    turnId: string;
    at: number;
    status: 'pending' | 'streaming' | 'done' | 'failed';
    author?: Author;
}

export type Item =
    | (ItemBase & { type: 'chat'; data: { text: string } })
    | (ItemBase & { type: 'notice'; data: { text: string; kind: string } })
    | (ItemBase & { type: 'tool'; data: { name: string; args?: unknown; result?: unknown; state: 'running' | 'ok' | 'error' } })
    | (ItemBase & { type: 'error'; data: { message: string } });

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
