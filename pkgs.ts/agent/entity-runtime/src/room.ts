// room.ts —— RoomActor：一个房间的聚合根。
//
// 一个 Room 拥有的东西（以前散在 server 的 7 个 Map 里）：
//   · 成员与默认应答（RoomMember：身份 + 本房间的模型/人格覆盖）
//   · 公共日志（RoomLog：人话 / 结论 / 通知，append-only）
//   · 会话池（每个 bot 一条 BotSession）
//   · 回合与展示顺序（turn / order 的唯一分配点）
//   · 路由（@ 规则）、结论发布、投递状态
//
// 不知道 HTTP / SSE：只通过 `emit` 把房间事件交出去，传输层自己决定怎么送。
//
// 领域不变量（改动前先看）：
//   1. 普通消息默认 next-step；被 @ 的人才是收件人，其余人只进上下文不唤醒
//   2. bot 的结论进公共日志，复制给其他 session，**不唤醒任何人**
//   3. bot 之间只能单人 @ 唤醒（@all 在 bot 侧忽略，防一次结论炸醒全房间）
//   4. 压缩只影响自己：没有房间级水位，也没有共享摘要
//   5. 同一房间运行中再发消息 → 沿用当前 turn（时间线不乱）

import type { ModelMessage, ToolSet } from 'ai';

import { effectivePersonaOf, mentionsOf, primaryMemberOf } from '@diy-agent/protocol';
import type { ContextSession } from '@diy-agent/context';

import { AskGate, askAnswerHeading, describeAnswer, type AnswerOutcome, type AskResult } from './ask';
import type { Compactor } from './compaction';
import { ASK_DRAFT_PREFIX, type Store } from './db';
import { RoomLog, type RoomEntry } from './room-log';
import { createRoomContext } from './system-context';
import { buildRoomTools } from './tools/index';
import { createToolOutputCapper } from './tool-output';
import { unitBoard, type UnitBoard } from './units';
import { jobNoticeOf, jobOwnerOf, type JobOwner } from './jobs';
import type { JobDoneEvent, RunRegistry } from '@diy-agent/jobs/node';
import type { CompactEvent } from './compaction';
import {
    BotSession,
    type CompactOptions,
    type SessionDeps,
    type SessionEvent,
    type SessionStats,
    type Turn,
} from './session';
import { publishable } from './end-reason';
import type {
    AskAnswer,
    AskRequest,
    Author,
    Bot,
    Delivery,
    InboxMode,
    Item,
    Room,
    RoomEvent,
    RoomMember,
    TurnEndReason,
} from './types';

export interface SessionInfo {
    botId: string;
    name: string;
    stats: SessionStats;
    compactions: ReturnType<BotSession['compactions']>;
}

export interface RoomActorDeps {
    spec: Room;
    store: Store;
    /** 全局 bot 身份表（可变化） */
    bots: () => Bot[];
    /** 房间事件出口；传输层在这里挂 SSE / rpc 推送 */
    emit: (event: RoomEvent) => void;
    /** 测试注入：假的模型运行 */
    run?: SessionDeps['run'];
    compactor?: Compactor;
    budget?: CompactOptions;
    /** 房间的工作目录；不传 = 不给文件/命令工具（只用内置 get_time） */
    cwd?: string;
    /**
     * 应用数据根（diy2 = 实例 home）：`<home>/AGENTS.md` 进规则链首。
     * 不传 = 没有应用级规范（测试 / 无 app 宿主）。
     */
    home?: string;
    /**
     * 设备根（diy2 = 生产 home `~/.diy2`）：设备级知识库 `<设备根>/knowledge`。
     * 不传 = 不投设备库（与 `home` 分开：lab 实例的应用根是 `run/diy2/lab`，设备库仍在生产根）。
     */
    deviceHome?: string;
    /** 是否开放 shell（缺省开放） */
    shell?: boolean;
    /**
     * 后台作业账本（进程级单例，由宿主创建）。不传 = bash 没有 `background`、也没有 `job` 工具。
     * 收口通知由宿主挂 `RunRegistry` 的 notifier 后调 `notifyJobDone` 送回来（见 jobs.ts）。
     */
    jobs?: { registry: RunRegistry };
    /** 步数上限（缺省 `DEFAULT_MAX_STEPS`；到顶按 `max-steps` 收尾） */
    maxSteps?: number;
    /** shell 缺省超时 */
    bashTimeoutMs?: number;

    /** 压缩事件（日志 / 监控） */
    onCompact?: (bot: Bot, event: CompactEvent) => void;
    now?: () => number;
    /** 「用户」在时间线上的身份（回答提问时以它投递）；缺省就是「我」 */
    human?: Author;
}

export class RoomActor {
    private readonly log: RoomLog;
    private readonly sessions = new Map<string, BotSession>();
    /**
     * 正在跑的手动压缩（compactId → 取消器）。
     *
     * 为什么需要：摘要是一次好几秒的 LLM 调用，用户点下去之后得能看见、能撤；
     * 而压缩会**重写自己的 transcript**，同一成员并发压两次会拿着同一份旧上下文
     * 算边界，后完成的那次把前一次的结果覆盖回去。
     */
    private readonly compacting = new Map<string, { botId: string; controller: AbortController }>();
    /** 展示顺序（跨 bot 稳定） */
    private order = 0;
    /** 回合号 */
    private turnSeq = 0;
    private currentTurn: Turn | null = null;
    private initialized = false;
    /** item.id → 展示顺序（同一 id 的流式更新不能换顺序） */
    private readonly orderOf = new Map<string, number>();
    /**
     * 工具条目 id → 它属于哪一轮。提问闸门用它给卡片盖 `turnId`（见 `AskGateDeps.turnOf`）。
     * 生命周期与 `orderOf` 相同（按 item id 累积）：只多了工具条目这一种，量级一样。
     */
    private readonly turnOfTool = new Map<string, string>();
    /** 已落库的 item id（流式更新会重复发同一条） */
    private readonly persisted = new Set<string>();
    /** 提问闸门：模型需要用户做决定时把卡片推到界面上（不阻塞本轮） */
    private readonly gate: AskGate;
    /** 用户的身份（回答提问时那条消息的作者） */
    private readonly human: Author;
    /**
     * 每个成员一份上下文会话：provider 值共享，但 cursor（模型已经看过哪棵树）各自推进。
     * 一个成员没被 @ 时只 ingest、不 step；等它下一次跑，增量会一次补齐。
     */
    private readonly contexts = new Map<string, ContextSession>();
    /** 系统自己的身份：「你的提问被挤掉了」这类通知的作者（不能冒充用户） */
    private static readonly SYSTEM: Author = { id: 'system:ask', name: '系统', color: '#9ca3af', role: 'system' };
    /** 每个成员一份工具集：只有 ask 的归属不同（按成员停止时要能分辨） */
    private readonly toolsByBot = new Map<string, ToolSet | undefined>();
    /** 正在跑一轮的成员（UI 的"谁在说话"用它，不由前端猜） */
    private readonly speaking = new Set<string>();
    /**
     * 在跑的那一轮从何时开始（botId → { turnId, startedAt }）。
     *
     * 存在理由：消息头要写「开始于 22:28」、滚动行要写「已用 2m44s」，这两个数字必须和
     * 收轮时的 `turn.end.startedAt` 是**同一个值**。让客户端拿条目时刻去推，收轮时会跳一下。
     * 进快照（`runningTurns`）：刷新后事件没了，但时间不变。
     */
    private readonly turnStarts = new Map<string, { turnId: string; startedAt: number }>();
    private lastRunningKey = '';

    constructor(private readonly deps: RoomActorDeps) {
        // 公共日志从库里恢复（append-only，seq 接着走）
        this.log = new RoomLog(this.deps.store.roomEntries(this.id));
        this.gate = new AskGate({
            request: (request) => {
                // 先落库再广播：进程在广播后、用户回答前挂掉，重启还能把卡片捞回来
                this.deps.store.putAsk({
                    askId: request.askId,
                    entityId: this.id,
                    at: request.at,
                    request,
                    state: 'pending',
                });
                this.deps.emit({ kind: 'ask', request });
            },
            settle: (request, result, owner) => this.settleAsk(request, result, owner),
            turnOf: (toolCallId) => (toolCallId === undefined ? undefined : this.turnOfTool.get(`tool-${toolCallId}`)),
            now: () => this.deps.now?.() ?? Date.now(),
        });
        // 待答的提问从库里恢复（ask 不阻塞，内存状态扛不住重启）
        this.gate.restore(
            this.deps.store.asksOf(this.id).map((record) => ({
                request: record.request,
                state: record.state,
                ...(record.answer === undefined ? {} : { answer: record.answer }),
                ...(record.reason === undefined ? {} : { reason: record.reason }),
                at: record.at,
                ...(record.settledAt === undefined ? {} : { settledAt: record.settledAt }),
            })),
        );
        this.human = this.deps.human ?? { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' };
        // 成员的 session 一开始就建好：上下文、统计、恢复都不需要等第一条消息
        for (const bot of this.members()) this.sessionOf(bot);
        this.reportOpenTurns();
    }

    /**
     * 上次没收尾的轮（进程崩溃 / 被杀）→ 补一条轮级事实，然后销标记。
     *
     * 为什么必须补：`turn.end` 在 session 的 finally 里发，进程死在那一步之前就什么都没落，
     * 磁盘上那一轮与「正常说完」完全同形。
     * 补成 `notice(kind: 'interrupted')` 是最省的那条路：走的是已有的轮级事实通道，
     * 直接以一条 notice 落盘，不需要新造事件类型。
     *
     * 没有开着的轮时**一次查询就走**（不读 items）—— 正常重启不该为此付 ensureInit 的钱。
     *
     * ⚠️ 只有「**不会续跑**的开轮」才算中断。diy2 的恢复会按原 turn 号重放还挂在
     * `queued` / `delivering` 的投递（见 `recover()`），那一轮马上就会重新 `turn.start` ——
     * 对它报「没跑完」会落成一条与紧随其后的续跑内容自相矛盾的事实；更要紧的是续跑完成
     * **不产条目**，于是这条 notice 永远是那一轮的最后一条轮级事实，bot 被永久误标成中断。
     * 所以：还挂着待重放投递的轮，一句都不报、标记也不销。
     */
    private reportOpenTurns(): void {
        const opens = this.deps.store.openTurns(this.id);
        if (opens.length === 0) return;
        // botId → 他名下会被续跑的 turnId（turnId 是房间级的，@all 时必须按 bot 分开认）
        const replaying = new Map<string, Set<string>>();
        for (const delivery of this.deps.store.pendingDeliveries(this.id)) {
            if (delivery.turnId === undefined) continue;
            const turns = replaying.get(delivery.botId) ?? new Set<string>();
            turns.add(delivery.turnId);
            replaying.set(delivery.botId, turns);
        }
        for (const open of opens) {
            const bot = this.member(open.botId);
            // 成员已经不在这个房间里（被移出）：没有可归属的事实，直接销标记
            if (bot === undefined) {
                this.deps.store.closeTurn(this.id, open.botId);
                continue;
            }
            if (replaying.get(open.botId)?.has(open.turnId) === true) {
                // 不报、不销标记：留给续跑的 turn.start / turn.end 自己收口。
                // 万一续跑没成（投递重放失败 → state 变 failed），它就不在 pending 里了，
                // 下次启动会走下面那条正经分支 —— 真中断不会漏报，只是晚一个启动周期。
                // 顺手把**上次启动已经报错落到磁盘**的那条撤掉（自愈旧误报）。
                this.deps.store.deleteInterruptedFacts(this.id, open.turnId, open.botId);
                continue;
            }
            const order = this.nextOrder();
            const notice: Item = {
                id: `n-${open.at.toString(36)}-${order}`,
                seq: this.deps.store.seqOf(this.id) + 1,
                order,
                turn: open.turn,
                turnId: open.turnId,
                // 用「发现时刻」而不是 open.at：时间线的位置按 order（出现时刻）排，
                // 这条排在末尾却标着昨晚的时间会让人以为消息被插错了地方 ——
                // 事实内容（哪一轮没跑完）由 turnId 与文案表达，不需要 at 来冒充
                at: Date.now(),
                status: 'done',
                type: 'notice',
                // 不带 author：轮级事实，UI 据此让它独立成条；
                // 归属记在 data.botId（turnId 是房间级的，@all 时认不出是谁）
                data: {
                    text: `${bot.name} 的上一轮没跑完（进程中断），结论可能不完整`,
                    kind: 'interrupted',
                    botId: open.botId,
                },
            };
            this.deps.emit({ kind: 'item', item: this.deps.store.appendItem(this.id, notice) });
            this.deps.store.closeTurn(this.id, open.botId);
        }
    }

    get id(): string {
        return this.deps.spec.id;
    }

    get spec(): Room {
        return this.deps.spec;
    }

    // ── 成员 ───────────────────────────────────────────────────

    /** 房间成员（已套用本房间的模型/人格覆盖） */
    members(): Bot[] {
        const identities = this.deps.bots();
        return this.deps.spec.members
            .map((member) => identities.find((bot) => bot.id === member.botId))
            .filter((bot): bot is Bot => bot !== undefined)
            .map((bot) => this.inRoom(bot));
    }

    member(botId: string): Bot | undefined {
        return this.members().find((bot) => bot.id === botId);
    }

    primary(): Bot | undefined {
        const member = primaryMemberOf(this.deps.spec);
        return member === undefined ? undefined : this.member(member.botId);
    }

    busy(): boolean {
        for (const session of this.sessions.values()) if (session.busy) return true;
        return false;
    }

    // ── 时间线 ─────────────────────────────────────────────────

    items(afterSeq = 0): Item[] {
        return this.deps.store.itemsOf(this.id, afterSeq);
    }

    deliveries(): Delivery[] {
        return this.deps.store.listDeliveries(this.id);
    }

    /** 公共日志（只读，调试 / 重放用） */
    entries(): readonly RoomEntry[] {
        return this.log.all();
    }

    // ── 写 ─────────────────────────────────────────────────────

    /**
     * 投一条消息：落库 → 进公共日志 → 按 @ 规则分发 → 等这一轮跑完。
     *
     * `quiet`：只留痕 —— 时间线上看得到、所有人的上下文里也有，但**不投给任何人**，
     * 于是不会叫醒任何成员跑一轮。用于系统通知（「你那问作废了」）：那是给人看的状态，
     * 不是需要回复的消息；走普通投递会把一个空闲成员叫起来，只为读一句「不用再等」。
     */
    async say(input: {
        text: string;
        author: Author;
        recipients?: string[];
        mode?: InboxMode;
        quiet?: boolean;
    }): Promise<void> {
        const text = input.text.trim();
        if (text === '') throw new Error('text required');

        const participants = this.members();
        if (participants.length === 0) throw new Error('room has no bot');

        // 先把成员 session 建好（新建的会回放日志），再追加这条公共条目，
        // 否则被 @ 的人会把同一条消息收两遍（日志 + steering）
        for (const bot of participants) this.sessionOf(bot);

        const turn = this.currentTurn !== null && this.busy() ? this.currentTurn : this.newTurn();
        const now = this.deps.now?.() ?? Date.now();
        const item: Item = {
            id: `u-${now.toString(36)}-${this.order + 1}`,
            seq: this.deps.store.seqOf(this.id) + 1,
            order: this.nextOrder(),
            turn: turn.turn,
            turnId: turn.turnId,
            at: now,
            status: 'done',
            author: input.author,
            type: 'chat',
            data: { text },
        };
        const saved = this.deps.store.appendItem(this.id, item);
        this.deps.emit({ kind: 'item', item: saved });

        const entry = this.appendEntry({
            kind: 'say',
            author: input.author,
            text,
            // 投递 / 公共条目对得上的唯一钥匙：崩溃恢复要靠它问 session「你读过这句没有」
            messageId: saved.id,
            turn: turn.turn,
            turnId: turn.turnId,
        });

        // 空 recipients ＝ 所有人都走 ingest（下面那条循环），谁也不被 post 叫醒
        const recipients = input.quiet === true ? [] : this.route(text, participants, input.recipients);
        const recipientIds = new Set(recipients.map((bot) => bot.id));
        for (const bot of participants) {
            if (!recipientIds.has(bot.id)) this.sessionOf(bot).ingest(entry);
        }

        for (const bot of recipients) {
            // 入队信息一起落库：崩溃后靠它重新投递
            const delivery = this.deps.store.setDelivery({
                roomId: this.id,
                messageId: saved.id,
                botId: bot.id,
                state: 'queued',
                mode: input.mode ?? 'next-step',
                turn: turn.turn,
                turnId: turn.turnId,
            });
            this.deps.emit({ kind: 'delivery', delivery });
        }

        // 变量增量不在这里算：它属于**模型步**（session 的 prepareStep 每步取一次），
        // 这样 say / 恢复重投 / agent 间结论走的是同一条路，不会有「时机不同就漏一把」。
        await Promise.all(
            recipients.map((bot) =>
                this.sessionOf(bot).post({
                    messageId: saved.id,
                    text,
                    mode: input.mode ?? 'next-step',
                    turn,
                    entry,
                }),
            ),
        );
    }

    /**
     * 崩溃恢复：把还没送达的投递重新投一遍。
     * `delivering` 视为未送到（进程中途挂了，模型回复也没落盘）。
     *
     * **返回 Promise 且内部串行**（2026-11-25）：以前是 `void post()` 一口气全排出去，
     * 于是启动时十几个房间同时向网关发请求 —— 一屏 429，再加上各自的压缩，UI 一打开
     * 就是灾难（## turn 180 的实测）。现在一个投递跑到收尾（post 的 Promise 在轮结束时
     * resolve）再放下一个；卡住的轮有 StallWatchdog 兜住，不会把后面永久堵死。
     *
     * 单个投递失败不中断其余：失败已经在 session 里落成事实，这里只记一行。
     */
    async recover(): Promise<void> {
        for (const delivery of this.deps.store.pendingDeliveries(this.id)) {
            const bot = this.member(delivery.botId);
            if (bot === undefined) continue;
            const text = this.deps.store.textOf(this.id, delivery.messageId);
            if (text === undefined) {
                this.deps.store.setDelivery({
                    roomId: this.id,
                    messageId: delivery.messageId,
                    botId: delivery.botId,
                    state: 'failed',
                    note: '恢复时找不到原文',
                });
                continue;
            }
            const turn =
                delivery.turn === undefined
                    ? undefined
                    : { turn: delivery.turn, turnId: delivery.turnId ?? `turn-${delivery.messageId}` };
            // 这条投递对应的公共条目（只有 say 带 messageId）。拿到它才能问 session
            // 「你上下文里到底有没有它」—— 不传的话 session 无处可查，只像个眼瞎的盲标。
            const entry = this.log
                .all()
                .find((item) => item.kind === 'say' && item.messageId === delivery.messageId);
            await this.postOrWarn(bot, delivery, text, entry, turn);
        }
    }

    /**
     * 续跑一条投递，失败只留一行线索（不拖住后面）。
     *
     * 为什么不在 `recover` 里内联 try/catch：那段已经有 5 个可空参数，再套一层就别想读了。
     * post 自己会把失败落成事实（delivery `state: failed` + notice）—— 这里只是不把
     * 「一条坏消息」升缆成「整台实例后面的房间都不续跑」。
     */
    private async postOrWarn(
        bot: Bot,
        delivery: ReturnType<Store['pendingDeliveries']>[number],
        text: string,
        entry: RoomEntry | undefined,
        turn: Turn | undefined,
    ): Promise<void> {
        try {
            await this.sessionOf(bot).post({
                messageId: delivery.messageId,
                text,
                mode: delivery.mode ?? 'next-step',
                // 不写 alreadyInContext：由 session 按序号自己判断（回放带了就带上它，
                // 水位跳过了就当普通消息补上）。原先无条件写 true 就是把消息凭空抹掉的那一刀。
                ...(entry === undefined ? {} : { entry }),
                ...(turn === undefined ? {} : { turn }),
            });
        } catch (error) {
            console.warn(`[room:${this.id}] 续跑投递失败：${(error as Error).message}`);
        }
    }

    /**
     * 停止：不给 botId 就停整个房间；给了只停那个成员。
     * 开会时"谁在说"是分开的，停一个人不该把别人也停掉。
     */
    cancel(options: { botId?: string; keepQueue?: boolean } = {}): void {
        // 注意：不动待回答的提问。ask 不阻塞，点「停止」时那一轮早就跑完了，
        // 卡片还得留在界面上等用户作答（回答会另开一轮）。
        if (options.botId === undefined) {
            for (const session of this.sessions.values()) session.cancel(options);
            return;
        }
        this.sessions.get(options.botId)?.cancel(options);
    }

    /**
     * 容器即将被删除：先停掉还在跑的会话和挂着的提问。
     * 不先停就删行的话，跑到一半的 race 收尾时还会往已删的容器里写条目。
     */
    stop(): void {
        if (this.busy()) this.cancel();
        // 容器要没了：挂在界面上的提问一并清掉，否则回答还会往已删的容器里投递
        this.gate.cancelAll('容器已关闭');
    }

    /** 当前在说话的成员（按成员顺序） */
    runningBots(): string[] {
        return this.members()
            .map((bot) => bot.id)
            .filter((botId) => this.speaking.has(botId));
    }

    /**
     * 还没开始跑的投递（`queued` / `delivering`），按成员计数。
     *
     * 「排队中」是**系统状态**而不是「要你动手」：重启后的待续跑（`recover()` 那条路）、
     * 连发几条还没轮到它，都落在这里。以前 UI 完全看不见这一段 —— 房间看起来
     * 「什么都没发生」，其实它排着队；反过来「红 N」里也混不进它们。
     */
    queuedByBot(): Map<string, number> {
        // 「排队」= 还没轮到它。**正在跑的那个成员手上握着一条投递**（`queued` 或 `delivering`
        // 都实测见过），那条是它此刻这一轮，不是排队 —— 不排除它，界面就会出现
        // 「在跑却写排队中」（用户 2026-11-26 报的就是这个）。
        // 判据只看「在不在跑」，不看投递状态：状态机里 `delivering` 只在部分路径打，
        // 靠它区分会把在跑的那条当成排队。
        const counts = new Map<string, number>();
        for (const delivery of this.deps.store.pendingDeliveries(this.id)) {
            counts.set(delivery.botId, (counts.get(delivery.botId) ?? 0) + 1);
        }
        // 在跑的成员减一（它手上那条）：剩多少条才是真排着的
        for (const botId of this.runningBots()) {
            const n = counts.get(botId);
            if (n === undefined) continue;
            if (n <= 1) counts.delete(botId);
            else counts.set(botId, n - 1);
        }
        return counts;
    }

    /**
     * 在跑的那几轮的开始时刻（快照用）。
     *
     * 只给 `runningBots()` 里真在跑的成员：`turnStarts` 里的旧记录可能是上一轮的残留。
     */
    runningTurns(): Array<{ botId: string; turnId: string; startedAt: number }> {
        return this.runningBots().flatMap((botId) => {
            const turn = this.turnStarts.get(botId);
            return turn === undefined ? [] : [{ botId, ...turn }];
        });
    }

    /** 用户的回答（整批一次提交）；返回结局（命中 / 已失效 / 答不全） */
    answerAsk(askId: string, answer: AskAnswer): AnswerOutcome {
        return this.gate.answer(askId, answer);
    }

    /**
     * 用户撤回某一问（不想答了）：卡片收尾成「已失效」，待回答计数减一。
     *
     * 不碰正在跑的运行 —— 那件事是 `cancel()`，与这张卡无关（ask 不阻塞，
     * 点「停止」时那一轮早就跑完了）。也不叫醒任何人：只给提问的成员留一句系统说明，
     * 它下次真正被叫起来时才读到（见 `notifyAskDropped`）。
     */
    cancelAsk(askId: string, reason = '提问已被撤回'): boolean {
        return this.gate.cancel(askId, reason);
    }

    /** 还有几个提问在等回答 */
    pendingAsks(): number {
        return this.gate.pendingCount();
    }

    /** 挂起的提问（刷新 / 重连时恢复卡片） */
    pendingAskRequests(): ReturnType<AskGate['list']> {
        return this.gate.list();
    }

    /** 已有结局的提问（最近的若干条）：刷新后卡片仍在，并带着已选状态 */
    answeredAskRequests(): ReturnType<AskGate['answeredList']> {
        return this.gate.answeredList();
    }

    /**
     * 提问解决：卡片收尾 + 留痕 + （关键）把回答变成一条用户消息投给提问的人。
     *
     * 为什么必须是消息：ask 不阻塞，模型的 run 早已结束，没有 tool call 能填回答案了。
     * 他会说话 ⇒ 走 steering 在下一个 step 边界注入；已经说完 ⇒ 这条消息开新的一轮。
     */
    private settleAsk(request: AskRequest, result: AskResult, owner?: string): void {
        // 先落库（待答 → 已答/已撤）：重启后卡片仍能带着「已选」或「已失效」回来
        this.deps.store.putAsk({
            askId: request.askId,
            entityId: this.id,
            at: request.at,
            request,
            state: result.answer === undefined ? (result.expired === true ? 'expired' : 'cancelled') : 'answered',
            ...(result.answer === undefined ? {} : { answer: result.answer }),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            settledAt: Date.now(),
        });
        this.deps.store.pruneAsks(this.id, 50);
        // 提问有结局 ⇒ 半填的答案就该消失（**这个**才是回收条件，不是"过多久没人动"）。
        // 答上来 / 被撤回 / 被新提问挤掉 / 房间关了，都走这里：卡片从此只读或不再显示，
        // 留着草稿只会让侧栏的 ? 为一个不存在的提问常亮（docs/drafts-design.md §12）。
        // 只删自己这一条 field：同一房间的发言框草稿不许受牵连。
        this.deps.store.deleteDraft(this.id, `${ASK_DRAFT_PREFIX}${request.askId}`);
        this.deps.emit({
            kind: 'ask.answered',
            askId: request.askId,
            ...(result.answer === undefined ? {} : { answer: result.answer }),
            ...(result.cancelled === true ? { cancelled: true } : {}),
            ...(result.expired === true ? { expired: true } : {}),
            ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
        // 取消（容器关闭 / 成员被移除 / 超时）：卡片消失就够了，不往时间线上写痕
        if (result.answer === undefined) {
            // 例外：被新提问挤掉的那条。提问的成员还在原地看着，而 ask 不阻塞、
            // 没有 tool call 能回填 —— 不告诉它，它会永远停在「我问了、等回答」。
            if (result.notifyOwner === true) this.notifyAskDropped(request, result, owner);
            return;
        }

        // 不再单独落一条 notice：回答本身就是一条消息，时间线上看得到，刷新也不丢。
        // 内容写成模型一眼能对上的样子：哪一问 + 答了什么
        const message = `${askAnswerHeading(request)}\n${describeAnswer(request, result.answer)}`;
        // 回答投给提问的成员；他已经不在房间了就退给主成员，再退给第一个成员。
        // 不退的话 recipients 会被 route() 过滤成空：消息落库了、没任何成员收到、也不报错 ——
        // 用户看到的是「我答了、时间线上有这条、没人理」。
        const target =
            owner !== undefined && this.member(owner) !== undefined
                ? owner
                : (this.primary()?.id ?? this.members()[0]?.id);
        void this.say({
            text: message,
            author: this.human,
            ...(target === undefined ? {} : { recipients: [target] }),
        }).catch((error: unknown) => {
            // 不能再吞：房间里一个成员的 session 都建不起来时 say 会抛，那种情况下用户必须知道答案没送到
            const reason = error instanceof Error ? error.message : String(error);
            this.deps.emit({ kind: 'error', message: `回答没有送出去：${reason}` });
        });
    }

    /**
     * 「你那问作废了」—— 落一条系统痕迹，进上下文，**不叫醒任何人**。
     *
     * 为什么是 `quiet` 而不是普通 `say`：`say` 会 post 给收件人，而 post 一个空闲成员
     * 就是**真的跑一整轮**（实测：B 先问一个→空闲，A 连问 21 个挤掉它 → 运行列表变成
     * `[bot:b#1, bot:a#1, bot:b#2]`，多出来的那一轮只为读一句「不用再等」）。
     * 通知变成叫醒：费钱、多一条无意义回复，还可能让它再提问、再挤掉别人。
     *
     * 作者是系统而不是 this.human：这条不是用户说的话，冒充用户会让模型以为
     * 「我问了、他自己把话题撤了」。transcript 里渲染成 `[系统] …`，跟真回答区分得开。
     */
    private notifyAskDropped(request: AskRequest, result: AskResult, owner?: string): void {
        const target = owner === undefined ? undefined : this.member(owner);
        // 成员已经不在房间了：没人需要知道（它那一份 pending 在移除时已被 cancelFor 清掉）
        if (target === undefined) return;
        const reason = result.reason;
        const suffix = reason === undefined || reason === '' ? '' : `：${reason}`;
        // 「过期」和「作废」对模型是两件事：作废=这问不算数了；过期=它自己已经往前走，
        // 需要的话重新提问（模型据此决定要不要再问，别一味重试一张早就过时的卡）。
        const headline = result.expired === true ? '已经过期' : '已经作废';
        // 多题时把题目都列出来：只说「提问已作废」，它不知道是哪一批（同一个成员可能问过好几张）
        const titles = request.questions.map((question) => `「${question.question}」`).join('');
        void this.say({
            text: `提问${titles}${headline}${suffix}。不用再等这个回答；还需要的话重新提问。`,
            author: RoomActor.SYSTEM,
            quiet: true,
        }).catch((error: unknown) => {
            // 同 settleAsk：送不到必须让用户看见，不能静默
            const message = error instanceof Error ? error.message : String(error);
            this.deps.emit({ kind: 'error', message: `提问作废的通知没有送出去：${message}` });
        });
    }

    /** 手动压某个成员的上下文（只影响它自己）。返回 compactId：UI 拿它取消 */
    async compact(
        botId: string,
        options: CompactOptions = {},
    ): Promise<{ compactId: string; event: Awaited<ReturnType<BotSession['forceCompact']>> }> {
        const bot = this.member(botId);
        if (bot === undefined) throw new Error('bot not in room');
        const running = [...this.compacting.values()].find((entry) => entry.botId === botId);
        if (running !== undefined) throw new Error(`${bot.name} 正在压缩，等它结束或先取消`);
        // id 可以由调用方先给：RPC 要「受理即返」（否则 UI 得等到压完才拿到可取消的键）
        const compactId = options.compactId ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const controller = new AbortController();
        this.compacting.set(compactId, { botId, controller });
        try {
            const event = await this.sessionOf(bot).forceCompact({ ...options, compactId, signal: controller.signal });
            return { compactId, event };
        } finally {
            this.compacting.delete(compactId);
        }
    }

    /** 撤掉一次正在跑的压缩；false = 它已经跑完了（不是错误，手点慢了而己） */
    cancelCompact(compactId: string): boolean {
        const entry = this.compacting.get(compactId);
        if (entry === undefined) return false;
        entry.controller.abort();
        return true;
    }

    /** 调试 / 测试：正在跑的手动压缩 id（检验 finally 有没有清干净） */
    compactingIds(): string[] {
        return [...this.compacting.keys()];
    }

    /** 调试 / 测试：某个成员当前的上下文快照 */
    contextOf(botId: string): readonly ModelMessage[] | undefined {
        return this.sessions.get(botId)?.context();
    }

    sessionsInfo(): SessionInfo[] {
        return [...this.sessions.entries()].map(([botId, session]) => ({
            botId,
            name: this.member(botId)?.name ?? botId,
            stats: session.stats(),
            compactions: session.compactions(),
        }));
    }

    // ── 成员变更（持久化在这里，不在 server）────────────────────

    setMembers(members: readonly RoomMember[]): void {
        this.deps.spec.members = [...members];
        this.deps.store.setMembers(this.id, this.deps.spec.members);
        this.deps.store.saveRoom(this.deps.spec);
        // 退出的成员把 session 一并丢掉（再进来会按日志重建）
        const keep = new Set(members.map((member) => member.botId));
        for (const botId of [...this.sessions.keys()]) {
            if (keep.has(botId)) continue;
            this.sessions.delete(botId);
            // 他问过、还没答的提问跟着失效：否则卡片永久挂在界面上，
            // 用户答了也没人收（成员已不在房间，投递会被路由成空）
            this.gate.cancelFor(botId, '提问的成员已离开房间');
        }
        for (const bot of this.members()) this.sessionOf(bot);
    }

    addMember(botId: string): void {
        if (this.deps.spec.members.some((member) => member.botId === botId)) return;
        this.setMembers([...this.deps.spec.members, { botId }]);
    }

    /**
     * 角色改了（名字 / 人格 / 模型），**成员名单没变**：已经建好的 session 把旧快照换代。
     *
     * 与 `setMembers` 分工：那个管「谁在房间里」，这个管「这些人还是不是原来那个他」。
     * 不推的话，角色页改完人格，房间要重启才生效 —— 而用户刚看到「已保存」。
     */
    refreshIdentities(): void {
        for (const bot of this.members()) this.sessions.get(bot.id)?.setIdentity(bot);
    }

    /**
     * 改容器元数据：默认模型 / data（名字、任务状态、描述…）。
     * data 是**浅合并**（`null` = 删掉这个键）：任务状态这类字段后端不懂语义，
     * 只按调用方给的值落库 —— 在这里写枚举就是让新类型（股票/日历）每次都要改 runtime。
     *
     * 容器的名字也在 data 里（task 的 `title` / `project` 的 `name`），所以改名不再有
     * 独立入参。
     *
     * ⚠ 改名**不再**同步角色名（2026-11-24 角色改成类型级之后）：一个角色服务该类型的
     * 所有房间，跟着某一间房改名字就等于把别的房里的助手一起改了。反过来说，任务标题
     * 和助手名字现在是两个独立概念 —— 这也是角色页存在的意义。
     */
    update(patch: { data?: Record<string, unknown> }): void {
        if (patch.data !== undefined) {
            for (const [key, value] of Object.entries(patch.data)) {
                if (value === null) delete this.deps.spec.data[key];
                else this.deps.spec.data[key] = value;
            }
        }
        // 改名 / 改 data 都要落库，否则重启后回到旧值
        this.deps.store.saveRoom(this.deps.spec);
    }

    // ── 内部 ───────────────────────────────────────────────────

    /** 只在"谁在说话"真的变了时广播 */
    private syncRunning(): void {
        const key = this.runningBots().join(',');
        if (key === this.lastRunningKey) return;
        this.lastRunningKey = key;
        this.deps.emit({ kind: 'running', botIds: this.runningBots() });
    }

    /** 追加一条公共条目：内存 + 落库（唯一的写入口） */
    private appendEntry(input: Parameters<RoomLog['append']>[0]): RoomEntry {
        const entry = this.log.append(input);
        this.deps.store.appendRoomEntry(this.id, entry);
        return entry;
    }

    private persistSession(botId: string): void {
        const session = this.sessions.get(botId);
        if (session === undefined) return;
        const snapshot = session.snapshot();
        // 水位由 session 自己算（它才知道自己真读到哪了）：房间的 log.lastSeq 含
        // 「已 append 但这一侧还没读」的条目，拿它当水位会在重启后跳过那些消息。
        this.deps.store.saveSession(this.id, botId, snapshot);
        this.turnSeq = Math.max(this.turnSeq, snapshot.turn);
    }

    /** 工具集：房间目录 + 审批闸门（每个成员一份，ask 带 owner） */
    private toolsFor(botId: string): ToolSet | undefined {
        if (this.toolsByBot.has(botId)) return this.toolsByBot.get(botId);
        const cwd = this.deps.cwd;
        const tools =
            cwd === undefined
                ? undefined
                : buildRoomTools({
                      cwd,
                      ...(this.deps.shell === undefined ? {} : { shell: this.deps.shell }),
                      ...(this.deps.bashTimeoutMs === undefined ? {} : { bashTimeoutMs: this.deps.bashTimeoutMs }),
                      ...(this.deps.jobs === undefined
                          ? {}
                          : { jobs: { registry: this.deps.jobs.registry, owner: jobOwnerOf(this.id, botId) } }),
                      ask: this.gate,
                      askOwner: botId,
                      // 投递层截断：单条工具输出超 2000 行 / 50KB ⇒ 头尾 + marker，原文落
                      // `<home>/toolout/`（模型不够自己 read 回取）。不接这一层 = 大输出的
                      // 原文直接进这一轮请求，压缩（只管轮首）拦不住。
                      toModelOutput: createToolOutputCapper(
                          this.deps.home === undefined ? {} : { home: this.deps.home },
                      ),
                      onJournal: (input) => {
                          this.deps.store.appendJournal(this.id, input);
                      },
                      // unit 是 task 私有的：非任务房间不给这套工具（它们没有图，也没有 #号可挂）
                      ...(this.deps.spec.type === 'task'
                          ? { units: { store: this.deps.store, taskId: this.id } }
                          : {}),
                  });
        this.toolsByBot.set(botId, tools);
        return tools;
    }

    /** 房间是否给成员配了工具（工具提示词据此决定说不说） */
    private get hasTools(): boolean {
        return this.deps.cwd !== undefined;
    }

    private toolsHint(): string {
        // 任务房间才有账本树。措辞分两段（2026-11-26 实测后改）：先给触发条件，再给节奏 ——
        // 只写「拆解用 unit_*」时模型的反应是「先 unit_list 看一眼，然后直接动手写代码」，
        // 账本始终是空的（用户实测：不明确说「把这件事拆成几步」它就不建）。
        const unitHint =
            this.deps.spec.type === 'task'
                ? '\n**先落账本再动手**：接到需求（或需求变了）时，先判断这件事是不是不止一步 —— ' +
                  '是就用 unit_add 把它拆成 2~5 条「能被验收的产出」（母项 → 子项，body 写验收口径），' +
                  '然后再开工；只有一步的小改（改个文案 / 跑个命令 / 看一眼状态）不要建。' +
                  '\n**每轮从账本里挑活**：上下文 units 节的 ready 就是现在能挑的（不必先 unit_list），' +
                  '挑 1~3 条做；开做标 doing、做完标 done，需求变了就让树跟着变（unit_update / unit_drop）。' +
                  '别把步骤只写在正文里，也别等做完再补树 —— 账本是给人看进度的唯一地方。'
                : '';
        const jobHint =
            this.deps.jobs === undefined
                ? ''
                : '\n后台长活（构建 / 测试 / 装依赖）用 bash 的 background，再用 job 查状态 / 取输出 / 停；' +
                  '起完就别轮询，结束时会插话叫醒你。';
        return (
            '可以用 read / write / edit 读写文件、用 bash 执行命令；' +
            `工作目录是 ${this.deps.cwd ?? '未设置'}，相对路径按它解析。` +
            '改文件优先用 edit（不要整份重写）。' +
            '留下决策 / 踩坑 / 评审结论时用 journal（一句话一条，按 kind 分类）。' +
            '需要用户做决定时**必须**调用 ask（选项 / 表单）：不要在正文里提问，' +
            '也不要在正文里列选项让用户挑——那些都会被大段输出淹没。' +
            'ask 不会停下来等：调用后当轮直接结束，用户作答会作为一条新消息回来。' +
            unitHint +
            jobHint
        );
    }

    private inRoom(bot: Bot): Bot {
        return { ...bot, persona: effectivePersonaOf(this.deps.spec, bot) };
    }

    /**
     * 路由（唯一实现）：
     *   显式 recipients = 开会；@all = 全员；@名字 = 命中者；没有 @ = 默认应答。
     */
    private route(text: string, participants: Bot[], explicit?: string[]): Bot[] {
        if (explicit !== undefined && explicit.length > 0) {
            return participants.filter((bot) => explicit.includes(bot.id));
        }
        const names = mentionsOf(text);
        if (names.includes('all')) return participants;
        const picked = participants.filter((bot) => names.includes(bot.name));
        if (picked.length > 0) return picked;
        const primary = this.primary();
        return primary === undefined ? [] : [primary];
    }

    /** 开一个新回合（唯一分配点） */
    private newTurn(): Turn {
        this.ensureInit();
        this.turnSeq += 1;
        const now = this.deps.now?.() ?? Date.now();
        this.currentTurn = { turn: this.turnSeq, turnId: `turn-${now.toString(36)}` };
        return this.currentTurn;
    }

    private nextOrder(): number {
        this.ensureInit();
        this.order += 1;
        return this.order;
    }

    private ensureInit(): void {
        if (this.initialized) return;
        this.initialized = true;
        for (const item of this.deps.store.itemsOf(this.id)) {
            this.order = Math.max(this.order, item.order ?? 0);
            this.turnSeq = Math.max(this.turnSeq, item.turn ?? 0);
        }
    }

    /**
     * 当前任务的需求账本树。工具与上下文走**同一个入口**：
     * 不然「agent 改完看到的」与「注入 system 的」会各算一份，迟早不一致。
     */
    private unitBoardOf(): UnitBoard {
        return unitBoard(this.deps.store.listUnits(this.id));
    }

    /** 某个成员的上下文会话；没有 cwd 的房间不建（与工具同判据） */
    private contextSessionOf(bot: Bot): ContextSession {
        const existing = this.contexts.get(bot.id);
        if (existing !== undefined) return existing;
        const cwd = this.deps.cwd;
        if (cwd === undefined) throw new Error('contextOf: 房间没有 cwd');
        const ctx = createRoomContext({
            spec: this.deps.spec,
            cwd,
            ...(this.deps.home === undefined ? {} : { home: this.deps.home }),
            ...(this.deps.deviceHome === undefined ? {} : { deviceHome: this.deps.deviceHome }),
            journal: () => this.deps.store.journalOf(this.id),
            ...(this.deps.spec.type === 'task' ? { units: () => this.unitBoardOf() } : {}),
            members: () => {
                const primary = this.primary();
                return this.members().map((bot) => ({
                    id: bot.id,
                    name: bot.name,
                    key: bot.name,
                    main: bot.id === primary?.id,
                }));
            },
        });
        ctx.open();
        this.contexts.set(bot.id, ctx);
        return ctx;
    }

    /** 取/建某个成员的 session；新建时回放公共日志（后加入的成员也能读到此前结论） */
    private sessionOf(bot: Bot): BotSession {
        let session = this.sessions.get(bot.id);
        if (session !== undefined) return session;

        const saved = this.deps.store.loadSession(this.id, bot.id);
        const context = this.deps.cwd === undefined ? null : this.contextSessionOf(bot);
        const systemContext = context?.system ?? '';
        session = new BotSession({
            bot,
            modelKey: bot.modelKey,
            allocateTurn: () => this.newTurn(),
            ...(saved === undefined ? {} : { seed: () => saved }),
            ...(this.deps.run === undefined ? {} : { run: this.deps.run }),
            ...(this.deps.compactor === undefined ? {} : { compactor: this.deps.compactor }),
            ...(this.deps.budget === undefined ? {} : { budget: this.deps.budget }),
            ...(this.deps.maxSteps === undefined ? {} : { maxSteps: this.deps.maxSteps }),
            ...(this.toolsFor(bot.id) === undefined ? {} : { tools: this.toolsFor(bot.id) }),
            ...(this.hasTools ? { toolsHint: this.toolsHint() } : {}),
            ...(systemContext === '' ? {} : { systemContext }),
            ...(context === null ? {} : { takeDelta: () => context.step().user, commitDelta: () => context.commit() }),
        });
        // 房间订阅 session 的输出：编号、落库、广播都在这一侧
        session.subscribe((event) => this.onSessionEvent(bot, event));

        // 回放水位：没有快照（后加入的成员）→ 全量回放；有快照但没水位（升级前的老库，
        // log_seq 是列默认值 0，不是真水位）→ 当作已全部 ingest 过，否则第一次启动就翻一倍。
        const from = saved === undefined ? 0 : (saved.logSeq ?? this.log.lastSeq);
        for (const entry of this.log.since(from)) session.ingest(entry);
        this.sessions.set(bot.id, session);
        return session;
    }

    /**
     * session 的唯一出口：序号与持久化都在这里补齐。
     */
    private onSessionEvent(bot: Bot, event: SessionEvent): void {
        switch (event.type) {
            case 'item': {
                const order = this.orderOf.get(event.item.id) ?? this.nextOrder();
                this.orderOf.set(event.item.id, order);
                const item: Item = { ...event.item, order };
                // 先记账再广播：ask 工具的执行体在同一个工具调用的**后面**才跑，
                // 那时 `tool-${callId}` → turnId 必须已经在这里了。
                //
                // 这张表**不恢复**（`orderOf` / `persisted` 同样）：它只需要活到本次调用结束，
                // 进程重启后不会有“拿一个上次的工具条目去问 turnId”的路径。
                // 代价是三张只增不减的 Map —— 长跑房间要清账时一起清。
                if (item.type === 'tool') this.turnOfTool.set(item.id, item.turnId);
                this.deps.emit({ kind: 'item', item });
                if ((item.status === 'done' || item.status === 'failed') && !this.persisted.has(item.id)) {
                    this.persisted.add(item.id);
                    this.deps.store.appendItem(this.id, item);
                }
                return;
            }
            case 'busy': {
                if (event.busy) this.speaking.add(bot.id);
                else this.speaking.delete(bot.id);
                this.syncRunning();
                return;
            }
            case 'delivery': {
                const delivery = this.deps.store.setDelivery({
                    roomId: this.id,
                    messageId: event.messageId,
                    botId: bot.id,
                    state: event.state,
                });
                this.deps.emit({ kind: 'delivery', delivery });
                return;
            }
            case 'turn.start':
                // 开始时刻先记下来再广播：消息头与「已用 Ns」要靠它，而快照（刷新）也读它。
                this.turnStarts.set(bot.id, { turnId: event.turn.turnId, startedAt: event.startedAt });
                this.deps.emit({
                    kind: 'turn.start',
                    botId: bot.id,
                    turnId: event.turn.turnId,
                    startedAt: event.startedAt,
                });
                // 这个成员开启了新的一轮：它已经读到新消息、可能已经重新提问 —— 上一张还没答的
                // 提问依赖的世界状态没了（寿命规则见 ask.ts 头部）。过期要点明、要通知它本人，
                // 否则它永远停在「我问了、等回答」（ask 不阻塞，没有 tool call 能回填）。
                this.gate.expireFor(bot.id, `${bot.name} 已开启新一轮`);
                // 落一行「这一轮开了、还没收尾」：进程若在这里被杀，磁盘上就留得住这个事实
                // （`completed` / `interrupted` 不产条目，靠 items 是看不出「开始过」的）。
                this.deps.store.openTurn(this.id, {
                    botId: bot.id,
                    turn: event.turn.turn,
                    turnId: event.turn.turnId,
                    at: this.deps.now?.() ?? Date.now(),
                });
                return;
            case 'progress':
                // 即时事实只广播、不落库：刷新后它本来也会被新的 tick 重新刷回来（turn 还在跑），
                // 而"卡过"这件事的持久说法在 notice 条目里（end-reason.ts 的 progressNotice）。
                this.deps.emit({
                    kind: 'progress',
                    botId: bot.id,
                    turnId: event.turnId,
                    awaiting: event.awaiting,
                    idleMs: event.idleMs,
                    alive: event.alive,
                    stage: event.stage,
                });
                return;
            case 'turn.end': {
                // 「这一轮是怎么停的」广播给客户端（消息页脚 / 结算行用它）。放在落库/发结论之前：
                // 页脚比快照早到一点没影响，但顺序上它属于这一轮自己的事实。
                //
                // 起止时刻与用量一起带：结算行要写「耗时 + 结束于 + tokens」，而这三个数
                // 只有运行侧知道（前端自己估会与消息头的开始时刻对不上）。
                const { result } = event;
                const turnCalls = result.endReason.toolCalls;
                this.deps.emit({
                    kind: 'turn.end',
                    botId: bot.id,
                    turnId: result.turnId,
                    reason: result.endReason,
                    ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
                    ...(result.endedAt === undefined ? {} : { endedAt: result.endedAt }),
                    ...(result.usage === undefined ? {} : { usage: result.usage }),
                    ...(turnCalls === undefined ? {} : { toolCalls: turnCalls }),
                });
                // 这一轮已经收了：开始时刻的使用者没了（留着只会在下一轮开始前被读到旧的）
                if (this.turnStarts.get(bot.id)?.turnId === result.turnId) this.turnStarts.delete(bot.id);
                this.persistSession(bot.id);
                // 快照落了才算收尾：销掉「开了没收尾」的标记再发结论
                this.deps.store.closeTurn(this.id, bot.id);
                // 这一轮带着「中断」事实却跑到收尾了 = 那条事实是重启时的误报（重启后按原 turn 号
                // 续跑，见 reportOpenTurns），而续跑完成不产条目 —— 不撤掉它就是这一轮的最后一条
                // 轮级事实，bot 会被永久显示成「中断」。真中断的轮根本走不到这里（进程已死）。
                // 靠 items_interrupted 部分索引，没误报的轮就是一次空查。
                this.deps.store.deleteInterruptedFacts(this.id, event.result.turnId, bot.id);
                this.publishConclusion(bot, event.result);
                return;
            }
            case 'compact.progress':
                // 手动压缩的进度：直接转手给客户端（UI 靠它做「摘要中…」的即时反馈）
                this.deps.emit({ kind: 'compact', compact: event.compact });
                return;
            case 'compact':
                this.persistSession(bot.id);
                this.deps.onCompact?.(bot, event.event);
                return;
            case 'error':
                this.deps.emit({ kind: 'error', message: event.message });
                return;
        }
    }

    /**
     * 结论进公共日志，并复制给其他 session —— 不唤醒任何人。
     * 唯一例外：结论里显式 @ 了某个 bot（单人），那是点名。
     */
    private publishConclusion(
        bot: Bot,
        result: { turn: number; turnId: string; text: string; failed: boolean; endReason: TurnEndReason },
    ): void {
        // 只有真正说完的一轮才算"这个 bot 的公开立场"：半句被截断的、失败的、未知停下的话
        // 发进公共日志就是在房间里传播错误信息（判据在 end-reason.ts `publishable`）。
        if (result.failed || result.text === '' || !publishable(result.endReason)) return;

        // 名字取**当前**的（deps.bots 实时读）：传进来的 bot 是 session 建好时的快照，
        // 角色改名后它会一直以旧名署名。
        const name = this.member(bot.id)?.name ?? bot.name;
        const entry = this.appendEntry({
            kind: 'conclusion',
            botId: bot.id,
            name,
            color: bot.color,
            text: result.text,
            turn: result.turn,
            turnId: result.turnId,
        });

        const mention = mentionsOf(result.text).find((value) => value !== 'all');
        const target =
            mention === undefined
                ? undefined
                : this.members().find((candidate) => candidate.name === mention && candidate.id !== bot.id);

        for (const [botId, session] of this.sessions) {
            if (botId === bot.id) continue;
            // 被点名的人走下面的 post（正文只进一次），这里跳过 —— 否则同一段结论读两遍
            if (botId === target?.id) continue;
            session.ingest(entry);
        }

        if (target === undefined) return;

        const now = this.deps.now?.() ?? Date.now();
        const notice: Item = {
            id: `n-${now.toString(36)}-${this.order + 1}`,
            seq: this.deps.store.seqOf(this.id) + 1,
            order: this.nextOrder(),
            turn: result.turn,
            turnId: result.turnId,
            at: now,
            status: 'done',
            type: 'notice',
            data: { text: `${name} 在结论里 @${target.name}，已唤起`, kind: 'mention' },
        };
        this.deps.emit({ kind: 'item', item: this.deps.store.appendItem(this.id, notice) });

        void this.sessionOf(target).post({
            messageId: notice.id,
            text: `[${name} 的结论] ${result.text}`,
            mode: 'next-turn',
            turn: { turn: result.turn, turnId: result.turnId },
        });
    }

    /**
     * 后台作业收口：宿主把 `JobDoneEvent` 按归属串路由回来，这里给起它的成员插一条 notice 并叫醒它。
     *
     * 不负责「告诉用户作业结束了」——UI 自己看账本；这里只解决模型的记忆：它起完活就去干别的了，
     * 不叫醒就永远不会去取结果。归属串对不上（已退出的成员）= 丢弃，但**要回报 false**：
     * 账本据此把这条 run 记成「结局无人接」（盘上 `done.json` 里 `notified: false`），
     * 否则它跑完了、谁也不知道，只剩一堆没人认领的产物。
     */
    notifyJobDone(owner: JobOwner, event: JobDoneEvent): boolean {
        const bot = this.members().find((candidate) => candidate.id === owner.botId);
        if (bot === undefined) return false;
        const turn = this.newTurn();
        const now = this.deps.now?.() ?? Date.now();
        const notice: Item = {
            id: `n-${now.toString(36)}-${this.order + 1}`,
            seq: this.deps.store.seqOf(this.id) + 1,
            order: this.nextOrder(),
            turn: turn.turn,
            turnId: turn.turnId,
            at: now,
            status: 'done',
            type: 'notice',
            // 结构化事实一并落库：`text` 是给模型读的人话（分隔线上读不出状态/退出码），
            // 界面拿这份画作业卡片（`JobNotice`，2026-11-23）
            data: { text: event.text, kind: 'job-done', job: jobNoticeOf(event.notify) },
        };
        this.deps.emit({ kind: 'item', item: this.deps.store.appendItem(this.id, notice) });
        void this.sessionOf(bot).post({
            messageId: notice.id,
            turn,
            mode: 'next-turn',
            text: `[后台作业结束] ${event.text}`,
        });
        return true;
    }
}
