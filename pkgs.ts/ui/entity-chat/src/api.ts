// api.ts —— 与 diy2 后端的唯一约定（组件不写 URL / 方法名）。

import type { Bot, Delivery, Entity, Item } from './model';

const BASE = '/api';

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
}

export interface Snapshot {
    entities: Entity[];
    bots: Record<string, Bot>;
}

export async function fetchSnapshot(): Promise<Snapshot> {
    const [entities, bots] = await Promise.all([jsonFetch<Entity[]>('/entities'), jsonFetch<Bot[]>('/bots')]);
    return { entities, bots: Object.fromEntries(bots.map((bot) => [bot.id, bot])) };
}

export async function fetchDeliveries(entityId: string): Promise<Delivery[]> {
    const data = await jsonFetch<{ deliveries: Delivery[] }>(`/entities/${encodeURIComponent(entityId)}/deliveries`);
    return data.deliveries;
}

export async function fetchHistory(entityId: string, afterSeq = 0): Promise<Item[]> {
    const data = await jsonFetch<{ items: Item[] }>(`/entities/${encodeURIComponent(entityId)}/history?afterSeq=${afterSeq}`);
    return data.items;
}

export async function createEntity(input: {
    kind: 'project' | 'task';
    name: string;
    dir?: string;
    projectId?: string;
}): Promise<Entity> {
    return jsonFetch<Entity>('/entities', { method: 'POST', body: JSON.stringify(input) });
}

export async function patchEntity(id: string, patch: { name?: string; modelKey?: string }): Promise<Entity> {
    return jsonFetch<Entity>(`/entities/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function createBot(input: { name: string; homeEntityId: string; modelKey?: string }): Promise<Bot> {
    return jsonFetch<Bot>('/bots', { method: 'POST', body: JSON.stringify(input) });
}

export async function addBotToEntity(entityId: string, botId: string): Promise<Entity> {
    return jsonFetch<Entity>(`/entities/${encodeURIComponent(entityId)}/bots`, { method: 'POST', body: JSON.stringify({ botId }) });
}

export type StreamEvent =
    | { kind: 'item'; item: Item }
    | { kind: 'delivery'; delivery: Delivery }
    | { kind: 'error'; message: string }
    | { kind: 'done' };

/** POST chat，逐条解析 SSE（data: {...}\n\n） */
export async function streamChat(entityId: string, text: string, onEvent: (event: StreamEvent) => void): Promise<void> {
    const res = await fetch(`${BASE}/entities/${encodeURIComponent(entityId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
    });
    if (!res.ok || res.body === null) throw new Error(`chat → ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
            const index = buffer.indexOf('\n\n');
            if (index < 0) break;
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                try {
                    onEvent(JSON.parse(line.slice(6)) as StreamEvent);
                } catch {
                    /* 忽略坏行 */
                }
            }
        }
    }
}
