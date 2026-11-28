// session.ts —— BotSession：某个 bot 在某个 room 里的那条原生单线对话。
//
// 职责（只有这些）：
//   · 串行：同一 session 同时只跑一个 turn
//   · 两个投递时机：next-step（step 边界插入，用 SDK 的 steering） / next-turn（等这轮结束）
//   · cancel：abort + 清空队列；keepQueue 时降级为 next-turn
//   · 自己的上下文自己攒：公共条目由房间 ingest 进来，私有过程来自本轮的模型产出
//   · 压缩：交给可替换的 Compactor，**只压自己**
//
// **不发起任何房间级动作**：投影出的条目、投递状态、回合结束、压缩事件都通过
// `subscribe()` 交给房间。房间负责编号、持久化、广播、结论发布。
//
// 不做：路由、持久化、SSE —— 那些属于 RoomActor。

import type { CompactionProgress } from '@diy-agent/protocol';
import type { AttachmentRef } from '@diy-agent/attachment/types';
import { experimental_createSteering, type Experimental_Steering, type ModelMessage, type ToolSet } from 'ai';

import { runAgent, DEFAULT_MAX_STEPS, type RunOptions } from './agent';
import { endItems, endReasonOf } from './end-reason';
import { scrubMedia } from './media-scrub';
import { friendlyError } from './errors';
import {
    DEFAULT_BUDGET,
    estimateChars,
    estimateTokens,
    createSummaryCompactor,
    type CompactEvent,
    type CompactionBudget,
    type CompactionResult,
    type Compactor,
    type TokenUsage,
    type TranscriptEntry,
} from './compaction';
import { contextWindowOf, maxOutputTokensOf } from './providers';
import { ProgressBroadcast, ProgressWatch, type ProgressPolicy } from './progress';
import type { createOutputStore } from './output-store';
import { nextId, Projector } from './projection';
import { toMessage, type RoomEntry } from './room-log';
import { AttachmentBytesCache, messageWithAttachments, type AttachmentReader } from './session-images';
import type { AgentEvent, Author, Bot, DeliveryState, Item, MessageKind, ProgressStage, TurnEndReason } from './types';

export interface CompactOptions {
    /** 手工压缩：保留最近几轮（0 = 压到头，与 diy1 的 keepRounds 同语义） */
    keepTurns?: number;
    /** 本次压缩的 id（UI 用它取消 / 去重）；缺省自己生成一个 */
    compactId?: string;
    /** 取消信号：只中断摘要那次 LLM 调用，已折叠的边界不生效 */
    signal?: AbortSignal;
}

/** @deprecated 用 DEFAULT_BUDGET；保留导出避免调用方一次改太多 */
export const DEFAULT_COMPACT = DEFAULT_BUDGET;

export interface Turn {
    turn: number;
    turnId: string;
}

export interface TurnResult extends Turn {
    /** 本轮产出的全部文本（房间层据此写"结论"条目） */
    text: string;
    failed: boolean;
    /**
     * 本轮实测用量（真实 token，可用于校准预算）。
     *
     * **是本轮的**，不是上一轮的：`lastUsage`（压缩判据用）在失败轮不会被刷新，直接用
     * 它会把这轮的结算行写成上一轮的数字（失败轮最常见的就是拿不到 usage）。
     */
    usage?: TokenUsage;
    /** 这一轮的开始时刻（= `turn.start` 广播的那个值，同一个来源） */
    startedAt?: number;
    /** 这一轮的结束时刻 */
    endedAt?: number;
    /**
     * 这一轮**为什么**结束。`max-tokens` / `tool-mismatch` / `interrupted` 都要能说出来 ——
     * 否则「被截断」和「说完了」在数据里没有区别（就是「执行一半停下」那个 bug）。
     */
    endReason: TurnEndReason;
}

/** session 对外的全部输出（房间订阅它） */
export type SessionEvent =
    /** 投影出的展示条目（order 由房间分配） */
    | { type: 'item'; item: Item }
    /** 投递状态变化 */
    | { type: 'delivery'; messageId: string; state: DeliveryState; note?: string }
    /**
     * 一轮**开始**（房间据此让这个成员的旧提问过期）。
     *
     * 为什么不复用 `busy: true`：一次 busy 期间可以连着跑好几轮（队列分几批），
     * 而"新的一轮"才是世界状态换代的时刻 —— 见 ask.ts 头部的寿命规则。
     */
    | { type: 'turn.start'; turn: Turn; startedAt: number }
    /** 一轮结束（房间据此写结论） */
    | { type: 'turn.end'; result: TurnResult }
    /** 真压了一次 */
    | { type: 'compact'; event: CompactEvent }
    /**
     * 一次手动压缩的**进度**（`running` → 终态）。与上面那条的分工：
     * 这条是给人看的（房间转手广播给 UI），`compact` 是给账本看的（落库 + 统计日志）。
     * 取消发生在 await LLM 的中途，那时根本没有 CompactEvent 可发。
     */
    | { type: 'compact.progress'; compact: CompactionProgress }
    /** 运行失败（条目层面的失败会以 item 形式出现） */
    | { type: 'error'; message: string }
    /**
     * 此刻在等什么、多久没动（ephemeral，房间补上 botId 后当 `progress` 事件广播）。
     * 只给 UI 看「还活着吗」，**不进 items、不进快照** —— 理由见 protocol 里的 `progress`。
     */
    | { type: 'progress'; turnId: string; awaiting: string; idleMs: number; alive: boolean; stage: ProgressStage }
    /** 开始 / 结束一轮（房间据此维护"谁在说话"） */
    | { type: 'busy'; busy: boolean };

export interface SessionStats {
    entries: number;
    chars: number;
    /** 上下文 token 估算（压缩判据的同一口径；真实用量看 usage） */
    tokens: number;
    /** 手工压缩默认保留的轮数（自动压缩按窗口 × 0.16 算，不看它） */
    budget: CompactionBudget;
    /** 当前模型窗口（token）；未知 = undefined（此时自动压缩不触发） */
    windowTokens?: number;
    /** 历史累计丢弃条数 */
    collapsed: number;
    compactions: number;
    lastCompactAt?: number;
    strategy: string;
    /** 当前上下文首条说明里带着的摘要正文（模型此刻看的承接信息）；没有 = 未摘要 */
    summary?: string;
    usage?: TokenUsage;
}

/** 恢复一个 session 的持久化状态 */
export interface SessionSeed {
    entries: TranscriptEntry[];
    /** 已折叠掉的条数（占位说明用） */
    collapsed?: number;
    /** 上一轮实测用量（压缩判据用） */
    usage?: TokenUsage;
    /**
     * 已读到的公共日志水位（房间最后一条「这条 session 真的看过」的 seq）。
     * 缺省 / 0 = 老库，回放从日志开头补（宁可重复也不能少）。
     */
    logSeq?: number;
}

export interface SessionDeps {
    bot: Bot;
    modelKey: string;
    /** 房间分配的回合号（唯一来源；session 自己不开新回合） */
    allocateTurn: () => Turn;
    /** 从持久化恢复（重启 / 后加入） */
    seed?: () => SessionSeed;
    /** 便于测试注入；默认用 runAgent（真实模型） */
    run?: (input: RunOptions) => AsyncIterable<AgentEvent>;
    /** 压缩策略；默认 simpleCompactor */
    compactor?: Compactor;
    budget?: CompactOptions;
    /**
     * 覆盖模型窗口（token）。缺省按 modelKey 去模型目录查；测试注入用 ——
     * 不注入就无法让「窗口水位」在单测里成立。
     */
    windowTokens?: number;
    /** 房间装配的工具（不传 = 内置 get_time） */
    tools?: ToolSet;
    toolsHint?: string;
    /** 规则上下文（AGENTS.md 链 + 知识库索引）；房间构造时组装一次，session 每轮复用 */
    systemContext?: string;
    /** 每步的变量增量（由房间的 ContextSession 提供；与触发时机无关） */
    takeDelta?: () => string;
    /** 该步成功收尾后推进快照 */
    commitDelta?: () => void;
    /** 本轮输出上限（缺省按 modelKey 推，见 providers.ts `maxOutputTokensOf`） */
    maxOutputTokens?: number;
    /** 步数上限（缺省 `DEFAULT_MAX_STEPS`；到顶按 `max-steps` 收尾，不算失败） */
    maxSteps?: number;
    /** 卡死看门狗的阈值（缺省见 progress.ts 的 `DEFAULT_PROGRESS_POLICY`）；测试可调小 */
    progressPolicy?: Partial<ProgressPolicy>;
    /** 看门狗判定间隔（缺省 5000ms）；测试可调小 */
    progressTickMs?: number;
    /**
     * 把附件 ref 读成字节（宿主注入：diy2 读 `<home>/blobs`，测试用内存表）。
     *
     * 不传 = 附件不送进模型，只在正文后补一行「附图未送达」—— 没注入就静默丢图比不送更糟。
     */
    readAttachment?: AttachmentReader;
    /**
     * 这个模型收不收图（由房间按模型目录回答）。不传 = 当收（老行为 / 测试）。
     *
     * 判据在 entity-runtime 的 `providers.acceptsImagesOf`：目录里没标能力位 ⇒ 当**不收**。
     */
    acceptsImages?: (modelKey: string) => boolean;
    /**
     * 会话所在房间（工具输出外置按房间分目录）。不传 = 不外置，工具结果全留在条目里。
     * 与 `output` 成对出现：只给一个不起作用。
     */
    roomId?: string;
    /** 工具输出外置存储（房间按 `home` 造一个；测试 / 无数据根时不给） */
    output?: ReturnType<typeof createOutputStore>;
}

interface QueueItem {
    messageId: string;
    text: string;
    /** 本条消息带的附件（已落 blobs 的 ref）；本轮组装 prompt 时展开成 image part */
    attachments?: readonly AttachmentRef[];
    /** 谁发的：`human` 能并进当前轮就并，`system` 永远等下一轮 */
    kind: MessageKind;
    /** 容器分配的轮次（同一条用户消息的所有 bot 共享） */
    turn?: Turn;
    /** 这条消息在房间日志里的条目：steering 没送到时兜底 ingest，避免丢掉 */
    entry?: RoomEntry;
    /** 已经在上下文里（崩溃恢复的日志回放）：本轮不再追加一条 user 消息 */
    alreadyInContext?: boolean;
    resolve: () => void;
}

export class BotSession {
    private readonly queue: QueueItem[] = [];
    private readonly listeners = new Set<(event: SessionEvent) => void>();
    /**
     * 已读过的附件字节（按 sha256 缓存）：同一张图在会话生命周期里只读一次盘。
     * 会话级而非轮级 —— 历史里的图每天都要重发，每轮重读盘是纯浪费。
     */
    private readonly imageCache = new AttachmentBytesCache();
    /** 自己的原生对话（本轮之前的全部内容） */
    private transcript: TranscriptEntry[];
    /** 已 ingest、还没并进 transcript 的公共条目（运行中到达的要排在本轮产出之后） */
    private pending: TranscriptEntry[] = [];
    private running = false;
    /**
     * 本轮的身份（turnId + 开始时刻）。`null` = 没在跑。
     *
     * 房间原先自己存一份 `turnStarts: Map<botId, …>` —— 那是这份事实的副本，
     * 于是「谁在跑、跑了多久」有两个真源，谁都可能晚一拍。现在只留这一份，房间问它要。
     */
    private activeTurn: { turnId: string; startedAt: number } | null = null;
    private steering: Experimental_Steering | null = null;
    private abort: AbortController | null = null;
    /** cancel({keepQueue:true}) 期间被 abort 的 next-step 要降级为下一轮，不能丢 */
    private keepOnCancel = false;
    /** 已被压缩掉的早期消息条数 */
    private collapsed = 0;
    /** 压缩事件（最近 N 条，调试用） */
    private readonly events: CompactEvent[] = [];
    /** 上一轮实测用量：给策略做真实 token 判据 */
    private lastUsage: TokenUsage | undefined;
    /** **本轮**实测用量：结算行（tokens）只用它，与本轮生命周期同起同落 */
    private turnUsage: TokenUsage | undefined;
    /** 最近一次运行的轮次号（手动压缩时用它，不额外消耗轮次） */
    private turnNow = 0;
    /** 当前使用的模型：房间改模型时要能推下来（构造时的 deps.modelKey 只是初值） */
    private modelKey: string;

    /**
     * 自己读到哪一条公共日志了（重启回放从它往后补）。
     *
     * 为什么存在 session 而不是由房间给：房间的 `log.lastSeq` 含「已经 append 到公共日志、
     * 但这一侧还没读」的条目 —— 典型现场是「用户发言已落库、下一轮刚起跑时压了一次，
     * 于是顺手落了快照」，快照水位跳过这轮正在处理的输入，重启回放跳过它 ⇒ 那句话在
     * 库里、在界面上都在，只有模型看不见（2026-11-23 的真事故）。
     *
     * 推进点只有三个，全部对应「真的读过了」：
     *   · steering 送达（SDK 已经把它插进在跑的那轮）
     *   · drainPending（已 ingest 的公共条目并进 transcript）
     *   · 本轮 userEntries 入账（本轮 prompt 已经直接带上了它）
     * 还在队列里等着的消息**不算** —— 重启后要靠回放把它补回来。
     */
    private logSeq = 0;

    constructor(private readonly deps: SessionDeps) {
        const seed = deps.seed?.();
        this.transcript = seed?.entries ?? [];
        this.collapsed = seed?.collapsed ?? 0;
        this.lastUsage = seed?.usage;
        this.logSeq = seed?.logSeq ?? 0;
        this.modelKey = deps.modelKey;
    }

    get busy(): boolean {
        return this.running;
    }

    /** 本轮的 turnId 与开始时刻（没在跑就是 undefined）—— 房间的快照直接读这个 */
    get currentTurn(): { turnId: string; startedAt: number } | undefined {
        return this.activeTurn ?? undefined;
    }

    /** 房间换模型：下一轮生效（已建好的 session 不会重建） */
    /**
     * 换掉工具集。
     *
     * 为什么需要：工具里有一部分是**宿主能力**，它可能比 session 晚就绪 ——
     * `run_code` 依赖的进程内 RPC client 在建完 handlers 之后才有。session 通常在
     * `RoomActor` 构造时就建好（上下文 / 统计不等第一条消息），那一刻拿到的工具集
     * 可能是「降级版」。留着这个入口让房间在每轮取 session 时对齐一次。
     */
    setTools(tools: ToolSet | undefined): void {
        this.deps.tools = tools;
    }

    setModelKey(modelKey: string): void {
        this.modelKey = modelKey;
    }

    /**
     * 房间改名：bot 跟着姓容器的名字（专属 bot 与容器 1:1）。
     *
     * session 持有的是**构造时的 bot 快照**：不同步的话，改名后它说的话仍署名旧名、
     * system prompt 里也还在自称旧名（用户报的「任务改名后 bot name 没变」）。
     * 已在跑的这一轮不改（instructions 已经发出去了），从下一轮 / 下一条 item 生效。
     */
    setBotName(name: string): void {
        this.deps.bot = { ...this.deps.bot, name };
    }

    /**
     * 角色改了（名字 / 人格 / 模型）：session 持有的是**构造时的快照**，不推下去就一直是旧的。
     *
     * 与 `setBotName` 的区别：那个只换显示名（容器改名的旧语义），这个换整个人格。
     * 已在跑的这一轮不改（instructions 已经发出去了），从下一轮 / 下一条 item 生效。
     */
    setIdentity(next: Bot): void {
        this.deps.bot = { ...next };
        this.modelKey = next.modelKey;
    }

    /** 房间订阅 session 的全部输出 */
    subscribe(listener: (event: SessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(event: SessionEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // 订阅者的异常不能打断会话
            }
        }
    }

    /** 当前上下文快照（调试 / 测试用）：已并入的 + 待并入的 */
    context(): readonly ModelMessage[] {
        return [...this.transcript, ...this.pending].map((entry) => entry.message);
    }

    stats(): SessionStats {
        // 待并入的公共条目也算"当前上下文"，否则长时间没跑的 bot 看起来是空的
        const entries = [...this.transcript, ...this.pending];
        const summary = this.currentSummary();
        const windowTokens = this.windowTokensOf();
        return {
            entries: entries.length,
            chars: estimateChars(entries),
            tokens: estimateTokens(entries),
            budget: this.budgetWith({}),
            ...(windowTokens === undefined ? {} : { windowTokens }),
            collapsed: this.collapsed,
            compactions: this.events.length,
            ...(this.events.at(-1) === undefined ? {} : { lastCompactAt: this.events.at(-1)!.at }),
            strategy: this.compactor.name,
            ...(summary === undefined ? {} : { summary }),
            ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
        };
    }

    /** 上下文首条说明里的摘要正文（压缩之后模型实际看到的承接信息） */
    private currentSummary(): string | undefined {
        const head = this.transcript[0];
        if (head?.origin !== 'note') return undefined;
        const content = head.message.content;
        const text = typeof content === 'string' ? content : '';
        const body = text.replace(COLLAPSED_PREFIX, '').trim();
        return body === '' ? undefined : body;
    }

    compactions(): readonly CompactEvent[] {
        return this.events;
    }

    /** 持久化快照（房间在每轮结束 / 压缩后落盘） */
    snapshot(): {
        turn: number;
        collapsed: number;
        entries: TranscriptEntry[];
        logSeq: number;
        usage?: TokenUsage;
    } {
        return {
            turn: this.turnNow,
            collapsed: this.collapsed,
            entries: [...this.transcript],
            logSeq: this.logSeq,
            ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
        };
    }

    /** 把水位推到至少 seq（单调；0 / 缺省什么都不做） */
    private bumpLogSeq(seq: number | undefined): void {
        if (seq === undefined || seq <= this.logSeq) return;
        this.logSeq = seq;
    }

    /**
     * 这条公共条目是不是已经在自己上下文里了。
     *
     * **按序号精确查 transcript / pending**，不能只看水位：老库里那批水位是旧语义
     * （房间 lastSeq）写的，它可能已经越过一条其实没读过的消息 —— 只看水位就和旧写法一样丢。
     */
    private hasInContext(seq: number | undefined): boolean {
        if (seq === undefined) return false;
        if (this.pending.some((entry) => entry.seq === seq)) return true;
        return this.transcript.some((entry) => entry.seq === seq);
    }

    /** 房间公共条目 → 自己这一侧的一条消息；不触发任何运行 */
    ingest(entry: RoomEntry): void {
        const message = toMessage(entry, this.deps.bot.id);
        if (message === null) return;
        this.pending.push({
            message,
            origin: 'public',
            seq: entry.seq,
            ...(entry.turn === undefined ? {} : { turn: entry.turn }),
            // 附件跟着走：ref 小（几百字节），落快照不心疼；字节等发请求时再读
            ...(entry.kind === 'say' && entry.attachments !== undefined && entry.attachments.length > 0
                ? { attachments: entry.attachments }
                : {}),
        });
    }

    /** 手动压一次（只影响自己，不触发运行） */
    async forceCompact(options: CompactOptions = {}): Promise<CompactEvent | null> {
        // 运行中不拦：transcript 只在一轮**结束时**才 push（本轮产出还在 pending 里，
        // 不参与这次压缩），所以压完不丢东西 —— 回归 `regressions.test.ts::F` 就守这条。
        // 真正要防的是**同一成员并发压两次**，那在 RoomActor.compact 里挡。
        const budget = this.budgetWith(options);
        const now = Date.now();
        return this.compact({
            force: true,
            turn: this.turnNow,
            turnId: `force-${now.toString(36)}`,
            budget,
            manual: true,
            compactId: options.compactId ?? `c-${now.toString(36)}`,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }

    /** 投一条消息；返回的 promise 在它所属 turn 结束时 resolve */
    post(input: {
        messageId: string;
        text: string;
        kind?: MessageKind;
        turn?: Turn;
        entry?: RoomEntry;
        /**
         * 这条消息已经在自己的上下文里了：置 true 时不再把它作为本轮 prompt 的 user 消息追加一次。
         *
         * 不给就**自己看**（序号在 pending 里 / 已进 transcript）—— 崩溃恢复那条路原先由
         * 房间无条件传 true（“公共日志回放时已经读到了”），可水位一旦越过它回放根本不会带它，
         * 这一句就把它从 prompt 里抹掉了：消息凭空消失（见 hasInContext）。
         */
        alreadyInContext?: boolean;
    }): Promise<void> {
        const kind = input.kind ?? 'human';
        const alreadyInContext = input.alreadyInContext ?? this.hasInContext(input.entry?.seq);
        const { promise, resolve } = withResolve();
        // 附件从条目自己取：`say` 与「崩溃恢复重投」两条路都不用改调用点
        const attachments =
            input.entry?.kind === 'say' && input.entry.attachments !== undefined && input.entry.attachments.length > 0
                ? input.entry.attachments
                : undefined;

        // 正在跑且是人的话：直接交给 SDK，在下一个 step 边界插入。
        //
        // **但带附件的不能走 steer**：`steer()` 只能插文本，图会在这一轮里凭空消失
        // （既没进 transcript、也没进 SDK 的上下文，要等重启回放才回来）。
        // 降成入队 —— 下一轮带着图一起跑，代价是晚一点回答，换来的是图不丢。
        if (this.running && kind === 'human' && this.steering !== null && attachments === undefined) {
            this.emit({ type: 'delivery', messageId: input.messageId, state: 'working' });
            // 插话没成功（含 steer 自己抛错）的兜底：能降级就降成下一轮，否则至少把公共条目
            // 留在上下文里，并 resolve。不 resolve 会把 room.say 的 Promise.all 一起挂死
            // （/chat 的 SSE 永远不收尾），unhandled rejection 还可能带走进程。
            const fallback = (): void => {
                if (this.keepOnCancel) {
                    // 被 cancel 打断：降级为下一轮
                    this.queue.push({
                        messageId: input.messageId,
                        text: input.text,
                        kind,
                        turn: input.turn,
                        entry: input.entry,
                        alreadyInContext,
                        resolve,
                    });
                    // 这条路径只在 runTurn 退出之后才可能走到，pump 已经停了：
                    // 不叫一次 pump 的话消息会一直卡在 delivering（要等用户再发一条才动）
                    void this.pump();
                    return;
                }
                // 没送进这一轮：至少让公共条目留在自己的上下文里，别静默丢失
                if (input.entry !== undefined) this.ingest(input.entry);
                this.emit({ type: 'delivery', messageId: input.messageId, state: 'done', note: 'failed' });
                resolve();
            };
            void this.steering
                .steer(input.text, { id: input.messageId })
                .then((outcome) => {
                    if (outcome.type === 'delivered') {
                        // 注意**不推水位**：它插进的是 SDK 在跑的那轮上下文，没进 transcript、
                        // 也不在任何快照里 —— 此刻推水位，重启后回放就不会补它，模型下一次
                        // 只看到自己的回复而看不到这条插话。宁可重启后重复一回，也不能少。
                        this.emit({ type: 'delivery', messageId: input.messageId, state: 'done' });
                        return;
                    }
                    fallback();
                })
                .catch(() => fallback());
            this.pendingResolvers.push(resolve);
            return promise;
        }

        this.queue.push({
            messageId: input.messageId,
            text: input.text,
            ...(attachments === undefined ? {} : { attachments }),
            kind,
            turn: input.turn,
            entry: input.entry,
            alreadyInContext,
            resolve,
        });
        void this.pump();
        return promise;
    }

    /** 停止当前 turn：默认丢弃未消费的消息；keepQueue 时降级为下一轮 */
    cancel(options: { keepQueue?: boolean } = {}): void {
        this.keepOnCancel = options.keepQueue === true;
        const rest = this.queue.splice(0, this.queue.length);
        for (const item of rest) {
            if (options.keepQueue === true) {
                // 来源不变（还是一条人的话）—— 只是这一轮被停了，下一轮再跑
                this.queue.push(item);
            } else {
                item.resolve();
            }
        }
        this.abort?.abort();
    }

    /**
     * 走 steer 那一路的 post() 的 resolve，等**它所属的这一轮**收尾时统一叫醒。
     *
     * 以前这份清单在 `pump()` 的 finally 里清 —— 那是「整个队列跑完」而不是「这一轮跑完」：
     * 插话成功之后队列里又来了新消息时，这条 promise 要挂到所有后续轮次都跑完才 resolve。
     * 生产看不出来（server 是 `void actor.say()` 受理即返），但 `await room.say()` 的调用方
     * （测试、将来的 CLI）会挂住。改到 `runTurn` 的 finally，语义就是注释里写的那个。
     */
    private pendingResolvers: Array<() => void> = [];

    private get compactor(): Compactor {
        return (
            this.deps.compactor ??
            createSummaryCompactor({ modelKey: () => this.modelKey, sessionId: this.deps.bot.id })
        );
    }

    private budgetWith(options: CompactOptions): CompactionBudget {
        return {
            keepTurns: options.keepTurns ?? this.deps.budget?.keepTurns ?? DEFAULT_BUDGET.keepTurns,
        };
    }

    /**
     * 当前模型的上下文窗口（token）。
     *
     * 自动压缩的**唯一输入**：水位、保留量、空转判据全由它派生（判据在 `@diy-agent/compaction`）。
     * 未知 = 自动压缩不触发 —— 猜一个窗口的代价是「要么永不压、要么一压到底」。
     */
    private windowTokensOf(): number | undefined {
        return this.deps.windowTokens ?? contextWindowOf(this.modelKey);
    }

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.emit({ type: 'busy', busy: true });
        try {
            while (this.queue.length > 0) {
                const items = this.queue.splice(0, this.queue.length);
                // **取走即算 working**：不等 `runTurn` 里压缩/读附件那一串跑完。
                // 否则中间那段（`busy` 已 true、投递还是 `pending`）UI 会写
                // 「在跑却在排队」（2026-11-26 报的就是这个形状）。
                for (const item of items) this.emit({ type: 'delivery', messageId: item.messageId, state: 'working' });
                await this.runTurn(items);
            }
        } finally {
            this.running = false;
            this.steering = null;
            this.emit({ type: 'busy', busy: false });
        }
    }

    private async runTurn(items: QueueItem[]): Promise<void> {
        const turn = items[0]?.turn ?? this.deps.allocateTurn();
        this.turnNow = turn.turn;
        // 这一轮的起止时刻：**一个来源**（广播、turn.end、界面消息头 / 结算行全从这里来）。
        // 不让客户端各自 `Date.now()`：跨刷新、跨 surface 的两个数字必须说的是同一件事。
        const startedAt = Date.now();
        this.activeTurn = { turnId: turn.turnId, startedAt };
        this.turnUsage = undefined;
        // 先广播"这一轮开始了"：房间据此把上一个回合留下的未答提问判过期（ask.ts 的寿命规则）
        this.emit({ type: 'turn.start', turn, startedAt });
        // 错误条目带上本轮实际用的模型：403 / 无订阅这类失败，事后只能从 log 里翻
        const projector = new Projector(this.authorOf(), turn.turn, {
            modelKey: this.modelKey,
            ...(this.deps.roomId === undefined ? {} : { roomId: this.deps.roomId }),
            ...(this.deps.output === undefined ? {} : { output: this.deps.output }),
        });
        const abort = new AbortController();
        this.abort = abort;

        // ── 看门狗 ──
        // 下面那个 for-await **只有 SDK 肯退出时**才会走到 finally：网关连上了不吐字节、
        // 流中途静默时，收尾判据（endReasonOf / endItems / turn.end）永远没机会跑 ——
        // 用户看到的是「一直转圈」，而且关掉重开照样转（卡在调用里的人没人管）。
        //
        // **本层只说不杀**（2026-11-25 裁）：模型流的中止权归 agent 层的 StallWatchdog
        //（它是「读流的人」，事实质量高一档）；这里负责「让人早点看见」 ——
        // 按它的斩杀线派生提示档，另管它看不见的三样（工具 / compact / 整轮墙钟）。
        const watch = new ProgressWatch({
            // exactOptionalPropertyTypes：不传就不带这个键
            // oxlint-disable-next-line no-useless-spread
            ...(this.deps.progressPolicy === undefined ? {} : { policy: this.deps.progressPolicy }),
        });
        watch.start(turn.turnId);
        // `progress` 事件的节流器（只在事实变了时发，见 progress.ts 的 ProgressBroadcast）
        const broadcast = new ProgressBroadcast(this.deps.progressPolicy ?? {});
        /**
         * StallWatchdog 中止时的事实（在等谁 / 空了多久），从 `run.failed.stall` 取。
         *
         * 为什么不在本层算：中止那一刻本层的 `pending` 已经被 `run.failed` 清空了（收尾不再判），
         * 现取只剩 undefined —— 真事实反而丢了。让杀它的那一层把事实带过来。
         */
        let stallFact: { awaiting: string; idleMs: number } | undefined;
        const watchdog = setInterval(() => {
            if (abort.signal.aborted) return;
            // **只广播事实，不落条目**（用户 2026-11-24：「过程不该进历史」）。
            // 这条 `progress` 事件是 ephemeral 的：刷新即失 —— 合理，下一秒 tick 又会把它
            // 刷回来（轮次还在跑）。以前这里还多一步：把「该提醒了」翻成一条 notice 写进
            // 永久时间线，于是“61 秒还没吐第一个字”“压缩已经 5 分钟没回”一天天堆着；
            // 现在这些只活在这一刻的档位里（`stage`），真出事由 endItems 给一条结论。
            const fact = watch.fact();
            const stage = fact === undefined ? null : broadcast.shouldSend(fact);
            if (fact !== undefined && stage !== null) {
                this.emit({
                    type: 'progress',
                    turnId: turn.turnId,
                    awaiting: fact.awaiting,
                    idleMs: fact.idleMs,
                    alive: fact.alive,
                    stage,
                });
            }
        }, this.deps.progressTickMs ?? 5_000);
        // 别拖住进程退出（worktree 里跑测试时不至于挂住）
        (watchdog as { unref?: () => void }).unref?.();

        // 开跑前先把已到的公共条目并进来，再按自己的预算压一次（压不压只看自己）
        this.drainPending();
        watch.enter('compact');
        try {
            await this.compact({ turn: turn.turn, turnId: turn.turnId });
        } finally {
            watch.settle('compact');
        }

        // 本轮要处理的用户消息直接作为 prompt 的一部分（不出现在别处，避免重复记账）
        const userEntries: TranscriptEntry[] = items
            .filter((item) => item.alreadyInContext !== true)
            .map((item) => ({
                message: { role: 'user', content: item.text },
                origin: 'public',
                ...(item.turn === undefined ? {} : { turn: item.turn.turn }),
                ...(item.entry === undefined ? {} : { seq: item.entry.seq }),
                ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
            }));
        // 展开附件：transcript 里只有 ref，**这里**才读字节换成 ai-sdk 的 file part。
        // 无附件的条目原样返回（不建数组），常规路径不多付一分钱。
        // 本模型收不收图：不收就只留一句说明（塞 image part 会被上游 400）。
        // 每轮算一次（模型可能刚被换过），代价与 maxOutputTokensOf 同一量级。
        const acceptsImages = this.deps.acceptsImages?.(this.modelKey) ?? true;
        // 注意：投递状态的 `working` 由上面 `post()` 那一侧发（main 上已合并过去），这里不再重发一遍

        const produced: TranscriptEntry[] = [];
        let text = '';
        let failed = false;
        /** 运行给的失败原文（`run.failed.message`）：错误条目要把它说出来，别把话丢了 */
        let failureMessage: string | undefined;
        /** `run.failed` 的原文已经被 Projector 落成错误条目了 —— 收尾时别再抄一遍 */
        let errorReported = false;
        /**
         * 收尾事实：来自 agent 的 `run.finished`。**没收到就不算完成** ——
         * `finished=false` 会被判成 `unknown` 并按错误处理（见 end-reason.ts）。
         */
        let finished = false;
        let finishReason: string | undefined;
        let steps = 0;
        let toolCalls = 0;
        /** 运行时实际发出去的上限（`run.finished` 带回；没带回就用开跑前算的） */
        let reportedBudget: number | undefined;
        /** 运行时实际生效的步数上限（同上；对账用） */
        let reportedStepCap: number | undefined;
        const maxOutputTokens = maxOutputTokensOf(this.modelKey, this.deps.maxOutputTokens);
        const maxSteps = this.deps.maxSteps ?? DEFAULT_MAX_STEPS;
        const windowTokens = this.windowTokensOf();
        /**
         * 超窗自愈：**只重试一次**。
         *
         * 判据来自上游（`run.failed.overflow`，`agent.ts` 认的是 `context_length_exceeded` 一类
         * 明确信号）：只有它才走这条路 —— 其它 400（reasoning_content 缺失、模型不在套餐里）
         * 压一次是白花钱，还会把真错误盖掉。
         *
         * 为什么需要：压缩判据只看**轮首**（上面那次 `this.compact()`），而轮内 200 步每步全量
         * 重发、单条工具输出 50KB，几十步就能把请求从 20 万堆到 100 万（2026-11-27 task-mwlxxv3u
         * 实证）。这一轮已经跑了大半，直接整轮作废是最坏的结果 —— 压掉一段历史从头再发就好。
         */
        let overflowRetried = false;
        try {
            const run = this.deps.run ?? runAgent;
            while (true) {
            // 本次尝试的上下文：**从当前 transcript + 本轮已发生的产出重建**。
            //
            // 第一次尝试的文本 / 工具结果已经广播过、也落库了：重试不把它们撤回去，
            // 而是让模型**接着看**（下一轮的 prompt 里它们就是已发生的事实）。
            // 若清空重跑，时间线上会出现同一段话两遍、且白烧一遍推理。
            const messages: ModelMessage[] = await Promise.all(
                [...this.transcript, ...userEntries, ...produced].map((entry) =>
                    messageWithAttachments(entry, this.deps.readAttachment, this.imageCache, { acceptsImages }),
                ),
            );
            const steering = experimental_createSteering();
            this.steering = steering;
            // 只回退**结局**（失败事实 / 收尾原因）；产出、文本、步数、工具次数是**本轮已经发生的**，
            // 累加才是真的（重试后 steps 会把两次加在一起，撞步数上限也会更早到顶 —— 那是对的）。
            failed = false;
            failureMessage = undefined;
            errorReported = false;
            finished = false;
            finishReason = undefined;
            let retry = false;
            for await (const event of run({
                bot: this.deps.bot,
                modelKey: this.modelKey,
                // 每步读一次：切模型后当前轮的下一次 LLM 请求就生效（不等下一轮）
                getModelKey: () => this.modelKey,
                messages,
                turnId: turn.turnId,
                // provider 的会话亲和键 = **bot**（不是轮次）：同一实体跨轮复用同一会话，
                // 网关侧的提示词缓存才留得住。opencode 那些网关缺这个 id 直接 400。
                sessionId: this.deps.bot.id,
                signal: abort.signal,
                steering,
                maxOutputTokens,
                maxSteps,
                ...(this.deps.tools === undefined ? {} : { tools: this.deps.tools }),
                ...(this.deps.toolsHint === undefined ? {} : { toolsHint: this.deps.toolsHint }),
                ...(this.deps.systemContext === undefined ? {} : { systemContext: this.deps.systemContext }),
                ...(this.deps.takeDelta === undefined ? {} : { takeDelta: this.deps.takeDelta }),
                ...(windowTokens === undefined ? {} : { windowTokens }),
                ...(this.deps.commitDelta === undefined ? {} : { commitDelta: this.deps.commitDelta }),
                onStepTranscript: (added) => {
                    // transcript 会进快照落 db：媒体字节在模型那侧已经用过了，这里只留说明
                    for (const message of added)
                        produced.push({ message: scrubMedia(message), origin: 'self', turn: turn.turn });
                },
                onUsage: (usage) => {
                    this.lastUsage = usage;
                    this.turnUsage = usage;
                },
            })) {
                // 超窗**不进 Projector**：这一轮马上要重跑，错误条目得扣住 ——
                // 落了条目用户就会看到一条「超窗失败」，而它其实马上自愈了
                if (event.type === 'run.failed' && event.overflow === true && !overflowRetried) {
                    retry = true;
                    break;
                }
                watch.apply(event);
                if (event.type === 'run.failed') {
                    failed = true;
                    failureMessage = event.message;
                    // agent 层看门狗杀的这一轮：把「在等谁 / 空了多久」拿过来（中止的事实只有它知道，
                    // 见上面 `stallFact` 的注释）。有这个就是 `stalled`，不是一般失败。
                    if (event.stall !== undefined) {
                        stallFact = {
                            awaiting: event.stall.phase === 'tool' ? 'tool' : 'model-stream',
                            idleMs: event.stall.waitedMs,
                        };
                    }
                }
                if (event.type === 'run.finished') {
                    finished = true;
                    finishReason = event.finishReason;
                    steps = event.steps;
                    // 事实上限以**运行时实际发出去的**为准（`run.finished` 带回来的那个）：
                    // session 在开跑前算的是"打算发多少"，两者不一致时（换模型 / 网关改写）
                    // 对账要信实际值，否则页脚会报一个没发生过的数字。
                    if (typeof event.maxOutputTokens === 'number') reportedBudget = event.maxOutputTokens;
                    if (typeof event.maxSteps === 'number') reportedStepCap = event.maxSteps;
                }
                if (event.type === 'tool.started') toolCalls += 1;
                if (event.type === 'text.delta') text += event.delta;
                for (const item of projector.apply(event)) {
                    // 失败原文已经由 Projector 落成条目了（`run.failed` 那条）：
                    // 记下来，免得下面 `endItems` 再补一条一模一样的错误
                    if (item.type === 'error') errorReported = true;
                    this.emit({ type: 'item', item });
                }
            }
            if (!retry) break;
            // 超窗：压掉一段历史再从头发一次（**只此一次**，压完还超就老实报错）
            overflowRetried = true;
            watch.enter('compact');
            try {
                await this.compact({ turn: turn.turn, turnId: turn.turnId, force: true });
            } finally {
                watch.settle('compact');
            }
            this.emit({
                type: 'item',
                item: {
                    id: nextId('notice'),
                    seq: 0,
                    type: 'notice',
                    turn: turn.turn,
                    turnId: turn.turnId,
                    at: Date.now(),
                    status: 'done',
                    data: {
                        text: '上一份请求超过了模型窗口：已压掉一段历史，这一轮从头再跑一次。',
                        kind: 'context-overflow',
                        botId: this.deps.bot.id,
                    },
                },
            });
            }
        } catch (error) {
            failed = true;
            failureMessage = friendlyError(error);
            this.emit({ type: 'error', message: failureMessage });
        } finally {
            clearInterval(watchdog);
            // 本轮真正发生过的内容（含自己的 tool / reasoning）原样入账
            this.transcript.push(...userEntries, ...produced);
            // 到这一步本轮输入才**真的进了 transcript**（= 会被写进快照）。水位只能跟到这里：
            // 在起跑前就推的话，“开了跑没过久崩”这种情形下快照里没它、水位又越过了它 ⇒ 回放不再补，
            // 那句话就只剩在库里和界面上。
            for (const item of items) this.bumpLogSeq(item.entry?.seq);
            // 跑的过程中到达的公共条目：排在本轮产出之后，下一轮才被读到
            this.drainPending();

            // 还在 streaming 的条目（典型：ask 挂着时被取消 → 工具拿到「未回答」返回、
            // 模型正常收尾 → 走不到 run.failed）在这里一次性收尾，否则 UI 一直转圈。
            for (const item of projector.finalize()) this.emit({ type: 'item', item });

            // 为什么结束：判定只在 end-reason.ts（session / 房间 / 测试 / lab 页共用一份）。
            const verdict = endReasonOf({
                failed,
                aborted: abort.signal.aborted,
                // 谁按的停：人按的（cancel）与看门狗杀的要分开 —— 后者是事实，不是故障。
                // 看门狗的 stallFact 放后面：它优先（它自己开跑 abort，session 信号没被 abort）
                ...(abort.signal.aborted ? { abortedBy: 'human' as const } : {}),
                ...(stallFact === undefined ? {} : { abortedBy: 'deadline' as const, stall: stallFact }),
                finished,
                ...(finishReason === undefined ? {} : { finishReason }),
                steps,
                textLength: text.length,
                toolCalls,
                maxOutputTokens: reportedBudget ?? maxOutputTokens,
                maxSteps: reportedStepCap ?? maxSteps,
            });
            // 工具次数放进结算事实（`endReasonOf` 只判「为什么停」，不记次数）：
            // 结算行要写「N 次工具」，而它只能从运行侧数得到。
            const endReason = toolCalls === 0 ? verdict : { ...verdict, toolCalls };

            // 「怎么停的」必须说出来，否则数据里和正常收尾一模一样：
            // 截断 / 过滤 / 工具悬空 → notice；未知 / 失败 → 错误条目（未知按错误处理）。
            for (const item of endItems(
                endReason,
                {
                    turn: turn.turn,
                    turnId: turn.turnId,
                    ...(failureMessage === undefined ? {} : { failureMessage }),
                    // 结局归属：一轮里 @all 的各 bot 共享 turnId，只看 turnId 会张冠李戴
                    botId: this.deps.bot.id,
                },
                { errorAlreadyReported: errorReported },
            )) {
                this.emit({ type: 'item', item });
            }

            // 失败 / 未知**也给** turn.end：房间据此落 session 快照（不给的话这一段对话就丢了）。
            // 「能不能当结论发出去」由 room.publishConclusion 看 publishable() 拦。
            this.emit({
                type: 'turn.end',
                result: {
                    turn: turn.turn,
                    turnId: turn.turnId,
                    text: text.trim(),
                    failed: endReason.type === 'error' || endReason.type === 'unknown',
                    endReason,
                    startedAt,
                    endedAt: Date.now(),
                    ...(this.turnUsage === undefined ? {} : { usage: this.turnUsage }),
                },
            });

            // 这一轮已经消费了这些消息 ⇒ 投递成功；跑失败是 bot 的问题（会有 error 条目），
            // 不该在用户消息上标"未送达"（那是传输层的事）。
            for (const item of items) this.emit({ type: 'delivery', messageId: item.messageId, state: 'done' });
            for (const item of items) item.resolve();
            this.steering = null;
            this.abort = null;
            this.keepOnCancel = false;
            this.activeTurn = null;
            // 插话的 post() 到这一轮收尾才算处理完（不是“整个队列清空”）
            const steerResolvers = this.pendingResolvers.splice(0, this.pendingResolvers.length);
            for (const resolve of steerResolvers) resolve();
        }
    }

    /**
     * 调策略压一次并记账。策略自己决定要不要压（返回 null = 不压）。
     * 这里只做：计时、统计前后规模、更新占位说明、发事件。
     */
    private async compact(options: {
        turn: number;
        turnId: string;
        budget?: CompactionBudget;
        force?: boolean;
        /** 手动那次才有：让外面按 id 取消 / 让 UI 去重 */
        compactId?: string;
        /** 仅手动：发进度事件（自动压缩是轮次里的内部动作，广播出去只会是噪点） */
        manual?: boolean;
        signal?: AbortSignal;
    }): Promise<CompactEvent | null> {
        const budget = options.budget ?? this.budgetWith({});
        const before = {
            entries: this.transcript.length,
            chars: estimateChars(this.transcript),
            tokens: estimateTokens(this.transcript),
        };
        const startedAt = Date.now();
        const compactId = options.compactId ?? `c-${startedAt.toString(36)}`;
        const visible = options.manual === true;
        const report = (state: CompactionProgress['state'], extra: Partial<CompactionProgress> = {}): void => {
            if (!visible) return;
            this.emit({
                type: 'compact.progress',
                compact: {
                    compactId,
                    botId: this.deps.bot.id,
                    botName: this.deps.bot.name,
                    state,
                    startedAt,
                    budget,
                    before,
                    manual: true,
                    ...extra,
                },
            });
        };

        // 先报「开始了」再 await LLM：这是用户点下去之后唯一会立刻发生的事
        report('running');

        let result: CompactionResult | null;
        try {
            const windowTokens = this.windowTokensOf();
            result = await this.compactor.compact({
                entries: this.transcript,
                budget,
                turn: options.turn,
                turnId: options.turnId,
                ...(windowTokens === undefined ? {} : { windowTokens }),
                ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
                ...(options.force === true ? { force: true } : {}),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
        } catch (error) {
            const cancelled = options.signal?.aborted === true;
            report(cancelled ? 'cancelled' : 'failed', cancelled ? {} : { error: errorText(error) });
            // 取消不是故障：不压这一次，上下文原样保留（compactor 抛错时还没动过 transcript）
            if (cancelled) return null;
            throw error;
        }
        if (result === null) {
            report('done');
            return null;
        }

        this.transcript = result.entries;
        this.collapsed += result.dropped;
        this.applyCollapsedNote(result.summary);

        const event: CompactEvent = {
            at: Date.now(),
            strategy: this.compactor.name,
            turn: options.turn,
            turnId: options.turnId,
            durationMs: Date.now() - startedAt,
            budget,
            before,
            after: {
                entries: this.transcript.length,
                chars: estimateChars(this.transcript),
                tokens: estimateTokens(this.transcript),
            },
            dropped: result.dropped,
            summarized: result.summarized,
            ...(result.summary === undefined ? {} : { summary: result.summary }),
            ...(result.summaryError === undefined ? {} : { summaryError: result.summaryError }),
            ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
        };
        this.events.push(event);
        if (this.events.length > 10) this.events.shift();
        report('done', {
            durationMs: event.durationMs,
            after: event.after,
            dropped: event.dropped,
            summarized: event.summarized,
            ...(event.summary === undefined ? {} : { summary: event.summary }),
            ...(event.summaryError === undefined ? {} : { summaryError: event.summaryError }),
        });
        this.emit({ type: 'compact', event });
        return event;
    }

    /** 压缩说明只保留一条，且始终在最前面；后续摘要由策略基于旧说明重新生成 */
    private applyCollapsedNote(summary?: string): void {
        if (this.collapsed === 0 && summary === undefined) return;
        let previousSummary = '';
        if (this.transcript[0]?.origin === 'note') {
            const content = this.transcript.shift()!.message.content;
            const text = typeof content === 'string' ? content : '';
            previousSummary = text.replace(COLLAPSED_PREFIX, '').trim();
        }
        const content = [...(this.collapsed > 0 ? [collapsedLabel(this.collapsed)] : []), summary ?? previousSummary]
            .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
            .join('\n\n');
        this.transcript.unshift({ message: { role: 'user', content }, origin: 'note' });
    }

    private drainPending(): void {
        if (this.pending.length === 0) return;
        // 并进来就算读过了：水位跟到这里最深的一条，重启回放不必再补它们
        for (const entry of this.pending) this.bumpLogSeq(entry.seq);
        this.transcript.push(...this.pending);
        this.pending = [];
    }

    private authorOf(): Author {
        return { id: this.deps.bot.id, name: this.deps.bot.name, color: this.deps.bot.color, role: 'bot' };
    }
}

/**
 * 压缩说明的前缀。`applyCollapsedNote` 写、`currentSummary` 读，**必须同一份**：
 * 两处各写一份字面量时，改一边另一处会静默返回 undefined（摘要从 UI 上消失但没人报错）。
 */
const COLLAPSED_PREFIX = /^\[更早的 \d+ 条消息已折叠\]/;

function collapsedLabel(count: number): string {
    return `[更早的 ${String(count)} 条消息已折叠]`;
}

/** 失败原因留一行（别把整个 stack 塞进 UI 的那一行提示） */
function errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.trim() === '' ? '压缩失败' : text.split('\n')[0]!;
}

function withResolve(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
