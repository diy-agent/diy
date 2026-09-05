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

// ─── 发送队列（steer 排队：发第二条时不丢弃，排到 main 端串行执行） ───
const [pendingCount, setPendingCount] = createSignal(0);
/** 待发送任务（每条 = 一条已上屏的用户消息；执行中的不算在内） */
const pendingMessages: { id: string; text: string }[] = [];
/** 当前执行轮次的 taskUri（供 cancel 定位会话） */
let activeTaskUri: string | null = null;
/** 当前执行轮次的用户消息 id（供状态标记） */
let activeMsgId: string | null = null;
/** 本轮是否被 cancel 请求过（决定最终状态是 completed 还是 cancelled） */
let activeCancelled = false;

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
      if (d?.status === "stopped" || d?.status === "idle") {
        setMessages((prev) =>
          prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        );
        setSending(false);
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
      setSending(false);
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
async function runOne(taskUri: string, content: string, msgId: string) {
  activeTaskUri = taskUri;
  activeMsgId = msgId;
  activeCancelled = false;
  setMessageQueueStatus(msgId, "running");
  setSending(true);
  setError(null);

  try {
    // 调用 chatStreamEvents RPC，获取完整 ACP 事件流
    const stream = await diyService.diy.agent.chatStreamEvents({ taskUri, model: activeModel() || "", messages: [{ role: "user", content: content.trim() }] });

    for await (const raw of stream) {
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

    // 流结束，标记所有流式消息为完成（agent 侧正常收尾）
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
  } finally {
    // 最终状态由确认方决定：被 cancel 请求过 → cancelled，否则 completed
    setMessageQueueStatus(msgId, activeCancelled ? "cancelled" : "completed");
    setSending(false);
  }
}

/**
 * 发送消息（DeepSeek Web 式排队）：消息立即上屏标记「排队中」，
 * 进入统一消费队列，当前轮结束后自动执行下一条。main 端 runGen
 * 按 task 串行，天然支持。
 */
function sendMessage(taskUri: string, content: string) {
  const text = content.trim();
  if (!text || !taskUri) return;

  // 立即上屏用户消息（无论排队还是执行）—— DeepSeek Web 式可见排队。
  // 先标 queued，消费轮到它时 runOne 改成 running。
  const userMsgId = `user-local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  setMessages((prev) => [
    ...prev,
    {
      id: userMsgId,
      type: "user",
      content: text,
      time: Date.now(),
      streaming: false,
      queueStatus: "queued",
    },
  ]);

  pendingMessages.push({ id: userMsgId, text });
  setPendingCount(pendingMessages.length);
  drain(taskUri);
}

/** 串行消费队列：只有一个消费循环（同步锁防同 tick 双跑） */
let draining = false;
function drain(taskUri: string) {
  if (draining) return;
  draining = true;
  void (async () => {
    while (pendingMessages.length > 0) {
      const task = pendingMessages.shift()!;
      setPendingCount(pendingMessages.length);
      await runOne(taskUri, task.text, task.id);
    }
    draining = false;
    activeTaskUri = null;
    activeMsgId = null;
  })();
}

/** 取消单条排队中的消息（DeepSeek Web 式：排队任务可单独撤回） */
function cancelMessage(msgId: string) {
  // 排队中：从队列摘除 + 标记 cancelled；正在执行：走 agent.cancel
  const idx = pendingMessages.findIndex((p) => p.id === msgId);
  if (idx >= 0) {
    pendingMessages.splice(idx, 1);
    setPendingCount(pendingMessages.length);
    setMessageQueueStatus(msgId, "cancelled");
    return;
  }
  if (activeMsgId === msgId) {
    void cancel();
  }
}

/** 取消当前生成并清空排队（不执行剩余消息） */
async function cancelAll() {
  // 排队中的全部标记取消
  for (const p of pendingMessages) setMessageQueueStatus(p.id, "cancelled");
  pendingMessages.length = 0;
  setPendingCount(0);
  if (sending()) await cancel();
}

/** 取消当前生成：agent 停止本轮，排队中的下一条自动接续执行 */
async function cancel() {
  if (!sending() || !activeTaskUri) return;
  activeCancelled = true;
  // 忽略失败：会话可能已被关闭/agent 退出，取消尽力而为。
  // ⚠️ 这里不能 setSending(false)：runOne 的 for-await 还在收尾，
  // 提前置 false 会让用户紧接着发送走「空闲」路径 → 双 for-await 并发。
  try {
    await diyService.diy.agent.cancel({ taskUri: activeTaskUri });
  } catch { /* 静默 */ }
}

// ─── session 创建回调（供 ChatPage 刷新 configOptions） ───
const onSessionCreatedCallbacks = new Set<() => void>();

function onSessionCreated(fn: () => void): () => void {
  onSessionCreatedCallbacks.add(fn);
  return () => onSessionCreatedCallbacks.delete(fn);
}

function clearChat() {
  setMessages([]);
  setError(null);
  pendingMessages.length = 0;
  setPendingCount(0);
  activeTaskUri = null;
  activeMsgId = null;
  draining = false;
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
async function closeSession(taskUri: string) {
  try {
    await diyService.diy.agent.closeSession({ taskUri });
    setMessages([]);
    setSessionId(null);
    setActiveModel("");
    setError(null);
    pendingMessages.length = 0;
    setPendingCount(0);
    activeTaskUri = null;
    activeMsgId = null;
    draining = false;
  } catch (e) {
    setError(e instanceof Error ? e.message : "关闭会话失败");
  }
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
