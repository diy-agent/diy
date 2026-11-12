// db.ts —— node:sqlite：bots（持久）+ 每个实体的 Item 时间线（持久）。
//
// 项目/任务目前放内存（切片阶段），bot 与消息落 sqlite。

import { DatabaseSync } from 'node:sqlite';

import type { Bot, Delivery, Item } from './types';

export interface Store {
    readonly db: DatabaseSync;
    listBots(): Bot[];
    upsertBot(bot: Bot): void;
    appendItem(entityId: string, item: Item): Item;
    setEntityBots(entityId: string, botIds: string[]): void;
    entityBots(): Record<string, string[]>;
    setDelivery(delivery: Omit<Delivery, 'updatedAt'>): Delivery;
    listDeliveries(entityId: string): Delivery[];
    itemsOf(entityId: string, afterSeq?: number): Item[];
    seqOf(entityId: string): number;
}

export function openStore(file: string): Store {
    const db = new DatabaseSync(file === ':memory:' ? ':memory:' : file);
    db.exec(`
        CREATE TABLE IF NOT EXISTS bots (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            persona TEXT NOT NULL,
            home_entity_id TEXT NOT NULL,
            home_dir TEXT,
            model_key TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entity_items (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id TEXT NOT NULL,
            item TEXT NOT NULL,
            at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS items_entity ON entity_items(entity_id, seq);
        CREATE TABLE IF NOT EXISTS entity_bots (
            entity_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (entity_id, bot_id)
        );
        CREATE TABLE IF NOT EXISTS deliveries (
            entity_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            state TEXT NOT NULL,
            note TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (entity_id, message_id, bot_id)
        );
    `);

    const toBot = (row: Record<string, unknown>): Bot => ({
        id: String(row['id']),
        name: String(row['name']),
        color: String(row['color']),
        persona: String(row['persona']),
        homeEntityId: String(row['home_entity_id']),
        homeDir: row['home_dir'] === null ? undefined : String(row['home_dir']),
        modelKey: String(row['model_key']),
    });

    return {
        db,
        listBots(): Bot[] {
            const rows = db.prepare('SELECT * FROM bots ORDER BY rowid ASC').all() as Record<string, unknown>[];
            return rows.map(toBot);
        },
        upsertBot(bot: Bot): void {
            db.prepare(
                'INSERT INTO bots (id, name, color, persona, home_entity_id, home_dir, model_key) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=?, persona=?, home_dir=?, model_key=?',
            ).run(
                bot.id,
                bot.name,
                bot.color,
                bot.persona,
                bot.homeEntityId,
                bot.homeDir ?? null,
                bot.modelKey,
                bot.name,
                bot.persona,
                bot.homeDir ?? null,
                bot.modelKey,
            );
        },
        appendItem(entityId: string, item: Item): Item {
            const result = db
                .prepare('INSERT INTO entity_items (entity_id, item, at) VALUES (?,?,?)')
                .run(entityId, JSON.stringify(item), item.at);
            return { ...item, seq: Number(result.lastInsertRowid) };
        },
        setEntityBots(entityId: string, botIds: string[]): void {
            db.prepare('DELETE FROM entity_bots WHERE entity_id = ?').run(entityId);
            const insert = db.prepare('INSERT INTO entity_bots (entity_id, bot_id, position) VALUES (?,?,?)');
            botIds.forEach((botId, index) => insert.run(entityId, botId, index));
        },
        entityBots(): Record<string, string[]> {
            const rows = db.prepare('SELECT entity_id, bot_id FROM entity_bots ORDER BY position ASC').all() as Record<string, unknown>[];
            const out: Record<string, string[]> = {};
            for (const row of rows) {
                const id = String(row['entity_id']);
                (out[id] ??= []).push(String(row['bot_id']));
            }
            return out;
        },
        setDelivery(delivery: Omit<Delivery, 'updatedAt'>): Delivery {
            const updatedAt = Date.now();
            db.prepare(
                'INSERT INTO deliveries (entity_id, message_id, bot_id, state, note, updated_at) VALUES (?,?,?,?,?,?) ' +
                    'ON CONFLICT(entity_id, message_id, bot_id) DO UPDATE SET state=?, note=?, updated_at=?',
            ).run(
                delivery.entityId,
                delivery.messageId,
                delivery.botId,
                delivery.state,
                delivery.note ?? null,
                updatedAt,
                delivery.state,
                delivery.note ?? null,
                updatedAt,
            );
            return { ...delivery, updatedAt };
        },
        listDeliveries(entityId: string): Delivery[] {
            const rows = db.prepare('SELECT * FROM deliveries WHERE entity_id = ? ORDER BY updated_at ASC').all(entityId) as Record<string, unknown>[];
            return rows.map((row) => ({
                entityId: String(row['entity_id']),
                messageId: String(row['message_id']),
                botId: String(row['bot_id']),
                state: row['state'] as Delivery['state'],
                note: row['note'] === null ? undefined : String(row['note']),
                updatedAt: Number(row['updated_at']),
            }));
        },
        itemsOf(entityId: string, afterSeq = 0): Item[] {
            const rows = db
                .prepare('SELECT seq, item FROM entity_items WHERE entity_id = ? AND seq > ? ORDER BY seq ASC')
                .all(entityId, afterSeq) as Record<string, unknown>[];
            return rows.map((row) => ({ ...(JSON.parse(String(row['item'])) as Item), seq: Number(row['seq']) }));
        },
        seqOf(entityId: string): number {
            const row = db.prepare('SELECT MAX(seq) AS max FROM entity_items WHERE entity_id = ?').get(entityId) as
                | { max: number | null }
                | undefined;
            return row?.max ?? 0;
        },
    };
}
