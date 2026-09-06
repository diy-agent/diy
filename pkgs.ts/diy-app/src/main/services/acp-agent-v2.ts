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
import { SerialQueue } from "../core/serial-queue";

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
  /** 建会话/load 时声明的额外目录（主 cwd 之外的文件 scope，不改相对路径基准） */
  additionalDirectories?: string[];
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
  /** 建会话/load 时声明的额外目录（只读快照，供 status/诊断展示） */
  readonly additionalDirectories: string[];
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
  /**
   * 会话死亡等待者（dispose/crash 时 reject）。
   * stopResolvers 只守「prompt 已发出、等 stop」的第二段；agent 崩溃时若卡在
   * `activeSession.prompt()` 第一阶段（SDK 不 resolve），光唤醒 stop 不够，
   * 在途轮次永久悬挂、连停止按钮都救不了。这里给第一段加竞速。
   */
  private deadResolvers: Array<(e: Error) => void> = [];
  /** 已死亡（dispose 后）：新 prompt 直接拒绝，不再进队列 */
  private dead = false;
  /** prompt 串行队列：同一会话的 prompt 必须串行（SDK 明确要求按序调用） */
  private promptQueue = new SerialQueue();

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

  constructor(activeSession: ActiveSession, cwd: string, private ctx: ClientContext, additionalDirectories: string[] = []) {
    this.activeSession = activeSession;
    this.sessionId = activeSession.sessionId;
    this.cwd = cwd;
    this.additionalDirectories = additionalDirectories;
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

  /** 发 prompt；同一会话的并发 prompt 串行执行（SerialQueue）。完成信号由常驻泵派发 stop 时触发 */
  async prompt(text: string): Promise<{ stopReason?: string }> {
    // 排到串行队列尾部：上一个 prompt 完全结束（stop 派发完）后才发下一个。
    // 否则两个回合的 agent_message_chunk 会交叉推送，事件无法归属到正确回合。
    return this.promptQueue.run(async () => {
      if (this.dead) throw new Error("ACP session 已释放，本轮取消");
      this.textBuf = "";
      // 注册本轮的 stop 等待者（在发 prompt 之前注册，避免漏掉瞬时 stop）
      let resolveStop!: () => void;
      const stopPromise = new Promise<void>((r) => {
        resolveStop = r;
      });
      this.stopResolvers.push(resolveStop);
      // 注册死亡竞速（dispose/crash 时 reject，防卡在 prompt 第一阶段）
      let rejectDead!: (e: Error) => void;
      const deadPromise = new Promise<never>((_, rej) => {
        rejectDead = rej;
      });
      this.deadResolvers.push(rejectDead);
      try {
        const resp = await Promise.race([this.activeSession.prompt(text), deadPromise]);
        // 等常驻泵消费到本轮的 stop（所有事件已派发完毕），再返回
        await stopPromise;
        return { stopReason: resp.stopReason };
      } finally {
        // 出错路径：stop 永远不会来，摘掉自己的等待者，防止泄漏
        const i = this.stopResolvers.indexOf(resolveStop);
        if (i >= 0) this.stopResolvers.splice(i, 1);
        const j = this.deadResolvers.indexOf(rejectDead);
        if (j >= 0) this.deadResolvers.splice(j, 1);
      }
    });
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
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 优雅退出：dispose 后不再等待 nextUpdate，直接结束泵循环。
      // 否则 dispose 调用 activeSession.dispose() 后，nextUpdate 的 reject 可能延迟，
      // 期间泵仍在消费事件，触发已 dispose 的 listener。
      if (this.disposed) break;

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
        const t = (ev.data?.content as { text?: string })?.text;
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

  /**
   * 取消当前生成。
   * session/cancel 是 notification（SDK 归类 AgentNotificationHandler），
   * 不是 request —— 用 ctx.request 发会让 agent 走 request 通道，opencode
   * 不予响应。协议约定 agent 收到后以 StopReason::Cancelled 结束本轮，
   * 常驻泵会 push stop 并唤醒 stopResolvers。
   * 兜底：立即唤醒等 stop 的调用者（若 agent 不按协议响应，队列也能续走）。
   */
  async cancel(): Promise<void> {
    await this.ctx.notify(methods.agent.session.cancel as any, {
      sessionId: this.sessionId,
    } as any);
    // 兜底唤醒：避免 agent 不响应 cancel 时 prompt 永久挂起。
    // 已 push 的 stop 会让 pump 再次走 stop 分支（幂等：resolvers 已清空）。
    for (const r of this.stopResolvers.splice(0)) r();
  }

  /** 释放本会话的流式路由（不关协议会话） */
  dispose(): void {
    this.disposed = true;
    this.dead = true;
    // 唤醒所有等待 stop 的 prompt（它们将因更新流中断而收尾）
    for (const r of this.stopResolvers.splice(0)) r();
    // 拒绝所有卡在 prompt 第一阶段的调用（crash 时 SDK 可能永不 resolve）
    const err = new Error("ACP session 已释放，本轮取消");
    for (const r of this.deadResolvers.splice(0)) r(err);
    this.activeSession.dispose();
  }

  /**
   * 通知 agent 关闭此协议会话（session/close）。
   * 与 dispose 的区别：dispose 只卸本地 update 路由；真正的会话关闭必须让
   * agent 侧释放状态，否则会在 opencode 里堆积死会话（每次 closeSession +
   * 再对话都在 agent 内留一个壳）。
   */
  async close(): Promise<void> {
    await this.ctx.request(methods.agent.session.close, { sessionId: this.sessionId });
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
  /** 进程是否已退出 */
  private exited = false;
  /** 是否已显式关闭（dispose 后不允许再启） */
  private disposed = false;
  /** 正在进行的重建连接（崩溃自愈并发去重：多个调用共享同一次 spawn） */
  private connectingPromise: Promise<void> | null = null;
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

  /**
   * 崩溃自愈：若进程已退出则重建连接（重 spawn + initialize）。
   * 返回是否发生了重建。轻量幂等 —— alive 时直接返回 false，无开销。
   * dispose 之后调用抛错（显式关闭不允许复活）。
   *
   * 重建后会话凭据仍在：sessionId 持久化在 project meta.yaml，
   * pool 的后续 ensure 会走 loadSession 恢复，上下文不丢。
   */
  async ensureConnected(): Promise<boolean> {
    if (this.alive) return false;
    if (this.disposed) {
      throw new Error("ACP agent 已显式关闭，不允许重连");
    }
    // 并发去重：崩溃后多个 task 同时 ensure 会各自通过 alive 检查 →
    // 每人 spawn 一个新进程。共享同一次重建，失败也共享同一个错误。
    if (!this.connectingPromise) {
      this.connectingPromise = (async () => {
        this.sessions.clear();      // 旧进程的会话路由全部失效
        this.exited = false;
        this.readyPromise = this.connect();
        await this.readyPromise;
      })();
    }
    try {
      await this.connectingPromise;
    } finally {
      // 无论成败都释放槽位：失败后下次调用可再重试，成功则后续走 alive 短路
      this.connectingPromise = null;
    }
    return true;
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

  /** 新建会话（cwd=主目录；additionalDirectories=额外 scope，不改相对路径基准） */
  async newSession(cwd: string, additionalDirectories: string[] = []): Promise<AcpSessionV2> {
    const activeSession = await this.ctx
      .buildSession(cwd)
      .withAdditionalDirectories(additionalDirectories)
      .start();
    const sess = new AcpSessionV2(activeSession, cwd, this.ctx, additionalDirectories);
    this.sessions.set(sess.sessionId, sess);
    return sess;
  }

  /** 恢复已有会话（loadSession）。
   *  load 的 additionalDirectories 是**全量设置**（替换 agent 侧存量），
   *  所以每次恢复都必须重带，否则之前声明的额外 scope 会丢。 */
  async loadSession(sessionId: string, cwd: string, additionalDirectories: string[] = []): Promise<AcpSessionV2> {
    // 1. 调用 session/load 恢复 agent 侧会话
    //    响应体的 configOptions 必须留下来：恢复出来的会话若没有它，
    //    currentModelId / availableModels 全是空 —— 界面上就显示不出当前模型。
    const loadResp = (await this.ctx.request(methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
      additionalDirectories,
    } as any)) as { configOptions?: SessionConfigOptionLike[] } | undefined;

    // 2. 构造包含 sessionId 的响应对象，用于 SDK 内部路由设置
    //    LoadSessionResponse 没有 sessionId（在 request 里），需要构造一个 fake NewSessionResponse
    const fakeResponse = {
      sessionId,
      configOptions: loadResp?.configOptions ?? [],
    } as any;

    // 3. 使用 SDK 内部 attachSession 创建 ActiveSession（设置 session/update 路由）
    //    ⚠️ attachSession 是 private（SDK v1 未公开「恢复会话」的公开入口），
    //    通过类型断言访问。升级 SDK 前必须确认该方法仍在：
    //    若被改名/移除，这里会拿到 undefined 并在调用的瞬间抛 TypeError，
    //    错误信息不明所以 —— 所以先做能力探测，失败时给可定位的提示。
    const rawCtx = this.ctx as unknown as { attachSession?: (response: unknown) => ActiveSession };
    if (typeof rawCtx.attachSession !== "function") {
      throw new Error(
        "[acp] @agentclientprotocol/sdk 的 attachSession 私有方法不存在 —— " +
        "SDK 版本变更破坏了 loadSession 恢复能力，请升级本代码或锁定 SDK 版本",
      );
    }
    const activeSession = rawCtx.attachSession(fakeResponse);

    const sess = new AcpSessionV2(activeSession, cwd, this.ctx, additionalDirectories);
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

  /** 关闭连接 */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill();
    }
  }
}
