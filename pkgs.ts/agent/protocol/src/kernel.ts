// kernel.ts —— actor（实体容器）内的命令 / 事件契约草案。
//
// 两个**不同**的概念，之前用 authorId 混在一起，是设计错误，这里分开：
//
//   1) 来源 Source —— 这条消息是谁说的（human / bot / system / job）。纯元数据，没有执行语义。
//   2) 会话 BotSession —— 一个 bot 在某个 room 里的原生单线对话（turn/step/tool）。
//      system/job 不是对话参与者，不产生 step，只能往 inbox 投事实。
//
// 所以层级是「容器 → 每 bot 一个原生 session」，不是「一个 session + authorId 模拟来源」：
//
//   RoomActor（容器：参与者 / 路由 / inbox / 投递 / 时间线）
//     ├── botSession(bot A)  ← 原生 LLM 单线会话：自己的 turn → step → message/tool，自己的 seq
//     ├── botSession(bot B)  ← 同上，各自独立编号，不共享 step
//     └── orderSeq             ← 容器级单调序号，**只用于跨会话展示/重放排序**
//
// 命名纪律：
//   · session 内的 seq / step 归 session 自己（原生结构，不改）
//   · 跨并行会话需要共享序号时用 `orderSeq`（不叫 seq、不叫 step）
//
// 语义（写死在契约里，实现不得违反）：
//   1. 普通用户消息默认 delivery='next-step'
//   2. next-step 只在 **step 边界** 被 claim：工具批次结果落盘之后、下调模型之前
//   3. 被 claim 的消息作为**独立 user 消息**追加，不合并进工具结果、不合并进上一条
//   4. next-step 到达时若 turn 本要结束 → 多跑一步（不丢消息）
//   5. cancel 默认清空 inbox；keepInbox=true 时残留项降级为 next-turn
//   6. 失败后残留的 next-step 不自动唤醒，由外部再次 post 触发

import type { DeliveryState, InboxMode } from './types';

// ── 来源（元数据，不拥有 step）──────────────────────────────────

export type Source =
    | { type: 'human'; id: string; name: string }
    | { type: 'bot'; id: string; name: string }
    | { type: 'system'; id: string; name: string }
    | { type: 'job'; id: string; name: string };

// ── 命令 ──────────────────────────────────────────────────────

export type SessionCommand =
    /** 往这个会话投一条用户消息；delivery 决定它在哪个边界生效（默认 next-step） */
    | { type: 'say'; data: { text: string; delivery?: InboxMode } }
    /** 停止当前 turn；默认清空 inbox，keepInbox 时残留项降级为 next-turn */
    | { type: 'cancel'; data?: { keepInbox?: boolean } }
    | { type: 'compact'; data: { keep: { type: 'last-turns'; count: number } } };

export interface Receipt {
    commandId: string;
    accepted: boolean;
    /** 该 session 内分配到的 seq（不是 orderSeq） */
    seq: number;
    error?: { code: string; message: string };
}

// ── 会话事件（bot 在 room 里的原生会话，seq 归自己）──────────────────

export type StreamKind = 'turn' | 'step' | 'message' | 'tool';

interface SessionEventBase {
    /** session 内单调 */
    seq: number;
    at: number;
    /** = botId */
    botId: string;
    stream: StreamKind;
    turnId?: string;
    step?: number;
    messageId?: string;
    toolCallId?: string;
}

export type SessionEvent =
    | (SessionEventBase & {
          stream: 'turn';
          type: 'turn.started';
          data: { turnId: string; trigger: { type: 'say'; delivery: InboxMode } | { type: 'activation' } };
      })
    | (SessionEventBase & {
          stream: 'turn';
          type: 'turn.completed';
          data: { turnId: string; reason: 'done' | 'cancelled' | 'failed'; extraSteps: number };
      })
    // step = 调一次模型；工具批次在其内部
    | (SessionEventBase & { stream: 'step'; type: 'step.started'; data: { turnId: string; step: number; planHash: string } })
    | (SessionEventBase & {
          stream: 'step';
          type: 'step.completed';
          data: { turnId: string; step: number; next: 'continue' | 'end' };
      })
    // 消息：懒创建，只有真实内容才 start
    | (SessionEventBase & {
          stream: 'message';
          type: 'message.started';
          data: { messageId: string; turnId: string; step: number; source: Source; role: 'user' | 'assistant' };
      })
    | (SessionEventBase & { stream: 'message'; type: 'message.delta'; data: { messageId: string; delta: string } })
    | (SessionEventBase & {
          stream: 'message';
          type: 'message.completed';
          data: { messageId: string; text: string; usage?: { input: number; output: number } };
      })
    | (SessionEventBase & {
          stream: 'tool';
          type: 'tool.started';
          data: { toolCallId: string; turnId: string; step: number; name: string; args?: unknown };
      })
    | (SessionEventBase & {
          stream: 'tool';
          type: 'tool.completed';
          data: { toolCallId: string; turnId: string; step: number; name: string; result?: unknown; error?: string };
      })
    | (SessionEventBase & { stream: 'turn' | 'step' | 'message' | 'tool'; type: 'failed'; data: { message: string; where: StreamKind } });

// ── 容器事件（room 级：路由 / 队列 / 投递 / 时间线）─────────────────

interface RoomEventBase {
    /** 容器级单调序号：只用于跨会话展示与重放排序，不参与 agent 语义 */
    orderSeq: number;
    at: number;
    roomId: string;
}

export type RoomEvent =
    /** 用户/系统发出的一条消息被容器接受（此时还没决定投给谁） */
    | (RoomEventBase & { type: 'message.accepted'; data: { messageId: string; source: Source; text: string } })
    /** 这条消息投给了哪个 bot、到没到 */
    | (RoomEventBase & {
          type: 'delivery.changed';
          data: { messageId: string; botId: string; state: DeliveryState; note?: string };
      })
    /** 进某个会话的 inbox（system/job 也走这里，但它们没有自己的 session） */
    | (RoomEventBase & {
          type: 'inbox.enqueued';
          data: { botId: string; itemId: string; delivery: InboxMode; messageId: string; source: Source };
      })
    | (RoomEventBase & {
          type: 'inbox.claimed';
          data: { botId: string; itemId: string; delivery: InboxMode; at: 'step-boundary'; turnId: string; step: number };
      })
    | (RoomEventBase & {
          type: 'inbox.dropped';
          data: { botId: string; itemId: string; reason: 'cancelled' | 'superseded' };
      })
    /** 原生会话事件的转发：session 自己的 seq 在 data.event 里，容器只加 orderSeq */
    | (RoomEventBase & { type: 'conversation.event'; data: { botId: string; event: SessionEvent } });

// ── 订阅 / 快照 ────────────────────────────────────────────────

export interface RoomFilter {
    /** 只要这些 bot 的会话（缺省 = 全部，含尚未激活的） */
    botIds?: string[];
    /** 只要容器事件 / / 只要某类 */
    types?: RoomEvent['type'][];
    afterOrderSeq?: number;
}

export interface RoomSnapshot {
    /** 当前在跑的会话 */
    running: Array<{ botId: string; turnId: string; step: number }>;
    /** 已入队未消费（按 orderSeq） */
    inbox: Array<{ botId: string; itemId: string; delivery: InboxMode; messageId: string; source: Source }>;
    lastOrderSeq: number;
}

export interface SessionFilter {
    afterSeq?: number;
    types?: SessionEvent['type'][];
}

/** bot 在 room 里的原生会话（turn/step/message/tool 归自己；sessionId = roomId::botId） */
export interface BotSession {
    readonly botId: string;
    post(command: SessionCommand): Promise<Receipt>;
    snapshot(): Promise<{ turn: { turnId: string; step: number } | null; lastSeq: number }>;
    subscribe(filter?: SessionFilter): AsyncIterable<SessionEvent>;
}

/** 容器：参与者 / 路由 / inbox / 投递 / 时间线（无 mode：收件人是谁就是谁） */
export interface RoomActor {
    readonly roomId: string;
    /**
     * 投一条消息（默认 next-step）。
     * recipients 缺省时按 @ 规则解析；显式给出即为「开会」——多人参与、成本可见。
     */
    say(input: { text: string; source: Source; delivery?: InboxMode; recipients?: string[] }): Promise<Receipt>;
    cancel(input?: { keepInbox?: boolean }): Promise<Receipt>;
    snapshot(): Promise<RoomSnapshot>;
    subscribe(filter?: RoomFilter): AsyncIterable<RoomEvent>;
    /** 取某个 bot 的原生会话（没有则为 undefined） */
    session(botId: string): BotSession | undefined;
}
