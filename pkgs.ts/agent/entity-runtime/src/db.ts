// db.ts —— node:sqlite：实体身份 + 域表 + 记录表。
//
// 三层（设计见 docs/plans/2026-11-21-identity.md）：
//   entities  身份：一切可被引用的东西一行（id / type / created_at）。不做存储。
//   tasks     任务域：真源。标题、编号、正文、状态、工作目录都是真列。
//   projects  项目域：真源。项目只是任务的**字段**，不参与目录层级。
//   其余（entity_items / room_entries / session_state / journal_entries …）是**记录**：
//   属于某个实体、没有独立身份、不参与引用。
//
// 插件实体只在 entities 里有一行身份，payload 在插件自己的存储里 —— 我们不碰。

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

/** 任务日志的五种 kind（每种只回答一个问题；写错 kind = 以后查不到） */
export const JOURNAL_KINDS = ['decision', 'pitfall', 'review', 'progress', 'learn'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** 一条任务日志（append-only；房间级） */
export interface JournalEntry {
    seq: number;
    at: number;
    kind: JournalKind;
    text: string;
}

/** 实体身份（`entities` 一行）：可被引用的最小信息 */
export interface EntityRecord {
    id: string;
    type: string;
    createdAt: number;
}

/** 任务域记录（`tasks` 一行）—— 真源。`Room` 只是它的线上投影（给旧 UI 用） */
export interface TaskRecord {
    id: string;
    /** 实例内的显示号：不回收、不重分配（换项目 / 换目录都不变） */
    number: number;
    title: string;
    /** 一句话描述（任务简报） */
    summary: string;
    /** 正文（方案 / 边界 / 验收口径） */
    body: string;
    /** 所属项目：**只是字段**，不产生目录层级，也不做外键（项目删了任务会成为「孤儿」） */
    projectId: string | null;
    /** 工具 cwd；与项目解耦，可指向任意 worktree */
    workspace: string | null;
    status: string;
    closedAt: number | null;
    modelKey: string;
    createdAt: number;
}

/** 写任务：`number` / `createdAt` 缺省由 store 补（number 走 counters，永不回收） */
export type TaskInput = Omit<TaskRecord, 'number' | 'createdAt'> & {
    number?: number;
    createdAt?: number;
};

export interface ProjectRecord {
    id: string;
    name: string;
    /** 项目的默认工作目录；任务新建时可继承，但不是外键关系 */
    workspace: string | null;
    modelKey: string;
    createdAt: number;
}

export type ProjectInput = Omit<ProjectRecord, 'createdAt'> & { createdAt?: number };

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

    // ── 实体身份 ───────────────────────────────────────────────
    /** 身份行（不含域数据）；插件实体的 payload 不在我们这儿 */
    entityOf(id: string): EntityRecord | undefined;

    // ── 任务域（真源）─────────────────────────────────────────
    listTasks(): TaskRecord[];
    taskOf(id: string): TaskRecord | undefined;
    /** upsert；新任务分配一个永不回收的 number */
    saveTask(task: TaskInput): TaskRecord;

    // ── 项目域（真源）─────────────────────────────────────────
    listProjects(): ProjectRecord[];
    projectOf(id: string): ProjectRecord | undefined;
    saveProject(project: ProjectInput): ProjectRecord;

    /**
     * 旧容器接口（**兼容层**）：把 `Room` 拆成/拼回 entities + tasks / projects。
     * 新代码请直接用 `saveTask` / `saveProject`；这里只为 UI 与服务端路由平滑迁移。
     * core 只有 project / task 两类容器 —— 其它类型走实体会话，不走 Room。
     */
    saveRoom(room: Room): void;
    listRooms(): Room[];
    /**
     * 删除容器及其**全部从属数据**（消息 / 公共日志 / 成员 / 会话快照 / 投递 / 域行）。
     * 只删一个 id：项目下任务的级联由调用方（server）决定，库里不懂项目/任务。
     */
    deleteRoom(roomId: string): void;
    /** 删除 bot 身份（容器被删时清理它自动建的专属 bot） */
    deleteBot(botId: string): void;
    appendItem(roomId: string, item: Item): Item;
    /** 追加一条任务日志（append-only；回放用 `journalOf`） */
    appendJournal(roomId: string, input: { kind: JournalKind; text: string; at?: number }): JournalEntry;
    /** 最近 N 条任务日志（时间正序；缺省 24） */
    journalOf(roomId: string, limit?: number): JournalEntry[];
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
    /**
     * 有草稿的容器 id，按种类分开：`input`（发言框 / 对话框表单）与 `ask`（提问卡半填答案）。
     * 一次扫描查完避免 N+1。
     *
     * 目前只有 `input` 有运行时消费者（侧栏 ✎）；`ask` 这一半没人读 —— 侧栏的 `?` 数的是
     * 提问本身的未决数（`Actor.pendingAsks`），不是「答了一半的草稿」：提问卡已经在时间线上
     * 摆着，再加个 `?` 只是噪音。留着这一半是为了让分类被测试钉住（见 db.test.ts），
     * 等真出现第二个消费者再用。
     *
     * 为什么不合成一个列表：合起来就分不出「发言框有字」和「提问答了一半」，而这两件事
     * 在侧栏该不该亮是相反的。
     */
    draftOwnersByKind(): { input: string[]; ask: string[] };
    /**
     * 容器 id → 最后一条 item 的时刻（毫秒）。侧栏「最后活动」用，一次查完避免 N+1。
     *
     * 这是**投影**不是事实：`rooms` 表故意不存 updated_at —— 那条路径要改名 / 改状态 /
     * 加成员 / 发消息四个写点都记得盖章才不会漂。这里的 smell 就一条：只反映「聊过」，
     * 改个名字不算活动（见 ## 讨论）。没有 item 的容器不出现在结果里（由调用方显示「—」）。
     *
     * 实现是一条 `GROUP BY entity_id` 取 `MAX(at)`：靠 `items_entity_at` 覆盖索引才是
     * 索引扫描而不是全表扫（实测差 20 倍，见建表处）。那条索引是这条查询的一部分，别删。
     */
    lastItemAtByRoom(): Record<string, number>;
    /**
     * 清掉「已经没有结局可言」的 ask 草稿：`ask:<id>` 不在 keepAskIds 里（时间线上不再等回答）
     * 且早于 olderThan。返回清掉的条数。
     *
     * 为什么要有它：提问从时间线上彻底消失（房间重开、条目被裁）时没人替它清草稿，
     * 侧栏 ✎ 会为一个早就不存在的提问一直亮着。
     */
    pruneAskDrafts(roomId: string, keepAskIds: ReadonlySet<string>, olderThan: number): number;
    /** 清掉 owner 前缀匹配、且早于 olderThan 的草稿（synthetic scope 不随房间级联删） */
    pruneDraftOwners(ownerPrefix: string, olderThan: number): number;
}

/** LIKE 匹配用：把 % _ \ 转义掉（id 里出现也不能当通配符） */
function likeEscape(text: string): string {
    return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** LIKE 前缀匹配：escape + 结尾 % */
function likePrefix(prefix: string): string {
    return `${likeEscape(prefix)}%`;
}

/** ask 草稿的字段前缀：`ask:<askId>`（见 docs/drafts-design.md §5） */
export const ASK_DRAFT_PREFIX = 'ask:';

/** 草稿是否已经"没有内容"：空串 / 空数组 / 全空对象都算，避免 ✎ 永远亮着 */
function isEmptyDraft(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.every((item) => isEmptyDraft(item));
    if (typeof value === 'object')
        return Object.values(value as Record<string, unknown>).every((item) => isEmptyDraft(item));
    return false;
}

// ── Room（旧线上形状）↔ 域记录 ─────────────────────────────────────
//
// `Room` 曾经就是「一个 data 袋子」；现在它只是域记录给旧 UI / 路由看的投影。
// 只认下面这些键：其余键**不读也不写** —— 老库里可能残留 diy1 时代的字段，
// 但绝不能让它们再被存回去（core 不再有开放袋子）。

function dataText(room: Room, key: string): string {
    const value = room.data[key];
    return typeof value === 'string' ? value : '';
}

function roomToTask(room: Room): TaskInput {
    const closedAt = room.data['closedAt'];
    return {
        id: room.id,
        title: room.name,
        summary: dataText(room, 'desc'),
        body: dataText(room, 'body'),
        projectId: dataText(room, 'projectId') || null,
        workspace: dataText(room, 'dir') || null,
        status: dataText(room, 'status') || 'open',
        closedAt: typeof closedAt === 'number' ? closedAt : null,
        modelKey: room.modelKey,
    };
}

function roomToProject(room: Room): ProjectInput {
    return {
        id: room.id,
        name: room.name,
        workspace: dataText(room, 'dir') || null,
        modelKey: room.modelKey,
    };
}

function taskToRoom(task: TaskRecord, members: RoomMember[]): Room {
    const data: Record<string, unknown> = { status: task.status };
    if (task.projectId !== null) data['projectId'] = task.projectId;
    if (task.workspace !== null) data['dir'] = task.workspace;
    if (task.closedAt !== null) data['closedAt'] = task.closedAt;
    if (task.summary !== '') data['desc'] = task.summary;
    if (task.body !== '') data['body'] = task.body;
    return { id: task.id, type: 'task', name: task.title, data, members, modelKey: task.modelKey };
}

function projectToRoom(project: ProjectRecord, members: RoomMember[]): Room {
    const data: Record<string, unknown> = {};
    if (project.workspace !== null) data['dir'] = project.workspace;
    return { id: project.id, type: 'project', name: project.name, data, members, modelKey: project.modelKey };
}

export function openStore(file: string): Store {
    const db = new DatabaseSync(file === ':memory:' ? ':memory:' : file);
    // 域表用 ON DELETE CASCADE 挂在 entities 上；不打开这个 pragma 就只是注释
    db.exec('PRAGMA foreign_keys = ON');
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
        -- 「每个容器最后一条 item 的时间」要 GROUP BY entity_id 取 MAX(at)：
        -- 没有这条覆盖索引就是全表扫（6409 条实测 15.6ms，随历史线性涨），有了是 0.7ms。
        CREATE INDEX IF NOT EXISTS items_entity_at ON entity_items(entity_id, at);
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
        -- 身份：一切可被引用的东西一行。不做存储，只有「是谁」。
        CREATE TABLE IF NOT EXISTS entities (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS entities_type ON entities(type);
        -- 项目域（1:1 挂在 entities 上）
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            workspace TEXT,
            model_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        -- 任务域（1:1 挂在 entities 上）。项目是**字段**不是父目录，所以不做外键
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
            number INTEGER NOT NULL UNIQUE,
            title TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            project_id TEXT,
            workspace TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            closed_at INTEGER,
            model_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status, id);
        -- 编号分配：next = 下一个要发的号。独立于任务行，所以删任务不会回收号码
        CREATE TABLE IF NOT EXISTS counters (
            scope TEXT PRIMARY KEY,
            next INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO counters (scope, next) VALUES ('task', 1);
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
        -- 任务日志：append-only（decision / pitfall / review / progress / learn）
        CREATE TABLE IF NOT EXISTS journal_entries (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id TEXT NOT NULL,
            at INTEGER NOT NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS journal_entity ON journal_entries(entity_id, seq);
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

    // ── 域表读写（saveTask / saveProject 与老库迁移共用）─────────────────

    const writeEntity = (id: string, type: string, createdAt: number): void => {
        db.prepare('INSERT INTO entities (id, type, created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run(
            id,
            type,
            createdAt,
        );
    };

    /**
     * 分配任务号：`next` 是「下一个要发的号」，独立于任务行。
     * 一条语句原子完成（counters 不存在就种 1，否则 +1 并返回旧值），所以删掉最大号也不会被回收。
     */
    const allocateTaskNumber = (): number => {
        const row = db
            .prepare(
                "INSERT INTO counters (scope, next) VALUES ('task', 2) " +
                    'ON CONFLICT(scope) DO UPDATE SET next = next + 1 RETURNING next - 1 AS n',
            )
            .get() as { n: number };
        return Number(row.n);
    };

    const readTaskRow = (row: Record<string, unknown>): TaskRecord => ({
        id: String(row['id']),
        number: Number(row['number']),
        title: String(row['title']),
        summary: String(row['summary']),
        body: String(row['body']),
        projectId: row['project_id'] === null ? null : String(row['project_id']),
        workspace: row['workspace'] === null ? null : String(row['workspace']),
        status: String(row['status']),
        closedAt: row['closed_at'] === null ? null : Number(row['closed_at']),
        modelKey: String(row['model_key']),
        createdAt: Number(row['created_at']),
    });

    const readProjectRow = (row: Record<string, unknown>): ProjectRecord => ({
        id: String(row['id']),
        name: String(row['name']),
        workspace: row['workspace'] === null ? null : String(row['workspace']),
        modelKey: String(row['model_key']),
        createdAt: Number(row['created_at']),
    });

    const writeTask = (task: TaskInput): TaskRecord => {
        const existing = db.prepare('SELECT number, created_at FROM tasks WHERE id = ?').get(task.id) as
            | { number: number; created_at: number }
            | undefined;
        const createdAt = existing?.created_at ?? task.createdAt ?? Date.now();
        const number = existing?.number ?? task.number ?? allocateTaskNumber();

        db.exec('BEGIN IMMEDIATE');
        try {
            writeEntity(task.id, 'task', createdAt);
            db.prepare(
                'INSERT INTO tasks (id, number, title, summary, body, project_id, workspace, status, closed_at, model_key, created_at) ' +
                    'VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
                    'title=excluded.title, summary=excluded.summary, body=excluded.body, project_id=excluded.project_id, ' +
                    'workspace=excluded.workspace, status=excluded.status, closed_at=excluded.closed_at, model_key=excluded.model_key',
            ).run(
                task.id,
                number,
                task.title,
                task.summary,
                task.body,
                task.projectId ?? null,
                task.workspace ?? null,
                task.status,
                task.closedAt ?? null,
                task.modelKey,
                createdAt,
            );
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return { ...task, number, createdAt };
    };

    const writeProject = (project: ProjectInput): ProjectRecord => {
        const existing = db.prepare('SELECT created_at FROM projects WHERE id = ?').get(project.id) as
            | { created_at: number }
            | undefined;
        const createdAt = existing?.created_at ?? project.createdAt ?? Date.now();

        db.exec('BEGIN IMMEDIATE');
        try {
            writeEntity(project.id, 'project', createdAt);
            db.prepare(
                'INSERT INTO projects (id, name, workspace, model_key, created_at) VALUES (?,?,?,?,?) ' +
                    'ON CONFLICT(id) DO UPDATE SET name=excluded.name, workspace=excluded.workspace, model_key=excluded.model_key',
            ).run(project.id, project.name, project.workspace ?? null, project.modelKey, createdAt);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return { ...project, createdAt };
    };

    /**
     * 老库迁移：rooms（一个 data JSON 袋子）→ entities + tasks / projects。
     *
     * 幂等：逐行 upsert，编号沿用已有行；全部成功后才把 rooms 改名成备份表。
     * 中途抛错则 rooms 原样留着，下次启动重试 —— 不会出现「一半搬完、入口全丢」。
     */
    const migrateLegacyRooms = (): void => {
        const rows = db.prepare('SELECT * FROM rooms ORDER BY created_at ASC, rowid ASC').all() as Array<
            Record<string, unknown>
        >;
        for (const row of rows) {
            const id = String(row['id']);
            const type = String(row['type']);
            const createdAt = Number(row['created_at']) || Date.now();
            let data: Record<string, unknown> = {};
            try {
                const parsed: unknown = JSON.parse(String(row['data']));
                if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
            } catch {
                /* 坏 data 不该拦住整库迁移：当成空对象，至少保住身份与名字 */
            }
            const text = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '');
            const legacyStatus: Record<string, string> = { todo: 'open', doing: 'open', done: 'closed' };
            const rawStatus = text('status').trim().toLowerCase();

            if (type === 'task') {
                writeTask({
                    id,
                    title: String(row['name']),
                    summary: text('desc'),
                    body: text('body'),
                    projectId: text('projectId') || null,
                    workspace: text('dir') || null,
                    status: legacyStatus[rawStatus] ?? (rawStatus === '' ? 'open' : rawStatus),
                    closedAt: typeof data['closedAt'] === 'number' ? data['closedAt'] : null,
                    modelKey: String(row['model_key']),
                    createdAt,
                });
            } else if (type === 'project') {
                writeProject({
                    id,
                    name: String(row['name']),
                    workspace: text('dir') || null,
                    modelKey: String(row['model_key']),
                    createdAt,
                });
            } else {
                // 历史上有过其它类型：保住身份，不进任何域表
                writeEntity(id, type, createdAt);
            }
        }

        const max = db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM tasks').get() as { n: number };
        db.prepare("UPDATE counters SET next = ? WHERE scope = 'task'").run(Number(max.n) + 1);

        // 备份表名避开已有：迁移完成过一次就不会再有 rooms
        let backup = 'rooms_v0';
        for (let i = 1; ; i += 1) {
            const taken = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(backup) as
                | { x: number }
                | undefined;
            if (taken === undefined) break;
            backup = `rooms_v0_${i}`;
        }
        db.exec(`ALTER TABLE rooms RENAME TO ${backup}`);
    };

    const hasLegacyRooms =
        db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='rooms'").get() !== undefined;
    if (hasLegacyRooms) migrateLegacyRooms();

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
        appendJournal(roomId: string, input: { kind: JournalKind; text: string; at?: number }): JournalEntry {
            const at = input.at ?? Date.now();
            const result = db
                .prepare('INSERT INTO journal_entries (entity_id, at, kind, text) VALUES (?,?,?,?)')
                .run(roomId, at, input.kind, input.text);
            return { seq: Number(result.lastInsertRowid), at, kind: input.kind, text: input.text };
        },
        journalOf(roomId: string, limit = 24): JournalEntry[] {
            const rows = db
                .prepare(
                    'SELECT seq, at, kind, text FROM journal_entries WHERE entity_id = ? ORDER BY seq DESC LIMIT ?',
                )
                .all(roomId, limit) as Array<Record<string, unknown>>;
            return rows
                .map((row) => ({
                    seq: Number(row['seq']),
                    at: Number(row['at']),
                    kind: String(row['kind']) as JournalKind,
                    text: String(row['text']),
                }))
                .reverse();
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
            db.prepare('DELETE FROM journal_entries WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM drafts WHERE owner_id = ?').run(roomId);
            // 对话框草稿（synthetic scope，见 docs/drafts-design.md）挂在房间后面：
            // `dlg:<用途>:<roomId>`。删房间时一起清，不等 TTL
            db.prepare("DELETE FROM drafts WHERE owner_id LIKE ? ESCAPE '\\'").run(`dlg:%:${likeEscape(roomId)}`);
            // 身份一行 + 域行（tasks / projects 靠 ON DELETE CASCADE 跟着走）
            db.prepare('DELETE FROM entities WHERE id = ?').run(roomId);
        },
        deleteBot(botId: string): void {
            db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
        },
        members(): Record<string, RoomMember[]> {
            return readMembers();
        },
        entityOf(id: string): EntityRecord | undefined {
            const row = db.prepare('SELECT id, type, created_at FROM entities WHERE id = ?').get(id) as
                | Record<string, unknown>
                | undefined;
            if (row === undefined) return undefined;
            return { id: String(row['id']), type: String(row['type']), createdAt: Number(row['created_at']) };
        },
        listTasks(): TaskRecord[] {
            const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC').all() as Array<
                Record<string, unknown>
            >;
            return rows.map(readTaskRow);
        },
        taskOf(id: string): TaskRecord | undefined {
            const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
            return row === undefined ? undefined : readTaskRow(row);
        },
        saveTask(task: TaskInput): TaskRecord {
            return writeTask(task);
        },
        listProjects(): ProjectRecord[] {
            const rows = db.prepare('SELECT * FROM projects ORDER BY created_at ASC, rowid ASC').all() as Array<
                Record<string, unknown>
            >;
            return rows.map(readProjectRow);
        },
        projectOf(id: string): ProjectRecord | undefined {
            const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
                | Record<string, unknown>
                | undefined;
            return row === undefined ? undefined : readProjectRow(row);
        },
        saveProject(project: ProjectInput): ProjectRecord {
            return writeProject(project);
        },
        saveRoom(room: Room): void {
            if (room.type === 'project') {
                writeProject(roomToProject(room));
                return;
            }
            if (room.type === 'task') {
                writeTask(roomToTask(room));
                return;
            }
            throw new Error(
                `Room 只承载 project / task；${room.type} 是实体类型，payload 应放插件自己的存储（见 docs/plans/2026-11-21-identity.md）`,
            );
        },
        listRooms(): Room[] {
            const members = readMembers();
            const out: Array<{ createdAt: number; room: Room }> = [];
            const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC, rowid ASC').all() as Array<
                Record<string, unknown>
            >;
            for (const row of projects) {
                const project = readProjectRow(row);
                out.push({ createdAt: project.createdAt, room: projectToRoom(project, members[project.id] ?? []) });
            }
            const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC').all() as Array<
                Record<string, unknown>
            >;
            for (const row of tasks) {
                const task = readTaskRow(row);
                out.push({ createdAt: task.createdAt, room: taskToRoom(task, members[task.id] ?? []) });
            }
            return out.sort((a, b) => a.createdAt - b.createdAt).map((entry) => entry.room);
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
        lastItemAtByRoom(): Record<string, number> {
            const rows = db
                .prepare('SELECT entity_id, MAX(at) AS last FROM entity_items GROUP BY entity_id')
                .all() as Array<Record<string, unknown>>;
            const out: Record<string, number> = {};
            for (const row of rows) {
                const at = Number(row['last']);
                if (Number.isFinite(at) && at > 0) out[String(row['entity_id'])] = at;
            }
            return out;
        },
        draftOwnersByKind(): { input: string[]; ask: string[] } {
            const rows = db.prepare('SELECT owner_id, field, value FROM drafts').all() as Array<
                Record<string, unknown>
            >;
            const input = new Set<string>();
            const ask = new Set<string>();
            for (const row of rows) {
                try {
                    if (isEmptyDraft(JSON.parse(String(row['value'])))) continue;
                } catch {
                    continue; // 坏行不算"有草稿"
                }
                const owner = String(row['owner_id']);
                if (String(row['field']).startsWith(ASK_DRAFT_PREFIX)) ask.add(owner);
                else input.add(owner);
            }
            return { input: [...input], ask: [...ask] };
        },
        pruneAskDrafts(roomId: string, keepAskIds: ReadonlySet<string>, olderThan: number): number {
            const stale = db
                .prepare("SELECT field FROM drafts WHERE owner_id = ? AND field LIKE ? || '%' AND updated_at < ?")
                .all(roomId, ASK_DRAFT_PREFIX, olderThan) as Array<Record<string, unknown>>;
            const remove = db.prepare('DELETE FROM drafts WHERE owner_id = ? AND field = ?');
            let count = 0;
            for (const row of stale) {
                const field = String(row['field']);
                if (keepAskIds.has(field.slice(ASK_DRAFT_PREFIX.length))) continue;
                remove.run(roomId, field);
                count += 1;
            }
            return count;
        },
        pruneDraftOwners(ownerPrefix: string, olderThan: number): number {
            const result = db
                .prepare("DELETE FROM drafts WHERE owner_id LIKE ? ESCAPE '\\' AND updated_at < ?")
                .run(likePrefix(ownerPrefix), olderThan);
            return Number(result.changes);
        },
    };
}
