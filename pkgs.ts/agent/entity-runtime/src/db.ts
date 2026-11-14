// db.ts —— node:sqlite：bots（持久）+ 每个实体的 Item 时间线（持久）。
//
// 项目/任务目前放内存（切片阶段），bot 与消息落 sqlite。

import { DatabaseSync } from 'node:sqlite';

import type { Bot, Delivery, Item, RoomMember } from './types';

export interface Store {
    readonly db: DatabaseSync;
    listBots(): Bot[];
    upsertBot(bot: Bot): void;
    appendItem(roomId: string, item: Item): Item;
    setMembers(roomId: string, members: readonly RoomMember[]): void;
    /** roomId → 成员（按 position） */
    members(): Record<string, RoomMember[]>;
    setDelivery(delivery: Omit<Delivery, 'updatedAt'>): Delivery;
    listDeliveries(roomId: string): Delivery[];
    itemsOf(roomId: string, afterSeq?: number): Item[];
    seqOf(roomId: string): number;
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
        CREATE TABLE IF NOT EXISTS room_members (
            entity_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            primary_flag INTEGER NOT NULL DEFAULT 0,
            model_key TEXT,
            persona TEXT,
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

    // 迁移：老的 entity_bots（只有 id 列表）→ room_members（第一位为 primary）
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_bots'").get() as
        | { name: string }
        | undefined;
    if (legacy !== undefined) {
        const count = (db.prepare('SELECT COUNT(*) AS n FROM room_members').get() as { n: number }).n;
        if (count === 0) {
            const rows = db.prepare('SELECT entity_id, bot_id, position FROM entity_bots ORDER BY entity_id, position').all() as Array<
                Record<string, unknown>
            >;
            const insert = db.prepare(
                'INSERT OR IGNORE INTO room_members (entity_id, bot_id, position, primary_flag) VALUES (?,?,?,?)',
            );
            for (const row of rows) {
                insert.run(String(row['entity_id']), String(row['bot_id']), Number(row['position']), Number(row['position']) === 0 ? 1 : 0);
            }
        }
        db.exec('DROP TABLE entity_bots');
    }

    const toBot = (row: Record<string, unknown>): Bot => ({
        id: String(row['id']),
        name: String(row['name']),
        color: String(row['color']),
        persona: String(row['persona']),
        homeRoomId: String(row['home_entity_id']),
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
                bot.homeRoomId,
                bot.homeDir ?? null,
                bot.modelKey,
                bot.name,
                bot.persona,
                bot.homeDir ?? null,
                bot.modelKey,
            );
        },
        appendItem(roomId: string, item: Item): Item {
            const result = db
                .prepare('INSERT INTO entity_items (entity_id, item, at) VALUES (?,?,?)')
                .run(roomId, JSON.stringify(item), item.at);
            return { ...item, seq: Number(result.lastInsertRowid) };
        },
        setMembers(roomId: string, members: readonly RoomMember[]): void {
            db.prepare('DELETE FROM room_members WHERE entity_id = ?').run(roomId);
            const insert = db.prepare(
                'INSERT INTO room_members (entity_id, bot_id, position, primary_flag, model_key, persona) VALUES (?,?,?,?,?,?)',
            );
            members.forEach((member, index) => {
                insert.run(
                    roomId,
                    member.botId,
                    index,
                    member.primary === true ? 1 : 0,
                    member.modelKey ?? null,
                    member.persona ?? null,
                );
            });
        },
        members(): Record<string, RoomMember[]> {
            const rows = db
                .prepare('SELECT * FROM room_members ORDER BY entity_id, position ASC')
                .all() as Array<Record<string, unknown>>;
            const out: Record<string, RoomMember[]> = {};
            for (const row of rows) {
                const id = String(row['entity_id']);
                const member: RoomMember = {
                    botId: String(row['bot_id']),
                    ...(row['primary_flag'] === 1 ? { primary: true } : {}),
                    ...(row['model_key'] === null ? {} : { modelKey: String(row['model_key']) }),
                    ...(row['persona'] === null ? {} : { persona: String(row['persona']) }),
                };
                (out[id] ??= []).push(member);
            }
            return out;
        },
        setDelivery(delivery: Omit<Delivery, 'updatedAt'>): Delivery {
            const updatedAt = Date.now();
            db.prepare(
                'INSERT INTO deliveries (entity_id, message_id, bot_id, state, note, updated_at) VALUES (?,?,?,?,?,?) ' +
                    'ON CONFLICT(entity_id, message_id, bot_id) DO UPDATE SET state=?, note=?, updated_at=?',
            ).run(
                delivery.roomId,
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
        listDeliveries(roomId: string): Delivery[] {
            const rows = db.prepare('SELECT * FROM deliveries WHERE entity_id = ? ORDER BY updated_at ASC').all(roomId) as Record<string, unknown>[];
            return rows.map((row) => ({
                roomId: String(row['entity_id']),
                messageId: String(row['message_id']),
                botId: String(row['bot_id']),
                state: row['state'] as Delivery['state'],
                note: row['note'] === null ? undefined : String(row['note']),
                updatedAt: Number(row['updated_at']),
            }));
        },
        itemsOf(roomId: string, afterSeq = 0): Item[] {
            const rows = db
                .prepare('SELECT seq, item FROM entity_items WHERE entity_id = ? AND seq > ? ORDER BY seq ASC')
                .all(roomId, afterSeq) as Record<string, unknown>[];
            return rows.map((row) => ({ ...(JSON.parse(String(row['item'])) as Item), seq: Number(row['seq']) }));
        },
        seqOf(roomId: string): number {
            const row = db.prepare('SELECT MAX(seq) AS max FROM entity_items WHERE entity_id = ?').get(roomId) as
                | { max: number | null }
                | undefined;
            return row?.max ?? 0;
        },
    };
}
