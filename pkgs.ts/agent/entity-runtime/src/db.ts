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

import { dirname, resolve } from 'node:path';

import type { TranscriptEntry, TokenUsage } from './compaction';
import { isLinkKind } from './id';
import type { RoomEntry } from './room-log';
import { appendJournalLine, taskDirOf as taskDirAt, trashTaskDir, writeTaskDoc } from './task-dir';
import type { Bot, AskAnswer, AskRequest, Delivery, InboxMode, Item, Room, RoomMember } from './types';

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

/**
 * 「一轮开了头、还没收尾」的标记（`turn_open`，一行一 bot）。
 *
 * 存在的理由：`completed` / `interrupted` 都不产条目，进程崩在那一段时磁盘上没留下
 * 任何「这轮开始过」的痕迹 —— 结局判据只能读成「正常结束」（见 bot-status.ts 的局限说明）。
 * 轮开始写一行、收尾删一行；进程重启后还留着 = 上一轮没走到收尾。
 */
export interface OpenTurn {
    botId: string;
    turn: number;
    turnId: string;
    at: number;
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

/**
 * 一次提问的持久化记录。
 *
 * ask 不阻塞（工具立即返回、run 照常结束），所以「还在等回答」这个状态本来只在
 * `AskGate` 的内存里 —— 进程一重启卡片就消失，而模型那边早以为问过了。
 * 待答也必须落库。
 */
export interface AskRecord {
    askId: string;
    entityId: string;
    /** 提问时刻 */
    at: number;
    request: AskRequest;
    /**
     * `expired` = 过期（`cancelled` 的一种）：不是环境没了，是它依赖的状态翻篇了
     *（提问者开了新一轮 / 同一个人又提了一次问）。单独存一个值，是为了重启后
     * 卡片还能说清「为什么没答成」，而不是笼统的「已失效」。
     */
    state: 'pending' | 'answered' | 'cancelled' | 'expired';
    answer?: AskAnswer;
    reason?: string;
    settledAt?: number;
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
    /** 最后一次**内容变化**的时刻（启动时的重复保存不算） */
    updatedAt: number;
}

/** 写任务：`number` / `createdAt` / `updatedAt` 缺省由 store 补（number 走 counters，永不回收） */
export type TaskInput = Omit<TaskRecord, 'number' | 'createdAt' | 'updatedAt'> & {
    number?: number;
    createdAt?: number;
    updatedAt?: number;
};

/** unit 的三种状态。**没有 cancelled** —— 取消就是真删（痕迹留在 `unit.dropped` 事件里） */
export const UNIT_STATUSES = ['open', 'doing', 'done'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

function isUnitStatus(value: string): value is UnitStatus {
    return (UNIT_STATUSES as readonly string[]).includes(value);
}

/**
 * 任务内的工作单元（`task_units` 一行）—— **task 私有**，不是实体：
 * 不占 #号、不进侧栏、不被 `entity_links` 引用。`id` 形如 `u1`、`u2`，**只在同一 task 内唯一**，
 * 所以所有读写入口都必须带上 `taskId`（跨 task 会重号，这是刻意的：人读短、agent 引用短）。
 *
 * 2026-11-25 用户裁：这里只记**需求**（要做成什么样），不记执行规划。
 * 于是只有一条关系 —— `parent`（这块需求由哪几块组成）；没有依赖边、没有分层、没有批次。
 * 为什么：人的对齐只到「要做哪些事」，而「先做哪个、一次做几条」是执行时的判断，写进账本
 * 反而要人提前排一遍序，排完还得维护。bot 每次自己从树里挑（见 `units.ts` 的 `ready`）。
 */
export interface UnitRecord {
    taskId: string;
    id: string;
    title: string;
    /** 这一步做什么 + 验收口径（不是任务方案全文：方案在 task.body） */
    body: string;
    status: UnitStatus;
    /**
     * 树上的父（功能域 / 母项）id；`null` = 根。
     *
     * 唯一的层级关系：父子表达「这块需求由哪几块组成」，就是人说话时的递归切分。
     * 它不带执行含义 —— 有子的节点是容器（自己不动手），叶子才是可动手的一条。
     */
    parent: string | null;
    /** 创建序：只用于稳定排序（同父兄弟的先后也按它），不随状态变化重排 */
    seq: number;
    createdAt: number;
    updatedAt: number;
}

/** 写 unit：`id` / `seq` / 时间戳缺省由 store 补（新 unit 的 id 走 counters，永不回收） */
export type UnitInput = Omit<UnitRecord, 'id' | 'parent' | 'seq' | 'createdAt' | 'updatedAt'> & {
    id?: string;
    /** 父（功能域）；缺省 = 沿用库里已有的，库里也没有就是根 */
    parent?: string | null;
    createdAt?: number;
    updatedAt?: number;
    /**
     * 显式给的 id 允许**是新的**（agent 自起的 key，见 `tools/units.ts` 的 `unit_add`）。
     * 缺省 false：`u<n>` 号只能由 counters 发，否则「不回收」就破了。
     * 已存在的 id 永远走更新，`allowNewId` 不影响它。
     */
    allowNewId?: boolean;
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

/** 一条实体关系（有向）：`from --kind--> to` */
export interface EntityLink {
    from: string;
    to: string;
    kind: string;
}

/** 某个实体的关系：出边与入边分开（反向链接由索引算，不要求手写双向） */
export interface LinkSets {
    out: EntityLink[];
    in: EntityLink[];
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

    // ── 提问（ask 不阻塞，待答状态必须落库）──────────────────
    /** 写一条提问：新建 pending / 收尾时改成 answered | cancelled（幂等） */
    putAsk(record: AskRecord): void;
    /** 某个容器的提问（旧→新，含 pending 与已收尾） */
    asksOf(entityId: string): AskRecord[];
    /** 只留最近 keep 条**已收尾**的（pending 永不剪）；返回删了几条 */
    pruneAsks(entityId: string, keep: number): number;

    // ── 实体身份 ───────────────────────────────────────────────
    /** 身份行（不含域数据）；插件实体的 payload 不在我们这儿 */
    entityOf(id: string): EntityRecord | undefined;

    // ── 任务域（真源）─────────────────────────────────────────
    listTasks(): TaskRecord[];
    taskOf(id: string): TaskRecord | undefined;
    /** upsert；新任务分配一个永不回收的 number */
    saveTask(task: TaskInput): TaskRecord;
    /**
     * 任务的产物目录（`<数据根>/tasks/2026-11-21/<id>/`）：由创建日派生，**只算路径不创建**。
     * `:memory:` 库或不是任务时返回 undefined。
     */
    taskDirOf(id: string): string | undefined;

    // ── 项目域（真源）─────────────────────────────────────────
    listProjects(): ProjectRecord[];
    projectOf(id: string): ProjectRecord | undefined;
    saveProject(project: ProjectInput): ProjectRecord;

    // ── 任务的需求账本树（task 私有；只有 parent 一条关系）──────
    /** 某任务的全部 unit（创建序）。**不是实体**：没有 number / 不进侧栏 */
    listUnits(taskId: string): UnitRecord[];
    unitOf(taskId: string, unitId: string): UnitRecord | undefined;
    /** upsert；新 unit 分配 `u<n>`（不回收），显式给的 id 必须已存在 */
    saveUnit(unit: UnitInput): UnitRecord;
    /** 删一个 unit；返回是否真删了（幂等） */
    removeUnit(taskId: string, unitId: string): boolean;

    // ── 关系（替代父子）──────────────────────────────────────
    /**
     * 建一条有向关系。校验：kind 合法、两端实体存在、不自连；
     * `blocks` 额外查环（A→B→…→A 会让任务永远阻塞）。
     */
    link(from: string, to: string, kind: string): EntityLink;
    /** 删一条关系；返回是否真的删掉了（幂等） */
    unlink(from: string, to: string, kind: string): boolean;
    /** 出边 + 入边（入边 = 「谁指向我」，不需要调用方写反向） */
    linksOf(id: string): LinkSets;

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
    /**
     * 追加一条领域事件（通用）。命名约定同 journal：`<type>.<verb>`（实体类型做前缀）。
     * unit 变更走这里（`task.unit.added` 等）而**不走 journal**：journal 五种 kind 的服务对象是
     * 人，且最近 24 条要进 system 上下文 —— unit 变频率高，塞进去会把真决策挤出去。
     */
    appendEvent(input: {
        event: string;
        subject: string;
        actor?: string | null;
        data?: unknown;
        at?: number;
    }): number;
    /** 某个实体的事件（新→旧）；`prefix` 非空时只取该前缀（如 `task.unit.`） */
    eventsOf(
        subject: string,
        prefix?: string,
        limit?: number,
    ): Array<{ seq: number; at: number; event: string; data: unknown }>;
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
    /** 记下「这个成员开始了第 turn 轮、还没收尾」（轮开始时写，收尾时删） */
    openTurn(roomId: string, record: OpenTurn): void;
    /** 这一轮走到收尾了，销掉标记 */
    closeTurn(roomId: string, botId: string): void;
    /** 还挂着没收尾的轮（重启后非空 = 上次没跑完的那几个） */
    openTurns(roomId: string): OpenTurn[];
    /**
     * 撤掉某一轮的「中断」事实（那一轮其实还会续跑 / 续跑完了）。
     *
     * 误报的来路：重启时看到 `turn_open` 就报「没跑完」，但 diy2 的恢复会**按原 turn 号重放投递**
     * （`deliveries.state='delivering'`），同一轮随即续跑 —— 于是磁盘上留下一条与后续内容
     * 自相矛盾的事实，且因为「续跑完成不产条目」它会永远是该轮的最后一条轮级事实（结局被误标）。
     *
     * 为什么是 DELETE 而不是补条目：items 没有「更新 / 撤回」通道（事件只有 append 型 `item`），
     * 补一条只会让消息流里多一条噪音。删库的代价是在线页面（只做增量）要刷新才消失 ——
     * 这个调用点全在重启后，页面对应的那次重连本来就会重拉。
     */
    deleteInterruptedFacts(roomId: string, turnId: string, botId: string): number;
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
     * 每个 bot 在给定房间里的**最后一条 item**（「上一轮怎么结束的」的唯一来源）。
     *
     * 一轮收尾时 `endItems()` 产出的 notice / error 就是该轮最后落盘的条目，
     * 所以这一条既是「谁最后说话」也是「怎么停的」—— 判据在 `bot-status.ts`，
     * 这里只负责把「每个 (房间, bot) 的最后一条」查出来（别在调用方循环 N 次读全量）。
     *
     * 不给 `roomIds` = 全实例一张表（三级面板用）；给了就只查这几个房间。
     * 注意这是**磁盘侧**的结论：正在跑的轮次最后一条还是中途产出，会读成「正常」——
     * 在跑 / 等回答由内存侧（`runningBots` / `pendingAsks`）覆盖。
     */
    lastItemPerBot(roomIds?: readonly string[]): Array<{ roomId: string; item: Item }>;
    /**
     * 每条**轮级事实**（不带 author 的 notice / error）的最后一条，按归属分组。
     *
     * `lastItemPerBot` 按 `author.id` 分组，恰好把结局事实排除了（见 bot-status.ts 的论证）。
     * 它们只能单独认领，所以单独一条查询：调用方先拿到 bot 最后一轮，再从这里取那一轮的结局。
     *
     * `owner` = 事实自带的 `data.botId`，没有就退回 `turnId`：
     *   · 新数据带 botId —— `turnId` 是房间级的（@all 各 bot 共享），只按它归属会张冠李戴；
     *   · 老数据没有 botId，只能按轮认（实测历史数据里带结局的轮全部只有一个 bot，所以安全）。
     * 调用方先看 botId 命中、再看 turnId 命中，新数据自动优先。
     */
    lastFactPerTurn(roomIds?: readonly string[]): Array<{ roomId: string; owner: string; item: Item }>;
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
        title: dataText(room, 'title'),
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
        name: dataText(room, 'name'),
        workspace: dataText(room, 'dir') || null,
        modelKey: room.modelKey,
    };
}

function taskToRoom(task: TaskRecord, members: RoomMember[], taskDir?: string): Room {
    const data: Record<string, unknown> = { status: task.status, number: task.number };
    if (task.projectId !== null) data['projectId'] = task.projectId;
    if (task.workspace !== null) data['dir'] = task.workspace;
    if (task.closedAt !== null) data['closedAt'] = task.closedAt;
    if (task.summary !== '') data['desc'] = task.summary;
    if (task.body !== '') data['body'] = task.body;
    // 容器名跟着容器走：任务的标题就在 data.title（Room 本身没有 name）
    data['title'] = task.title;
    // 只读：产物目录由创建日派生（不落库、不参与保存）
    if (taskDir !== undefined) data['taskDir'] = taskDir;
    return { id: task.id, type: 'task', data, members, modelKey: task.modelKey };
}

function projectToRoom(project: ProjectRecord, members: RoomMember[]): Room {
    const data: Record<string, unknown> = { name: project.name };
    if (project.workspace !== null) data['dir'] = project.workspace;
    return { id: project.id, type: 'project', data, members, modelKey: project.modelKey };
}

export function openStore(file: string): Store {
    const db = new DatabaseSync(file === ':memory:' ? ':memory:' : file);
    // 数据根 = 数据库所在目录（`<home>/diy2.db` → `<home>/tasks/...`）；内存库没有磁盘产物
    const dataRoot = file === ':memory:' ? undefined : dirname(resolve(file));
    /**
     * 写导出物是**尽力而为**：磁盘满 / 权限不对只记日志，不该让任务存不下去
     * （DB 才是真源，文件和它不一致时以 DB 为准）。
     */
    const mirror = (fn: () => void): void => {
        try {
            fn();
        } catch (error) {
            console.error(`[task-dir] ${(error as Error).message}`);
        }
    };
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
        -- 「每个 bot 最后一条 item」与「每轮最后一条结局事实」都在 json 里分组：
        -- author.id、归属 = COALESCE(data.botId, turnId)。没有下面两条表达式索引就是
        -- 全表扫 118MB 的 json（实测 2.7 万行：8.4s / 3.5s），有了是 25ms / 54ms。
        -- 部分索引让体积停在 1.3MB / 0.02MB；WHERE 必须与查询里的过滤条件逐字一致才命中。
        CREATE INDEX IF NOT EXISTS items_author_seq ON entity_items(
            entity_id, json_extract(item, '$.author.id'), seq
        ) WHERE json_extract(item, '$.author.id') IS NOT NULL;
        CREATE INDEX IF NOT EXISTS items_fact_owner_seq ON entity_items(
            entity_id,
            COALESCE(json_extract(item, '$.data.botId'), json_extract(item, '$.turnId')),
            seq
        ) WHERE json_extract(item, '$.author.id') IS NULL
            AND json_extract(item, '$.type') IN ('notice', 'error');
        -- 「这一轮报过中断吗」与「续跑时要撤掉哪条」都按 (kind, turnId, botId) 定位。
        -- 表里 kind='interrupted' 的行通常只有个位数，部分索引因此极小；
        -- WHERE 必须与 deleteInterruptedFacts 的过滤条件逐字一致才命中。
        CREATE INDEX IF NOT EXISTS items_interrupted ON entity_items(
            entity_id,
            json_extract(item, '$.turnId'),
            json_extract(item, '$.data.botId')
        ) WHERE json_extract(item, '$.data.kind') = 'interrupted';
        CREATE TABLE IF NOT EXISTS room_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            at INTEGER NOT NULL,
            entry TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS room_entries_room ON room_entries(entity_id, seq);
        -- 提问：ask 不阻塞，待答状态只在内存里的话重启即丢（见 AskRecord）
        CREATE TABLE IF NOT EXISTS asks (
            ask_id     TEXT PRIMARY KEY,
            entity_id  TEXT NOT NULL,
            at         INTEGER NOT NULL,
            request    TEXT NOT NULL,
            state      TEXT NOT NULL,
            answer     TEXT,
            reason     TEXT,
            settled_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS asks_entity ON asks(entity_id, at);
        -- 开了头没收尾的轮（一 bot 一行）：崩溃/被杀后重启靠它认出「那一轮没跑完」
        CREATE TABLE IF NOT EXISTS turn_open (
            entity_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            turn_id TEXT NOT NULL,
            at INTEGER NOT NULL,
            PRIMARY KEY (entity_id, bot_id)
        );
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status, id);
        -- 编号分配：next = 下一个要发的号。独立于任务行，所以删任务不会回收号码
        CREATE TABLE IF NOT EXISTS counters (
            scope TEXT PRIMARY KEY,
            next INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO counters (scope, next) VALUES ('task', 1);
        -- 任务的需求账本树（**不是实体**：不占 #号、不进侧栏、不进 entity_links）。
        -- 主键 (task_id, id)：id 只在同一 task 内唯一，人读短、agent 引用短。
        -- 2026-11-25 裁：只记「要做什么」的父子结构，执行规划不落库（见 UnitRecord 注释）
        CREATE TABLE IF NOT EXISTS task_units (
            task_id    TEXT NOT NULL,
            id         TEXT NOT NULL,
            title      TEXT NOT NULL,
            body       TEXT NOT NULL DEFAULT '',
            status     TEXT NOT NULL DEFAULT 'open',
            -- 树上的父（母项）。NULL = 根
            parent_id  TEXT,
            seq        INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (task_id, id)
        );
        CREATE INDEX IF NOT EXISTS task_units_task ON task_units(task_id, seq);
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
        -- 实体关系：core kind（related / blocks / duplicate）或插件 kind（<plugin_id>/<kind>）
        CREATE TABLE IF NOT EXISTS entity_links (
            from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            to_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            kind    TEXT NOT NULL,
            PRIMARY KEY (from_id, to_id, kind)
        );
        CREATE INDEX IF NOT EXISTS entity_links_to ON entity_links(to_id, kind);
        -- 事件流：subject = 事情发生在谁身上，actor = 谁干的（可空）。
        -- 任务日志（journal）是它的一个投影：event = <type>.journal，data = {kind, text}
        CREATE TABLE IF NOT EXISTS events (
            seq     INTEGER PRIMARY KEY AUTOINCREMENT,
            at      INTEGER NOT NULL,
            event   TEXT NOT NULL,
            subject TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            actor   TEXT REFERENCES entities(id) ON DELETE SET NULL,
            data    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_subject ON events(subject, seq);
        CREATE INDEX IF NOT EXISTS events_event ON events(event, seq);
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

    // 老库补列：tasks.updated_at（P2 加的）。历史行没有「最后改动」概念，用 created_at 兜
    const taskColumns = new Set(
        (db.prepare('PRAGMA table_info(tasks)').all() as Array<Record<string, unknown>>).map((row) =>
            String(row['name']),
        ),
    );
    if (!taskColumns.has('updated_at')) {
        db.exec('ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
        db.exec('UPDATE tasks SET updated_at = created_at WHERE updated_at = 0');
    }

    // 老库补列：task_units.parent_id（分解树）。历史行没有分解树概念，一律当根
    const unitColumns = new Set(
        (db.prepare('PRAGMA table_info(task_units)').all() as Array<Record<string, unknown>>).map((row) =>
            String(row['name']),
        ),
    );
    if (!unitColumns.has('parent_id')) db.exec('ALTER TABLE task_units ADD COLUMN parent_id TEXT');
    // 2026-11-25：依赖边与交付批次整体退役（只留需求账本树）。旧库里的两张表直接删 ——
    // 它们是纯派生侧的记录，删掉不丢「要做什么」。task_units.batch_id 是老库的死列：
    // SQLite 不能删列，代码也再不读写它，留着不影响任何判据。
    db.exec('DROP TABLE IF EXISTS unit_deps');
    db.exec('DROP TABLE IF EXISTS unit_batches');

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

    const readEntity = (id: string): EntityRecord | undefined => {
        const row = db.prepare('SELECT id, type, created_at FROM entities WHERE id = ?').get(id) as
            | Record<string, unknown>
            | undefined;
        if (row === undefined) return undefined;
        return { id: String(row['id']), type: String(row['type']), createdAt: Number(row['created_at']) };
    };

    /** `blocks` 边是否已经从 start 走到 target（建边前用它挡环） */
    const blocksReaches = (start: string, target: string): boolean => {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length > 0) {
            const current = stack.pop()!;
            if (current === target) return true;
            if (seen.has(current)) continue;
            seen.add(current);
            const rows = db
                .prepare("SELECT to_id FROM entity_links WHERE from_id = ? AND kind = 'blocks'")
                .all(current) as Array<Record<string, unknown>>;
            for (const row of rows) stack.push(String(row['to_id']));
        }
        return false;
    };

    /** 事件名 = `<type>.<verb>`：插件事件因此自动带上自己的命名空间 */
    const journalEventOf = (id: string): string => `${readEntity(id)?.type ?? 'task'}.journal`;

    /**
     * 重命名成备份表（`rooms` → `rooms_v0`）。迁移完成后才调，
     * 目的只是「数据还在磁盘上」而不是继续被读写。
     */
    const renameToBackup = (table: string, base: string): void => {
        let backup = base;
        for (let i = 1; ; i += 1) {
            const taken = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(backup) as
                | { x: number }
                | undefined;
            if (taken === undefined) break;
            backup = `${base}_${i}`;
        }
        db.exec(`ALTER TABLE ${table} RENAME TO ${backup}`);
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
        updatedAt: Number(row['updated_at'] ?? 0),
    });

    const readProjectRow = (row: Record<string, unknown>): ProjectRecord => ({
        id: String(row['id']),
        name: String(row['name']),
        workspace: row['workspace'] === null ? null : String(row['workspace']),
        modelKey: String(row['model_key']),
        createdAt: Number(row['created_at']),
    });

    const readTask = (id: string): TaskRecord | undefined => {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row === undefined ? undefined : readTaskRow(row);
    };

    // ── unit（任务私有的需求账本树）──────────────────────────
    //
    // 与 entity_links 是**两套结构**：实体关系图（task ↔ task，有外键）和任务内部的父子树。
    // 不复用 entity_links 是因为 unit 不是实体（无 identity 行 / 不进侧栏 / 不占 #号）——
    // 而 entity_links 有 `REFERENCES entities(id)` 外键。

    const readUnitRow = (row: Record<string, unknown>): UnitRecord => ({
        taskId: String(row['task_id']),
        id: String(row['id']),
        title: String(row['title']),
        body: String(row['body']),
        status: String(row['status']) as UnitStatus,
        parent: row['parent_id'] === null || row['parent_id'] === undefined ? null : String(row['parent_id']),
        seq: Number(row['seq']),
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
    });

    const readUnit = (taskId: string, unitId: string): UnitRecord | undefined => {
        const row = db.prepare('SELECT * FROM task_units WHERE task_id = ? AND id = ?').get(taskId, unitId) as
            | Record<string, unknown>
            | undefined;
        return row === undefined ? undefined : readUnitRow(row);
    };

    /**
     * 分配 unit id（`u1` / `u2`…）。scope 按 task 分开 —— 删掉的号**不会被后来者顶替**
     *（同 task 内 u3 永远是 u3），这也是「聊天里引用过的号还能对得上」的前提。
     */
    const allocateUnitId = (taskId: string): string => {
        const row = db
            .prepare(
                'INSERT INTO counters (scope, next) VALUES (?, 2) ' +
                    'ON CONFLICT(scope) DO UPDATE SET next = next + 1 RETURNING next - 1 AS n',
            )
            .get(`unit:${taskId}`) as { n: number };
        return `u${Number(row.n)}`;
    };

    const writeUnit = (unit: UnitInput): UnitRecord => {
        const title = unit.title.trim();
        if (title === '') throw new Error('unit 的 title 不能为空');
        if (!isUnitStatus(unit.status)) {
            throw new Error(`unit 状态不合法：${unit.status}（只有 ${UNIT_STATUSES.join(' / ')}）`);
        }
        const previous = unit.id === undefined ? undefined : readUnit(unit.taskId, unit.id);
        // 显式给的 id 必须已存在 —— 除非调用方声明它就是新 key（`allowNewId`）。
        // 默认严格：`u<n>` 的「不回收」靠这条守住，随手传 id 不该悄悄建节点。
        if (unit.id !== undefined && previous === undefined) {
            if (unit.allowNewId !== true) {
                throw new Error(`unit 不存在：${unit.id}（新 unit 不要传 id，由 store 分配）`);
            }
            if (unit.id.trim() === '') throw new Error('unit 的 id 不能为空');
        }
        const now = Date.now();
        const nextSeq =
            (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM task_units WHERE task_id = ?').get(unit.taskId) as {
                n: number;
            }).n;
        const record: UnitRecord = {
            taskId: unit.taskId,
            id: previous?.id ?? unit.id ?? allocateUnitId(unit.taskId),
            title,
            body: unit.body,
            status: unit.status,
            // 缺省沿用（改 title 不该顺手把挂点抹掉）；新节点缺省 = 根
            parent: unit.parent === undefined ? (previous?.parent ?? null) : unit.parent,
            seq: previous?.seq ?? Number(nextSeq),
            createdAt: previous?.createdAt ?? unit.createdAt ?? now,
            updatedAt: unit.updatedAt ?? now,
        };
        if (record.parent === record.id) throw new Error(`unit 不能是自己的父：${record.id}`);
        db.prepare(
            'INSERT INTO task_units (task_id, id, title, body, status, parent_id, seq, created_at, updated_at) ' +
                'VALUES (?,?,?,?,?,?,?,?,?) ' +
                'ON CONFLICT(task_id, id) DO UPDATE SET title=?, body=?, status=?, parent_id=?, updated_at=?',
        ).run(
            record.taskId,
            record.id,
            record.title,
            record.body,
            record.status,
            record.parent,
            record.seq,
            record.createdAt,
            record.updatedAt,
            record.title,
            record.body,
            record.status,
            record.parent,
            record.updatedAt,
        );
        return record;
    };

    /**
     * 删一条 unit。
     *
     * 有子节点的母项也能删（树是账本，不是外键）：`task_units` 上父只是个 id 字符串，
     * 删掉母项不会连带删子项 —— 那些子项就成了「悬空父」，`unitBoard` 按根处理
     * （与「悬空父不制造幽灵节点」同一条判据）。要连子一起删，调方自己逐条删；
     * `unit_drop` 工具会顺手把它们提到上一级，比留成悬空更好读。
     */
    const dropUnit = (taskId: string, unitId: string): boolean => {
        const result = db.prepare('DELETE FROM task_units WHERE task_id = ? AND id = ?').run(taskId, unitId);
        return Number(result.changes) > 0;
    };

    /** 内容是否真的变了（changed 才盖 updated_at、才重写 task.md） */
    const sameTaskContent = (a: TaskRecord, b: TaskRecord): boolean =>
        a.title === b.title &&
        a.summary === b.summary &&
        a.body === b.body &&
        a.projectId === b.projectId &&
        a.workspace === b.workspace &&
        a.status === b.status &&
        a.closedAt === b.closedAt &&
        a.modelKey === b.modelKey;

    const writeTask = (task: TaskInput): TaskRecord => {
        const previous = readTask(task.id);
        const createdAt = previous?.createdAt ?? task.createdAt ?? Date.now();
        const number = previous?.number ?? task.number ?? allocateTaskNumber();

        const draft: TaskRecord = {
            ...task,
            number,
            createdAt,
            updatedAt: task.updatedAt ?? Date.now(),
        };
        // 启动时会把所有任务重存一遍：内容没变就不该盖「最后更新」、也不该重写文件
        const changed = previous === undefined || !sameTaskContent(previous, draft);
        const updatedAt = changed ? draft.updatedAt : previous.updatedAt;
        const record: TaskRecord = { ...draft, updatedAt };

        db.exec('BEGIN IMMEDIATE');
        try {
            writeEntity(task.id, 'task', createdAt);
            db.prepare(
                'INSERT INTO tasks (id, number, title, summary, body, project_id, workspace, status, closed_at, model_key, created_at, updated_at) ' +
                    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
                    'title=excluded.title, summary=excluded.summary, body=excluded.body, project_id=excluded.project_id, ' +
                    'workspace=excluded.workspace, status=excluded.status, closed_at=excluded.closed_at, ' +
                    'model_key=excluded.model_key, updated_at=excluded.updated_at',
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
                updatedAt,
            );
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        // 导出物：task.md（DB 仍是真源；文件失败只记日志）
        if (changed && dataRoot !== undefined) mirror(() => writeTaskDoc(dataRoot, record));
        return record;
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
                    // 历史任务没有「最后改动」概念：用创建时刻兜，别让迁移当天变成全员更新
                    updatedAt: createdAt,
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

        renameToBackup('rooms', 'rooms_v0');
    };

    /**
     * bots → entities。幂等：新 bot 由 `upsertBot` 自己写身份行，这里只补历史。
     * 老 `bots` 表没有创建时间，统一盖当前时刻（bot 的 created_at 目前没有消费者）。
     */
    const syncBotEntities = (): void => {
        db.prepare("INSERT OR IGNORE INTO entities (id, type, created_at) SELECT id, 'bot', ? FROM bots").run(
            Date.now(),
        );
    };

    /**
     * 老库迁移：journal_entries → events（`event = <type>.journal`，`data = {kind, text}`）。
     *
     * subject 已经不存在（理论上删房间时就清干净了）的行不硬造身份，留在 `journal_entries_v0` 里。
     */
    const migrateJournal = (): void => {
        const exists = db
            .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='journal_entries'")
            .get();
        if (exists === undefined) return;

        const rows = db
            .prepare(
                'SELECT j.at, j.entity_id, j.kind, j.text, e.type AS type FROM journal_entries j ' +
                    'LEFT JOIN entities e ON e.id = j.entity_id ORDER BY j.seq ASC',
            )
            .all() as Array<Record<string, unknown>>;

        db.exec('BEGIN IMMEDIATE');
        try {
            const insert = db.prepare('INSERT INTO events (at, event, subject, data) VALUES (?,?,?,?)');
            for (const row of rows) {
                const type = row['type'];
                if (type === null || type === undefined) continue;
                insert.run(
                    Number(row['at']),
                    `${String(type)}.journal`,
                    String(row['entity_id']),
                    JSON.stringify({ kind: String(row['kind']), text: String(row['text']) }),
                );
            }
            renameToBackup('journal_entries', 'journal_entries_v0');
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    };

    const hasLegacyRooms =
        db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='rooms'").get() !== undefined;
    // 顺序有意义：先搬房间（journal 的 subject 要能解析到实体），再补 bot 身份，最后折日志
    if (hasLegacyRooms) migrateLegacyRooms();
    syncBotEntities();
    migrateJournal();

    return {
        db,
        listBots(): Bot[] {
            const rows = db.prepare('SELECT * FROM bots ORDER BY rowid ASC').all() as Record<string, unknown>[];
            return rows.map(toBot);
        },
        upsertBot(bot: Bot): void {
            // bot 也是实体（可被 entity_links 引用）：身份行与 bots 行同步
            writeEntity(bot.id, 'bot', Date.now());
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
                .prepare('INSERT INTO events (at, event, subject, data) VALUES (?,?,?,?)')
                .run(at, journalEventOf(roomId), roomId, JSON.stringify({ kind: input.kind, text: input.text }));
            const entry: JournalEntry = {
                seq: Number(result.lastInsertRowid),
                at,
                kind: input.kind,
                text: input.text,
            };
            // 任务的日志同时追加到 <任务目录>/journal.jsonl（append-only 的天然形状）
            const task = dataRoot === undefined ? undefined : readTask(roomId);
            if (dataRoot !== undefined && task !== undefined) mirror(() => appendJournalLine(dataRoot, task, entry));
            return entry;
        },
        appendEvent(input: {
            event: string;
            subject: string;
            actor?: string | null;
            data?: unknown;
            at?: number;
        }): number {
            const result = db
                .prepare('INSERT INTO events (at, event, subject, actor, data) VALUES (?,?,?,?,?)')
                .run(
                    input.at ?? Date.now(),
                    input.event,
                    input.subject,
                    input.actor ?? null,
                    JSON.stringify(input.data ?? {}),
                );
            return Number(result.lastInsertRowid);
        },
        eventsOf(subject: string, prefix = '', limit = 50) {
            // prefix 直接当 LIKE 前缀用（内部调用方只传固定串，不拼不可信输入）
            const rows = (
                prefix === ''
                    ? db
                          .prepare('SELECT seq, at, event, data FROM events WHERE subject = ? ORDER BY seq DESC LIMIT ?')
                          .all(subject, limit)
                    : db
                          .prepare(
                              'SELECT seq, at, event, data FROM events WHERE subject = ? AND event LIKE ? ' +
                                  'ORDER BY seq DESC LIMIT ?',
                          )
                          .all(subject, `${prefix}%`, limit)
            ) as Array<Record<string, unknown>>;
            return rows.map((row) => {
                let data: unknown = {};
                try {
                    data = JSON.parse(String(row['data']));
                } catch {
                    /* 坏 data 不该让整串事件读不出来 */
                }
                return { seq: Number(row['seq']), at: Number(row['at']), event: String(row['event']), data };
            });
        },
        journalOf(roomId: string, limit = 24): JournalEntry[] {
            const rows = db
                .prepare('SELECT seq, at, data FROM events WHERE subject = ? AND event = ? ORDER BY seq DESC LIMIT ?')
                .all(roomId, journalEventOf(roomId), limit) as Array<Record<string, unknown>>;
            return rows
                .map((row) => {
                    let data: { kind?: unknown; text?: unknown } = {};
                    try {
                        const parsed: unknown = JSON.parse(String(row['data']));
                        if (typeof parsed === 'object' && parsed !== null) data = parsed as typeof data;
                    } catch {
                        /* 坏 data 不该让整份日志读不出来 */
                    }
                    return {
                        seq: Number(row['seq']),
                        at: Number(row['at']),
                        kind: (typeof data.kind === 'string' ? data.kind : 'progress') as JournalKind,
                        text: typeof data.text === 'string' ? data.text : '',
                    };
                })
                .reverse();
        },
        putAsk(record: AskRecord): void {
            db.prepare(
                'INSERT INTO asks (ask_id, entity_id, at, request, state, answer, reason, settled_at) VALUES (?,?,?,?,?,?,?,?) ' +
                    'ON CONFLICT(ask_id) DO UPDATE SET state=excluded.state, answer=excluded.answer, ' +
                    'reason=excluded.reason, settled_at=excluded.settled_at',
            ).run(
                record.askId,
                record.entityId,
                record.at,
                JSON.stringify(record.request),
                record.state,
                record.answer === undefined ? null : JSON.stringify(record.answer),
                record.reason ?? null,
                record.settledAt ?? null,
            );
        },
        asksOf(entityId: string): AskRecord[] {
            const rows = db
                .prepare('SELECT * FROM asks WHERE entity_id = ? ORDER BY at ASC, ask_id ASC')
                .all(entityId) as Array<Record<string, unknown>>;
            return rows.map((row) => ({
                askId: String(row['ask_id']),
                entityId: String(row['entity_id']),
                at: Number(row['at']),
                request: JSON.parse(String(row['request'])) as AskRequest,
                state: String(row['state']) as AskRecord['state'],
                ...(row['answer'] === null ? {} : { answer: JSON.parse(String(row['answer'])) as AskAnswer }),
                ...(row['reason'] === null ? {} : { reason: String(row['reason']) }),
                ...(row['settled_at'] === null ? {} : { settledAt: Number(row['settled_at']) }),
            }));
        },
        pruneAsks(entityId: string, keep: number): number {
            const result = db
                .prepare(
                    "DELETE FROM asks WHERE entity_id = ? AND state <> 'pending' AND ask_id NOT IN (" +
                        'SELECT ask_id FROM asks WHERE entity_id = ? AND state <> ? ORDER BY at DESC LIMIT ?)',
                )
                .run(entityId, entityId, 'pending', keep);
            return Number(result.changes);
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
            // 删之前记下任务（目录要按创建日挪进 _trash），删之后就读不到了
            const task = dataRoot === undefined ? undefined : readTask(roomId);
            // 顺序不重要（没有外键），但都按 entity_id 走索引或主键
            db.prepare('DELETE FROM entity_items WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM room_entries WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM session_state WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM turn_open WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM deliveries WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM room_members WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM asks WHERE entity_id = ?').run(roomId);
            db.prepare('DELETE FROM drafts WHERE owner_id = ?').run(roomId);
            // unit 不是实体（没有外键可跟），删房间时**得自己清**：否则整张分解图留在库里当孤儿，
            // 而它没有任何其他入口能被发现（侧栏看不见、任务没了、RPC 也不会再查它）。
            // 发号游标一起清 —— 「号不回收」说的是同一个任务内，任务本身没了就没有「同任务内」了
            db.prepare('DELETE FROM task_units WHERE task_id = ?').run(roomId);
            db.prepare('DELETE FROM counters WHERE scope = ?').run(`unit:${roomId}`);
            // 对话框草稿（synthetic scope，见 docs/drafts-design.md）挂在房间后面：
            // `dlg:<用途>:<roomId>`。删房间时一起清，不等 TTL
            db.prepare("DELETE FROM drafts WHERE owner_id LIKE ? ESCAPE '\\'").run(`dlg:%:${likeEscape(roomId)}`);
            // 身份一行 + 域行（tasks / projects 靠 ON DELETE CASCADE 跟着走）
            db.prepare('DELETE FROM entities WHERE id = ?').run(roomId);
            // 产物目录不删，挪进 _trash（截图 / 日志是排查材料，删任务通常只是不想再看到它）
            if (dataRoot !== undefined && task !== undefined) mirror(() => trashTaskDir(dataRoot, task));
        },
        deleteBot(botId: string): void {
            db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
            // 身份行只在确实属于 bot 时删（防 id 撞到房间）
            db.prepare("DELETE FROM entities WHERE id = ? AND type = 'bot'").run(botId);
        },
        members(): Record<string, RoomMember[]> {
            return readMembers();
        },
        entityOf(id: string): EntityRecord | undefined {
            return readEntity(id);
        },
        listTasks(): TaskRecord[] {
            const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC').all() as Array<
                Record<string, unknown>
            >;
            return rows.map(readTaskRow);
        },
        taskOf(id: string): TaskRecord | undefined {
            return readTask(id);
        },
        saveTask(task: TaskInput): TaskRecord {
            return writeTask(task);
        },
        taskDirOf(id: string): string | undefined {
            if (dataRoot === undefined) return undefined;
            const task = readTask(id);
            return task === undefined ? undefined : taskDirAt(dataRoot, task);
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
        link(from: string, to: string, kind: string): EntityLink {
            if (!isLinkKind(kind)) {
                throw new Error(
                    `关系 kind 不合法：${kind}（core 用 related / blocks / duplicate；插件用 <plugin_id>/<kind>）`,
                );
            }
            if (from === to) throw new Error(`实体不能和自己建立关系：${from}`);
            for (const id of [from, to]) {
                if (readEntity(id) === undefined) throw new Error(`实体不存在：${id}`);
            }
            // blocks 是有向的「先 A 后 B」：再加 A→…→A 会让两边永远等对方
            if (kind === 'blocks' && blocksReaches(to, from)) {
                throw new Error(`blocks 会成环：${from} → ${to} → … → ${from}`);
            }
            db.prepare('INSERT OR IGNORE INTO entity_links (from_id, to_id, kind) VALUES (?,?,?)').run(from, to, kind);
            return { from, to, kind };
        },
        unlink(from: string, to: string, kind: string): boolean {
            const result = db
                .prepare('DELETE FROM entity_links WHERE from_id = ? AND to_id = ? AND kind = ?')
                .run(from, to, kind);
            return Number(result.changes) > 0;
        },
        listUnits(taskId: string): UnitRecord[] {
            const rows = db.prepare('SELECT * FROM task_units WHERE task_id = ? ORDER BY seq ASC').all(taskId) as Array<
                Record<string, unknown>
            >;
            return rows.map(readUnitRow);
        },
        unitOf(taskId: string, unitId: string): UnitRecord | undefined {
            return readUnit(taskId, unitId);
        },
        saveUnit(unit: UnitInput): UnitRecord {
            return writeUnit(unit);
        },
        removeUnit(taskId: string, unitId: string): boolean {
            return dropUnit(taskId, unitId);
        },
        linksOf(id: string): LinkSets {
            const outRows = db
                .prepare('SELECT from_id, to_id, kind FROM entity_links WHERE from_id = ? ORDER BY rowid ASC')
                .all(id) as Array<Record<string, unknown>>;
            const inRows = db
                .prepare('SELECT from_id, to_id, kind FROM entity_links WHERE to_id = ? ORDER BY rowid ASC')
                .all(id) as Array<Record<string, unknown>>;
            const toLink = (row: Record<string, unknown>): EntityLink => ({
                from: String(row['from_id']),
                to: String(row['to_id']),
                kind: String(row['kind']),
            });
            return { out: outRows.map(toLink), in: inRows.map(toLink) };
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
                out.push({
                    createdAt: task.createdAt,
                    room: taskToRoom(
                        task,
                        members[task.id] ?? [],
                        dataRoot === undefined ? undefined : taskDirAt(dataRoot, task),
                    ),
                });
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
        openTurn(roomId: string, record: OpenTurn): void {
            db.prepare(
                'INSERT INTO turn_open (entity_id, bot_id, turn, turn_id, at) VALUES (?,?,?,?,?) ' +
                    'ON CONFLICT(entity_id, bot_id) DO UPDATE SET turn=?, turn_id=?, at=?',
            ).run(
                roomId,
                record.botId,
                record.turn,
                record.turnId,
                record.at,
                record.turn,
                record.turnId,
                record.at,
            );
        },
        closeTurn(roomId: string, botId: string): void {
            db.prepare('DELETE FROM turn_open WHERE entity_id = ? AND bot_id = ?').run(roomId, botId);
        },
        openTurns(roomId: string): OpenTurn[] {
            const rows = db
                .prepare('SELECT bot_id, turn, turn_id, at FROM turn_open WHERE entity_id = ? ORDER BY at ASC')
                .all(roomId) as Array<Record<string, unknown>>;
            return rows.map((row) => ({
                botId: String(row['bot_id']),
                turn: Number(row['turn']),
                turnId: String(row['turn_id']),
                at: Number(row['at']),
            }));
        },
        deleteInterruptedFacts(roomId: string, turnId: string, botId: string): number {
            const result = db
                .prepare(
                    "DELETE FROM entity_items WHERE entity_id = ? " +
                        "AND json_extract(item, '$.data.kind') = 'interrupted' " +
                        "AND json_extract(item, '$.turnId') = ? " +
                        "AND json_extract(item, '$.data.botId') = ?",
                )
                .run(roomId, turnId, botId);
            return Number(result.changes);
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
        lastItemPerBot(roomIds?: readonly string[]): Array<{ roomId: string; item: Item }> {
            // 没有 author 的条目（system 之类）不属于任何 bot，SQL 里就排掉：
            // 让它们自成一组只会给调用方多一份要过滤的垃圾。
            const filter = "json_extract(item, '$.author.id') IS NOT NULL";
            const sql =
                'SELECT entity_id, MAX(seq) AS seq, item FROM entity_items ' +
                (roomIds === undefined
                    ? `WHERE ${filter} `
                    : `WHERE entity_id IN (SELECT value FROM json_each(?)) AND ${filter} `) +
                "GROUP BY entity_id, json_extract(item, '$.author.id')";
            const rows = (
                roomIds === undefined ? db.prepare(sql).all() : db.prepare(sql).all(JSON.stringify(roomIds))
            ) as Array<Record<string, unknown>>;
            const out: Array<{ roomId: string; item: Item }> = [];
            for (const row of rows) {
                try {
                    const item = JSON.parse(String(row['item'])) as Item;
                    out.push({ roomId: String(row['entity_id']), item: { ...item, seq: Number(row['seq']) } });
                } catch {
                    // 坏行不该让整张表都读不出来（与 itemsOf 同策）
                }
            }
            return out;
        },
        lastFactPerTurn(roomIds?: readonly string[]): Array<{ roomId: string; owner: string; item: Item }> {
            const owner = "COALESCE(json_extract(item, '$.data.botId'), json_extract(item, '$.turnId'))";
            const sql =
                `SELECT entity_id, ${owner} AS owner, MAX(seq) AS seq, item FROM entity_items ` +
                "WHERE json_extract(item, '$.author.id') IS NULL " +
                "AND json_extract(item, '$.type') IN ('notice','error') " +
                (roomIds === undefined ? '' : 'AND entity_id IN (SELECT value FROM json_each(?)) ') +
                `GROUP BY entity_id, ${owner}`;
            const rows = (
                roomIds === undefined ? db.prepare(sql).all() : db.prepare(sql).all(JSON.stringify(roomIds))
            ) as Array<Record<string, unknown>>;
            const out: Array<{ roomId: string; owner: string; item: Item }> = [];
            for (const row of rows) {
                try {
                    const item = JSON.parse(String(row['item'])) as Item;
                    out.push({
                        roomId: String(row['entity_id']),
                        owner: String(row['owner']),
                        item: { ...item, seq: Number(row['seq']) },
                    });
                } catch {
                    // 坏行不该让整张表都读不出来（与 itemsOf / lastItemPerBot 同策）
                }
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
