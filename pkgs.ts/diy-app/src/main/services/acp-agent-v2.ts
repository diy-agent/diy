// src/main/services/acp-agent-v2.ts
// 🎯 ACP 客户端 V2 — 官方 SDK 版 (opencode 优先)
//
// 与 acp-agent.ts（自建协议）对照：
//   - 用 @agentclientprotocol/sdk 官方 ClientContext + ActiveSession
//   - 强类型方法（无动态字符串 request）
//   - V2b 常驻：connectWith 回调不返回，保持连接
//   - 支持 opencode 会话级热切模型（session/set_model）
//   - 支持 loadSession 恢复会话
//
// 分层：
//   AcpAgentV2 = 一个 agent 进程 = 一个 ClientContext（常驻）
//   AcpSessionV2 = 该进程上的一个会话（ActiveSession 封装）

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  methods,
  type ClientContext,
  type ActiveSession,
  type Stream,
} from "@agentclientprotocol/sdk";

// ═══════════════════════════════════════
// 类型
// ═══════════════════════════════════════

export interface AcpModel {
  modelId: string;
  name?: string;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  models: AcpModel[];
  currentModelId?: string;
}

export interface AcpUpdateEvent {
  kind: string;
  data: Record<string, unknown>;
}

/** ACP SessionConfigOption 中我们用到的字段（select 型） */
interface SessionConfigOptionLike {
  id: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string }>;
}

export interface AcpAgentV2Options {
  /** ACP agent 命令（默认 opencode acp） */
  command: string;
  /** 工作目录 */
  cwd?: string;
  /** 对 agent 发来的 session/request_permission 默认自动同意 */
  autoApprovePermission?: boolean;
  /**
   * agent stderr 的落盘汇（必填语义上由调用方给出）。
   * stdio 里的 stderr 一旦成 pipe 就**必须有人消费**：无人读取时 64KB 缓冲填满，
   * 子进程会在 write 上阻塞 → agent 静默卡死，且没有任何报错。
   */
  stderrSink?: (line: string) => void;
}

function childProcStreams(proc: ChildProcess): Stream {
  const output = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  return ndJsonStream(output, input);
}

// ═══════════════════════════════════════
// AcpSessionV2 — 单个会话（封装 ActiveSession）
// ═══════════════════════════════════════

export class AcpSessionV2 {
  readonly sessionId: string;
  readonly cwd: string;
  private activeSession: ActiveSession;
  private listeners = new Set<(ev: AcpUpdateEvent) => void>();
  private history: AcpUpdateEvent[] = [];
  private done = false;
  private textBuf = "";

  /**
   * agent 通过 `config_option_update` 推送的最新全量配置（协议内的权威来源）。
   * null = 尚未收到推送。实测 opencode **不推**这个事件，故多数会话恒为 null。
   */
  private liveConfigOptions: SessionConfigOptionLike[] | null = null;

  /**
   * 本端成功执行 setModel 后记下的模型 id（乐观记录）。
   * 实测 opencode 的 session/set_model 返回 `{}`、也不推 config_option_update，
   * 对它而言这是切换后唯一可信来源；会推配置的 agent 由 liveConfigOptions 覆盖。
   */
  private appliedModelId?: string;

  constructor(activeSession: ActiveSession, cwd: string, private ctx: ClientContext) {
    this.activeSession = activeSession;
    this.sessionId = activeSession.sessionId;
    this.cwd = cwd;
  }

  /** session/new 返回的一次性配置快照（不会随切换更新） */
  private snapshotConfigOptions(): SessionConfigOptionLike[] {
    const resp = (this.activeSession as any).newSessionResponse ?? {};
    return (resp.configOptions as SessionConfigOptionLike[] | undefined) ?? [];
  }

  /** 可用模型列表（从 configOptions 的 `model` 项解析，opencode 支持） */
  get availableModels(): AcpModel[] {
    const opts = this.liveConfigOptions ?? this.snapshotConfigOptions();
    const modelOpt = opts.find((o) => o.id === "model");
    return (modelOpt?.options ?? []).map((o) => ({ modelId: o.value, name: o.name }));
  }

  /**
   * 当前模型，按可信度取：agent 推送的实时值 > 本端成功切换的记录 > 建会话快照。
   * 只读快照会让 status 永远报旧值（本仓曾因此把「切模型」误判成已验证）。
   */
  get currentModelId(): string | undefined {
    if (this.liveConfigOptions) {
      return this.liveConfigOptions.find((o) => o.id === "model")?.currentValue;
    }
    const snap = this.snapshotConfigOptions().find((o) => o.id === "model")?.currentValue;
    return this.appliedModelId ?? snap;
  }

  /** 订阅本会话的流式事件（agent_message_chunk / tool_call / ...） */
  onEvent(fn: (ev: AcpUpdateEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 发 prompt，异步收流式事件；返回 prompt 最终响应 */
  async prompt(text: string): Promise<{ stopReason?: string }> {
    this.textBuf = "";
    const pump = this.pumpUpdates();
    try {
      const resp = await this.activeSession.prompt(text);
      return { stopReason: resp.stopReason };
    } finally {
      this.done = true;
      await pump;
    }
  }

  /** 便捷：读文本直到 prompt turn 结束 */
  async readText(): Promise<string> {
    return this.activeSession.readText();
  }

  /** 后台消费 nextUpdate → 触发事件 */
  private async pumpUpdates(): Promise<void> {
    try {
      while (true) {
        const msg = await this.activeSession.nextUpdate();
        if (msg.kind === "stop") {
          this.history.push({ kind: "stop", data: msg.response });
          for (const fn of this.listeners) fn({ kind: "stop", data: msg.response });
          break;
        }
        const ev: AcpUpdateEvent = { kind: msg.update.sessionUpdate, data: msg.notification.update };
        this.history.push(ev);
        if (ev.kind === "agent_message_chunk") {
          const t = (ev.data?.content as any)?.text;
          if (t) this.textBuf += t;
        }
        if (ev.kind === "config_option_update") {
          // 协议规定这是「全量配置及其当前值」，收到即整体替换，不做增量合并
          const opts = ev.data?.configOptions as SessionConfigOptionLike[] | undefined;
          if (Array.isArray(opts)) this.liveConfigOptions = opts;
        }
        for (const fn of this.listeners) fn(ev);
      }
    } catch (e) {
      // 正常结束走 done=true + break；能进到这里说明更新流意外断掉。
      // 静默吞掉会让「agent 掉了但界面毫无反应」变成无法定位的问题。
      if (!this.done) {
        console.warn(`[acp] session ${this.sessionId} 更新流中断：${(e as Error)?.message ?? e}`);
      }
    }
  }

  /** 热切模型（opencode 原生 session/set_model；响应体为空，故成功即本地记账） */
  async setModel(modelId: string): Promise<void> {
    await this.ctx.request("session/set_model" as any, {
      sessionId: this.sessionId,
      modelId,
    } as any);
    this.appliedModelId = modelId;
  }

  /** 取消当前生成 */
  async cancel(): Promise<void> {
    await this.ctx.request(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  /** 释放本会话的流式路由（不关协议会话） */
  dispose(): void {
    this.activeSession.dispose();
  }
}

// ═══════════════════════════════════════
// AcpAgentV2 — 官方 SDK 常驻连接
// ═══════════════════════════════════════

export class AcpAgentV2 {
  private proc!: ChildProcess;
  private ctx!: ClientContext;
  private opts: AcpAgentV2Options;
  private readyPromise: Promise<void>;
  private sessions = new Map<string, AcpSessionV2>();
  private initResult: any = null;
  private cachedModels: AcpModel[] | null = null;
  /** 进程是否已退出 */
  private exited = false;
  /** 进程退出回调 */
  private onExitCallbacks = new Set<(code: number | null) => void>();

  constructor(opts: AcpAgentV2Options) {
    this.opts = opts;
    this.readyPromise = this.connect();
  }

  /** 等待连接就绪（connectWith + initialize 完成） */
  async ready(): Promise<void> {
    await this.readyPromise;
  }

  /** 进程是否存活 */
  get alive(): boolean {
    return !this.exited && this.proc && this.proc.exitCode === null;
  }

  /** 注册进程退出回调 */
  onExit(fn: (code: number | null) => void): () => void {
    this.onExitCallbacks.add(fn);
    return () => this.onExitCallbacks.delete(fn);
  }

  private async connect(): Promise<void> {
    this.proc = spawn(this.opts.command, {
      shell: true,
      cwd: this.opts.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 必须消费 stderr：pipe 无人读取会填满缓冲，令 agent 在 write 上阻塞至假死。
    // 逐行转写调用方给的落盘汇（未提供则丢弃，但仍要读走）。
    this.proc.stderr?.setEncoding("utf-8");
    let stderrTail = "";
    this.proc.stderr?.on("data", (chunk: string) => {
      stderrTail += chunk;
      const lines = stderrTail.split("\n");
      stderrTail = lines.pop() ?? ""; // 末段可能半行，留待下次
      if (this.opts.stderrSink) {
        for (const line of lines) {
          if (line.trim()) this.opts.stderrSink(line);
        }
      }
    });

    // 进程退出检测
    this.proc.on("exit", (code) => {
      this.exited = true;
      for (const fn of this.onExitCallbacks) fn(code);
    });

    // 进程启动失败检测：命令不存在 / 权限问题只能从这里冒出来，不能丢
    this.proc.on("error", (err) => {
      console.error(`[acp] agent 进程错误（${this.opts.command}）：${err?.message ?? err}`);
      this.exited = true;
      for (const fn of this.onExitCallbacks) fn(null);
    });

    const stream = childProcStreams(this.proc);

    await new Promise<void>((resolve, reject) => {
      // 连接超时（默认 30s）
      const timeout = setTimeout(() => {
        reject(new Error(`ACP 连接超时 (${this.opts.command})`));
        this.proc.kill();
      }, 30_000);

      const app = client({ name: "diy-agent-v2" });

      if (this.opts.autoApprovePermission) {
        app.onRequest(
          methods.client.session.requestPermission,
          () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
        );
      }

      app
        .connectWith(stream, async (ctx) => {
          this.ctx = ctx;
          this.initResult = await ctx.request(methods.agent.initialize, {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
            },
          });
          clearTimeout(timeout);
          resolve();
          // 不 return → 保持连接常驻
          await new Promise<void>((keepAlive) => {
            this.proc.on("exit", () => keepAlive());
          });
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  /** 新建会话 */
  async newSession(cwd: string): Promise<AcpSessionV2> {
    const activeSession = await this.ctx.buildSession(cwd).start();
    const sess = new AcpSessionV2(activeSession, cwd, this.ctx);
    this.sessions.set(sess.sessionId, sess);
    return sess;
  }

  /** 恢复已有会话（loadSession） */
  async loadSession(sessionId: string, cwd: string): Promise<AcpSessionV2> {
    // 1. 调用 session/load 恢复 agent 侧会话
    //    响应体的 configOptions 必须留下来：恢复出来的会话若没有它，
    //    currentModelId / availableModels 全是空 —— 界面上就显示不出当前模型。
    const loadResp = (await this.ctx.request(methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
    } as any)) as { configOptions?: SessionConfigOptionLike[] } | undefined;

    // 2. 构造包含 sessionId 的响应对象，用于 SDK 内部路由设置
    //    LoadSessionResponse 没有 sessionId（在 request 里），需要构造一个 fake NewSessionResponse
    const fakeResponse = {
      sessionId,
      configOptions: loadResp?.configOptions ?? [],
    } as any;

    // 3. 使用 SDK 内部 attachSession 创建 ActiveSession（设置 session/update 路由）
    //    attachSession 是 private，通过类型断言访问
    const activeSession = (this.ctx as any).attachSession(fakeResponse) as ActiveSession;

    const sess = new AcpSessionV2(activeSession, cwd, this.ctx);
    this.sessions.set(sessionId, sess);
    return sess;
  }

  /** 取已有会话 */
  getSession(sessionId: string): AcpSessionV2 | undefined {
    return this.sessions.get(sessionId);
  }

  /** 热切模型（opencode 自定义方法） */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.ctx.request("session/set_model" as any, {
      sessionId,
      modelId,
    } as any);
  }

  /**
   * 列出可用模型（agent 级能力）。
   * 内部 lazy 建一个 probe session 获取模型列表并缓存；后续直接读缓存。
   * 不依赖外部先建 session —— 因为创建 session 前就需要模型列表给用户选。
   */
  async listModels(): Promise<AcpModel[]> {
    if (this.cachedModels) return this.cachedModels;
    await this.ready();
    // probe session：建一个即弃，只为拿 configOptions 模型列表
    const probe = await this.ctx.buildSession(this.opts.cwd ?? process.cwd()).start();
    const models = (probe as any).newSessionResponse?.configOptions
      ?.find((o: any) => o.id === "model")?.options
      ?.map((o: any) => ({ modelId: o.value, name: o.name })) ?? [];
    probe.dispose();
    this.cachedModels = models.length > 0 ? models : [{ modelId: "default", name: "Default" }];
    return this.cachedModels!;
  }

  /** 关闭连接 */
  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill();
    }
  }
}
