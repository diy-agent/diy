// db.ts —— node:sqlite：bots（持久）+ 每个实体的 Item 时间线（持久）。
//
// 项目/任务目前放内存（切片阶段），bot 与消息落 sqlite。

import { DatabaseSync } from 'node:sqlite';

import type { TranscriptEntry, TokenUsage } from './compaction';
import type { RoomEntry } from './room-log';
import type { Bot, Delivery, InboxMode, Item, Room, RoomMember } from './types';

/** 一个 bot 在某个房间里的对话快照（持久化单位） */
export interface SessionSnapshot {
    turn: number;
    collapsed: number;
    entries: TranscriptEntry[];
    usage?: TokenUsage;
    /**
     * 保存这份快照时，房间公共日志的水位（RoomLog.lastSeq）。
     * 重启回放时只补这之后的部分 —— 否则快照里已有的公共条目会被再塞一遍，
     * 每重启一次上下文就翻一倍。
     */
    logSeq?: number;
}

/** 一条草稿：某个容器里某个字段尚未提交的输入（value 由消费方解释） */
export interface Draft {
    field: string;
    value: unknown;
    updatedAt: number;
}

/** 投递时的入队信息：崩溃后据此重新投递 */
export interface DeliveryInput extends Omit<Delivery, 'updatedAt'> {
    mode?: InboxMode;
    turn?: number;
    turnId?: string;
}

export interface Store {
    readonly db: DatabaseSync;
    listBots(): Bot[];
    upsertBot(bot: Bot): void;
    /**
     * 容器（项目/任务/…）本身的元数据：名字、类型、data、模型。
     * 成员在 room_members 里单独存；消息在 entity_items 里。
     * 不落这张表的话，运行时新建的容器重启后就从侧栏消失了（数据还在，没入口）。
     */
    saveRoom(room: Room): void;
    listRooms(): Room[];
    /**
     * 删除容器及其**全部从属数据**（消息 / 公共日志 / 成员 / 会话快照 / 投递）。
     * 只删 rooms 一行的话，消息和成员会变成没有入口的孤儿，占着库且再也删不掉。
     * 只删一个 id：项目下任务的级联由调用方（server）决定，库里不懂项目/任务。
     */
    deleteRoom(roomId: string): void;
    /** 删除 bot 身份（容器被删时清理它自动建的专属 bot） */
    deleteBot(botId: string): void;
    appendItem(roomId: string, item: Item): Item;
    setMembers(roomId: string, members: readonly RoomMember[]): void;
    /** roomId → 成员（按 position） */
    members(): Record<string, RoomMember[]>;
    setDelivery(delivery: DeliveryInput): Delivery;
    listDeliveries(roomId: string): Delivery[];
    /** 崩溃恢复：还没送达的投递（queued / delivering） */
    pendingDeliveries(roomId: string): Array<DeliveryInput & { messageId: string }>;
    /** 房间还没处理完的消息正文（按 messageId） */
    textOf(roomId: string, messageId: string): string | undefined;
    saveSession(roomId: string, botId: string, snapshot: SessionSnapshot): void;
    loadSession(roomId: string, botId: string): SessionSnapshot | undefined;
    appendRoomEntry(roomId: string, entry: RoomEntry): void;
    roomEntries(roomId: string): RoomEntry[];
    itemsOf(roomId: string, afterSeq?: number): Item[];
    seqOf(roomId: string): number;
    /** 某个容器的全部草稿（composer / ask:<id> …） */
    listDrafts(roomId: string): Draft[];
    /** 写一条草稿；value 为空内容 = 删除（不存空行） */
    putDraft(roomId: string, field: string, value: unknown): Draft | undefined;
    deleteDraft(roomId: string, field: string): void;
    /** 有草稿的容器 id（侧栏 ✎ 用，一次查完避免 N+1） */
    draftOwners(): string[];
}

/** 草稿是否已经"没有内容"：空串 / 空数组 / 全空对象都算，避免 ✎ 永远亮着 */
function isEmptyDraft(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.every((item) => isEmptyDraft(item));
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every((item) => isEmptyDraft(item));
    return false;
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
        CREATE TABLE IF NOT EXISTS room_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            at INTEGER NOT NULL,
            entry TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS room_entries_room ON room_entries(entity_id, seq);
        CREATE TABLE IF NOT EXISTS session_state (
            entity_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            collapsed INTEGER NOT NULL,
            entries TEXT NOT NULL,
            usage TEXT,
            log_seq INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (entity_id, bot_id)
        );
        CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            data TEXT NOT NULL,
            model_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
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
        CREATE TABLE IF NOT EXISTS drafts (
            owner_id TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (owner_id, field)
        );
    `);

    // 迁移：老的 entity_bots（只有 id 列表）→ room_members（第一位为 primary）
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_bots'").get() as
        | { name: string }
        | undefined;
    if (legacy !== undefined) {
        const count = (db.prepare('SELECT COUNT(*) AS n FROM room_members').get() as { n: number }).n;
        if (count === 0) {
            const rows = db
                .prepare('SELECT entity_id, bot_id, position FROM entity_bots ORDER BY entity_id, position')
                .all() as Array<Record<string, unknown>>;
            const insert = db.prepare(
                'INSERT OR IGNORE INTO room_members (entity_id, bot_id, position, primary_flag) VALUES (?,?,?,?)',
            );
            for (const row of rows) {
                insert.run(
                    String(row['entity_id']),
                    String(row['bot_id']),
                    Number(row['position']),
                    Number(row['position']) === 0 ? 1 : 0,
                );
            }
        }
        db.exec('DROP TABLE entity_bots');
    }

    // 老库补列：mode / turn / turn_id
    const columns = new Set(
        (db.prepare('PRAGMA table_info(deliveries)').all() as Array<Record<string, unknown>>).map((row) =>
            String(row['name']),
        ),
    );
    for (const column of ['mode', 'turn', 'turn_id']) {
        if (!columns.has(column)) db.exec(`ALTER TABLE deliveries ADD COLUMN ${column}`);
    }

    // 老库补列：session_state.log_seq（回放水位）
    const sessionColumns = new Set(
        (db.prepare('PRAGMA table_info(session_state)').all() as Array<Record<string, unknown>>).map((row) =>
            String(row['name']),
        ),
    );
    if (!sessionColumns.has('log_seq'))
        db.exec('ALTER TABLE session_state ADD COLUMN log_seq INTEGER NOT NULL DEFAULT 0');

    /** room_members → roomId: members[]（members() 与 listRooms() 共用） */
    const readMembers = (): Record<string, RoomMember[]> => {
        const rows = db.prepare('SELECT * FROM room_members ORDER BY entity_id, position ASC').all() as Array<
            Record<string, unknown>
        >;
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
    };

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
        deleteRoom(roomId: string): void {
            // 顺序不重要（没有外键），但都按 entity_id 走索引或主键
            db.prepare('DELETE FROM entity_items WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM room_entries WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM session_state WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM deliveries WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM room_members WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM drafts WHERE owner_id = ?').run(roomId);
            db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
        },
        deleteBot(botId: string): void {
            db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
        },
        members(): Record<string, RoomMember[]> {
            return readMembers();
        },
        saveRoom(room: Room): void {
            const data = JSON.stringify(room.data ?? {});
            db.prepare(
                'INSERT INTO rooms (id, type, name, data, model_key, created_at) VALUES (?,?,?,?,?,?) ' +
                    'ON CONFLICT(id) DO UPDATE SET type=?, name=?, data=?, model_key=?',
            ).run(
                room.id,
                room.type,
                room.name,
                data,
                room.modelKey,
                Date.now(),
                room.type,
                room.name,
                data,
                room.modelKey,
            );
        },
        listRooms(): Room[] {
            const members = readMembers();
            const rows = db.prepare('SELECT * FROM rooms ORDER BY created_at ASC, rowid ASC').all() as Array<
                Record<string, unknown>
            >;
            return rows.map((row) => {
                const id = String(row['id']);
                let data: Record<string, unknown> = {};
                try {
                    const parsed: unknown = JSON.parse(String(row['data']));
                    if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
                } catch {
                    /* 坏数据当空对象，不要让整张列表起不来 */
                }
                return {
                    id,
                    type: String(row['type']),
                    name: String(row['name']),
                    data,
                    members: members[id] ?? [],
                    modelKey: String(row['model_key']),
                };
            });
        },
        setDelivery(delivery: DeliveryInput): Delivery {
            const updatedAt = Date.now();
            db.prepare(
                'INSERT INTO deliveries (entity_id, message_id, bot_id, state, note, updated_at, mode, turn, turn_id) ' +
                    'VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_id, message_id, bot_id) DO UPDATE SET ' +
                    'state=?, note=?, updated_at=?, mode=COALESCE(?, mode), turn=COALESCE(?, turn), turn_id=COALESCE(?, turn_id)',
            ).run(
                delivery.roomId,
                delivery.messageId,
                delivery.botId,
                delivery.state,
                delivery.note ?? null,
                updatedAt,
                delivery.mode ?? null,
                delivery.turn ?? null,
                delivery.turnId ?? null,
                delivery.state,
                delivery.note ?? null,
                updatedAt,
                delivery.mode ?? null,
                delivery.turn ?? null,
                delivery.turnId ?? null,
            );
            return { ...delivery, updatedAt };
        },
        listDeliveries(roomId: string): Delivery[] {
            const rows = db
                .prepare('SELECT * FROM deliveries WHERE entity_id = ? ORDER BY updated_at ASC')
                .all(roomId) as Record<string, unknown>[];
            return rows.map((row) => ({
                roomId: String(row['entity_id']),
                messageId: String(row['message_id']),
                botId: String(row['bot_id']),
                state: row['state'] as Delivery['state'],
                note: row['note'] === null ? undefined : String(row['note']),
                updatedAt: Number(row['updated_at']),
            }));
        },
        pendingDeliveries(roomId: string): Array<DeliveryInput & { messageId: string }> {
            const rows = db
                .prepare(
                    "SELECT * FROM deliveries WHERE entity_id = ? AND state IN ('queued','delivering') ORDER BY updated_at ASC",
                )
                .all(roomId) as Array<Record<string, unknown>>;
            return rows.map((row) => ({
                roomId: String(row['entity_id']),
                messageId: String(row['message_id']),
                botId: String(row['bot_id']),
                state: row['state'] as Delivery['state'],
                ...(row['mode'] === null ? {} : { mode: row['mode'] as InboxMode }),
                ...(row['turn'] === null ? {} : { turn: Number(row['turn']) }),
                ...(row['turn_id'] === null ? {} : { turnId: String(row['turn_id']) }),
            }));
        },
        textOf(roomId: string, messageId: string): string | undefined {
            const row = db
                .prepare('SELECT item FROM entity_items WHERE entity_id = ? ORDER BY seq DESC LIMIT 200')
                .all(roomId) as Array<Record<string, unknown>>;
            for (const rowItem of row) {
                const item = JSON.parse(String(rowItem['item'])) as Item;
                if (item.id === messageId && item.type === 'chat') return item.data.text;
            }
            return undefined;
        },
        saveSession(roomId: string, botId: string, snapshot: SessionSnapshot): void {
            db.prepare(
                'INSERT INTO session_state (entity_id, bot_id, turn, collapsed, entries, usage, log_seq, updated_at) VALUES (?,?,?,?,?,?,?,?) ' +
                    'ON CONFLICT(entity_id, bot_id) DO UPDATE SET turn=?, collapsed=?, entries=?, usage=?, log_seq=?, updated_at=?',
            ).run(
                roomId,
                botId,
                snapshot.turn,
                snapshot.collapsed,
                JSON.stringify(snapshot.entries),
                snapshot.usage === undefined ? null : JSON.stringify(snapshot.usage),
                snapshot.logSeq ?? 0,
                Date.now(),
                snapshot.turn,
                snapshot.collapsed,
                JSON.stringify(snapshot.entries),
                snapshot.usage === undefined ? null : JSON.stringify(snapshot.usage),
                snapshot.logSeq ?? 0,
                Date.now(),
            );
        },
        loadSession(roomId: string, botId: string): SessionSnapshot | undefined {
            const row = db
                .prepare('SELECT * FROM session_state WHERE entity_id = ? AND bot_id = ?')
                .get(roomId, botId) as Record<string, unknown> | undefined;
            if (row === undefined) return undefined;
            return {
                turn: Number(row['turn']),
                collapsed: Number(row['collapsed']),
                entries: JSON.parse(String(row['entries'])) as TranscriptEntry[],
                ...(row['usage'] === null ? {} : { usage: JSON.parse(String(row['usage'])) as TokenUsage }),
                ...(row['log_seq'] === null || row['log_seq'] === undefined || Number(row['log_seq']) <= 0
                    ? {}
                    : { logSeq: Number(row['log_seq']) }),
            };
        },
        appendRoomEntry(roomId: string, entry: RoomEntry): void {
            db.prepare('INSERT INTO room_entries (entity_id, seq, at, entry) VALUES (?,?,?,?)').run(
                roomId,
                entry.seq,
                entry.at,
                JSON.stringify(entry),
            );
        },
        roomEntries(roomId: string): RoomEntry[] {
            const rows = db
                .prepare('SELECT entry FROM room_entries WHERE entity_id = ? ORDER BY seq ASC')
                .all(roomId) as Array<Record<string, unknown>>;
            return rows.map((row) => JSON.parse(String(row['entry'])) as RoomEntry);
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
        listDrafts(roomId: string): Draft[] {
            const rows = db
                .prepare('SELECT field, value, updated_at FROM drafts WHERE owner_id = ? ORDER BY updated_at ASC')
                .all(roomId) as Array<Record<string, unknown>>;
            const drafts: Draft[] = [];
            for (const row of rows) {
                let value: unknown;
                try {
                    value = JSON.parse(String(row['value']));
                } catch {
                    continue; // 坏行不该让整个房间的草稿都读不出来
                }
                if (isEmptyDraft(value)) continue;
                drafts.push({ field: String(row['field']), value, updatedAt: Number(row['updated_at']) });
            }
            return drafts;
        },
        putDraft(roomId: string, field: string, value: unknown): Draft | undefined {
            if (isEmptyDraft(value)) {
                db.prepare('DELETE FROM drafts WHERE owner_id = ? AND field = ?').run(roomId, field);
                return undefined;
            }
            const updatedAt = Date.now();
            const serialized = JSON.stringify(value);
            db.prepare(
                'INSERT INTO drafts (owner_id, field, value, updated_at) VALUES (?,?,?,?) ' +
                    'ON CONFLICT(owner_id, field) DO UPDATE SET value=?, updated_at=?',
            ).run(roomId, field, serialized, updatedAt, serialized, updatedAt);
            return { field, value, updatedAt };
        },
        deleteDraft(roomId: string, field: string): void {
            db.prepare('DELETE FROM drafts WHERE owner_id = ? AND field = ?').run(roomId, field);
        },
        draftOwners(): string[] {
            const rows = db.prepare('SELECT owner_id, value FROM drafts').all() as Array<Record<string, unknown>>;
            const owners = new Set<string>();
            for (const row of rows) {
                try {
                    if (!isEmptyDraft(JSON.parse(String(row['value'])))) owners.add(String(row['owner_id']));
                } catch {
                    /* 坏行不算"有草稿" */
                }
            }
            return [...owners];
        },
    };
}
