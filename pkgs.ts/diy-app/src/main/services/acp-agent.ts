// src/main/services/acp-agent.ts
// 🎯 ACP (Agent Client Protocol v1) 客户端
//
// 通过 stdin/stdout + NDJSON 与 ACP agent（hermes acp 等）通信：
//   initialize → session/new → session/prompt → session/update 流式推送
// 自建轻量实现（不用 @agentclientprotocol/sdk），协议细节见 docs/plans/2026-07-10-acp-research.md。

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

/** JSON-RPC 请求/响应/通知 信封 */
interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** initialize 响应中的 agent 能力声明 */
export interface AcpCapabilities {
  loadSession: boolean;
  resume: boolean;
  list: boolean;
  fork: boolean;
  promptImage: boolean;
  /** 自定义扩展 */
  meta: Record<string, unknown>;
}

/** agent 基本信息 */
export interface AgentInfo {
  name: string;
  version?: string;
}

export interface AcpModel {
  modelId: string;
  name?: string;
}

export interface AcpMode {
  id: string;
  name?: string;
}

/** session/new 的完整结果 */
export interface AcpSessionInfo {
  sessionId: string;
  models: AcpModel[];
  currentModelId?: string;
  modes: AcpMode[];
  currentModeId?: string;
  capabilities: AcpCapabilities;
  agentInfo: AgentInfo;
}

/** session/update 流式推送的单一事件 */
export interface AcpUpdateEvent {
  /** 事件类型：agent_message_chunk / agent_thought_chunk / plan / tool_call / tool_call_update / usage_update / ... */
  kind: string;
  /** 事件负载（结构随 kind 变化，见官方协议） */
  data: Record<string, unknown>;
}

/** ACP agent 状态（供 diy.agent.status RPC） */
export interface AgentStatus {
  agentId: string;
  state: string;
  model?: string;
  error?: string;
}

// ═══════════════════════════════════════
// AcpClient — 一个 ACP agent 子进程（stdio + NDJSON JSON-RPC）
// ═══════════════════════════════════════

export interface AcpClientOptions {
  /** ACP agent 命令（默认 hermes acp） */
  command: string;
  /** 工作目录 */
  cwd?: string;
  /** 自定义环境变量 */
  env?: Record<string, string>;
}

/**
 * ACP agent 客户端：spawn 子进程，通过 stdio 发 JSON-RPC。
 * 实现 initialize 握手 + 通用 request。一个实例绑定一个 agent 子进程。
 */
export class AcpClient {
  private proc: ChildProcess;
  private rl: Interface;
  private nextId = 1;
  /** id → 待 resolve 的 request */
  private pending = new Map<number, (msg: RpcMessage) => void>();
  /** 已注册的 session/update 通知回调 */
  private updateHandlers = new Set<(sessionId: string, event: AcpUpdateEvent) => void>();

  capabilities: AcpCapabilities | null = null;
  agentInfo: AgentInfo | null = null;
  protocolVersion = 0;

  constructor(private readonly opts: AcpClientOptions) {
    // command 形如 "hermes acp"，需经 shell 解析（拆参数 + 找 PATH）
    this.proc = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.onLine(line));

    // 子进程异常退出 → 拒绝所有 pending
    this.proc.on("error", (err) => {
      for (const reject of this.pending.values()) {
        reject({ jsonrpc: "2.0", error: { code: -32000, message: `ACP 进程错误: ${err.message}` } });
      }
      this.pending.clear();
    });
    this.proc.on("exit", (code) => {
      const msg: RpcMessage = { jsonrpc: "2.0", error: { code: -32000, message: `ACP 进程退出（code=${code}）` } };
      for (const reject of this.pending.values()) reject(msg);
      this.pending.clear();
    });
  }

  /** 注册 session/update 通知回调 */
  onUpdate(fn: (sessionId: string, event: AcpUpdateEvent) => void): () => void {
    this.updateHandlers.add(fn);
    return () => this.updateHandlers.delete(fn);
  }

  /** ACP 握手：发 initialize，读回 agent 能力。 */
  async initialize(): Promise<AcpCapabilities> {
    const result = (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    })) as {
      protocolVersion: number;
      agentCapabilities: Record<string, unknown>;
      agentInfo?: AgentInfo;
    };
    this.protocolVersion = result.protocolVersion;
    this.agentInfo = result.agentInfo ?? { name: "unknown" };
    this.capabilities = parseCapabilities(result.agentCapabilities ?? {});
    return this.capabilities;
  }

  /** 通用 JSON-RPC request（自动分配 id、匹配响应）。 */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error) {
          reject(new Error(`ACP ${method} 失败: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      });
      const frame: RpcMessage = { jsonrpc: "2.0", id, method, params };
      this.proc.stdin!.write(JSON.stringify(frame) + "\n");
    });
  }

  /** 关闭子进程 */
  async close(): Promise<void> {
    const proc = this.proc;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.stdin!.end();
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      // 兜底超时强杀
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        resolve();
      }, 2000);
    });
  }

  // ── 内部：解析一行 NDJSON ──
  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return; // 非 JSON 行（如 stray log）忽略
    }

    // 通知（无 id，method=session/update）
    if (msg.id === undefined && msg.method) {
      if (msg.method === "session/update") {
        this.dispatchUpdate(msg.params);
      }
      return;
    }

    // request 响应：匹配 pending
    if (msg.id !== undefined) {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  private dispatchUpdate(params: unknown): void {
    const p = params as { sessionId?: string; update?: Record<string, unknown> };
    if (!p || !p.update) return;
    const kind = String(p.update["sessionUpdate"] ?? "");
    const event: AcpUpdateEvent = { kind, data: p.update };
    for (const fn of this.updateHandlers) fn(p.sessionId ?? "", event);
  }
}

// ═══════════════════════════════════════
// AcpSession — 基于 AcpClient 的单个会话
// ═══════════════════════════════════════

/**
 * 一个 ACP 会话：封装 session/new、session/prompt、流式响应。
 * 一个 AcpClient 可承载多个会话（agent 需支持并发，见 _meta.maxConcurrentSessions）。
 */
export class AcpSession {
  private events: AcpUpdateEvent[] = [];
  private handlers = new Set<(ev: AcpUpdateEvent) => void>();

  constructor(
    private readonly client: AcpClient,
    readonly info: AcpSessionInfo,
  ) {}

  get sessionId(): string {
    return this.info.sessionId;
  }

  /** 订阅本会话的流式事件 */
  onEvent(fn: (ev: AcpUpdateEvent) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  /** 发送 prompt，异步拉取本会话的流式事件（agent_message_chunk 等）。 */
  async prompt(content: Array<{ type: string; text?: string }>): Promise<void> {
    const sessionId = this.sessionId;
    const unsubscribe = this.client.onUpdate((sid, ev) => {
      if (sid === sessionId) {
        this.events.push(ev);
        for (const h of this.handlers) h(ev);
      }
    });
    try {
      await this.client.request("session/prompt", {
        sessionId,
        prompt: content,
        metadata: { cwd: this.client["opts"].cwd },
      });
    } finally {
      unsubscribe();
    }
  }

  /** 取消当前生成 */
  async cancel(): Promise<void> {
    await this.client.request("session/cancel", { sessionId: this.sessionId });
  }

  /** 关闭会话（若 agent 支持） */
  async close(): Promise<void> {
    await this.client.request("session/close", { sessionId: this.sessionId });
  }
}

// ═══════════════════════════════════════
// 顶层门面 — 保持 api-impl 调用面兼容
// ═══════════════════════════════════════

export interface AcpMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ name: string; arguments: string }>;
  tool_call_id?: string;
}

/**
 * ACP Agent 门面：适配 diy.agent.* RPC 的调用面。
 * 内部维护一个 AcpClient + 最近会话。旧实现是 Ollama HTTP，此处重写为真 ACP。
 */
export class AcpAgentClient {
  private client: AcpClient;
  private session: AcpSession | null = null;
  private cwd: string;

  constructor(opts: Partial<AcpClientOptions> = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.client = new AcpClient({ command: opts.command ?? "hermes acp", cwd: this.cwd, env: opts.env });
  }

  /** 初始化握手（幂等） */
  private async ensureReady(): Promise<void> {
    if (!this.client.capabilities) {
      await this.client.initialize();
    }
    if (!this.session) {
      const info = await this.newSession();
      this.session = new AcpSession(this.client, info);
    }
  }

  /** session/new */
  async newSession(): Promise<AcpSessionInfo> {
    const result = (await this.client.request("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    })) as Record<string, unknown>;
    return parseSessionInfo(result, this.client);
  }

  /** 非流式对话（聚合流式增量） */
  async chat(model: string, messages: AcpMessage[]): Promise<AcpMessage> {
    const collected: string[] = [];
    await this.streamChatMaybe(model, messages, (t) => collected.push(t));
    return { role: "assistant", content: collected.join("") };
  }

  /** 流式对话：yield 文本增量 */
  async *streamChat(model: string, messages: AcpMessage[]): AsyncGenerator<string> {
    await this.ensureReady();
    const session = this.session!;
    yield* this.streamPrompt(session, messages);
  }

  /** 向会话发 prompt，yield 文本增量（内部迭代） */
  private async *streamPrompt(session: AcpSession, messages: AcpMessage[]): AsyncGenerator<string> {
    // 文本增量队列 + 完成/唤醒信号
    const queue: string[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const kick = () => {
      wake?.();
      wake = null;
    };

    const unsub = session.onEvent((ev) => {
      if (ev.kind === "agent_message_chunk") {
        const text = (ev.data["content"] as { text?: string })?.text;
        if (text) {
          queue.push(text);
          kick();
        }
      }
    });

    try {
      // prompt 返回的 Promise：回合结束时 resolve（含文本收集完毕）
      const promptDone = session
        .prompt(messages.map((m) => ({ type: "text", text: m.content })))
        .finally(() => {
          ended = true;
          kick();
        });

      // 消费：有数据就 yield；否则等 kick；ended 且空队列则退出
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (ended) break;
        await new Promise<void>((r) => {
          wake = r;
          if (queue.length > 0 || ended) r();
        });
      }
      await promptDone; // 确保异常向上抛
    } finally {
      unsub();
    }
  }

  /** 兼容 helper：带回调的流式（供 chat 聚合） */
  private async streamChatMaybe(
    model: string,
    messages: AcpMessage[],
    onDelta: (t: string) => void,
  ): Promise<void> {
    for await (const t of this.streamChat(model, messages)) onDelta(t);
  }

  /** 获取 agent 状态 */
  async getAgentStatus(agentId: string): Promise<AgentStatus> {
    try {
      await this.ensureReady();
      return {
        agentId,
        state: "ready",
        model: this.session?.info.currentModelId,
      };
    } catch (err) {
      return { agentId, state: "error", error: (err as Error).message };
    }
  }

  /** 列出可用模型 */
  async listModels(): Promise<AcpModel[]> {
    await this.ensureReady();
    return this.session?.info.models ?? [];
  }

  /** 关闭底层连接 */
  async dispose(): Promise<void> {
    await this.client.close();
  }
}

// ═══════════════════════════════════════
// 解析工具
// ═══════════════════════════════════════

/** 从 initialize 的 agentCapabilities 构建 AcpCapabilities（缺省降级） */
export function parseCapabilities(c: Record<string, unknown>): AcpCapabilities {
  const sc = (c["sessionCapabilities"] ?? {}) as Record<string, unknown>;
  const pc = (c["promptCapabilities"] ?? {}) as Record<string, unknown>;
  return {
    loadSession: !!c["loadSession"],
    resume: !!sc["resume"],
    list: !!sc["list"],
    fork: !!sc["fork"],
    promptImage: !!pc["image"],
    meta: (c["_meta"] ?? {}) as Record<string, unknown>,
  };
}

/** 从 session/new 的 result 构建 AcpSessionInfo */
function parseSessionInfo(result: Record<string, unknown>, client: AcpClient): AcpSessionInfo {
  const models = ((result["models"] as Record<string, unknown>)?.["availableModels"] ?? []) as AcpModel[];
  const modes = ((result["modes"] as Record<string, unknown>)?.["availableModes"] ?? []) as AcpMode[];
  const currentModelId = (result["models"] as Record<string, unknown>)?.["currentModelId"] as string | undefined;
  const currentModeId = (result["modes"] as Record<string, unknown>)?.["currentModeId"] as string | undefined;
  return {
    sessionId: String(result["sessionId"]),
    models,
    currentModelId,
    modes,
    currentModeId,
    capabilities: client.capabilities ?? {
      loadSession: false,
      resume: false,
      list: false,
      fork: false,
      promptImage: false,
      meta: {},
    },
    agentInfo: client.agentInfo ?? { name: "unknown" },
  };
}
