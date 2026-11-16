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
    name: string;
    /** 类型特有数据：project/task → { dir, projectId? }；stock → { symbol } */
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

export type Item =
    | (ItemBase & { type: 'chat'; data: { text: string } })
    | (ItemBase & { type: 'notice'; data: { text: string; kind: string } })
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
 * 一次待回答的提问。
 * 为什么要走工具而不是让模型在正文里问：正文里的问题会被大段输出淹掉，
 * 用户看不到"现在需要你决定"；这里渲染成置顶的选项/表单。
 */
export interface AskRequest {
    askId: string;
    question: string;
    /** choice = 选项；form = 表单；text = 只有一个自由输入框 */
    kind: 'choice' | 'form' | 'text';
    options?: AskOption[];
    fields?: AskField[];
    /** 选项是否多选 */
    multiple?: boolean;
    /** 选项之外还允许自由输入（"其他：____"） */
    allowFreeform?: boolean;
    /** 补充说明（背景、影响） */
    note?: string;
    /** 触发它的工具调用：界面据此把卡片渲染在正文里那个工具行下面 */
    toolCallId?: string;
    at: number;
}

/** 用户的回答：choice 用 values，form 用 fields */
export interface AskAnswer {
    values?: string[];
    fields?: Record<string, string>;
    /** 自由输入（allowFreeform / kind='text'） */
    text?: string;
}

/**
 * 已经有结局的提问（被回答 / 被取消）。
 * 卡片不消失：留在时间线上把用户选过的项标出来，选项与答案的对应关系一眼可见。
 */
export interface AnsweredAsk {
    request: AskRequest;
    answer?: AskAnswer;
    cancelled?: boolean;
    reason?: string;
    /** 收尾时刻（毫秒） */
    at: number;
}

/** 传输层回推给 UI 的事件流（目前是 SSE，将来可能是 diy-rpc 订阅） */
export type StreamEvent =
    | { kind: 'item'; item: Item }
    | { kind: 'delivery'; delivery: Delivery }
    | { kind: 'error'; message: string }
    /** 模型在等用户回答 */
    | { kind: 'ask'; request: AskRequest }
    /** 已回答（或被取消 / 超时） */
    | { kind: 'ask.answered'; askId: string; answer?: AskAnswer; cancelled?: boolean; reason?: string }
    /** 当前正在说话的成员（空数组 = 都停了）。谁是"说话中"由房间说了算，不由 UI 猜 */
    | { kind: 'running'; botIds: string[] }
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
    type: 'completed' | 'max-tokens' | 'filtered' | 'tool-mismatch' | 'interrupted' | 'unknown' | 'error';
    /** 上游的 `finishReason` 原文（`stop` / `length` / `tool-calls` / `error` / …） */
    finishReason?: string;
    /** 细因（机器读，`type` 只到类别）：`no-finish` / `empty-output` / `finish=xxx` */
    note?: string;
    /** 本轮实际发出去的输出上限（对账用：到底哪一层截的） */
    maxOutputTokens?: number;
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
      }
    | { seq: number; type: 'run.completed'; turnId: string }
    | { seq: number; type: 'run.failed'; turnId: string; message: string };

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
