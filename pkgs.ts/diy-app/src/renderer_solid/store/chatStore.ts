/**
 * chatStore — 完整聊天状态管理
 *
 * 处理 ACP 协议的所有事件类型，维护结构化消息列表。
 * 与 agentStore 的区别：agentStore 只存纯文本，chatStore 存完整事件结构。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";

// ═══════════════════════════════════════
// 消息类型定义
// ═══════════════════════════════════════

/** 文本内容块 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 图片内容块 */
export interface ImageBlock {
  type: "image";
  uri?: string;
  data?: string;
  mimeType?: string;
}

/** 资源链接 */
export interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  description?: string;
}

/** 内容块联合类型 */
export type ContentBlock = TextBlock | ImageBlock | ResourceLinkBlock | { type: string; [k: string]: unknown };

/** 工具调用状态 */
export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** 工具调用 */
export interface ToolCall {
  id: string;
  name?: string;
  title?: string;
  kind?: string;
  status: ToolCallStatus;
  content?: ContentBlock[];
  rawInput?: unknown;
  rawOutput?: unknown;
  /** 内容增量缓冲 */
  contentBuf: string;
}

/** 终端输出 */
export interface TerminalInfo {
  id: string;
  command?: string;
  cwd?: string;
  outputBuf: string;
  exitStatus?: { code: number };
}

/** 消息类型 */
export type ChatMessageType =
  | "user"
  | "assistant"
  | "thought"
  | "tool-call"
  | "terminal"
  | "compaction"
  | "system";

/** 单条消息 */
export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  /** 文本内容（markdown） */
  content: string;
  /** 关联的工具调用（assistant 消息可能关联多个） */
  toolCalls?: ToolCall[];
  /** 关联的终端信息 */
  terminals?: TerminalInfo[];
  /** 思考过程（assistant 消息可选） */
  thought?: string;
  /** 时间戳 */
  time: number;
  /** 是否正在流式生成 */
  streaming?: boolean;
  /** token 用量 */
  usage?: { input?: number; output?: number; total?: number };
  /**
   * 用户消息的队列状态（DeepSeek Web 式排队显示）：
   * queued=已上屏在排队 / running=正在执行 / completed=完成 /
   * cancelled=用户取消。undefined 视为 completed。
   * agent 消息不用此字段（streaming 已表达运行态）。
   */
  queueStatus?: "queued" | "running" | "completed" | "cancelled";
}

// ═══════════════════════════════════════
// Store
// ═══════════════════════════════════════

const [messages, setMessages] = createSignal<ChatMessage[]>([]);
const [sending, setSending] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
const [activeModel, setActiveModel] = createSignal<string>("");
const [sessionId, setSessionId] = createSignal<string | null>(null);

// ═══════════════════════════════════════
// Actor 模型：命令邮箱 + 状态投影
//
// UI 永远不直接改状态，只 post 命令到 mailbox；actor loop 是
// 「状态转换」的唯一权威（写走消息）。需要结果时 post 返回
// Promise（ask 模式：loop 处理完该条命令后 resolve）。
// UI 读状态一律走投影信号（messages/pendingList/sending/...）。
// ═══════════════════════════════════════

/** 命令类型：UI 能做的所有事 */
type ChatCmd =
  | { type: "send"; taskUri: string; text: string; reply?: (ok: boolean) => void }
  | { type: "cancel-message"; msgId: string; reply?: (ok: boolean) => void }
  | { type: "stop"; reply?: (ok: boolean) => void }           // 取消当前轮，队列继续
  | { type: "stop-all"; reply?: (ok: boolean) => void }       // 取消当前轮 + 清空队列
  | { type: "clear"; reply?: (ok: boolean) => void }          // 清空界面（含取消 in-flight）
  | { type: "close-session"; taskUri: string; reply?: (ok: boolean) => void };

/** 命令邮箱（FIFO） */
const mailbox: ChatCmd[] = [];
/** 空邮箱等待者（nextCmd 挂起时注册，post 时唤醒） */
let mailboxWaiters: (() => void)[] = [];

/** 投递命令（ask 模式：返回该命令处理结果） */
function post(cmd: ChatCmd): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    cmd.reply = resolve;
    mailbox.push(cmd);
    // 唤醒等在 nextCmd 上的 loop（若 loop 此刻正处理长命令，等它下次取）
    const w = mailboxWaiters;
    mailboxWaiters = [];
    w.forEach((fn) => fn());
  });
}

/** actor loop 取下一条命令（空邮箱时挂起等待） */
async function nextCmd(): Promise<ChatCmd> {
  for (;;) {
    const cmd = mailbox.shift();
    if (cmd) return cmd;
    await new Promise<void>((resolve) => mailboxWaiters.push(resolve));
  }
}

// ─── 队列（loop/worker 共享，JS 单线程下天然串行） ───
const [pendingCount, setPendingCount] = createSignal(0);
/** 待发送任务（每条 = 一条已上屏的用户消息；执行中的不算在内） */
const pendingMessages: { id: string; text: string; taskUri: string }[] = [];
/** 排队列表投影（UI 只读） */
const [pendingList, setPendingList] = createSignal<{ id: string; text: string }[]>([]);
/** 当前执行轮次（供 cancel 定位；loop 专用私有状态） */
let runningTask: { taskUri: string; msgId: string; text: string } | null = null;
/** 本轮是否被 cancel 请求过（决定最终状态是 completed 还是 cancelled） */
let activeCancelled = false;
/** stop-all/clear 后置位：worker 消费完当前轮即停，不接续队列 */
let workerStop = false;
/** worker 是否在跑（单实例防双 worker） */
let workerActive = false;

/** 广播排队投影 + 计数 */
function broadcastPending() {
  setPendingCount(pendingMessages.length);
  setPendingList(pendingMessages.map(({ id, text }) => ({ id, text })));
}

/** 当前轮次的中止信号（loop 写入，worker 的事件循环检查：
 *  被 stop/clear 中止后不再处理后续事件，避免「清空后又冒消息」） */
let currentTurnAbort: { aborted: boolean } = { aborted: false };

/**
 * worker：串行消费队列，执行当前轮（for-await 事件流）。
 * 由 loop 的 send 命令启动；stop-all/clear 置 workerStop + 发
 * session/cancel 让当前流自然结束，worker 随后清空队列退出。
 */
async function workerLoop() {
  workerActive = true;
  try {
    while (pendingMessages.length > 0) {
      if (workerStop) {
        // 停止请求：剩余排队全部标记 cancelled
        for (const t of pendingMessages) setMessageQueueStatus(t.id, "cancelled");
        pendingMessages.length = 0;
        broadcastPending();
        break;
      }
      // 取出即将执行的任务（立即出队）：执行中的消息不属于
      // 「排队」——pendingList/pendingCount 只统计真正等待的，
      // 执行中由 runningTask 单独持有（UI 显示「生成中…」而非排队）。
      const task = pendingMessages.shift()!;
      runningTask = { taskUri: task.taskUri, msgId: task.id, text: task.text };
      activeCancelled = false;
      currentTurnAbort = { aborted: false };
      setMessageQueueStatus(task.id, "running");
      setSending(true);
      broadcastPending();
      // 执行当前轮；流被 session/cancel 打断后自然结束（abort ≠ cancelled）
      await runOne(task.taskUri, task.text, task.id, currentTurnAbort);
      // 确认语义：最终状态由 loop 侧决定，worker 只做确认标记
      setMessageQueueStatus(task.id, activeCancelled ? "cancelled" : "completed");
      broadcastPending();
      runningTask = null;
    }
  } finally {
    workerActive = false;
    workerStop = false;
    runningTask = null;
    setSending(false);
  }
}

/** loop 发现无 worker 且队列非空时启动消费 */
function maybeStartWorker() {
  if (workerActive) return;
  if (pendingMessages.length === 0) return;
  void workerLoop();
}

/** 发 session/cancel 让 agent 停当前轮（fire-and-forget，流自然结束） */
function cancelTurn(taskUri: string) {
  void diyService.diy.agent.cancel({ taskUri }).catch(() => { /* 会话可能已关闭 */ });
}

/** actor loop：命令状态转换的唯一权威 */
async function actorLoop() {
  for (;;) {
    const cmd = await nextCmd();
    switch (cmd.type) {
      case "send": {
        const taskUri = cmd.taskUri;
        const text = cmd.text.trim();
        if (!text || !taskUri) {
          cmd.reply?.(false);
          break;
        }
        // 立即上屏用户消息（DeepSeek Web 式可见排队）
        const userMsgId = `user-local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setMessages((prev) => [
          ...prev,
          { id: userMsgId, type: "user", content: text, time: Date.now(), streaming: false, queueStatus: "queued" },
        ]);
        pendingMessages.push({ id: userMsgId, text, taskUri });
        broadcastPending();
        maybeStartWorker();
        cmd.reply?.(true);
        break;
      }
      case "cancel-message": {
        const idx = pendingMessages.findIndex((p) => p.id === cmd.msgId);
        if (idx >= 0) {
          // 排队中：摘除 + 标记 cancelled
          const [t] = pendingMessages.splice(idx, 1);
          broadcastPending();
          setMessageQueueStatus(t.id, "cancelled");
          cmd.reply?.(true);
        } else if (runningTask?.msgId === cmd.msgId) {
          // 正在执行：中止事件处理 + 发 session/cancel 打断本轮
          activeCancelled = true;
          currentTurnAbort.aborted = true;
          cancelTurn(runningTask.taskUri);
          cmd.reply?.(true);
        } else {
          cmd.reply?.(false);
        }
        break;
      }
      case "stop": {
        // 取消当前轮；排队中的下一条自动接续（steer 语义）
        if (runningTask) {
          activeCancelled = true;
          currentTurnAbort.aborted = true;
          cancelTurn(runningTask.taskUri);
          cmd.reply?.(true);
        } else {
          cmd.reply?.(false);
        }
        break;
      }
      case "stop-all": {
        // 取消当前轮 + 清空队列（剩余排队标记 cancelled）
        for (const t of pendingMessages) setMessageQueueStatus(t.id, "cancelled");
        pendingMessages.length = 0;
        broadcastPending();
        workerStop = true;
        if (runningTask) {
          activeCancelled = true;
          currentTurnAbort.aborted = true;
          cancelTurn(runningTask.taskUri);
        }
        cmd.reply?.(true);
        break;
      }
      case "clear": {
        // 清空界面：先中止 in-flight 事件流，再清状态（防清空后冒消息）
        for (const t of pendingMessages) setMessageQueueStatus(t.id, "cancelled");
        pendingMessages.length = 0;
        broadcastPending();
        workerStop = true;
        if (runningTask) {
          activeCancelled = true;
          currentTurnAbort.aborted = true;
          cancelTurn(runningTask.taskUri);
        }
        setMessages([]);
        setError(null);
        setSessionId(null);
        cmd.reply?.(true);
        break;
      }
      case "close-session": {
        // 同 clear + 通知 main 关闭会话
        for (const t of pendingMessages) setMessageQueueStatus(t.id, "cancelled");
        pendingMessages.length = 0;
        broadcastPending();
        workerStop = true;
        if (runningTask) {
          activeCancelled = true;
          currentTurnAbort.aborted = true;
          cancelTurn(runningTask.taskUri);
        }
        setMessages([]);
        setError(null);
        setSessionId(null);
        setActiveModel("");
        try {
          await diyService.diy.agent.closeSession({ taskUri: cmd.taskUri });
          cmd.reply?.(true);
        } catch {
          cmd.reply?.(false);
        }
        break;
      }
    }
  }
}

/** 启动 actor loop（模块加载即开始，常驻） */
void actorLoop();

/** 按 id 查找消息索引 */
function findIndex(id: string): number {
  return messages().findIndex((m) => m.id === id);
}

/** 确保消息存在，不存在则创建 */
function ensureMessage(id: string, type: ChatMessageType, time?: number): ChatMessage {
  let idx = findIndex(id);
  if (idx >= 0) return messages()[idx];
  const msg: ChatMessage = { id, type, content: "", time: time ?? Date.now(), streaming: true };
  setMessages((prev) => [...prev, msg]);
  return msg;
}

/** 更新指定消息 */
function updateMessage(id: string, patch: Partial<ChatMessage>) {
  setMessages((prev) => {
    const idx = prev.findIndex((m) => m.id === id);
    if (idx < 0) return prev;
    const next = [...prev];
    next[idx] = { ...next[idx], ...patch };
    return next;
  });
}

/** 追加文本到指定消息 */
function appendToMessage(id: string, text: string) {
  setMessages((prev) => {
    const idx = prev.findIndex((m) => m.id === id);
    if (idx < 0) return prev;
    const next = [...prev];
    next[idx] = { ...next[idx], content: next[idx].content + text, streaming: true };
    return next;
  });
}

/** 确保 toolCall 存在并返回 */
function ensureToolCall(msgId: string, toolCallId: string): ToolCall {
  const msg = ensureMessage(msgId, "assistant");
  const calls = msg.toolCalls ?? [];
  let tc = calls.find((c) => c.id === toolCallId);
  if (!tc) {
    tc = { id: toolCallId, status: "pending", contentBuf: "" };
    updateMessage(msgId, { toolCalls: [...calls, tc] });
  }
  return tc;
}

/** 更新 toolCall */
function updateToolCall(msgId: string, toolCallId: string, patch: Partial<ToolCall>) {
  setMessages((prev) => {
    const idx = prev.findIndex((m) => m.id === msgId);
    if (idx < 0) return prev;
    const next = [...prev];
    const calls = (next[idx].toolCalls ?? []).map((c) =>
      c.id === toolCallId ? { ...c, ...patch } : c,
    );
    next[idx] = { ...next[idx], toolCalls: calls };
    return next;
  });
}

// ═══════════════════════════════════════
// ACP 事件处理
// ═══════════════════════════════════════

/** 处理 ACP session/update 事件 */
function handleAcpEvent(ev: { kind: string; data: Record<string, unknown> }) {
  const d = ev.data as any;
  const now = Date.now();

  switch (ev.kind) {
    // ─── 用户消息 ───
    case "user_message_chunk": {
      const id = d?.messageId ?? `user-${now}`;
      ensureMessage(id, "user", now);
      const text = d?.content?.text ?? "";
      if (text) appendToMessage(id, text);
      break;
    }
    case "user_message": {
      const id = d?.messageId ?? `user-${now}`;
      const content = extractTextContent(d?.content);
      updateMessage(id, { content, streaming: false });
      break;
    }

    // ─── Agent 消息 ───
    case "agent_message_chunk": {
      const id = d?.messageId ?? `agent-${now}`;
      const existing = messages().find((m) => m.id === id);
      if (existing && existing.type === "thought") {
        // 同一个 messageId 先被 thought_chunk 创建为 type="thought"，
        // 现在 message_chunk 到了 → 升级为 assistant，把已有内容移到 thought 字段
        updateMessage(id, { type: "assistant", thought: existing.content || existing.thought, content: "", streaming: true });
      } else {
        ensureMessage(id, "assistant", now);
      }
      const text = d?.content?.text ?? "";
      if (text) appendToMessage(id, text);
      break;
    }
    case "agent_message": {
      const id = d?.messageId ?? `agent-${now}`;
      const content = extractTextContent(d?.content);
      const existing = messages().find((m) => m.id === id);
      if (existing && existing.type === "thought") {
        // thought → assistant 升级
        updateMessage(id, {
          type: "assistant",
          thought: existing.content || existing.thought,
          content: content || "",
          streaming: false,
        });
      } else {
        updateMessage(id, {
          content: content || existing?.content || "",
          streaming: false,
        });
      }
      break;
    }

    // ─── 思考过程 ───
    case "agent_thought_chunk": {
      const id = d?.messageId ?? `thought-${now}`;
      ensureMessage(id, "thought", now);
      const text = d?.content?.text ?? "";
      if (text) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === id);
          if (idx < 0) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], thought: (next[idx].thought ?? "") + text, streaming: true };
          return next;
        });
      }
      break;
    }
    case "agent_thought": {
      const id = d?.messageId ?? `thought-${now}`;
      const content = extractTextContent(d?.content);
      updateMessage(id, { thought: content, streaming: false });
      break;
    }

    // ─── 工具调用 ───
    case "tool_call_update": {
      // tool_call_update 的 data 直接就是 ToolCallUpdate 结构
      const toolCallId = d?.toolCallId;
      if (!toolCallId) break;
      // 新建一条 assistant 消息来承载工具调用（如果没有正在流式的）
      const streamingMsg = messages().find((m) => m.streaming && m.type === "assistant");
      const msgId = streamingMsg?.id ?? `tool-${toolCallId}`;
      if (!streamingMsg) ensureMessage(msgId, "assistant", now);

      const tc = ensureToolCall(msgId, toolCallId);
      updateToolCall(msgId, toolCallId, {
        name: d?.name ?? tc.name,
        title: d?.title ?? tc.title,
        kind: d?.kind ?? tc.kind,
        status: mapToolStatus(d?.status) ?? tc.status,
        rawInput: d?.rawInput ?? tc.rawInput,
        rawOutput: d?.rawOutput ?? tc.rawOutput,
      });
      break;
    }
    case "tool_call_content_chunk": {
      const toolCallId = d?.toolCallId;
      if (!toolCallId) break;
      const streamingMsg = messages().find((m) => m.streaming && m.type === "assistant");
      if (!streamingMsg) break;
      const text = d?.content?.text ?? "";
      if (text) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === streamingMsg.id);
          if (idx < 0) return prev;
          const calls = (prev[idx].toolCalls ?? []).map((c) =>
            c.id === toolCallId ? { ...c, contentBuf: c.contentBuf + text } : c,
          );
          const next = [...prev];
          next[idx] = { ...next[idx], toolCalls: calls };
          return next;
        });
      }
      break;
    }

    // ─── 终端输出 ───
    case "terminal_update": {
      const termId = d?.terminalId;
      if (!termId) break;
      const streamingMsg = messages().find((m) => m.streaming && m.type === "assistant");
      const msgId = streamingMsg?.id ?? `term-${termId}`;
      if (!streamingMsg) ensureMessage(msgId, "terminal", now);

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === msgId);
        if (idx < 0) return prev;
        const terms = prev[idx].terminals ?? [];
        const existing = terms.find((t) => t.id === termId);
        let updated: TerminalInfo;
        if (existing) {
          updated = {
            ...existing,
            command: d?.command ?? existing.command,
            cwd: d?.cwd ?? existing.cwd,
            outputBuf: existing.outputBuf + (d?.output?.text ?? ""),
            exitStatus: d?.exitStatus ?? existing.exitStatus,
          };
        } else {
          updated = {
            id: termId,
            command: d?.command,
            cwd: d?.cwd,
            outputBuf: d?.output?.text ?? "",
            exitStatus: d?.exitStatus,
          };
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          terminals: [...terms.filter((t) => t.id !== termId), updated],
        };
        return next;
      });
      break;
    }
    case "terminal_output_chunk": {
      // 增量输出
      const termId = d?.terminalId;
      if (!termId) break;
      const streamingMsg = messages().find((m) => m.streaming);
      if (!streamingMsg) break;
      const text = d?.output?.text ?? d?.text ?? "";
      if (text) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === streamingMsg.id);
          if (idx < 0) return prev;
          const terms = (prev[idx].terminals ?? []).map((t) =>
            t.id === termId ? { ...t, outputBuf: t.outputBuf + text } : t,
          );
          const next = [...prev];
          next[idx] = { ...next[idx], terminals: terms };
          return next;
        });
      }
      break;
    }

    // ─── 状态变更 ───
    case "state_update": {
      // agent 停止时标记所有流式消息为完成
      // （sending 状态由 worker 权威管理，这里不碰）
      if (d?.status === "stopped" || d?.status === "idle") {
        setMessages((prev) =>
          prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        );
      }
      break;
    }

    // ─── 会话结束 ───
    case "stop": {
      // agent 回合结束（ACP session/update 最后一条通知）
      // 附上 usage（如果有）
      if (d?.usage) {
        const lastAssistant = [...messages()].reverse().find((m) => m.type === "assistant");
        if (lastAssistant) {
          updateMessage(lastAssistant.id, {
            usage: {
              input: d.usage.inputTokens,
              output: d.usage.outputTokens,
              total: d.usage.totalTokens,
            },
          });
        }
      }
      setMessages((prev) =>
        prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      );
      break;
    }

    // ─── 用量统计 ───
    case "usage_update": {
      // 找到最后一条 assistant 消息，附上用量
      const lastAssistant = [...messages()].reverse().find((m) => m.type === "assistant");
      if (lastAssistant) {
        updateMessage(lastAssistant.id, {
          usage: {
            input: d?.inputTokens ?? d?.promptTokens,
            output: d?.outputTokens ?? d?.completionTokens,
            total: d?.totalTokens,
          },
        });
      }
      break;
    }

    // ─── 上下文压缩 ───
    case "compaction_update":
    case "compaction_summary_chunk": {
      const id = `compaction-${now}`;
      const content = extractTextContent(d?.content) ?? d?.summary ?? "";
      if (content) {
        ensureMessage(id, "compaction", now);
        updateMessage(id, { content, streaming: ev.kind === "compaction_summary_chunk" });
      }
      break;
    }

    default:
      // 忽略未知事件（config_option_update, available_commands_update 等）
      break;
  }
}

/** 从 ContentBlock[] 提取文本 */
function extractTextContent(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

/** 映射 ACP tool call status 到我们的状态 */
function mapToolStatus(s: unknown): ToolCallStatus | undefined {
  if (typeof s !== "string") return undefined;
  const map: Record<string, ToolCallStatus> = {
    pending: "pending",
    running: "running",
    completed: "completed",
    succeeded: "completed",
    failed: "failed",
    cancelled: "cancelled",
    canceled: "cancelled",
  };
  return map[s] ?? undefined;
}

// ═══════════════════════════════════════
// 发送消息
// ═══════════════════════════════════════

/** 给用户消息标记队列状态（排队/执行中/完成/取消） */
function setMessageQueueStatus(id: string, queueStatus: ChatMessage["queueStatus"]) {
  setMessages((prev) => {
    const idx = prev.findIndex((m) => m.id === id);
    if (idx < 0) return prev;
    const next = [...prev];
    next[idx] = { ...next[idx], queueStatus };
    return next;
  });
}

/** 实际执行一轮对话（单条消息）；调用前必须已完成入队 */
async function runOne(taskUri: string, content: string, msgId: string, turnAbort?: { aborted: boolean }) {
  // 队列状态（queueStatus=sending）由 worker 管理；这里只跑流
  setError(null);

  try {
    // 调用 chatStreamEvents RPC，获取完整 ACP 事件流
    const stream = await diyService.diy.agent.chatStreamEvents({ taskUri, model: activeModel() || "", messages: [{ role: "user", content: content.trim() }] });

    for await (const raw of stream) {
      // 被 stop/clear 中止后：跳过事件处理（防「清空后又冒消息」），
      // 但继续消费流直到 stop 事件到达、流自然结束——结尾统一复位
      if (turnAbort?.aborted) continue;
      // chatStreamEvents 返回 JSON 序列化的 ACP 事件
      try {
        const ev = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (ev && typeof ev.kind === "string") {
          handleAcpEvent(ev);
        }
      } catch {
        // 纯文本回退
        if (typeof raw === "string" && raw.trim()) {
          const agentMsgId = `agent-fallback-${Date.now()}`;
          ensureMessage(agentMsgId, "assistant", Date.now());
          appendToMessage(agentMsgId, raw);
        }
      }
    }

    // 流结束（含被中止的流：stop 事件已消费完），标记所有流式消息为完成。
    // clear 后 messages 已空，map 是 no-op，不会误标新消息
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    );
    // 通知外部 session 已创建（configOptions 可用）
    onSessionCreatedCallbacks.forEach((fn) => fn());
  } catch (e: any) {
    // 被取消的轮次不算错误（stop 流正常结束后也会走到这里）
    if (!(e?.message?.includes("取消") || e?.name === "AbortError")) {
      setError(e?.message ?? String(e));
    }
  }
  // 队列状态（running→completed/cancelled、sending）由 worker 统一确认
}

/**
 * 发送消息（DeepSeek Web 式排队）：消息立即上屏标记「排队中」并进
 * 队列；worker 串行消费，当前轮结束后自动执行下一条。main 端 runGen
 * 按 task 串行，天然支持。返回是否成功入队（ask 模式）。
 */
function sendMessage(taskUri: string, content: string): Promise<boolean> {
  return post({ type: "send", taskUri, text: content });
}

/** 取消单条排队中的消息（排队中撤回 / 执行中中断本轮） */
function cancelMessage(msgId: string): Promise<boolean> {
  return post({ type: "cancel-message", msgId });
}

/** 取消当前生成：agent 停止本轮，排队中的下一条自动接续执行 */
function cancel(): Promise<boolean> {
  return post({ type: "stop" });
}

/** 取消当前生成并清空排队（不执行剩余消息） */
function cancelAll(): Promise<boolean> {
  return post({ type: "stop-all" });
}

// ─── session 创建回调（供 ChatPage 刷新 configOptions） ───
const onSessionCreatedCallbacks = new Set<() => void>();

function onSessionCreated(fn: () => void): () => void {
  onSessionCreatedCallbacks.add(fn);
  return () => onSessionCreatedCallbacks.delete(fn);
}

function clearChat(): Promise<boolean> {
  return post({ type: "clear" });
}

function clearError() {
  setError(null);
}

// ═══════════════════════════════════════
// 会话级操作（模型切换 / 状态同步 / 关闭会话）
// 与 agentStore 的分工：这些是「某个 task 的会话」状态，只放 chatStore。
// ═══════════════════════════════════════

/** 向主进程查询该 task 会话的真实模型；无会话则清空选择 */
async function syncStatus(taskUri: string) {
  try {
    const st = await diyService.diy.agent.status({ taskUri });
    setActiveModel(st.state === "ready" ? (st.model ?? "") : "");
  } catch { /* 查不到就维持现状 */ }
}

/** 切换会话模型（乐观更新，失败回滚） */
async function switchModel(taskUri: string, modelId: string) {
  const prev = activeModel();
  setActiveModel(modelId);
  if (!taskUri) return;
  try {
    await diyService.diy.agent.setModel({ taskUri, model: modelId });
    await syncStatus(taskUri);
  } catch (e) {
    setActiveModel(prev);
    setError(e instanceof Error ? e.message : "切换模型失败");
  }
}

/** 关闭会话（消息也清空：会话没了，旧消息对应的 sessionId 已失效） */
function closeSession(taskUri: string): Promise<boolean> {
  return post({ type: "close-session", taskUri });
}

// ═══════════════════════════════════════
// 导出
// ═══════════════════════════════════════

export const chatStore = {
  get messages() { return messages(); },
  get sending() { return sending(); },
  get error() { return error(); },
  get activeModel() { return activeModel(); },
  get sessionId() { return sessionId(); },
  get pendingCount() { return pendingCount(); },
  /** 排队中的消息列表投影（UI 只读，DeepSeek Web 式排队管理） */
  get pendingList() { return pendingList(); },
  sendMessage,
  cancelMessage,
  cancel,
  cancelAll,
  clearChat,
  clearError,
  switchModel,
  syncStatus,
  closeSession,
  setModel: setActiveModel,
  /** 直接注入 ACP 事件（供外部事件源使用） */
  handleAcpEvent,
  /** session 创建后回调（configOptions 可用） */
  onSessionCreated,
};
