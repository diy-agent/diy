// entity.ts —— 实体/参与者的纯函数（不依赖 UI）。

import type { Bot, Entity } from './types';

export function ownerOfBot(entity: Entity, bots: Record<string, Bot>): Bot | undefined {
    return bots[entity.botIds[0] ?? ''];
}

export function botsOf(entity: Entity, bots: Record<string, Bot>): Bot[] {
    return entity.botIds.map((id) => bots[id]).filter((bot): bot is Bot => bot !== undefined);
}

export function dirOf(entity: Entity, entities: Entity[]): string {
    if (entity.dir !== undefined) return entity.dir;
    const project = entities.find((entry) => entry.id === entity.projectId);
    return project?.dir ?? '—';
}
