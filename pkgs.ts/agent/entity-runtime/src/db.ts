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

import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { dirname, resolve } from 'node:path';

import type { TranscriptEntry, TokenUsage } from './compaction';
import { isLinkKind } from './id';
import type { RoomEntry } from './room-log';
import { readSessionEntries, sessionFilePath, writeSessionEntries } from './session-file';
import { appendJournalLine, taskDirOf as taskDirAt, trashTaskDir, writeTaskDoc } from './task-dir';
import { PLACEHOLDER_MODEL_KEY, applyMigrations } from '@diy-agent/migration';

import { offloadExistingToolOutputs } from './offload-existing';
import { describeFindings, verifyDatabase } from './verify-migrations';
import type { MigrationReporter, MigrationRuntime } from '@diy-agent/migration';

// 迁移体系对外的出口（实现全在 @diy-agent/migration，这里只转手）
export { appliedCount, MIGRATION_STEPS } from '@diy-agent/migration';
export type { MigrationReporter, MigrationStepEvent } from '@diy-agent/migration';
import type {
    AskAnswer,
    AskRequest,
    Bot,
    BotProfile,
    Delivery,
    InboxMode,
    Item,
    BotProfileDefaults,
    MessageKind,
    Room,
    RoomMember,
} from './types';

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
 * 任何「这轮开始过」的痕迹 —— 否则结局判据只能读成「正常结束」。
 * 轮开始写一行、收尾删一行；进程重启后还留着 = 上一轮没走到收尾。
 */
export interface OpenTurn {
    botId: string;
    turn: number;
    turnId: string;
    at: number;
}

/**
 * 一轮跑完后的结算事实（`turn_facts` 表一行）。
 *
 * 与 `OpenTurn` 是**两件事**：那个是「开了没收尾」的临时标记（收尾即删），
 * 这个是「跑完了、结果如何」的永久账（一行一轮，随 room 活到底）。
 * 存起来只为一件事：刷新后消息底下的结算行还能画出来。
 */
export interface TurnFactRow {
    botId: string;
    turnId: string;
    /** 轮号（房间内递增） */
    turn: number;
    /** 开始时刻（缺省 = 那一轮没报） */
    startedAt?: number;
    /** 结束时刻 —— 这一行存在的理由 */
    endedAt: number;
    /** 本轮实测用量（缺省 = 没拿到） */
    usage?: TokenUsage;
    /** 本轮工具调用数（缺省 = 没报） */
    toolCalls?: number;
    /**
     * 怎么结束的（`TurnEndReason` 整包）。
     *
     * 用 `unknown` 而不是 import 协议类型：db 层只负责搬运（存 JSON、读出来还回去），
     * 不解析、不依赖 `reason.type` 的联合 —— 让协议改枚举时这里一行都不用动。
     */
    reason?: unknown;
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
    /**
     * 这条日志讲的是**哪条账本条目**（`task_units.id`）；空/缺省 = 任务级。
     *
     * 为什么要它（2026-11-27 用户）：「决策」不该是第二本账 —— 一条决策天然属于某条需求，
     * 记在 journal 上再按 unit 过滤，就是那条需求的「决策」列表；而 journal 本身还是 append-only，
     * 不需要维护「这条决策还有效吗」。
     */
    unit?: string;
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

/**
 * 账本里的层级上限（2026-11-27 用户裁）：**只有两层** —— 目标（根）→ 需求（一层子）。
 *
 * 为什么砍掉第三层「步骤」（`kind = 'step'`，同一天上线、同一天退役）：
 * 生产库 153 条 unit 里 `kind = 'step'` **一条都没被用过**（2026-11-27 体检）。工具支持、
 * 提示词写了判据，模型仍从不主动标 step —— 「靠模型自愿分层」这条路不成立，那一层事实上不存在。
 * 执行过程本来就另有出处：`journal`（决策 / 进展）+ `job` + 工具调用记录，不必进账本。
 *
 * 于是现在的形状是：根 = **目标**（可以没有子、可以独立开始/完成/放弃），子 = **需求**
 * （要能验收，`accept`）。写完不再嵌套 —— 真需要更细的粒度就新建一个根目标。
 */
export const UNIT_MAX_DEPTH = 1;

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
    /** 这条需求要解决什么（背景 / 范围）。**验收口径不写这里** —— 它有自己的字段 `accept` */
    body: string;
    /**
     * 「怎么算做完」——一句话能判断完/未完的判据。
     *
     * 为什么单独一个字段（2026-11-26 用户裁）：原先验收口径埋在 `body` 里，模型经常忘，
     * 人也没法快速核对（body 里既有背景又有口径，还得找出哪句是判据）。
     * 做成字段之后：缺了能看得见（界面标「未写验收」）、提示词也有一条明确的填空要求。
     * 空串 = 还没写（不假装有）。
     */
    accept: string;
    /**
     * 这条需求来自**哪句人话**（`entity_items.id`，形如 `u-mwwtvgiy-1`）；空串 = 不知道
     * （老数据 / 非人类触发）。
     *
     * 为什么要它（2026-11-26 用户）：人核对账本时第一个问题永远是「这是我要的吗」，
     * 而现在只能翻聊天记录去猜。由宿主在**本轮触发消息**上自动盖章 —— 不靠模型填
     * （模型根本看不到消息 id，让它编只会编错）。
     */
    source: string;
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
export type UnitInput = Omit<UnitRecord, 'id' | 'parent' | 'seq' | 'createdAt' | 'updatedAt' | 'accept' | 'source'> & {
    id?: string;
    /**
     * 「怎么算做完」。缺省 = 沿用库里已有的（更新时）；新建缺省就是空串 = 还没写。
     * **不做成必填**：老代码 / 老数据里没有这一栏，逼着所有调用点补一遍只会让人随手写个占位串。
     */
    accept?: string;
    /**
     * 来自哪句人话（`entity_items.id`）。缺省沿用库里已有的；新建缺省空串。
     * 同样**不设成必填**：宿主盖章是锦上添花，缺了不该让写入失败。
     */
    source?: string;
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
    /** 谁发的（db 列名沿用 `mode`，但值已从 `next-step/next-turn` 改成 `human/system`） */
    mode?: MessageKind;
    turn?: number;
    turnId?: string;
}

export interface Store {
    readonly db: DatabaseSync;
    /** 全部角色（按 type、建得早排序；房间成员由它们派生，见 protocol 的 membersOfType） */
    listBotProfiles(): BotProfile[];
    upsertBotProfile(role: BotProfile): void;

    // ── 类型默认配置（bot_profile_defaults，2026-11-26）────────────────────
    /** 全部类型默认配置 */
    listBotProfileDefaults(): BotProfileDefaults[];
    /** 某类型的默认配置；没配过返回 undefined */
    getBotProfileDefaults(type: string): BotProfileDefaults | undefined;
    /** 写某类型的默认配置（upsert） */
    setBotProfileDefaults(config: BotProfileDefaults): void;

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
    /**
     * 一条 unit 的**原始行**（`task_units` 的全部列，按列名给）。
     *
     * 为什么另开一个口而不是把 `UnitRecord` 序列化：详情页的「源码」要回答的是
     * 「数据库里到底存了什么」—— 投影（`UnitRecord`）会补缺省值、换算字段名，
     * 拿它当「原文」给用户看，等于让人以为库里就长这样。
     */
    rawUnit(taskId: string, unitId: string): Record<string, unknown> | undefined;
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
    /** 删角色 + 它的会话/投递（成员是派生的，房间表不用清；每类最后一个角色的护栏在 server） */
    deleteBotProfile(roleId: string): void;
    appendItem(roomId: string, item: Item): Item;
    /** 追加一条任务日志（append-only；回放用 `journalOf`） */
    appendJournal(roomId: string, input: { kind: JournalKind; text: string; at?: number; unit?: string }): JournalEntry;
    /**
     * 追加一条领域事件（通用）。命名约定同 journal：`<type>.<verb>`（实体类型做前缀）。
     * unit 变更走这里（`task.unit.added` 等）而**不走 journal**：journal 五种 kind 的服务对象是
     * 人，且最近 24 条要进 system 上下文 —— unit 变频率高，塞进去会把真决策挤出去。
     */
    appendEvent(input: { event: string; subject: string; actor?: string | null; data?: unknown; at?: number }): number;
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
    /**
     * 每个容器中「最新一条投递失败」的成员数（侧栏「未送达」标记）。0 不占键。
     *
     * 必须按**成员收敛到最新一条消息**，不能数历史 failed 行：旧消息插话失败、后来新消息
     * 正常送达时，房间不该永远挂着「未送达」。排队的投递由 `queuedByBot` 另算，也不该
     * 在这里重复报 failed；只有最新一条确实是 failed 才算。
     *
     * `roomIds` = 要统计哪几个房间（调用方手里有列表就给，省掉自己推断一遍）；
     * 不给 = `entities` ∪ `entity_items` 里出现过的房间（见 `roomIdsOf`）。
     */
    failedByRoom(roomIds?: readonly string[]): Record<string, number>;
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
     * 记下一轮的**结算事实**（收尾时写，一行一轮，永远不删）。
     *
     * 为什么要一张表：`turn.end` 只是广播，刷新后历史轮次的 `endedAt` / `usage` / step 数
     * 就全没了 —— 消息底下的结算行（`完成 · 3m12s · 12.4k tokens`）整行消失。
     * 原先的假设是「结算行靠持久条目（notice / error）说清了」，但那只对**出错 / 中断**
     * 的轮成立：正常完成的轮一条 notice 都不落（`endFooterOf(completed)` 返回 undefined）。
     */
    saveTurnFact(roomId: string, fact: TurnFactRow): void;
    /** 这个房间所有轮的结算事实（按轮号升序）：`chat.history` 一并下发，结算行靠它 */
    turnFacts(roomId: string): TurnFactRow[];
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
    /**
     * 按**条目 id** 取若干条（`unit.source_message_id` 指向它）。找不到的 id 静默缺席 ——
     * 消息可能已被剪 / 老数据没有来源，调用方按「不知道」处理，不要报错。
     *
     * 为什么不复用 `itemsOf(roomId)` 再过滤：那是把整个房间的消息全 `JSON.parse` 一遍
     * 就为拿 N 条原话；而这张表随历史线性涨（界面上 5 秒轮询一次）。一次 `IN` 查询只读命中的行。
     */
    itemsByIds(ids: readonly string[]): Item[];
    /**
     * 某个房间**最后 n 条**（仍按 seq 升序返回）。
     *
     * 为什么要有（2026-11-26 实测）：`chat.history` 一次回包 **5.7 MB** —— 6000+ 条 items
     * 全量发给浏览器，JSON.parse + 渲染就是那 2~5 秒的长任务（用户「切任务很慢」）。
     * 展示层只需要「最近的」；更早的历史由用户主动要（`limit<=0` 时仍走 `itemsOf` 全量）。
     *
     * 走 `items_entity(entity_id, seq)` 倒序取 n 行，只 JSON.parse 这 n 条 —— 服务端也省掉
     * 了把几千条解析出来的开销。
     */
    lastItemsOf(roomId: string, n: number): Item[];
    /** 条目总数（分页时要告诉界面“上面还有多少条”，别为了数它把全量都解析一遍） */
    countItemsOf(roomId: string): number;
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
     * 实现是**逐房间** `ORDER BY at DESC LIMIT 1`（2026-11-28）：走 `items_entity_at` 的 seek，
     * 只读命中那一行。以前是 `GROUP BY entity_id` 取 `MAX(at)` —— 那条要扫完整条索引，
     * 随历史线性涨（真库 4 万条时 9ms 起步、生产日志里到过 162ms）。那条索引仍是 seek
     * 的前提，别删。
     *
     * `roomIds` = 要统计哪几个房间；不给 = `entities` ∪ `entity_items` 里出现过的房间。
     */
    lastItemAtByRoom(roomIds?: readonly string[]): Record<string, number>;
    /**
     * 记下「这个房间我读到 seq 了」—— 只前进不后退（同一房间被旧客户端的迟到上报
     * 拉回去就永远有未读了）。
     *
     * 不给 `seq` = 推到这个房间**当前最后一条** —— 这正是 UI 要的语义（“我在看这个房间”，
     * 它不需要知道全局 seq 是多少；UI 从此不必订阅 items 只为了算一个数字）。
     */
    markRead(roomId: string, seq?: number): void;
    /** 这个房间当前读到哪一条了（没读过 = undefined，不是 0）。 */
    readSeqOf(roomId: string): number | undefined;
    /** 这个房间最后一条 item 的 seq（没有 = undefined） */
    maxSeqOf(roomId: string): number | undefined;
    /**
     * 每个房间的**未读结论数**：`seq > 已读水位` 且 `type = 'chat'` 且「不是我发的」。
     *
     * **没有水位记录的房间算 0**（不是“全未读”）：未读是 2026-11-26 才有的功能，
     * 若把历史全当未读，每个老房间一上来就是几百（实测 `99+`）—— 那是“历史上说过多少话”，
     * 不是“还有几条没看”。所以水位缺省取“这个房间当前最后一条”：从现在开始算。
     *
     * 只数**发言**（结论），不数事件 —— 用户 2026-11-26 的原话：“按 room 的结论数统计，
     * 而不是事件数，不然几千的很多”。一个 turn 里几十条 tool 调用、几条 notice 都算进去，
     * 侧栏角标就不再是“还有几条没看”，而是“这个房间历史上跑过多少步”。
     *
     * 不算的还有我自己发的话（`author.role === 'human'`）—— 那是我刚打的，不必提醒我。
     * 没读过的房间从 0 起算（第一次打开前全是未读）。0 不占键。
     */
    unreadByRoom(): Record<string, number>;
    /**
     * 每个 bot 在给定房间里的**最后一条 item**（「上一轮怎么结束的」的唯一来源）。
     *
     * 一轮收尾时 `endItems()` 产出的 notice / error 就是该轮最后落盘的条目，
     * 所以这一条既是「谁最后说话」也是「怎么停的」；
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
     * `lastItemPerBot` 按 `author.id` 分组，恰好把结局事实排除了（结局事实不带 author）。
     * 它们只能单独认领，所以单独一条查询：调用方先拿到 bot 最后一轮，再从这里取那一轮的结局。
     *
     * `owner` = 事实自带的 `data.botId`，没有就退回 `turnId`：
     *   · 新数据带 botId —— `turnId` 是房间级的（@all 各 bot 共享），只按它归属会张冠李戴；
     *   · 老数据没有 botId，只能按轮认（实测历史数据里带结局的轮全部只有一个 bot，所以安全）。
     * 调用方先看 botId 命中、再看 turnId 命中，新数据自动优先。
     */
    lastFactPerTurn(roomIds?: readonly string[]): Array<{ roomId: string; owner: string; item: Item }>;
    /**
     * 某个 (房间, bot) 的最后一条带 author 的条目 —— `lastItemPerBot` 的**点查版**。
     *
     * 为什么要它（2026-11-28）：投影版的分组键是两个 json 表达式，SQLite 只能**全索引扫**
     * （`SCAN ... USING INDEX`，真库 4.3 万条时一次 272ms），而 `rooms.list` 每隔几秒就要问一遍
     * 「每个成员上一轮的结局」。这里 `ORDER BY seq DESC LIMIT 1` 走 `items_author_seq` 的 seek，
     * 单次约 26µs（同样的 109 个查询：272ms → 2.8ms）。两者语义相同，**热路径用这个**。
     */
    lastItemOfBot(roomId: string, botId: string): Item | undefined;
    /** 某个房间里某个归属（`data.botId`，老数据退回 `turnId`）的最后一条轮级事实 —— 点查版 */
    lastFactOfOwner(roomId: string, owner: string): Item | undefined;
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
    };
}

function roomToProject(room: Room): ProjectInput {
    return {
        id: room.id,
        name: dataText(room, 'name'),
        workspace: dataText(room, 'dir') || null,
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
    return { id: task.id, type: 'task', data, members };
}

function projectToRoom(project: ProjectRecord, members: RoomMember[]): Room {
    const data: Record<string, unknown> = { name: project.name };
    if (project.workspace !== null) data['dir'] = project.workspace;
    return { id: project.id, type: 'project', data, members };
}

export { PLACEHOLDER_MODEL_KEY };

/** 读模型键：占位值 / null 都当「没选」（空串 = 继承） */
function cleanModelKey(value: unknown): string {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return text === PLACEHOLDER_MODEL_KEY ? '' : text;
}

export interface OpenStoreOptions {
    /** 迁移逐个上报（迁移页用）；不传 = 静默，启动路径不受影响 */
    onMigrationStep?: MigrationReporter;
}

export function openStore(file: string, options: OpenStoreOptions = {}): Store {
    const db = new DatabaseSync(file === ':memory:' ? ':memory:' : file);
    /**
     * 懒预编译的点查语句（见 `lastItemOfBot` / `lastFactOfOwner`）。
     * `db.prepare` 每次都会重新编译 SQL，而这两条在 `rooms.list` 里每次上百次 —— 留个句柄复用。
     */
    const stmts: {
        lastItemOfBot?: StatementSync;
        lastFactOfOwner?: StatementSync;
        entityIds?: StatementSync;
        itemRoomIds?: StatementSync;
        lastAtOfRoom?: StatementSync;
        unreadOfRoom?: StatementSync;
        deliveriesOfRoom?: StatementSync;
        saySeqOfRoom?: StatementSync;
    } = {};
    /**
     * 「要统计哪几个房间」——逐房间点查的循环源（见 `lastItemAtByRoom` / `failedByRoom`）。
     *
     * 优先用调用方给的（`rooms.list` 手里就有），没有才自己找：
     * **`entities` 身份 ∪ `entity_items` 里出现过的房间**。为什么不能只用 entities：
     * 历史上有 items 却没有身份行的房间（迁移自检的 `orphan-entity-items` 就是这个），
     * 只按 entities 循环会把它们静默漏掉。
     */
    const roomIdsOf = (hint?: readonly string[]): string[] => {
        if (hint !== undefined) return [...hint];
        stmts.entityIds ??= db.prepare('SELECT id FROM entities');
        stmts.itemRoomIds ??= db.prepare('SELECT DISTINCT entity_id FROM entity_items');
        const ids = new Set<string>();
        for (const row of stmts.entityIds.all() as Array<{ id: string }>) ids.add(String(row.id));
        for (const row of stmts.itemRoomIds.all() as Array<{ entity_id: string }>) ids.add(String(row.entity_id));
        return [...ids];
    };
    /** 一行 `{ seq, item }` → `Item`（坏行当没有：与 `itemsOf` / `lastItemPerBot` 同策） */
    const itemOfRow = (row: unknown): Item | undefined => {
        if (row === undefined) return undefined;
        const record = row as Record<string, unknown>;
        try {
            return { ...(JSON.parse(String(record['item'])) as Item), seq: Number(record['seq']) };
        } catch {
            return undefined;
        }
    };
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

    /**
     * 事务，**可重入**。
     *
     * 迁移器会给每个迁移包一层（保证「执行 + 记账」同进同退），而里面的写入路径
     * （writeTask / writeProject）平时自己也开事务 —— 已在事务里就直接跑，不撞 BEGIN。
     */
    let txDepth = 0;
    const transaction = <T>(fn: () => T): T => {
        if (txDepth > 0) return fn();
        txDepth += 1;
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            db.exec('COMMIT');
            return result;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        } finally {
            txDepth -= 1;
        }
    };

    const report: MigrationReporter = options.onMigrationStep ?? ((): void => undefined);

    /**
     * 当前 schema 的落地（`CREATE TABLE IF NOT EXISTS` 一整套）。
     *
     * 它作为第 3 号迁移（`003-create-tables`）执行 —— 为什么必须排在那之后：
     * 两条表改名（bot_roles / role_config）得赶在建表前面，否则新表先被建出来，
     * 老表就再也改不了名，旧数据全成孤儿（2026-11-27 的教训）。
     */
    const createSchema = (): void => {
        db.exec(`
        -- 角色：一种工作对象类型上的固定席位（见 docs/plans/2026-11-24-bot-role.md）。
        -- 旧的 bots 表按「每个容器一个同名 bot」建，35 行里 27 行 persona 一模一样；
        -- 角色改成类型级：新建任务自动出现在任务房间里，一个房间一份会话。
        CREATE TABLE IF NOT EXISTS bot_profiles (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            instructions TEXT NOT NULL DEFAULT '',
            primary_flag INTEGER NOT NULL DEFAULT 0,
            model_key TEXT,
            reasoning_effort TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            -- per-task bot（2026-11-26）：domain 归属。type 级角色（模板）为 null，向后兼容
            domain_type TEXT,
            domain_id TEXT,
            -- 人设代码贡献点（persona_ref）：null = 用 instructions 文本（向后兼容）
            persona_ref TEXT
        );
        -- 「每类型至多一个 primary」不靠应用层自觉：应用层漏一次就是一段时间的双应答
        CREATE UNIQUE INDEX IF NOT EXISTS bot_profiles_primary ON bot_profiles(type) WHERE primary_flag = 1;
        CREATE INDEX IF NOT EXISTS bot_profiles_type ON bot_profiles(type, created_at);
        -- 类型默认配置（2026-11-26）：几百个任务 bot 共享一套 model / effort，
        -- 只有个别 bot 需要 override 时才在 bot_profiles 上填（model_key / reasoning_effort 为 null = 走类型默认）。
        CREATE TABLE IF NOT EXISTS bot_profile_defaults (
            type TEXT PRIMARY KEY,
            model_key TEXT,
            reasoning_effort TEXT,
            updated_at INTEGER NOT NULL
        );
        -- 旧 bots 表不在这里建：新库不该有它。只在老库里存在，且迁移后改名为 bots_v0。
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
        -- 未读计数（unreadByRoom）：按 (entity_id, type, role) 筛出 chat 再 GROUP BY。
        -- 没有这条索引 = 全表 3.5 万行逐行 json_extract（**实测 926ms**），而 rooms.list
        -- 首屏必经、每 30s 一次 —— 用户 2026-11-26 报“页面很慢”就是它。建完走覆盖索引
        -- **2.2ms**（420 倍）。部分索引只收 chat 行（体积小）；
        -- WHERE 必须与查询里的 json_extract(i.item, '$.type') = 'chat' 逐字一致才命中。
        CREATE INDEX IF NOT EXISTS items_chat_role ON entity_items(
            entity_id,
            json_extract(item, '$.type'),
            json_extract(item, '$.author.role'),
            seq
        ) WHERE json_extract(item, '$.type') = 'chat';
        -- 「这一轮报过中断吗」与「续跑时要撤掉哪条」都按 (kind, turnId, botId) 定位。
        -- 表里 kind='interrupted' 的行通常只有个位数，部分索引因此极小；
        -- WHERE 必须与 deleteInterruptedFacts 的过滤条件逐字一致才命中。
        CREATE INDEX IF NOT EXISTS items_interrupted ON entity_items(
            entity_id,
            json_extract(item, '$.turnId'),
            json_extract(item, '$.data.botId')
        ) WHERE json_extract(item, '$.data.kind') = 'interrupted';
        -- 按条目 id 批量取（itemsByIds：WHERE json_extract(item,'$.id') IN (…)）。
        -- 需求板每次轮询都要把 source（「来自哪句人话」）解回原话，而 item 的 id 只在 json 里 ——
        -- 没有这条索引就是**全表扫 43,933 行 / 150MB**：真库实测 50 个 id 0.86~1.18s，
        -- 建完 0.01s（~100 倍）。部分索引只收有 id 的行（全表都是），体积 ~1.5MB。
        -- WHERE 必须与 itemsByIds 的过滤条件一致；查询不加 entity_id 条件（来源可能跨房间）。
        CREATE INDEX IF NOT EXISTS items_item_id ON entity_items(
            json_extract(item, '$.id')
        ) WHERE json_extract(item, '$.id') IS NOT NULL;
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
        -- 每一轮的结算事实（一行一轮，收尾时写、永不删）：刷新后消息底下的
        -- 结算行（耗时 / tokens / 步数 / 工具次数）靠它，没它历史轮次整行消失
        CREATE TABLE IF NOT EXISTS turn_facts (
            entity_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER NOT NULL,
            usage TEXT,
            tool_calls INTEGER,
            reason TEXT,
            PRIMARY KEY (entity_id, turn_id, bot_id)
        );
        CREATE INDEX IF NOT EXISTS turn_facts_entity ON turn_facts(entity_id, turn);
        -- 会话键 =（容器, 角色）。列名 2026-11-24 从 bot_id 改为 bot_profile_id：
        -- 同名的旧列会被 ALTER TABLE ... RENAME COLUMN 改过来（见老库补列）
        CREATE TABLE IF NOT EXISTS session_state (
            entity_id TEXT NOT NULL,
            bot_profile_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            collapsed INTEGER NOT NULL,
            entries TEXT NOT NULL,
            usage TEXT,
            log_seq INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (entity_id, bot_profile_id)
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
        -- 2026-11-27 裁：只有两层（目标 → 需求）；kind 列已退役（代码不再读写，
        -- 只保留 DEFAULT 'need' 以免老库写入报错，见 migration 019）
        CREATE TABLE IF NOT EXISTS task_units (
            task_id    TEXT NOT NULL,
            id         TEXT NOT NULL,
            kind       TEXT NOT NULL DEFAULT 'need',
            title      TEXT NOT NULL,
            body       TEXT NOT NULL DEFAULT '',
            -- 「怎么算做完」：空串 = 还没写（界面会标出来）
            accept     TEXT NOT NULL DEFAULT '',
            -- 来自哪句人话（entity_items.id）：宿主按「本轮触发的那条消息」自动盖章
            source_message_id TEXT NOT NULL DEFAULT '',
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
        -- 已读水位：「这个房间我看到哪一条了」（2026-11-26）。
        --
        -- 按**房间**记而不是按 bot 记：人是唯一读者 —— 谁发的都无所谓，
        -- 只要「我」没看过就是未读。企业的多人场景不在当前模型内（没有身份）。
        -- seq 取自 entity_items.seq（全局自增，单调可比）：跨房间的绝对值不重要，
        -- 只要同一条流里单调就能「比大小」。—— 只前进不后退（markRead 里取 MAX）。
        CREATE TABLE IF NOT EXISTS room_read (
            entity_id TEXT PRIMARY KEY,
            last_read_seq INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
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
    };

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
                ...(row['persona'] === null ? {} : { persona: String(row['persona']) }),
            };
            (out[id] ??= []).push(member);
        }
        return out;
    };

    const toRole = (row: Record<string, unknown>): BotProfile => ({
        id: String(row['id']),
        type: String(row['type']),
        name: String(row['name']),
        color: String(row['color']),
        instructions: String(row['instructions']),
        primary: Number(row['primary_flag']) === 1,
        modelKey: row['model_key'] === null ? null : String(row['model_key']),
        reasoningEffort: row['reasoning_effort'] === null ? null : String(row['reasoning_effort']),
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
        domainType: row['domain_type'] === null ? null : String(row['domain_type']),
        domainId: row['domain_id'] === null ? null : String(row['domain_id']),
        personaRef: row['persona_ref'] === null ? null : String(row['persona_ref']),
    });

    const toBotProfileDefaults = (row: Record<string, unknown>): BotProfileDefaults => ({
        type: String(row['type']),
        modelKey: row['model_key'] === null ? null : String(row['model_key']),
        reasoningEffort: row['reasoning_effort'] === null ? null : String(row['reasoning_effort']),
        updatedAt: Number(row['updated_at']),
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
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at'] ?? 0),
    });

    const readProjectRow = (row: Record<string, unknown>): ProjectRecord => ({
        id: String(row['id']),
        name: String(row['name']),
        workspace: row['workspace'] === null ? null : String(row['workspace']),
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
        accept: row['accept'] === null || row['accept'] === undefined ? '' : String(row['accept']),
        source:
            row['source_message_id'] === null || row['source_message_id'] === undefined
                ? ''
                : String(row['source_message_id']),
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
        // 缺省沿用（改 title 不该顺手把挂点抹掉）；新节点缺省 = 根
        const nextParent = unit.parent === undefined ? (previous?.parent ?? null) : unit.parent;
        // seq 的作用域 = **同一个父下面**（2026-11-27 裁）：目标之间排一次、每个目标下的需求
        // 各自再排一次。原来全局一把号，新需求会把「目标列表」和「某目标下的需求列表」串成
        // 一条看不到边界的计数。
        const nextSeq = (
            db.prepare(
                'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM task_units ' +
                    'WHERE task_id = ? AND ((? IS NULL AND parent_id IS NULL) OR parent_id = ?)',
            ).get(unit.taskId, nextParent, nextParent) as {
                n: number;
            }
        ).n;
        const record: UnitRecord = {
            taskId: unit.taskId,
            id: previous?.id ?? unit.id ?? allocateUnitId(unit.taskId),
            title,
            body: unit.body,
            // 缺省沿用（改标题不该把已写好的验收口径抹掉）
            accept: unit.accept ?? previous?.accept ?? '',
            // 来源同理：只在显式给的时候覆盖（重跑一遍 unit_add 不会把来源抹成空）
            source: unit.source ?? previous?.source ?? '',
            status: unit.status,
            parent: nextParent,
            // 换挂点时重新拿号：旧号在原来的兄弟里才有意义，搬到新父下会插到中间去
            seq: previous === undefined || previous.parent !== nextParent ? Number(nextSeq) : previous.seq,
            createdAt: previous?.createdAt ?? unit.createdAt ?? now,
            updatedAt: unit.updatedAt ?? now,
        };
        if (record.parent === record.id) throw new Error(`unit 不能是自己的父：${record.id}`);
        db.prepare(
            'INSERT INTO task_units (task_id, id, title, body, accept, source_message_id, status, parent_id, seq, created_at, updated_at) ' +
                'VALUES (?,?,?,?,?,?,?,?,?,?,?) ' +
                'ON CONFLICT(task_id, id) DO UPDATE SET title=?, body=?, accept=?, source_message_id=?, status=?, parent_id=?, updated_at=?',
        ).run(
            record.taskId,
            record.id,
            record.title,
            record.body,
            record.accept,
            record.source,
            record.status,
            record.parent,
            record.seq,
            record.createdAt,
            record.updatedAt,
            record.title,
            record.body,
            record.accept,
            record.source,
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
        a.closedAt === b.closedAt;

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

        transaction(() => {
            writeEntity(task.id, 'task', createdAt);
            db.prepare(
                'INSERT INTO tasks (id, number, title, summary, body, project_id, workspace, status, closed_at, created_at, updated_at) ' +
                    'VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
                    'title=excluded.title, summary=excluded.summary, body=excluded.body, project_id=excluded.project_id, ' +
                    'workspace=excluded.workspace, status=excluded.status, closed_at=excluded.closed_at, ' +
                    'updated_at=excluded.updated_at',
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
                createdAt,
                updatedAt,
            );
        });
        // 导出物：task.md（DB 仍是真源；文件失败只记日志）
        if (changed && dataRoot !== undefined) mirror(() => writeTaskDoc(dataRoot, record));
        return record;
    };

    const writeProject = (project: ProjectInput): ProjectRecord => {
        const existing = db.prepare('SELECT created_at FROM projects WHERE id = ?').get(project.id) as
            | { created_at: number }
            | undefined;
        const createdAt = existing?.created_at ?? project.createdAt ?? Date.now();

        transaction(() => {
            writeEntity(project.id, 'project', createdAt);
            db.prepare(
                'INSERT INTO projects (id, name, workspace, created_at) VALUES (?,?,?,?) ' +
                    'ON CONFLICT(id) DO UPDATE SET name=excluded.name, workspace=excluded.workspace',
            ).run(project.id, project.name, project.workspace ?? null, createdAt);
        });
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
                    createdAt,
                    // 历史任务没有「最后改动」概念：用创建时刻兜，别让迁移当天变成全员更新
                    updatedAt: createdAt,
                });
            } else if (type === 'project') {
                writeProject({
                    id,
                    name: String(row['name']),
                    workspace: text('dir') || null,
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

        transaction(() => {
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
        });
    };

    /**
     * 老库迁移：`bots`（每个容器一个同名 bot）→ `bot_profiles`（类型级角色）。
     *
     * 合并规则 = `(type, persona)` 相同即同一个角色：
     *   · type 取 bot 归属容器的实体类型（project / task / …）；归属容器已不在时按 task 处理
     *   · 角色 id 复用组内**最早那行**的 bot id —— 单行组（几个项目 bot）的会话键因此一字不动，
     *     只有被合并掉的 26 个 task bot 需要改键
     *   · 角色名：单行组用 bot 名；合并组用类型名（「任务助手」）—— 否则 27 个任务会有一个
     *     叫「UI Workbench 架构对齐」的角色
     *   · primary：该类型里「组内在 room_members 当过 primary」次数最多的那组，平手取最早
     *
     * 会话 / 投递按新旧 id 映射重写；同一容器里两行撞到同一个角色时留 turn 大的那条并打日志。
     * 迁移完把旧表改名 `bots_v0` 留档（跟 `rooms_v0` 一个路数，不删人数据）。
     */
    const migrateBots = (): void => {
        const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='bots'").get();
        if (exists === undefined) return;
        const rows = db
            .prepare(
                `SELECT b.id AS id, b.name AS name, b.color AS color, b.persona AS persona, b.model_key AS model_key,
                        COALESCE(e.type, 'task') AS type,
                        (SELECT COUNT(*) FROM room_members m WHERE m.bot_id = b.id AND m.primary_flag = 1) AS primaries
                   FROM bots b LEFT JOIN entities e ON e.id = b.home_entity_id
                  ORDER BY b.rowid ASC`,
            )
            .all() as Array<Record<string, unknown>>;
        if (rows.length === 0) {
            renameToBackup('bots', 'bots_v0');
            return;
        }

        const defaultName = (type: string): string =>
            ({ project: '项目助手', task: '任务助手' })[type] ?? `${type} 助手`;
        const now = Date.now();
        interface Group {
            type: string;
            persona: string;
            ids: string[];
            first: Record<string, unknown>;
            primaries: number;
        }
        const groups = new Map<string, Group>();
        for (const row of rows) {
            const type = String(row['type']);
            const persona = String(row['persona']);
            const key = `${type}\u0000${persona}`;
            const group = groups.get(key);
            if (group === undefined) {
                groups.set(key, {
                    type,
                    persona,
                    ids: [String(row['id'])],
                    first: row,
                    primaries: Number(row['primaries']),
                });
            } else {
                group.ids.push(String(row['id']));
                group.primaries += Number(row['primaries']);
            }
        }

        const remap = new Map<string, string>();
        const insert = db.prepare(
            'INSERT OR REPLACE INTO bot_profiles (id, type, name, color, instructions, primary_flag, model_key, reasoning_effort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        );
        // primary 每类型一个：先按组算胜出者
        const primaryOf = new Map<string, Group>();
        for (const group of groups.values()) {
            const best = primaryOf.get(group.type);
            if (best === undefined || group.primaries > best.primaries) primaryOf.set(group.type, group);
        }
        let seq = 0;
        for (const group of groups.values()) {
            const id = group.ids[0]!;
            const modelKey = group.first['model_key'];
            insert.run(
                id,
                group.type,
                group.ids.length === 1 ? String(group.first['name']) : defaultName(group.type),
                String(group.first['color']),
                group.persona,
                primaryOf.get(group.type) === group ? 1 : 0,
                // 老库里有 `none@none/none` 这种占位值（当年拿它表示「没配」）：迁移时落成 null，
                // 空串 / 占位都不该进角色列 —— 角色没选模型 = 继续继承（房间 → 全局默认）
                modelKey === null || String(modelKey) === '' || String(modelKey) === PLACEHOLDER_MODEL_KEY
                    ? null
                    : String(modelKey),
                null,
                // 组内相对次序要稳定：主选按「建得早」排，这里就得给出单调的 createdAt
                now - (rows.length - seq) * 60_000,
                now,
            );
            seq += 1;
            for (const oldId of group.ids) remap.set(oldId, id);
        }

        const moved = [...remap.entries()].filter(([from, to]) => from !== to);
        transaction(() => {
            // 映射先落临时表：下面两张 JSON 大表的 author.id / owner 要**一次扫完**。
            // 以前是「每个映射都全表扫一遍」—— 真库 37 个映射 × 2274 条大 JSON ≈ 两分半，
            // 全都卡在这一段，迁移页上一行 running 一动不动（2026-11-27 实测）。
            db.exec('CREATE TEMP TABLE IF NOT EXISTS _bot_remap (from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL)');
            db.exec('DELETE FROM _bot_remap');
            const addRemap = db.prepare('INSERT OR REPLACE INTO _bot_remap (from_id, to_id) VALUES (?,?)');

            let done = 0;
            for (const [from, to] of moved) {
                addRemap.run(from, to);
                // 撞键：同一容器里两个 bot 合并成一个角色 ⇒ 留 turn 大的那份会话
                const dropped = db
                    .prepare(
                        'DELETE FROM session_state WHERE bot_profile_id = ? AND entity_id IN (SELECT entity_id FROM session_state WHERE bot_profile_id = ?)',
                    )
                    .run(from, to).changes;
                if (Number(dropped) > 0) {
                    console.error(
                        `[bot-role] 合并会话：${from} → ${to}，丢掉 ${String(dropped)} 份旧快照（同容器重复）`,
                    );
                }
                db.prepare('UPDATE session_state SET bot_profile_id = ? WHERE bot_profile_id = ?').run(to, from);
                db.prepare(
                    'DELETE FROM deliveries WHERE bot_id = ? AND entity_id IN (SELECT entity_id FROM deliveries WHERE bot_id = ?)',
                ).run(from, to);
                db.prepare('UPDATE deliveries SET bot_id = ? WHERE bot_id = ?').run(to, from);
                done += 1;
                if (done % 10 === 0 || done === moved.length) runtime.progress?.(done, moved.length);
            }

            if (moved.length > 0) {
                // 历史消息里的作者 id 也要跟着换：界面按「消息 author.id ∈ 当前成员」决定
                // 归属与是否显示 —— 不改的话，被合并掉的那批旧 bot 的消息会因对不上新角色 id
                // 而在界面上整段消失（数据在库里、只是看不见）。2026-11-26 实测发现。
                db.prepare(
                    "UPDATE entity_items SET item = json_set(item, '$.author.id', (SELECT to_id FROM _bot_remap WHERE from_id = json_extract(item, '$.author.id'))) " +
                        "WHERE json_extract(item, '$.author.id') IN (SELECT from_id FROM _bot_remap)",
                ).run();
                runtime.progress?.(moved.length, moved.length);
                // 提问的 owner 同理：ask 卡片的归属 /「谁问的」也按角色 id 认。
                db.prepare(
                    "UPDATE asks SET request = json_set(request, '$.owner', (SELECT to_id FROM _bot_remap WHERE from_id = json_extract(request, '$.owner'))) " +
                        "WHERE json_extract(request, '$.owner') IN (SELECT from_id FROM _bot_remap)",
                ).run();
            }
            renameToBackup('bots', 'bots_v0');
        });
    };

    /**
     * 退役：房间级 `model_key`（2026-11-27 用户裁「模型真源 = 人设」）。
     *
     * `tasks` / `projects` 的 model_key 曾是「建容器时把默认模型写死一份」，于是角色级改动
     * 永远被它盖住（UI 显示角色级、执行读房间级）。这里把列直接删掉（SQLite ≥ 3.35）；
     * 删不动（老版本 / 被索引引用）就清空 —— 代码已经不再读写它，留着只是噪音。
     */
    // ── 跑迁移（2026-11-27 重构）───────────────────────────────────────
    // 编排全在 `./migrations/`：一个迁移一个文件、顺序 = 数组顺序、记账表 = schema_migrations。
    // 这里只提供「迁移允许用到的能力面」—— 纯库操作 + 三个必须走 store 语义的搬家
    // （老房间搬迁要分配任务编号、折 bots 要重写会话 / 消息、老日志要落事件流）。
    const runtime: MigrationRuntime = {
        db,
        transaction,
        hasTable: (name: string): boolean =>
            db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined,
        columns: (table: string): Set<string> => {
            const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(table);
            if (exists === undefined) return new Set();
            return new Set(
                (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
            );
        },
        renameToBackup: (table: string): void => renameToBackup(table, 'v0'),
        createSchema,
        legacyRooms: (): void => migrateLegacyRooms(),
        foldBots: (): void => migrateBots(),
        journalToEvents: (): void => migrateJournal(),
        // 存量工具输出外置：迁移器已开着事务（执行 + 记账同进同退），实现只复用它的写入路径。
        // 内存库（`:memory:`）没有数据根 → 无处放文件，什么都不做（也就永远不会「迁完」）。
        offloadToolOutputs: (report) => {
            if (dataRoot === undefined) return { offloaded: 0, bytesMoved: 0, failed: 0 };
            const stats = offloadExistingToolOutputs(db, {
                dataRoot,
                inTransaction: true,
                ...(report === undefined ? {} : { onProgress: report }),
            });
            return { offloaded: stats.offloaded, bytesMoved: stats.bytesMoved, failed: stats.failed };
        },
        log: (message: string): void => console.error(`[migrate] ${message}`),
    };
    const migrationRun = applyMigrations(runtime, report);
    // 启动日志报一句「库版本」：出问题时第一眼看的就是它（没跑东西就不啰嗦）
    if (migrationRun.ran.length > 0) {
        console.error(
            `[migrate] 库版本 ${String(migrationRun.total)} 条已就位；本次跑了 ${String(migrationRun.ran.length)} 条：${migrationRun.ran.join(', ')}`,
        );
    }
    // 迁移跑完**自检**（2026-11-27）：步骤 done ≠ 库是对的。孤儿引用 / 行数对不上在这里爆，
    // 而不是等某个读路径撞上变成 500。判据见 ./verify-migrations.ts（error 拦启动，warn 只报）。
    const findings = verifyDatabase(runtime);
    if (findings.length > 0) {
        const hard = findings.filter((item) => item.level === 'error');
        const detail = describeFindings(findings);
        console.error(`[migrate] 迁移后自检：${detail}`);
        report({ id: 'verify', title: '迁移后自检', state: hard.length > 0 ? 'failed' : 'done', note: detail });
        if (hard.length > 0) {
            throw Object.assign(new Error(`迁移后自检未通过：${detail}`), { code: 'migration/verify-failed' });
        }
    }

    return {
        db,
        listBotProfiles(): BotProfile[] {
            const rows = db
                .prepare('SELECT * FROM bot_profiles ORDER BY type ASC, primary_flag DESC, created_at ASC, rowid ASC')
                .all() as Record<string, unknown>[];
            return rows.map(toRole);
        },
        upsertBotProfile(role: BotProfile): void {
            // 「每类型至多一个 primary」由唯一索引兜底：先撤掉同类型别人身上的旗，再写自己
            db.exec('BEGIN IMMEDIATE');
            try {
                if (role.primary) {
                    db.prepare('UPDATE bot_profiles SET primary_flag = 0 WHERE type = ? AND id <> ?').run(
                        role.type,
                        role.id,
                    );
                }
                db.prepare(
                    'INSERT INTO bot_profiles (id, type, name, color, instructions, primary_flag, model_key, reasoning_effort, created_at, updated_at, domain_type, domain_id, persona_ref) ' +
                        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
                        'name=excluded.name, color=excluded.color, instructions=excluded.instructions, ' +
                        'primary_flag=excluded.primary_flag, model_key=excluded.model_key, ' +
                        'reasoning_effort=excluded.reasoning_effort, updated_at=excluded.updated_at, ' +
                        'domain_type=excluded.domain_type, domain_id=excluded.domain_id, persona_ref=excluded.persona_ref',
                ).run(
                    role.id,
                    role.type,
                    role.name,
                    role.color,
                    role.instructions,
                    role.primary ? 1 : 0,
                    role.modelKey === null || role.modelKey === '' ? null : role.modelKey,
                    role.reasoningEffort,
                    role.createdAt,
                    role.updatedAt,
                    role.domainType ?? null,
                    role.domainId ?? null,
                    role.personaRef ?? null,
                );
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        listBotProfileDefaults(): BotProfileDefaults[] {
            const rows = db.prepare('SELECT * FROM bot_profile_defaults ORDER BY type ASC').all() as Record<
                string,
                unknown
            >[];
            return rows.map(toBotProfileDefaults);
        },
        getBotProfileDefaults(type: string): BotProfileDefaults | undefined {
            const row = db.prepare('SELECT * FROM bot_profile_defaults WHERE type = ?').get(type) as
                | Record<string, unknown>
                | undefined;
            return row === undefined ? undefined : toBotProfileDefaults(row);
        },
        setBotProfileDefaults(config: BotProfileDefaults): void {
            db.prepare(
                'INSERT INTO bot_profile_defaults (type, model_key, reasoning_effort, updated_at) VALUES (?,?,?,?) ' +
                    'ON CONFLICT(type) DO UPDATE SET model_key=excluded.model_key, reasoning_effort=excluded.reasoning_effort, updated_at=excluded.updated_at',
            ).run(config.type, config.modelKey, config.reasoningEffort, config.updatedAt);
        },
        appendItem(roomId: string, item: Item): Item {
            const result = db
                .prepare('INSERT INTO entity_items (entity_id, item, at) VALUES (?,?,?)')
                .run(roomId, JSON.stringify(item), item.at);
            return { ...item, seq: Number(result.lastInsertRowid) };
        },
        appendJournal(
            roomId: string,
            input: { kind: JournalKind; text: string; at?: number; unit?: string },
        ): JournalEntry {
            const at = input.at ?? Date.now();
            const unit = input.unit === undefined || input.unit === '' ? undefined : input.unit;
            const result = db
                .prepare('INSERT INTO events (at, event, subject, data) VALUES (?,?,?,?)')
                .run(
                    at,
                    journalEventOf(roomId),
                    roomId,
                    JSON.stringify({ kind: input.kind, text: input.text, ...(unit === undefined ? {} : { unit }) }),
                );
            const entry: JournalEntry = {
                seq: Number(result.lastInsertRowid),
                at,
                kind: input.kind,
                text: input.text,
                ...(unit === undefined ? {} : { unit }),
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
                          .prepare(
                              'SELECT seq, at, event, data FROM events WHERE subject = ? ORDER BY seq DESC LIMIT ?',
                          )
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
                    let data: { kind?: unknown; text?: unknown; unit?: unknown } = {};
                    try {
                        const parsed: unknown = JSON.parse(String(row['data']));
                        if (typeof parsed === 'object' && parsed !== null) data = parsed as typeof data;
                    } catch {
                        /* 坏 data 不该让整份日志读不出来 */
                    }
                    // 未知 kind 归位成 progress：journal 的 kind 由 schema 硬校验（context 里
                    // `journal.entries[].kind` 是枚举），一条脏数据会让**整轮上下文装配崩掉**。
                    // 2026-11-27 实测：lab 里 bot 把步骤写成 `kind: "step"` → 启动即 ZodError。
                    const kind: JournalKind = JOURNAL_KINDS.includes(data.kind as JournalKind)
                        ? (data.kind as JournalKind)
                        : 'progress';
                    return {
                        seq: Number(row['seq']),
                        at: Number(row['at']),
                        kind,
                        text: typeof data.text === 'string' ? data.text : '',
                        ...(typeof data.unit === 'string' && data.unit !== '' ? { unit: data.unit } : {}),
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
                'INSERT INTO room_members (entity_id, bot_id, position, primary_flag, persona) VALUES (?,?,?,?,?)',
            );
            members.forEach((member, index) => {
                insert.run(roomId, member.botId, index, member.primary === true ? 1 : 0, member.persona ?? null);
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
        deleteBotProfile(roleId: string): void {
            // 成员是从角色表派生的：删了角色，各房间的成员名单下一次派生时就少一个，
            // 但那间房的会话/投递还挂着这个 id，不清就是永久孤儿行
            db.prepare('DELETE FROM session_state WHERE bot_profile_id = ?').run(roleId);
            db.prepare('DELETE FROM deliveries WHERE bot_id = ?').run(roleId);
            db.prepare('DELETE FROM bot_profiles WHERE id = ?').run(roleId);
            // 老库里 bot 都是实体：身份行只在确实属于 bot 时删（防 id 撞到房间）
            db.prepare("DELETE FROM entities WHERE id = ? AND type = 'bot'").run(roleId);
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
        rawUnit(taskId: string, unitId: string): Record<string, unknown> | undefined {
            const row = db.prepare('SELECT * FROM task_units WHERE task_id = ? AND id = ?').get(taskId, unitId) as
                | Record<string, unknown>
                | undefined;
            return row === undefined ? undefined : { ...row };
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
                    // 未完成的两种都算：`pending` 还没轮到，`working` 是「上次跑时正在处理」——
                    // 进程重启后它是孤儿，`recover()` 要把它重投一遍。
                    "SELECT * FROM deliveries WHERE entity_id = ? AND state IN ('pending','working') ORDER BY updated_at ASC",
                )
                .all(roomId) as Array<Record<string, unknown>>;
            return rows.map((row) => ({
                roomId: String(row['entity_id']),
                messageId: String(row['message_id']),
                botId: String(row['bot_id']),
                state: row['state'] as Delivery['state'],
                ...(row['mode'] === null ? {} : { mode: row['mode'] as MessageKind }),
                ...(row['turn'] === null ? {} : { turn: Number(row['turn']) }),
                ...(row['turn_id'] === null ? {} : { turnId: String(row['turn_id']) }),
            }));
        },
        failedByRoom(roomIds?: readonly string[]): Record<string, number> {
            // 一个 bot 在同一房间可能有多条历史 failed（旧插话没送进去、崩溃重投失败…）。
            // 只有「它最新那条消息」的投递状态才代表现在：先按轮次，再按消息在本房间
            // 时间线上的落盘 seq，最后才用状态更新时刻兜底（老消息没有 turn 字段）。
            // 这里刻意不把 queued / delivering 当失败：那些由 `queuedByBot` 单独画排队。
            //
            // 不在 SQL 里按 message_id 连 entity_items：实测那条路在本机真库上要 11s
            // （json_extract 连接找不到可用索引），而这个是 `rooms.list` 的 30s 轮询的一部分。
            // 改用 room_entries 的 say 条目取消息序号 —— 投递的 messageId 本来就是它落的，
            // 而且这张表只有条目流的一小部分（真库实测 2.1k vs entity_items 36.9k）。
            //
            // **逐房间问**（2026-11-28）：原来一次算全实例，光那次「扫全部 say 条目取序号」
            // 就要把 2.5k 行 / 2MB entry 的 json 摸一遍（副本实测 58ms、生产热库 176ms），
            // 而这里面绝大多数房间一条投递都没有。按房间问就只摸该房间那几行；
            // 且 seq 只在**两条候选的轮次相等（含都缺 turn 的老数据）**时才真去读 ——
            // 新数据的比较走到 turn 那一级就分出来了。
            stmts.deliveriesOfRoom ??= db.prepare(
                'SELECT bot_id, message_id, state, note, turn, updated_at FROM deliveries WHERE entity_id = ? ORDER BY updated_at ASC',
            );
            stmts.saySeqOfRoom ??= db.prepare(
                "SELECT seq, json_extract(entry, '$.messageId') AS message_id FROM room_entries " +
                    "WHERE entity_id = ? AND json_extract(entry, '$.kind') = 'say'",
            );

            type Latest = { state: string; note?: string; turn: number; seq?: number; at: number; messageId: string };
            const failed: Record<string, number> = {};
            for (const roomId of roomIdsOf(roomIds)) {
                const rows = stmts.deliveriesOfRoom.all(roomId) as Array<Record<string, unknown>>;
                if (rows.length === 0) continue;

                /** 懒建：该房间的「消息 id → 落盘 seq」（只有轮次相等时才真的会调它） */
                let seqOf: Map<string, number> | undefined;
                const seqOfMessage = (messageId: string): number => {
                    seqOf ??= new Map(
                        (stmts.saySeqOfRoom!.all(roomId) as Array<{ seq: number; message_id: string | null }>).flatMap(
                            (row) =>
                                row.message_id === null
                                    ? []
                                    : [[String(row.message_id), Number(row.seq)] as [string, number]],
                        ),
                    );
                    return seqOf.get(messageId) ?? -1;
                };
                /** `a` 是否比 `b` 更新（轮次 → 消息 seq → 状态时刻，判据同 isLaterDelivery） */
                const laterThan = (a: Latest, b: Latest): boolean => {
                    if (a.turn !== b.turn) return a.turn > b.turn;
                    a.seq ??= seqOfMessage(a.messageId);
                    b.seq ??= seqOfMessage(b.messageId);
                    if (a.seq !== b.seq) return a.seq > b.seq;
                    if (a.at !== b.at) return a.at > b.at;
                    return a.messageId > b.messageId;
                };

                const latest = new Map<string, Latest>();
                for (const row of rows) {
                    const candidate: Latest = {
                        state: String(row['state']),
                        note: row['note'] === null ? undefined : String(row['note']),
                        turn: row['turn'] === null ? -1 : Number(row['turn']),
                        at: Number(row['updated_at']),
                        messageId: String(row['message_id']),
                    };
                    const botId = String(row['bot_id']);
                    const current = latest.get(botId);
                    if (current === undefined || laterThan(candidate, current)) latest.set(botId, candidate);
                }

                let count = 0;
                for (const row of latest.values()) {
                    // 失败不再是独立状态：`done + note='failed'`（2026-11-27 收敛到 3 个状态）
                    if (row.state === 'done' && row.note === 'failed') count += 1;
                }
                if (count > 0) failed[roomId] = count;
            }
            return failed;
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
            // 正文落库外（`sessions/<roomId>__<botId>.json`），表里只留元数据。
            // 写盘失败退回「正文进表」：宁可库大一点，也不能丢上下文。
            let entriesText = '';
            const file = dataRoot === undefined ? undefined : sessionFilePath(dataRoot, roomId, botId);
            if (file === undefined) {
                entriesText = JSON.stringify(snapshot.entries);
            } else {
                try {
                    writeSessionEntries(file, snapshot.entries);
                } catch (error) {
                    console.error(`[session-file] 写盘失败，回退进库：${(error as Error).message}`);
                    entriesText = JSON.stringify(snapshot.entries);
                }
            }
            db.prepare(
                'INSERT INTO session_state (entity_id, bot_profile_id, turn, collapsed, entries, usage, log_seq, updated_at) VALUES (?,?,?,?,?,?,?,?) ' +
                    'ON CONFLICT(entity_id, bot_profile_id) DO UPDATE SET turn=?, collapsed=?, entries=?, usage=?, log_seq=?, updated_at=?',
            ).run(
                roomId,
                botId,
                snapshot.turn,
                snapshot.collapsed,
                entriesText,
                snapshot.usage === undefined ? null : JSON.stringify(snapshot.usage),
                snapshot.logSeq ?? 0,
                Date.now(),
                snapshot.turn,
                snapshot.collapsed,
                entriesText,
                snapshot.usage === undefined ? null : JSON.stringify(snapshot.usage),
                snapshot.logSeq ?? 0,
                Date.now(),
            );
        },
        loadSession(roomId: string, botId: string): SessionSnapshot | undefined {
            const row = db
                .prepare('SELECT * FROM session_state WHERE entity_id = ? AND bot_profile_id = ?')
                .get(roomId, botId) as Record<string, unknown> | undefined;
            if (row === undefined) return undefined;
            // 两条判据：表里有正文 ⇒ 老数据 / 写盘失败的回退；是空串 ⇒ 正文在文件里。
            // 文件丢了（被手动删 / 坏了）当「没有快照」→ 全量回放，退化但不丢消息。
            const raw = String(row['entries'] ?? '');
            const entries =
                raw === ''
                    ? dataRoot === undefined
                        ? undefined
                        : readSessionEntries(sessionFilePath(dataRoot, roomId, botId))
                    : (JSON.parse(raw) as TranscriptEntry[]);
            if (entries === undefined) return undefined;
            return {
                turn: Number(row['turn']),
                collapsed: Number(row['collapsed']),
                entries,
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
            ).run(roomId, record.botId, record.turn, record.turnId, record.at, record.turn, record.turnId, record.at);
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
        saveTurnFact(roomId: string, fact: TurnFactRow): void {
            // UPSERT：同一轮被收尾两次（续跑后又收一次）不报错，后一次覆盖前一次
            db.prepare(
                'INSERT INTO turn_facts (entity_id, turn_id, bot_id, turn, started_at, ended_at, usage, tool_calls, reason) ' +
                    'VALUES (?,?,?,?,?,?,?,?,?) ' +
                    'ON CONFLICT(entity_id, turn_id, bot_id) DO UPDATE SET ' +
                    'started_at=excluded.started_at, ended_at=excluded.ended_at, usage=excluded.usage, ' +
                    'tool_calls=excluded.tool_calls, reason=excluded.reason',
            ).run(
                roomId,
                fact.turnId,
                fact.botId,
                fact.turn,
                fact.startedAt ?? null,
                fact.endedAt,
                fact.usage === undefined ? null : JSON.stringify(fact.usage),
                fact.toolCalls ?? null,
                fact.reason === undefined ? null : JSON.stringify(fact.reason),
            );
        },
        turnFacts(roomId: string): TurnFactRow[] {
            const rows = db
                .prepare(
                    'SELECT bot_id, turn_id, turn, started_at, ended_at, usage, tool_calls, reason FROM turn_facts WHERE entity_id = ? ORDER BY turn ASC',
                )
                .all(roomId) as Array<Record<string, unknown>>;
            return rows.map((row) => ({
                botId: String(row['bot_id']),
                turnId: String(row['turn_id']),
                turn: Number(row['turn']),
                ...(row['started_at'] === null ? {} : { startedAt: Number(row['started_at']) }),
                endedAt: Number(row['ended_at']),
                ...(row['usage'] === null ? {} : { usage: JSON.parse(String(row['usage'])) as TokenUsage }),
                ...(row['tool_calls'] === null ? {} : { toolCalls: Number(row['tool_calls']) }),
                ...(row['reason'] === null ? {} : { reason: JSON.parse(String(row['reason'])) as unknown }),
            }));
        },
        deleteInterruptedFacts(roomId: string, turnId: string, botId: string): number {
            const result = db
                .prepare(
                    'DELETE FROM entity_items WHERE entity_id = ? ' +
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
        itemsByIds(ids: readonly string[]): Item[] {
            const wanted = [...new Set(ids.filter((id) => id !== ''))];
            if (wanted.length === 0) return [];
            // 房间不限定：`entity_items` 的 id 是全局唯一的（`u-…`），而来源可能指向别的房间
            // （bot 在 A 房间被叫到、需求落在自己家任务上）。这里只按 id 取，不要多加 `entity_id = ?`
            // 那种「看起来更安全」的条件 —— 它会把跨房间的来源静默变成「不知道」。
            const rows = db
                .prepare(
                    `SELECT seq, item FROM entity_items WHERE json_extract(item, '$.id') IN (${wanted
                        .map(() => '?')
                        .join(',')})`,
                )
                .all(...wanted) as Record<string, unknown>[];
            const items: Item[] = [];
            for (const row of rows) {
                try {
                    items.push({ ...(JSON.parse(String(row['item'])) as Item), seq: Number(row['seq']) });
                } catch {
                    continue; // 坏行不该让整批来源都读不出来（与 lastItemPerBot 同策）
                }
            }
            return items;
        },
        lastItemsOf(roomId: string, n: number): Item[] {
            const rows = db
                .prepare('SELECT seq, item FROM entity_items WHERE entity_id = ? ORDER BY seq DESC LIMIT ?')
                .all(roomId, n) as Record<string, unknown>[];
            // 倒序取完再翻回来：调用方要的是时间线顺序
            return rows
                .map((row) => ({ ...(JSON.parse(String(row['item'])) as Item), seq: Number(row['seq']) }))
                .reverse();
        },
        countItemsOf(roomId: string): number {
            const row = db.prepare('SELECT COUNT(*) AS n FROM entity_items WHERE entity_id = ?').get(roomId) as
                | { n: number }
                | undefined;
            return row?.n ?? 0;
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
        lastItemAtByRoom(roomIds?: readonly string[]): Record<string, number> {
            // 逐房间 seek（2026-11-28）：`GROUP BY entity_id` 要扫完整条 `(entity_id, at)` 索引，
            // 真库 4 万条时 9ms 起步且随历史线性涨；而每个房间只要最后一条的时刻，
            // `ORDER BY at DESC LIMIT 1` 天然是 items_entity_at 的 seek（40 个房间 0.7ms）。
            stmts.lastAtOfRoom ??= db.prepare(
                'SELECT at FROM entity_items WHERE entity_id = ? ORDER BY at DESC LIMIT 1',
            );
            const out: Record<string, number> = {};
            for (const roomId of roomIdsOf(roomIds)) {
                const row = stmts.lastAtOfRoom.get(roomId) as { at: number } | undefined;
                if (row === undefined) continue;
                const at = Number(row.at);
                if (Number.isFinite(at) && at > 0) out[roomId] = at;
            }
            return out;
        },
        maxSeqOf(roomId: string): number | undefined {
            const row = db.prepare('SELECT MAX(seq) AS seq FROM entity_items WHERE entity_id = ?').get(roomId) as
                | Record<string, unknown>
                | undefined;
            const seq = row === undefined ? NaN : Number(row['seq']);
            return Number.isFinite(seq) && seq > 0 ? seq : undefined;
        },
        markRead(roomId: string, seq?: number): void {
            // 不传 seq = 推到这个房间当前的最后一条（见接口注释）。
            // 不用 `this.maxSeqOf`：store 可能被解构使用（`const { markRead } = store`），
            // 那样 this 就丢了 —— 直接写一段同样的查询，5 行重复换一个不会静的磊。
            let target = seq;
            if (target === undefined) {
                const row = db.prepare('SELECT MAX(seq) AS seq FROM entity_items WHERE entity_id = ?').get(roomId) as
                    | Record<string, unknown>
                    | undefined;
                const max = row === undefined ? NaN : Number(row['seq']);
                target = Number.isFinite(max) && max > 0 ? max : undefined;
            }
            if (target === undefined) return;
            db.prepare(
                `INSERT INTO room_read (entity_id, last_read_seq, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(entity_id) DO UPDATE SET
                     last_read_seq = MAX(room_read.last_read_seq, excluded.last_read_seq),
                     updated_at = excluded.updated_at`,
            ).run(roomId, Math.floor(target), Date.now());
        },
        readSeqOf(roomId: string): number | undefined {
            const row = db.prepare('SELECT last_read_seq FROM room_read WHERE entity_id = ?').get(roomId) as
                | Record<string, unknown>
                | undefined;
            if (row === undefined) return undefined;
            const seq = Number(row['last_read_seq']);
            return Number.isFinite(seq) ? seq : undefined;
        },
        unreadByRoom(): Record<string, number> {
            // **只数 `chat`**：tool / notice / error 都是“过程”，按它们计数会炸成几千
            // （用户 2026-11-26 报的）；`author.role <> 'human'` 排掉我自己刚打的。
            // 没水位记录的房间算 0（历史不算未读，见接口注释）。
            //
            // 逐房间 seek（2026-11-28）：原来的全实例 GROUP BY 要扫全部 chat 行并逐行比对
            // 水位，真库 4 万条时到过 199ms（生产日志）。而侧栏要的只是「每个房间还有几条」，
            // 每个房间 `(entity_id, type='chat', role, seq)` 走 items_chat_role 的 seek，
            // 只扫该房间 chat 行、且只扫水位之后那一小段（40 个房间实测 6.4ms → 0.7ms）。
            stmts.unreadOfRoom ??= db.prepare(
                `SELECT COUNT(*) AS n FROM entity_items
                  WHERE entity_id = ? AND seq > ?
                    AND json_extract(item, '$.type') = 'chat'
                    AND COALESCE(json_extract(item, '$.author.role'), '') <> 'human'`,
            );
            const reads = new Map<string, number>();
            for (const row of db.prepare('SELECT entity_id, last_read_seq FROM room_read').all() as Array<
                Record<string, unknown>
            >) {
                reads.set(String(row['entity_id']), Number(row['last_read_seq']));
            }
            const out: Record<string, number> = {};
            for (const [roomId, water] of reads) {
                const row = stmts.unreadOfRoom.get(roomId, water) as { n: number } | undefined;
                const n = row === undefined ? 0 : Number(row.n);
                if (Number.isFinite(n) && n > 0) out[roomId] = n;
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
        lastItemOfBot(roomId: string, botId: string): Item | undefined {
            // 预编译一次、用一辈子：这条每几秒被问上百次，每次 `db.prepare` 都要重新编译 SQL。
            stmts.lastItemOfBot ??= db.prepare(
                "SELECT seq, item FROM entity_items " +
                    "WHERE entity_id = ? AND json_extract(item, '$.author.id') = ? " +
                    'ORDER BY seq DESC LIMIT 1',
            );
            return itemOfRow(stmts.lastItemOfBot.get(roomId, botId));
        },
        lastFactOfOwner(roomId: string, owner: string): Item | undefined {
            stmts.lastFactOfOwner ??= db.prepare(
                "SELECT seq, item FROM entity_items " +
                    'WHERE entity_id = ? ' +
                    "AND COALESCE(json_extract(item, '$.data.botId'), json_extract(item, '$.turnId')) = ? " +
                    "AND json_extract(item, '$.author.id') IS NULL " +
                    "AND json_extract(item, '$.type') IN ('notice','error') " +
                    'ORDER BY seq DESC LIMIT 1',
            );
            return itemOfRow(stmts.lastFactOfOwner.get(roomId, owner));
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
