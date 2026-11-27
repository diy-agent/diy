// Diy2Client —— ChatClient 的 **RPC 实现**（命令走 `diy2.*`，事件走同一条 WS 的 room 流）。
//
// 历史：这个包以前叫 chat-transport-http，命令是 REST；P2 之后浏览器侧不再有 REST
// （只留 `/api/info` 给探活）。包名暂时保留，避免一次跨包重命名掩盖真正的改动。
//
// 一条连接两用：
//   · 命令：`diy2.rooms.list` / `diy2.chat.chat` …（unary，受理即返）
//   · 事件：`room({ room })` 的 server-stream（见 ./hub）
// 断线重连、等待首次连接、取消都在 StreamHub 里；这里只做「方法名 + 类型」。

import type {
    AskAnswer,
    ChatClient,
    Command,
    CompactOutcome,
    Delivery,
    Item,
    Room,
    SessionInfo,
    Snapshot,
    StreamEvent,
} from '@diy-agent/chat-core';

import type {
    ActivityFrame,
    BotProfile,
    BotProfileDefaults,
    AttachmentRef,
    BotRow,
    JobRunRow,
    ModelCatalogModel,
    ModelCatalogProvider,
    ModelCatalogSnapshot,
    ModelConfigSnapshot,
    ModelCostView,
} from '@diy-agent/protocol';

export type { JobRunRow };

import { StreamHub } from './hub';

export interface RpcChatClientOptions {
    /**
     * 事件流 + 命令的 WS 端点；缺省按当前页推导（`ws(s)://<host>/rpc`）。
     * 非浏览器环境（测试）必须显式给。
     */
    rpcUrl?: string;
    /** 兼容旧参数：已不再使用（REST 已删） */
    base?: string;
    /** 兼容旧参数：已不再使用 */
    fetchImpl?: typeof fetch;
}

/** 房间 → 话题名（与 server 的 `room:<id>` 一一对应） */
const topicOf = (entityId: string): string => `room:${entityId}`;

/**
 * `roles.create` / `roles.update` 的可选字段（与 protocol 的 `rolesApi` 入参对齐）。
 *
 * `modelKey: null` 与 `''` 同义 = 清空 → 继续继承（房间 → 全局默认）。
 */
export interface RoleInput {
    /** create 必填；update 缺省 = 不改名 */
    name?: string;
    color?: string;
    instructions?: string;
    modelKey?: string | null;
    reasoningEffort?: string | null;
    primary?: boolean;
}

/**
 * 需求账本树上的一个节点（与 `@diy-agent/entity-runtime` 的 `UnitBoardRow` 同形）。
 *
 * 2026-11-25 裁：账本只记「要做什么」，所以这里没有 deps / layer —— 谁先做、一次做几条
 * 是执行时的判断，不进账本（模型每轮自己从 `ready` 里挑）。
 */
export interface UnitItem {
    id: string;
    title: string;
    body: string;
    /**
     * 「怎么算做完」：一句话能判断完/未完的判据。空串 = 还没写（界面上标「未写验收」）。
     *
     * 为什么与 body 分开（2026-11-26 用户裁）：body 里既装背景又装口径时，模型经常忘、
     * 人也没法一眼核对；拆成字段之后「没写」是**看得见**的。
     */
    accept: string;
    /**
     * 这条需求来自哪句人话（消息 id，如 `u-mwwtvgiy-1`）；空串 = 不知道（老数据）。
     * 界面用它回答「这是我要的吗」—— 点一下能回到那条消息。
     */
    source: string;
    /**
     * `source` 解开后的「谁 + 原话」：树节点上直接显示，不用点进别处才知道是谁提的。
     *
     * **没有这个键 = 不知道**（老数据 / 消息已被剪 / 非人类触发）—— 界面别编一个假来源，
     * 只把 ↩ 跳转留着。原话是服务端截断过的（`…` 结尾还有下文）。
     */
    sourceQuote?: SourceQuoteView;
    /** **有效**状态：叶子 = 落库值；目标（有子）= 由子派生（全 done → done） */
    status: 'open' | 'doing' | 'done';
    /** 树上的父（目标）；null = 根 */
    parent: string | null;
    /** 子节点（按书写顺序排） */
    children: string[];
    /** 有子 = 目标（两层里的上层，本身不执行） */
    group: boolean;
    /** 树深（根 = 0）：视图按它缩进 */
    depth: number;
    /** 书写顺序（同一父下的稳定次序） */
    seq: number;
}

/**
 * 一条需求的来源原话（`source` 解开之后）。
 *
 * `role` 用来区分「人提的」与「agent 自己落的」：两者都该看得见，但分量不一样 ——
 * 只把 human 当「需求」，其余的最多算「待确认的自作主张」。
 */
export interface SourceQuoteView {
    /** 发言人名字（消息 `author.name`）；空串 = 那条消息没署名 */
    author: string;
    role: 'human' | 'bot' | 'system' | '';
    /** 原话（已截断，一行） */
    text: string;
}

/**
 * 一条需求的**全貌**（点开时取）：需求本身 + 步骤 + 挂在它上面的决策与其它日志。
 *
 * 为什么不放进 `list`：首屏只要需求层；12 个任务 125 条如果每条都带决策与步骤，
 * 界面每 5 秒轮询就是在搬几百条用不到的详情。
 */
export interface UnitDetailView {
    need: UnitItem;
    /**
     * 小目标（子需求）：左栏拍平后只在点开这条时出现（2026-11-27「外面是目标，里面是小目标」）。
     * 步骤在 `need.steps` 里；这里只放仍是 need 的子条目。
     */
    children: Array<{ id: string; title: string; status: 'open' | 'doing' | 'done'; accept: string }>;
    /** 决策（journal 里 kind=decision 且挂在这条需求上的）：谁定的、为什么 */
    decisions: JournalLineView[];
    /** 其它日志（progress / pitfall / review / learn）—— 当成「过程记录」 */
    notes: JournalLineView[];
}

/** 一条需求的原始存储（「源码」面板显示的就是它，直接 JSON.stringify） */
export interface UnitRawView {
    /** 库表名（说明这份 JSON 对应哪张表） */
    table: string;
    /** `task_units` 的那一行（列名 → 值，NULL 也在） */
    row: Record<string, unknown>;
    /** 挂它的 journal 事件（`events` 表里 `event = 'task.journal'` 的那些） */
    events: JournalLineView[];
}

/** journal 的一条（`unit` 是它所属的需求） */
export interface JournalLineView {
    seq: number;
    at: number;
    kind: string;
    text: string;
    unit?: string;
}

/** 需求账本树的视图快照：树 + ready/doing（现在能挑的） */
export interface UnitBoardView {
    /** **树的先序**（根按创建序，子同）：视图照这个顺序缩进就是树 */
    rows: UnitItem[];
    /** 根节点 id（树的先序） */
    roots: string[];
    /** 现在能挑的：只有叶子（母项不进这里） */
    ready: string[];
    doing: string[];
    /** 派生状态为 done 的全部节点（含子都做完的母项） */
    done: string[];
    /** 母项（有子）的 id */
    groups: string[];
    /** 父指向一个不存在的 id（脏数据 / 先建子后建父的中间态）：这些节点当根处理并报出来 */
    danglingParents: string[];
}

/**
 * `units` 节原文（模型读到的就是它）。
 *
 * `mode` 说明服务端走的是哪条路：`full` 给全树，`summary` 是超过硬线后退成的摘要 ——
 * 界面要能把「为什么我看得到全树、模型只看到 ready」说清楚，否则容易以为上下文丢了。
 */
export interface UnitTextView {
    /** 原文（空字符串 = 这个任务还没有拆分，整节缺席） */
    text: string;
    /** 字符数（界面上标「≈ 多少 tok」用，与 ContextPanel 同一口径 *0.78） */
    chars: number;
    mode: 'full' | 'summary' | 'empty';
    /** 树行数（`full` 时才有意义；摘要形态是 0） */
    treeLines: number;
}

/** 一条草稿（服务端 rooms/drafts 的返回项） */
export interface DraftEntry {
    field: string;
    value: unknown;
    updatedAt: number;
}

/** 侧栏投影：列表接口比 Room 多这几个字段（pendingAskTitles = 未结提问的题干，给侧栏 ? 的 tooltip） */
export type RoomRow = Room & {
    hasDraft?: boolean;
    pendingAsks?: number;
    pendingAskTitles?: string[];
    lastActivityAt?: number;
    /**
     * 在跑成员数（侧栏每一行的呼吸态）。0 不写 —— 与 `pendingAsks` 同一约定。
     *
     * 只当**初值**用：真正的更新走全局活动流（`ActivityFrame`），这条字段让首屏 / 断线
     * 重连时不必等下一次 turn 起停才知道谁在跑。
     */
    running?: number;
    /**
     * 排着队的投递数（本房间所有成员之和：`queued` / `delivering`）。
     *
     * 与 `running` 同一约定（0 不写）：侧栏用它画一颗灰色「排队中」—— 包括重启后
     * 待续跑的那几条，以前这一段在界面完全看不见。
     */
    queued?: number;
    /**
     * 未读条数（`seq > 已读水位` 且不是我发的），见 `room_read`。
     *
     * 与 `pendingAsks` 同一约定（0 不写）：侧栏画一颗蓝点。
     * **它不参与「要你动手」的计数** —— 未读是“有结果了，去看看吧”，不是“卡住了”。
     */
    unread?: number;
    /**
     * 上一轮出错的成员数（在跑的不算）。
     *
     * 侧栏任务图标的颜色靠它：表格里写「出错」、侧栏图标却没事，两处会不一致
     * （用户 2026-11-26 报的）。与 `bots.rows` 的 `needs-attention` 同源（`turnLookupOf`）。
     */
    broken?: number;
    /**
     * 「最新一条投递失败」的成员数（侧栏「未送达」标记）。0 不写。
     *
     * 与 `queued` 是两件事：queued 是还没轮到 / 待续跑，failed 是消息确实没送到；
     * 与 `broken` 也不是一件事：broken 是 bot 上一轮跑坏了，failed 是你的话没递进去。
     * 只按每个成员最新一条消息收敛 —— 旧的 failed 被后来的 delivered 覆盖后不再报。
     */
    failed?: number;
};

export class RpcChatClient implements ChatClient {
    private readonly hub: StreamHub;

    constructor(options: RpcChatClientOptions = {}) {
        this.hub = new StreamHub({
            // exactOptionalPropertyTypes：不传就不带这个键
            // oxlint-disable-next-line no-useless-spread
            ...(options.rpcUrl === undefined ? {} : { rpcUrl: options.rpcUrl }),
        });
    }

    /** 收掉那条连接（测试 / 应用卸载时用） */
    close(): void {
        this.hub.close();
    }

    /** 命令面：`diy2.<method>` */
    private call<T>(method: string, input: unknown): Promise<T> {
        return this.hub.invoke<T>(`diy2.${method}`, input);
    }

    // ── 命令面（UI 直接用：store / drafts / TaskPanel）──────────────

    readonly rooms = {
        list: (): Promise<RoomRow[]> => this.call('rooms.list', {}),
        create: (input: {
            name: string;
            type?: 'project' | 'task';
            modelKey?: string;
            data?: Record<string, unknown>;
        }): Promise<Room> => this.call('rooms.create', input),
        update: (input: {
            id: string;
            name?: string;
            modelKey?: string;
            data?: Record<string, unknown>;
        }): Promise<Room> => this.call('rooms.update', input),
        remove: (id: string): Promise<{ deleted?: string[] }> => this.call('rooms.remove', { id }),
        /**
         * 上报未读水位（房间打开且页面可见时由 UI 调）。
         * 服务端只前进不后退，所以重复 / 迟到的上报都安全。
         */
        markRead: (id: string, seq?: number): Promise<unknown> =>
            this.call('rooms.markRead', seq === undefined ? { id } : { id, seq }),
    };

    /**
     * 角色（原来叫 bots）。
     *
     * 语义：成员是**从角色表派生**的（2026-11-24）—— 没有再“拉一个 bot 进房间”这个动作，
     * 所以这里没有 addMember —— 改角色 = 该类型所有房间同时变。
     */
    readonly botProfiles = {
        list: (): Promise<BotProfile[]> => this.call('botProfiles.list', {}),
        create: (input: RoleInput & { type: string; name: string }): Promise<BotProfile> =>
            this.call('botProfiles.create', input),
        update: (input: RoleInput & { id: string }): Promise<BotProfile> => this.call('botProfiles.update', input),
        remove: (id: string): Promise<unknown> => this.call('botProfiles.remove', { id }),
        config: {
            list: (): Promise<BotProfileDefaults[]> => this.call('botProfiles.config.list', {}),
            set: (input: {
                type: string;
                modelKey?: string | null;
                reasoningEffort?: string | null;
            }): Promise<BotProfileDefaults> => this.call('botProfiles.config.set', input),
        },
    };

    readonly drafts = {
        list: (owner: string): Promise<{ drafts: DraftEntry[] }> => this.call('drafts.list', { owner }),
        put: (owner: string, field: string, value: unknown): Promise<{ updatedAt: number }> =>
            this.call('drafts.put', { owner, field, value }),
        remove: (owner: string, field: string): Promise<unknown> => this.call('drafts.remove', { owner, field }),
    };

    readonly journal = {
        list: (id: string, limit?: number): Promise<{ entries: unknown[] }> =>
            this.call('journal.list', { id, ...(limit === undefined ? {} : { limit }) }),
    };

    /**
     * 模型面。`list` 给选模型器（只要「现在能选什么」）；`config` 起是配置页（写侧）。
     *
     * 写方法的回包一律是**重算后的整页快照** —— 界面拿到就直接替换，不再自己拼状态。
     * `saveAccount` 多一层 `{ config, saved }`：`saved.chars` 是 key 的长度，原值永远不回来。
     */
    readonly models = {
        list: (): Promise<ModelCatalogSnapshot> => this.call('models.list', {}),
        config: (): Promise<ModelConfigSnapshot> => this.call('models.config', {}),
        saveProvider: (input: {
            providerId: string;
            kind?: 'std' | 'custom';
            spec?: { id?: string; npm?: string; api?: string };
            models?: Record<string, { name?: string; contextWindow?: number; cost?: ModelCostView }>;
            filter?: { include?: string[] | null; exclude?: string[] | null };
        }): Promise<ModelConfigSnapshot> => this.call('models.saveProvider', input),
        removeProvider: (providerId: string): Promise<ModelConfigSnapshot> =>
            this.call('models.removeProvider', { providerId }),
        saveAccount: (input: {
            providerId: string;
            name: string;
            value: string;
            kind?: 'std' | 'custom';
        }): Promise<{ config: ModelConfigSnapshot; saved: { providerId: string; name: string; chars: number } }> =>
            this.call('models.saveAccount', input),
        renameAccount: (input: {
            providerId: string;
            from: string;
            to: string;
        }): Promise<ModelConfigSnapshot> => this.call('models.renameAccount', input),
        removeAccount: (input: { providerId: string; name: string }): Promise<ModelConfigSnapshot> =>
            this.call('models.removeAccount', input),
        saveDefaultModel: (modelKey: string | null): Promise<ModelConfigSnapshot> =>
            this.call('models.saveDefaultModel', { modelKey }),
    };

    /**
     * 后台作业（run 表）：与 agent 的 `job list` / `job kill` 同一份账本。
     *
     * 界面拿它画「现在在跑什么」——在此之前这张表只存在于 agent 的对话里，
     * 人看不见（只能等模型自己想起来调 `job status`）。
     */
    readonly jobs = {
        list: (): Promise<{ rows: JobRunRow[] }> => this.call('jobs.list', {}),
        kill: (id: string): Promise<{ ok: boolean }> => this.call('jobs.kill', { id }),
        /** 一条 run 的输出尾巴（`found:false` = 账本里没这条了） */
        tail: (
            id: string,
            lines?: number,
        ): Promise<{ found: boolean; tail?: { text: string; lines: number; droppedBytes: number } }> =>
            this.call('jobs.tail', { id, ...(lines === undefined ? {} : { lines }) }),
    };

    /**
     * 任务的需求账本树。**只读**：writer 只有 agent 的 `unit_*` 工具，
     * 界面是旁观窗口 —— 想改就在聊天里说。
     */
    readonly units = {
        list: (id: string): Promise<UnitBoardView> => this.call('units.list', { id }),
        /** 一条需求的全貌：需求 + 决策 + 过程记录 */
        get: (id: string, unit: string): Promise<UnitDetailView> => this.call('units.get', { id, unit }),
        /** 库里存的那几行（真源，不加工）：界面上「数据」面板用它当场核对投影 */
        raw: (id: string, unit: string): Promise<UnitRawView> => this.call('units.raw', { id, unit }),
        /** 模型实际读到的 `units` 节原文（YAML）：树视图与图视图共用这一段，不是两份 */
        text: (id: string): Promise<UnitTextView> => this.call('units.text', { id }),
    };

    readonly links = {
        list: (id: string): Promise<{ out: unknown[]; in: unknown[] }> => this.call('links.list', { id }),
        add: (id: string, to: string, kind: string): Promise<unknown> => this.call('links.add', { id, to, kind }),
        remove: (id: string, to: string, kind: string): Promise<{ removed: boolean }> =>
            this.call('links.remove', { id, to, kind }),
    };

    // ── ChatClient ──────────────────────────────────────────────

    /**
     * 拉一个房间的快照。
     *
     * `limit` 缺省 = 服务端缺省（只发最近 400 条）；传 `0` = **全量**（用户点“加载更早的”）。
     * 见 `Snapshot.truncated` 的注释：6000 条的房间里全量回包 5.7 MB，parse + 渲染 2~5 秒。
     */
    async load(entityId: string, options?: { limit?: number }): Promise<Snapshot> {
        const history = await this.call<{
            items: Item[];
            deliveries: Delivery[];
            asks: Snapshot['asks'];
            answered: Snapshot['answeredAsks'];
            speaking?: Snapshot['speaking'];
            runningTurns?: Snapshot['runningTurns'];
            total?: number;
            hasMore?: boolean;
        }>('chat.history', { id: entityId, ...(options?.limit === undefined ? {} : { limit: options.limit }) });
        return {
            items: history.items,
            ...(history.total === undefined ? {} : { totalItems: history.total }),
            ...(history.hasMore === true ? { truncated: true } : {}),
            deliveries: history.deliveries,
            asks: history.asks ?? [],
            answeredAsks: history.answered ?? [],
            // 老服务端没有这个字段：留 undefined（客户端退回倒推，见 Snapshot.speaking）
            ...(history.speaking === undefined ? {} : { speaking: history.speaking }),
            // 同上：老服务端没有 runningTurns 时客户端退回用条目时刻
            ...(history.runningTurns === undefined ? {} : { runningTurns: history.runningTurns }),
        };
    }

    /** 常驻订阅：重连 / 退避 / `ready` 全在 StreamHub；这里只说「我要看哪个房间」 */
    watch(entityId: string, onEvent: (event: StreamEvent) => void): () => void {
        return this.hub.subscribe(topicOf(entityId), onEvent);
    }

    /** 实例级活动（谁在跑 / 几个作业在跑）：一条流汇报全实例，首帧就是当前快照 */
    subscribeActivity(onFrame: (frame: ActivityFrame) => void): () => void {
        return this.hub.subscribeActivity(onFrame);
    }

    async sessions(entityId: string): Promise<SessionInfo[]> {
        const data = await this.call<{ sessions: SessionInfo[] }>('chat.sessions', { id: entityId });
        return data.sessions;
    }

    async compact(entityId: string, botId: string, options: { keepTurns?: number } = {}): Promise<CompactOutcome> {
        return this.call<CompactOutcome>('chat.compact', { id: entityId, botId, ...options });
    }

    async cancelCompact(entityId: string, compactId: string): Promise<boolean> {
        const data = await this.call<{ ok: boolean }>('chat.cancelCompact', { id: entityId, compactId });
        return data.ok === true;
    }

    async answerAsk(entityId: string, askId: string, answer: AskAnswer): Promise<void> {
        await this.call('asks.answer', { id: entityId, askId, answer });
    }

    async cancelAsk(entityId: string, askId: string): Promise<void> {
        await this.call('asks.cancel', { id: entityId, askId });
    }

    async post(entityId: string, command: Command, onEvent: (event: StreamEvent) => void): Promise<void> {
        if (command.kind === 'cancel') {
            await this.call('chat.cancel', {
                id: entityId,
                keepQueue: command.keepQueue === true,
                ...(command.botId === undefined ? {} : { botId: command.botId }),
            });
            onEvent({ kind: 'done' });
            return;
        }
        if (command.kind !== 'send') return;

        // 先确保这个房间的流已经开着再发：否则「受理即返」之后的第一条事件可能没人接。
        // 失败也无所谓 —— 消息必须送到，事件由重连后的 ready + 补拉快照兜。
        await this.hub.ensure(topicOf(entityId));
        await this.call('chat.chat', {
            id: entityId,
            text: command.text,
            ...(command.attachments === undefined ? {} : { attachments: command.attachments }),
        });
    }

    /**
     * 上传一份字节（粘贴 / 拖拽 / 选图）→ 落 blobs → 拿回 ref。
     *
     * 为什么从界面直传而不是先落进消息：一次发送可能带几张图，任何一张失败都该在
     * 「发送之前」就报错（用户还看得见它），而不是发出去之后在气泡里出现一个裂图。
     */
    async putAttachment(input: {
        name?: string;
        mime?: string;
        bytes: Uint8Array;
        source?: 'paste' | 'drop' | 'pick' | 'tool';
    }): Promise<AttachmentRef> {
        return this.call<AttachmentRef>('attachment.put', {
            base64: toBase64(input.bytes),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.mime === undefined ? {} : { mime: input.mime }),
            ...(input.source === undefined ? {} : { source: input.source }),
        });
    }

    /** 取回附件内容（显示缩略图 / 原图） */
    readAttachment(ref: AttachmentRef): Promise<{ base64: string; mime: string }> {
        return this.call<{ base64: string; mime: string }>('attachment.get', { ref });
    }
}

/**
 * 字节 → base64（走 JSON 通道的唯一办法）。
 *
 * 分块 `String.fromCharCode(...)`：一次性展开几十万个参数会撞引擎的实参上限
 * （`RangeError: Maximum call stack size exceeded`），1~3 MB 的截图足够触发。
 */
function toBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
    }
    return btoa(binary);
}

export { StreamHub, topicOfRoom, type StreamHubOptions } from './hub';
/** 目录视图形状在 protocol（服务端与界面共用一份），这里顺手透出，界面不用多装一个依赖 */
export type {
    ModelCatalogModel,
    ModelCatalogProvider,
    ModelCatalogSnapshot,
    ModelConfigAccount,
    ModelConfigModel,
    ModelConfigProvider,
    ModelConfigSnapshot,
    ModelCostView,
} from '@diy-agent/protocol';
