// types.ts —— 实体对话的协议层：只有类型，没有实现。
//
// 依赖规则（硬）：禁止 import React / node / 任何 UI kit / 任何 runtime 包。
// 后端（entity-runtime / server）与前端（chat-core / surface）共用这里的定义，
// 保证「后端产出的事件」与「前端消费的事件」是同一个类型，不靠约定同步。

// ── 容器 / 参与者 ──────────────────────────────────────────────

/**
 * 房间里的一名成员：bot 身份在房间里的绑定。
 *
 * Bot 是全局身份（名字 / 颜色 / 归属），RoomMember 是它在这个房间里的那副面孔：
 * 可以覆盖模型与人格 —— 同一个 bot 在造价房间和实验房间里不是同一个人格。
 */
export interface RoomMember {
    botId: string;
    /** 本房间覆盖的模型；缺省用房间默认 */
    modelKey?: string;
    /** 本房间覆盖的人格；缺省用 bot 自己的 */
    persona?: string;
    /** 默认应答（每个房间至多一个；没有 @ 时只有它说话） */
    primary?: boolean;
}

/**
 * 会话容器（原 Entity）。type 开放：project / task / stock / 任意自定义；
 * 类型特有的字段进 data，容器本身只保留跨类型通用的部分。
 */
export interface Room {
    id: string;
    /** 开放字符串，不做枚举 */
    type: string;
    /**
     * 类型特有数据，**容器的名字也在这里**（2026-11-22 裁）：
     *   project → { name, dir }
     *   task    → { title, number, status, desc, body, dir, projectId? }
     *   stock   → { symbol }
     *
     * 为什么 Room 不再有 `name`：房间是**虚拟概念**，本身没有身份 —— 它的显示名
     * 来自具体容器（任务标题 / 项目名 / 助手 bot 名）。挂一个通用 `name` 等于把
     * 同一个名字存两份（容器一份、房间一份），还得随时对齐。谁的名字谁持有。
     */
    data: Record<string, unknown>;
    /** 成员：身份 + 本房间的覆盖 */
    members: RoomMember[];
    /** 房间默认模型（成员没覆盖时用它） */
    modelKey: string;
}

export interface Bot {
    id: string;
    name: string;
    color: string;
    persona: string;
    /** 归属容器（创建它的地方；bot 可以被多个 room 借用） */
    homeRoomId: string;
    /** bot 自己的目录（可选） */
    homeDir?: string;
    modelKey: string;
}

export type Author = {
    id: string;
    name: string;
    color: string;
    role: 'human' | 'bot' | 'system';
};

// ── 展示条目（UI 只消费这些）────────────────────────────────────

export type ItemStatus = 'pending' | 'streaming' | 'done' | 'failed';

interface ItemBase {
    id: string;
    /** 存储层单调序号（同一 room） */
    seq: number;
    /** 展示顺序（服务端首次出现时分配；跨 bot 也稳定） */
    order?: number;
    /** 会话内的轮次序号（发送时分配；老数据可能没有） */
    turn?: number;
    turnId: string;
    at: number;
    status: ItemStatus;
    author?: Author;
}

/**
 * `job-done` 通知的**结构化事实**（与 `text` 同一件事，只是不拍平）。
 *
 * 为什么要在条目上带一份：`text` 是一段给模型读的人话（命令 + 输出尾部），当分隔线糊在
 * 一行里既看不出状态也看不出退出码；而 `run` / `state` / `exitCode` / `tail` 本来就有，
 * 只是没进条目。UI 据此画作业卡片（2026-11-23）。
 */
export interface JobNotice {
    /** run id（`job status` / `job output` 的入参） */
    run: string;
    /** RunState：running / exited / killed / failed */
    state: string;
    exitCode?: number | null;
    signal?: string | null;
    durationMs?: number;
    command?: string;
    /** 输出尾部（已去过 ANSI 色码） */
    tail?: string;
    /** tail 之前被截掉的字节数 */
    truncatedBytes?: number;
}

/**
 * 一条 run 的**列表投影**（`diy2.jobs.list` 的回包项）：界面画「现在在跑什么」用的那一份。
 *
 * 为什么不直接发注册表的 `RunInfo`：那份是**账本内部形状**（`notified` / `awaitingGroup` /
 * `hadSurvivingGroup` / `dir` …），界面一个都不用；界面要的是「哪条在跑、跑了多久、什么命令、
 * 谁起的、日志在哪」。投影住协议里 ⇒ 服务端只挑一次，两个 surface 不再各猜一遍。
 */
export interface JobRunRow {
    id: string;
    /** RunState：running / exited / killed / failed */
    state: string;
    startedAt: number;
    endedAt?: number;
    /** 已跑时长（运行中 = 到现在；终态 = 收口时刻 − 起点） */
    durationMs: number;
    command: string;
    /** 人话标题（缺省 = 命令首行） */
    title?: string;
    cwd: string;
    logPath: string;
    pid?: number;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    /** 谁起的：`taskUri` 是 dsh 的实体地址（房间 / 任务），turnId 是那一轮 */
    origin?: { taskUri: string; turnId?: string };
}

export type Item =
    | (ItemBase & { type: 'chat'; data: { text: string } })
    | (ItemBase & { type: 'notice'; data: { text: string; kind: string; job?: JobNotice } })
    | (ItemBase & {
          type: 'tool';
          data: { name: string; args?: unknown; result?: unknown; state: 'running' | 'ok' | 'error' };
      })
    | (ItemBase & { type: 'error'; data: { message: string } });

// ── 投递（消息 → bot 的到达状态）────────────────────────────────

export type DeliveryState = 'queued' | 'delivering' | 'delivered' | 'failed' | 'skipped';

export interface Delivery {
    roomId: string;
    messageId: string;
    botId: string;
    state: DeliveryState;
    note?: string;
    updatedAt: number;
}

// ── 命令 / 事件（前后端唯一契约）────────────────────────────────

export type Command =
    | { kind: 'send'; text: string }
    /** 不传 botId = 停整个房间；传了只停那个成员 */
    | { kind: 'cancel'; botId?: string; keepQueue?: boolean };

// ── 向用户提问（模型需要人做决定时）────────────────────────────

export interface AskOption {
    value: string;
    label: string;
    description?: string;
}

export interface AskField {
    name: string;
    label: string;
    type: 'text' | 'textarea' | 'number';
    placeholder?: string;
    required?: boolean;
}

/**
 * 一批里的一个问题。
 *
 * 为什么一个提问能带多题：模型经常需要连着定几件相关的事（口径 / 拓扑 / 落地到哪步）。
 * 以前一次 ask 只能问一个，模型只能连调三次工具 ⇒ 界面上三张卡、用户点三次提交、
 * 模型收到三条独立的用户消息。现在一批一次问完、一次提交，用户一屏看全、能对比着答。
 * 这与 dsh（questions[]）、opencode（questions[] → Form fields）、assistant-ui
 * （display:'questions'）的批量契约一致。
 */
export interface AskQuestion {
    /** 批次内唯一：回答按它回传。缺省由闸门分配 q1 / q2 … */
    id: string;
    question: string;
    /** choice = 选项；form = 表单；text = 只有一个自由输入框 */
    kind: 'choice' | 'form' | 'text';
    options?: AskOption[];
    fields?: AskField[];
    /** 选项是否多选 */
    multiple?: boolean;
    /** 选项之外还允许自由输入（"其他：____"） */
    allowFreeform?: boolean;
    /** 这一问的补充说明（背景、影响） */
    note?: string;
    /**
     * 这题是否必须作答，缺省 true。
     *
     * 为什么要它：一批里常有「主决策 + 顺带确认」（比如「要不要顺手改文档」）——
     * 全都强制会逼着用户在明显无关的题上点一下，全都不强制又会让主决策漏答。
     * false 的题在界面上标「（可选）」、可以直接翻过去，提交时不拦。
     */
    required?: boolean;
}

/**
 * 一次待回答的提问 = 一批问题（至少 1 个），一次提交。
 * 为什么要走工具而不是让模型在正文里问：正文里的问题会被大段输出淹掉，
 * 用户看不到"现在需要你决定"；这里渲染成置顶的选项/表单。
 */
export interface AskRequest {
    askId: string;
    /** 这一批问题（至少 1 个）。顺序即界面顺序 */
    questions: AskQuestion[];
    /** 整批的背景说明（每题还有自己的 note） */
    note?: string;
    /** 触发它的工具调用：界面据此把卡片渲染在正文里那个工具行下面 */
    toolCallId?: string;
    /**
     * 提问的成员 id。回答据此投递；卡片找不到自己的工具行时也用它显示头像 ——
     * 否则一张滑出窗口的旧卡片既不知道谁问的，也看不出属于哪一轮。
     */
    owner?: string;
    /**
     * 提问发生在哪一轮。`(turnId, owner)` 就是那张卡片该挂进的那条回复的地址。
     *
     * 为什么必须盖在这里、不能由 UI 反推：卡片的归属靠工具行（`toolCallId`）定位，而那条
     * 工具行可能早滑出窗口了。没有 turnId 时 UI 只能造一张 `turnId: ''` 的独立卡片 ——
     * 它在数据上不属于任何一轮，既不参加"正在输入"的匹配，也不认领这一轮的页脚。
     */
    turnId?: string;
    at: number;
}

/**
 * 其中一题的回答：choice 用 values，form 用 fields，text 用 text。
 * `skipped` 与"没答"是两件事 —— 用户明确跳过时记 true，模型据此区分
 * 「他不想定」和「他漏了」（dsh 用 `{selected:[]}` 占位、shadcn 用 status:'skipped'
 * 表达同一件事，两家独立收敛）。
 */
export interface AskQuestionAnswer {
    /** 对应 AskQuestion.id */
    id: string;
    values?: string[];
    fields?: Record<string, string>;
    /** 自由输入（allowFreeform / kind='text'） */
    text?: string;
    /** 用户明确跳过了这一题 */
    skipped?: boolean;
}

/** 用户的回答：按题回传，一次提交整批 */
export interface AskAnswer {
    answers: AskQuestionAnswer[];
}

/**
 * 已经有结局的提问（被回答 / 被取消）。
 * 卡片不消失：留在时间线上把用户选过的项标出来，选项与答案的对应关系一眼可见。
 */
export interface AnsweredAsk {
    request: AskRequest;
    answer?: AskAnswer;
    cancelled?: boolean;
    /**
     * 过期（`cancelled` 的一种）：不是环境没了，而是**它依赖的状态翻篇了** ——
     * 提问者已经开了新一轮，或同一个人又提了一次问。界面上必须点明这件事
     *（「已过期：它已经继续工作了」），不能和其它失效混成一句「已失效」。
     */
    expired?: boolean;
    reason?: string;
    /** 收尾时刻（毫秒） */
    at: number;
}

/**
 * 一次压缩的可见进度。
 *
 * 为什么不挂在 turn 上：压缩确实是一次 LLM 调用（摘要），但它**不是 agent 的对话轮次** ——
 * 不进 transcript、不产生公开结论、别的 bot 也读不到。可它又是唯一一个「点了要等好几秒」
 * 的操作，所以它是**房间级事件**（和 `running` 同级）：带 compactId，能取消、能去重、
 * 状态从 `running` 走到终态。UI 靠它做「摘要中…」的就地反馈，不靠 RPC 的返回值。
 */
export interface CompactionProgress {
    compactId: string;
    botId: string;
    botName?: string;
    state: 'running' | 'done' | 'failed' | 'cancelled';
    startedAt: number;
    /** 终态才有（运行中让界面自己跑秒表） */
    durationMs?: number;
    budget: { keepLast: number; maxChars: number };
    /** 压缩前规模：start 就带上，界面立刻能显示「要压多少」 */
    before: { entries: number; chars: number };
    /** 终态才有；缺省 = 这次没压（没有可压的内容） */
    after?: { entries: number; chars: number };
    folded?: number;
    dropped?: number;
    /** 本次是否新生成摘要（沿用旧摘要 / 失败都是 false） */
    summarized?: boolean;
    summary?: string;
    /** 摘要没成的原因（压缩本身仍生效）；`failed` 才是整次压缩失败 */
    summaryError?: string;
    /** state='failed' 的失败原因 */
    error?: string;
    /** true = 用户手点的；false / 缺省 = 自动触发 */
    manual?: boolean;
}

/** 传输层回推给 UI 的事件流（目前是 SSE，将来可能是 diy-rpc 订阅） */
export type StreamEvent =
    | { kind: 'item'; item: Item }
    | { kind: 'delivery'; delivery: Delivery }
    | { kind: 'error'; message: string }
    /** 模型在等用户回答 */
    | { kind: 'ask'; request: AskRequest }
    /** 已回答（或被取消 / 超时 / 过期） */
    | {
          kind: 'ask.answered';
          askId: string;
          answer?: AskAnswer;
          cancelled?: boolean;
          expired?: boolean;
          reason?: string;
      }
    /** 当前正在说话的成员（空数组 = 都停了）。谁是"说话中"由房间说了算，不由 UI 猜 */
    | { kind: 'running'; botIds: string[] }
    /**
     * 一次压缩的进度（`running` → `done` / `failed` / `cancelled`）。
     *
     * 手动压缩的反馈就靠它：点下去立刻收到 `running`，结束收到终态 —— 不走轮询、
     * 也不等那条要挂好几秒的 RPC 返回（它只做兜底）。
     */
    | { kind: 'compact'; compact: CompactionProgress }
    /**
     * 某一轮结束了，以及**为什么**（`completed` / `max-tokens` / `interrupted` …）。
     *
     * 这是**事实广播**，不是错误：页面用它显示消息页脚的结局（"这一轮是怎么停的"），
     * 而"该做什么"由时间线上的 notice / error 条目说。两者分工，不要合并 ——
     * 页脚是稳定的一行，条目是可能有多条的解释。
     *
     * 刷新后不带回来（它不在快照里）：ephemeral 的结局靠条目持久，`completed`
     * 本来也不需要页脚。
     */
    | { kind: 'turn.end'; botId: string; turnId: string; reason: TurnEndReason }
    /** 常驻流刚连上（含重连成功）：客户端据此补拉快照，填平断线期间丢的事件 */
    | { kind: 'ready' }
    | { kind: 'done' };

/** 房间自己会发的事件（`done` 属于传输层，不属于领域） */
export type RoomEvent = Exclude<StreamEvent, { kind: 'done' }>;

export interface Snapshot {
    items: Item[];
    deliveries: Delivery[];
    /** 还在等用户回答的提问（刷新页面后卡片要能恢复） */
    asks?: AskRequest[];
    /** 已经有结局的提问（最近的若干条）：刷新后卡片仍在，显示已选状态 */
    answeredAsks?: AnsweredAsk[];
    /**
     * **服务端事实**：这一刻还在跑的成员（= 房间的 `running` 集合，与运行中广播同源）。
     *
     * 为什么必须进快照：客户端原先靠「快照里有没有 `status:'streaming'` 的条目」倒推，
     * 而一轮卡在**等上游**（还没吐第一个字）时一个流式条目都没有 —— 刷新之后既没有
     * 「正在说话…」也没有停止按钮，用户看不出它在跑、更停不掉（2026-11-23 实测）。
     *
     * 缺省 `undefined` = 老服务端：客户端退回旧的倒推。空数组是**有意义**的（确实没人跑）。
     */
    speaking?: string[];
}

/** capabilities 决定 UI 显示哪些按钮（不要写 surfaceId 分支） */
export interface Capabilities {
    /** 运行中还能发消息（在下一个 step 边界插入） */
    nextStep: boolean;
    approval: boolean;
    multiAgent: boolean;
    replay: boolean;
}

export const DEFAULT_CAPABILITIES: Capabilities = {
    nextStep: true,
    approval: false,
    multiAgent: true,
    replay: false,
};

// ── 运行时事件（模型 → 投影层）───────────────────────────────────

/**
 * 一轮为什么结束。**只说事实，不猜原因**（判据在 runtime，文案在 UI）。
 *
 * 存在的理由：没有它的时候，「被输出上限截断」和「正常说完」在数据里长得一模一样 ——
 * 用户看到的是「执行一半就停下、UI 却显示完成」。老路径（`##288`/`##429`）有这套词汇，
 * entity-runtime 迁移时丢了，这里补回来。
 */
export interface TurnEndReason {
    /**
     * `unknown` = 我们**不知道**为什么停（没收到收尾信号 / 上游给了不认识的收尾原因 /
     * 空产出就停）。它按错误处理：不发结论，时间线上一条错误。
     * 「没有证据」不等于「正常完成」（未知按错误处理，见 end-reason.ts）。
     */
    type:
        | 'completed'
        | 'max-tokens'
        | 'max-steps'
        | 'filtered'
        | 'tool-mismatch'
        | 'interrupted'
        | 'unknown'
        | 'error';
    /** 上游的 `finishReason` 原文（`stop` / `length` / `tool-calls` / `error` / …） */
    finishReason?: string;
    /** 细因（机器读，`type` 只到类别）：`no-finish` / `empty-output` / `finish=xxx` */
    note?: string;
    /** 本轮实际发出去的输出上限（对账用：到底哪一层截的） */
    maxOutputTokens?: number;
    /** 本轮的步数上限（`max-steps` 撞的是这个数；对账用） */
    maxSteps?: number;
    /** 本轮的 step 数（多轮工具循环时用于区分「说完了」和「刚到一半」） */
    steps?: number;
}

/** 模型运行的原始事件（seq 单调；投影成 Item 后 UI 才消费） */
export type AgentEvent =
    | { seq: number; type: 'run.started'; turnId: string; messageId: string }
    | { seq: number; type: 'text.delta'; messageId: string; delta: string }
    | { seq: number; type: 'reasoning.delta'; messageId: string; delta: string }
    | { seq: number; type: 'tool.started'; turnId: string; toolCallId: string; name: string; args?: unknown }
    | {
          seq: number;
          type: 'tool.completed';
          turnId: string;
          toolCallId: string;
          name: string;
          result?: unknown;
          error?: string;
      }
    | { seq: number; type: 'message.completed'; messageId: string }
    /** 流正常结束时的收尾事实（截断/工具悬空都从这里看出来；`run.failed` 则不给它） */
    | {
          seq: number;
          type: 'run.finished';
          turnId: string;
          /** 上游 `finishReason`：`stop` / `length` / `content-filter` / `tool-calls` / `error` … */
          finishReason: string;
          steps: number;
          maxOutputTokens: number;
          /** 本轮的步数上限（`max-steps` 判据：撞到它且上游还想继续才算掐停） */
          maxSteps?: number;
      }
    | { seq: number; type: 'run.completed'; turnId: string }
    | { seq: number; type: 'run.failed'; turnId: string; message: string };

// ── 模型目录的视图（`diy2.models.list` 的回包）────────────────────
//
// 为什么放在 protocol：服务端（entity-runtime 从 model.yaml 生成）与客户端（选模型器 /
// 新建房间的缺省值）必须拿同一个形状 —— 各自定义一遍就会漂移，而这次的问题正是
// 「界面自带一份表」与真配置对不上。

/** 价目（$/1M tokens，与 `@diy-agent/model-catalog` 同口径） */
export interface ModelCostView {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/** 目录里的一个模型 */
export interface ModelCatalogModel {
    id: string;
    /** 人可读名（目录里没有就回落到 id，不编造） */
    name: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    cost?: ModelCostView;
}

/** 一个 provider 的视图（**永不含 key 值**：账号只有名字与「填没填」） */
export interface ModelCatalogProvider {
    id: string;
    /** 给人看的名字：目录里没有名字字段 ⇒ 就用 id（不编造） */
    name: string;
    /** 上游基址（不含 `/chat/completions`） */
    api: string;
    npm?: string;
    accounts: Array<{ name: string; configured: boolean }>;
    models: ModelCatalogModel[];
}

/** `diy2.models.list` 的回包 */
export interface ModelCatalogSnapshot {
    providers: ModelCatalogProvider[];
    /** `model.yaml` 的 `defaultModel`；缺省 = 服务端用兜底常量 */
    defaultModelKey?: string;
}

// ── actor 收件箱（后端内部，但类型放这里以便将来跨进程）─────────

export type InboxMode = 'next-step' | 'next-turn';

export interface InboxItem {
    id: string;
    actor: string;
    seq: number;
    mode: InboxMode;
    kind: 'chat' | 'notice';
    payload: Record<string, unknown>;
    status: 'pending' | 'claimed';
    createdAt: number;
    claimedAt?: number;
}
