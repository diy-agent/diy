// src/main/services/acp-sessions-v2.ts
// 🎯 task 级 ACP session 池 V2 — 官方 SDK 版 (opencode 优先)
//
// 与旧 acp-sessions.ts（自建协议版，已删除）对照：
//   - 底层用 AcpAgentV2/AcpSessionV2（官方 @agentclientprotocol/sdk）
//   - 支持 opencode 会话级热切模型（session/set_model）
//   - 支持 loadSession 恢复会话
//   - 持久化 sessionId 到 project meta.yaml（复用 acp-sessions-persist.ts 的纯函数）
//
// 接口与 TaskSessionPool 对齐，便于 diff 对比。

import { AcpAgentV2, AcpSessionV2, type AcpModel } from "./acp-agent-v2";
import { readTaskSessionId, writeTaskSessionId, clearTaskSessionId } from "./acp-sessions-persist";
import { createLogSink, getInstalledHome } from "./diagnostics";
import { projectFromUri } from "../core/state";
import { getProjectPath } from "../core/project";

export class TaskSessionPoolV2 {
  private agent: AcpAgentV2;
  /** taskUri → session */
  private sessions = new Map<string, AcpSessionV2>();
  /** taskUri → 正在进行的建/恢复 promise（并发去重） */
  private ensuring = new Map<string, Promise<AcpSessionV2>>();
  /** taskUri → 流式对话互斥链（整个事件流排他：订阅→prompt→收完 stop 才放行） */
  private streamLocks = new Map<string, Promise<void>>();
  /** agent 崽溃回调 */
  private onCrashCallbacks = new Set<() => void>();

  /**
   * 以互斥方式跑一段 async 生成器：同一 task 的流式对话严格串行。
   * 必须串到「整个流」而不是只串 prompt 发送 —— 事件泵是会话级广播，
   * streamChatEvents 在发 prompt 前就订阅了，两个并发流会互相收到
   * 对方回合的事件。串行订阅+收流才能保证归属性。
   * 用法：yield* this.runExclusive(taskUri, async function* () { ... })
   */
  private async* runExclusive(
    taskUri: string,
    body: () => AsyncGenerator<string>,
  ): AsyncGenerator<string> {
    const prev = this.streamLocks.get(taskUri) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // 队列尾 = 上一个流收尾（gate 打开）后才轮到本次；上次失败的错误
    // 已向调用方传播，这里不能让它污染链条（否则后续流全被同一个错误卡死）
    this.streamLocks.set(taskUri, prev.then(() => gate, () => gate));
    await prev.catch(() => undefined);
    try {
      yield* body();
    } finally {
      release();
    }
  }

  constructor(command = "opencode acp") {
    // agent stderr 独立落 <DIY_HOME>/log/acp.log：分文件是故意的 —— 对方的输出量
    // 不该把自家 main.log 滚掉；诊断未安装时给 undefined，agent 侧仍会读走并丢弃。
    const home = getInstalledHome();
    this.agent = new AcpAgentV2({
      command,
      cwd: process.cwd(),
      autoApprovePermission: true,
      stderrSink: home ? createLogSink(home, "acp") : undefined,
    });

    // 监听进程退出
    this.agent.onExit((code) => {
      if (code !== 0) {
        console.error(`[acp] agent 进程退出 (code=${code})`);
      }
      this.sessions.clear();
      for (const fn of this.onCrashCallbacks) fn();
    });
  }

  /** 注册 agent 崽溃回调 */
  onCrash(fn: () => void): () => void {
    this.onCrashCallbacks.add(fn);
    return () => this.onCrashCallbacks.delete(fn);
  }

  /** agent 是否存活 */
  get alive(): boolean {
    return this.agent.alive;
  }

  /** 等待连接就绪 */
  async ready(): Promise<void> {
    await this.agent.ready();
  }

  /** 取某 task 的 session：优先恢复，无则新建 */
  async ensure(taskUri: string): Promise<AcpSessionV2> {
    if (!this.alive) {
      throw new Error("ACP agent 进程已退出，无法创建 session");
    }

    const existing = this.sessions.get(taskUri);
    if (existing) return existing;

    // 并发去重：check-act 之间有 await 缺口，两个并发请求都能通过上面的
    // miss 检查 → 同一个 task 会建出两个 session（都写 meta.yaml、都塞 map，
    // 先建的变孤儿）。这里用 inflight promise 合并：同 task 的建/恢复只跑一次。
    let inFlight = this.ensuring.get(taskUri);
    if (!inFlight) {
      inFlight = this.loadOrCreate(taskUri).finally(() => {
        this.ensuring.delete(taskUri);
      });
      this.ensuring.set(taskUri, inFlight);
    }
    const session = await inFlight;
    this.sessions.set(taskUri, session);
    return session;
  }

  /** 按 project 目录建/恢复 session */
  private async loadOrCreate(taskUri: string): Promise<AcpSessionV2> {
    await this.agent.ready();

    const pid = projectFromUri(taskUri);
    const cwd = (pid ? getProjectPath(pid) : undefined) ?? process.cwd();

    // 尝试恢复持久化的 sessionId
    const savedId = readTaskSessionId(taskUri);
    if (savedId) {
      try {
        const sess = await this.agent.loadSession(savedId, cwd);
        this.sessions.set(taskUri, sess);
        return sess;
      } catch {
        // 恢复失败 → 回退新建
        clearTaskSessionId(taskUri);
      }
    }

    // 新建
    const sess = await this.agent.newSession(cwd);
    writeTaskSessionId(taskUri, sess.sessionId);
    return sess;
  }

  /**
   * 向某 task 的 session 流式对话：yield 文本增量。
   * 多次调用同一 task 的 prompt，session 上下文连续。
   * 整个流（订阅→prompt→收完 stop）在 runExclusive 互斥下串行：
   * 事件泵是会话级广播，只串 prompt 发送挡不住「B 流收到 A 回合事件」。
   */
  async *streamChat(
    taskUri: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const session = await this.ensure(taskUri);
    yield* this.runExclusive(taskUri, async function* () {
      // 切模型。只有「agent 没实现这个方法」(-32601) 才允许静默保持原模型；
      // 其它失败（模型名写错、参数不合法…）必须冒出来 —— 以前一律 catch 掉，
      // 结果是用户以为切了、实际还在旧模型上跑，且不留任何痕迹。
      if (model && model !== session.currentModelId) {
        try {
          await session.setModel(model);
        } catch (e) {
          if ((e as { code?: number })?.code !== -32601) {
            console.error(`[acp] 切换模型到 "${model}" 失败：${(e as Error)?.message ?? e}`);
            throw e;
          }
          console.warn(`[acp] agent 不支持 session/set_model，保持原模型 ${session.currentModelId ?? "?"}`);
        }
      }

      // 文本增量队列 + 完成/唤醒信号
      const queue: string[] = [];
      let ended = false;
      let wake: (() => void) | null = null;
      const kick = () => { wake?.(); wake = null; };

      const unsub = session.onEvent((ev) => {
        if (ev.kind === "agent_message_chunk") {
          const text = (ev.data["content"] as { text?: string })?.text;
          if (text) { queue.push(text); kick(); }
        }
      });

      try {
        const promptText = messages.map((m) => m.content).join("\n");
        const promptDone = session
          .prompt(promptText)
          .finally(() => { ended = true; kick(); });

        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          if (ended) break;
          await new Promise<void>((r) => {
            wake = r;
            if (queue.length > 0 || ended) r();
          });
        }
        await promptDone;
      } finally {
        unsub();
      }
    });
  }

  /**
   * 向某 task 的 session 流式对话：yield 完整 ACP 事件（JSON 字符串）。
   * 与 streamChat 的区别：不只返回文本增量，而是返回所有 session/update 通知，
   * 包括 agent_message_chunk、tool_call_update、agent_thought_chunk 等。
   * 整个流（订阅→prompt→收完 stop）在 runExclusive 互斥下串行：
   * 事件泵是会话级广播，只串 prompt 发送挡不住「B 流收到 A 回合事件」。
   */
  async *streamChatEvents(
    taskUri: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const session = await this.ensure(taskUri);
    yield* this.runExclusive(taskUri, async function* () {
      if (model && model !== session.currentModelId) {
        try {
          await session.setModel(model);
        } catch (e) {
          if ((e as { code?: number })?.code !== -32601) {
            console.error(`[acp] 切换模型到 "${model}" 失败：${(e as Error)?.message ?? e}`);
            throw e;
          }
          console.warn(`[acp] agent 不支持 session/set_model，保持原模型 ${session.currentModelId ?? "?"}`);
        }
      }

      // 事件队列（JSON 字符串）+ 完成/唤醒信号
      const queue: string[] = [];
      let ended = false;
      let wake: (() => void) | null = null;
      const kick = () => { wake?.(); wake = null; };

      // 订阅所有事件，序列化为 JSON yield
      const unsub = session.onEvent((ev) => {
        queue.push(JSON.stringify(ev));
        kick();
      });

      try {
        const promptText = messages.map((m) => m.content).join("\n");
        const promptDone = session
          .prompt(promptText)
          .finally(() => { ended = true; kick(); });

        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          if (ended) break;
          await new Promise<void>((r) => {
            wake = r;
            if (queue.length > 0 || ended) r();
          });
        }
        await promptDone;
      } finally {
        unsub();
      }
    });
  }

  /** 非流式对话：聚合流式增量为完整回复。 */
  async chat(
    taskUri: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ role: string; content: string }> {
    const collected: string[] = [];
    for await (const t of this.streamChat(taskUri, model, messages)) collected.push(t);
    return { role: "assistant", content: collected.join("") };
  }

  /**
   * 某 task 的 session 状态。
   * ⚠️ 只读语义：不得调 ensure() —— 那会顺手建会话（起子进程 + 写 meta.yaml），
   * 一个「查状态」的查询不该有这种副作用，UI 每次切换任务都调它更是灾难。
   */
  async status(
    taskUri: string,
  ): Promise<{ taskUri: string; state: "ready" | "no_session"; model?: string }> {
    const session = this.sessions.get(taskUri);
    if (!session) return { taskUri, state: "no_session" };
    return { taskUri, state: "ready", model: session.currentModelId };
  }

  /** 列出可用模型（从 opencode configOptions 解析）；refresh=true 绕过缓存重新探测 */
  async listModels(refresh = false): Promise<AcpModel[]> {
    return this.agent.listModels(refresh);
  }

  /** 热切模型（opencode 会话级） */
  async setModel(taskUri: string, modelId: string): Promise<void> {
    const session = await this.ensure(taskUri);
    await session.setModel(modelId);
  }

  /** 设置会话配置选项（effort / mode 等） */
  async setConfigOption(taskUri: string, configId: string, value: string): Promise<void> {
    const session = await this.ensure(taskUri);
    await session.setConfigOption(configId, value);
  }

  /** 运行切换 autoApprove（下放到 agent 的权限 handler，立即生效） */
  setAutoApprove(enabled: boolean): void {
    this.agent.setAutoApprove(enabled);
  }

  /** 当前 autoApprove 状态 */
  get autoApprove(): boolean {
    return this.agent.autoApprovePermission;
  }

  /** 获取会话配置选项 */
  getConfigOptions(taskUri: string): Array<{ id: string; name?: string; category?: string; currentValue?: string; options?: Array<{ value: string; name?: string }> }> {
    const s = this.sessions.get(taskUri);
    return s?.getConfigOptions() ?? [];
  }

  /** 关闭某 task 的 session */
  async closeSession(taskUri: string): Promise<void> {
    const s = this.sessions.get(taskUri);
    if (s) {
      s.dispose();
      this.sessions.delete(taskUri);
    }
    clearTaskSessionId(taskUri);
  }

  /** 关闭所有（app 退出时） */
  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    await this.agent.dispose();
  }
}
