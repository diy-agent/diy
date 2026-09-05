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
  private textBuf = "";
  /** 会话已释放（dispose 后更新流中断属正常，不再告警） */
  private disposed = false;
  /** 常驻更新泵是否已启动（幂等，防重复） */
  private pumping = false;
  /** 等待本轮 prompt 结束（stop 到达）的解析器 */
  private stopResolvers: Array<() => void> = [];
  /** prompt 互斥链：同一会话的 prompt 必须串行（SDK 明确要求按序调用） */
  private promptChain: Promise<unknown> = Promise.resolve();

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
    // 常驻更新泵：建会话/恢复会话后立即开始消费，agent 随时可能推事件
    // （config_option_update 等），不能等第一个 prompt 才启动。
    this.startPump();
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

  /** 发 prompt；同一会话的并发 prompt 串行执行（互斥链）。完成信号由常驻泵派发 stop 时触发 */
  async prompt(text: string): Promise<{ stopReason?: string }> {
    // 排到互斥链尾部：上一个 prompt 完全结束（stop 派发完）后才发下一个。
    // 否则两个回合的 agent_message_chunk 会交叉推送，事件无法归属到正确回合。
    const run = this.promptChain.then(async () => {
      this.textBuf = "";
      // 注册本轮的 stop 等待者（在发 prompt 之前注册，避免漏掉瞬时 stop）
      let resolveStop!: () => void;
      const stopPromise = new Promise<void>((r) => {
        resolveStop = r;
      });
      this.stopResolvers.push(resolveStop);
      try {
        const resp = await this.activeSession.prompt(text);
        // 等常驻泵消费到本轮的 stop（所有事件已派发完毕），再返回
        await stopPromise;
        return { stopReason: resp.stopReason };
      } finally {
        // 出错路径：stop 永远不会来，摘掉自己的等待者，防止泄漏
        const i = this.stopResolvers.indexOf(resolveStop);
        if (i >= 0) this.stopResolvers.splice(i, 1);
      }
    });
    // 链尾续上（没被吞掉的错误要在链尾吃掉，不能打断后续 prompt）
    this.promptChain = run.catch(() => undefined);
    return run;
  }

  /** 便捷：读文本直到 prompt turn 结束 */
  async readText(): Promise<string> {
    return this.activeSession.readText();
  }

  /** 后台常驻消费 nextUpdate → 触发事件；会话生命周期内一直运行 */
  private startPump(): void {
    if (this.pumping) return;
    this.pumping = true;
    // 不 await：泵与调用方并发；意外退出时记日志
    void this.pumpUpdates().catch((e) => {
      if (!this.disposed) {
        console.warn(`[acp] session ${this.sessionId} 更新流中断：${(e as Error)?.message ?? e}`);
      }
    }).finally(() => {
      this.pumping = false;
    });
  }

  private async pumpUpdates(): Promise<void> {
    while (true) {
      const msg = await this.activeSession.nextUpdate();
      if (msg.kind === "stop") {
        this.history.push({ kind: "stop", data: msg.response });
        for (const fn of this.listeners) fn({ kind: "stop", data: msg.response });
        // 唤醒等待本轮 stop 的 prompt（可能多个串行调用，全部唤醒）
        for (const r of this.stopResolvers.splice(0)) r();
        continue; // 常驻：等下一轮
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
  }

  /** 热切模型（opencode 原生 session/set_model；响应体为空，故成功即本地记账） */
  async setModel(modelId: string): Promise<void> {
    await this.ctx.request("session/set_model" as any, {
      sessionId: this.sessionId,
      modelId,
    } as any);
    this.appliedModelId = modelId;
  }

  /**
   * 设置会话配置选项（effort / model / mode 等）。
   * opencode 实现 session/set_config_option → 返回更新后的 configOptions。
   */
  async setConfigOption(configId: string, value: string): Promise<SessionConfigOptionLike[]> {
    const resp = await this.ctx.request("session/set_config_option" as any, {
      sessionId: this.sessionId,
      configId,
      value,
    } as any) as { configOptions?: SessionConfigOptionLike[] };
    const opts = resp?.configOptions;
    if (Array.isArray(opts)) this.liveConfigOptions = opts;
    return opts ?? [];
  }

  /** 获取当前全部配置选项（effort / model / mode 等） */
  getConfigOptions(): SessionConfigOptionLike[] {
    return this.liveConfigOptions ?? this.snapshotConfigOptions();
  }

  /** 取消当前生成 */
  async cancel(): Promise<void> {
    await this.ctx.request(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  /** 释放本会话的流式路由（不关协议会话） */
  dispose(): void {
    this.disposed = true;
    // 唤醒所有等待 stop 的 prompt（它们将因更新流中断而收尾）
    for (const r of this.stopResolvers.splice(0)) r();
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
  /** 实时 autoApprove 开关（handler 动态读取；初始取自 opts，可运行时切换） */
  private autoApprove: boolean;

  constructor(opts: AcpAgentV2Options) {
    this.opts = opts;
    this.autoApprove = opts.autoApprovePermission ?? false;
    this.readyPromise = this.connect();
  }

  /** 运行时切换 autoApprove（以前是内存假开关，现在真正改 handler 行为） */
  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
  }

  /** 当前 autoApprove 状态 */
  get autoApprovePermission(): boolean {
    return this.autoApprove;
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

      // 无条件注册权限处理：开关状态动态读取（this.autoApprove），
      // 运行时 setAutoApprove 立即生效，不再是建连时的快照。
      app.onRequest(
        methods.client.session.requestPermission,
        (req) => {
          if (this.autoApprove) {
            return { outcome: { outcome: "selected", optionId: "allow" } };
          }
          // 关闭时选择权限提供的第一个选项（通常是 deny），而不是直接拒绝请求：
          // 直接抛错可能让 agent 认为客户端出错，用选项答复最符合协议预期。
          const first = (req as any)?.permission?.options?.[0]?.id;
          return {
            outcome: first
              ? { outcome: "selected", optionId: first }
              : { outcome: "cancelled" },
          };
        },
      );

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
