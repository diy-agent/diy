// src/main/services/session-registry.ts
// 🎯 会话 / 轮次注册表 —— 「本次 main 进程启动后活跃过哪些会话」的**唯一真源**（##240）。
//
// 【为什么是内存态、为什么不需要落盘 / 时间戳】
//   用户 2026-10-15 拍板：注册表语义 = 「本次启动后活跃过的会话」，启动即空 —— 空表**本身就是**
//   「本次启动」的边界，故不记启动时间、不落盘、不枚举历史（扫 ops 文件反解 uri 已明令取消）。
//   轮次结束**只清 `turn`、条目保留**（R5）：于是"活跃过"零成本地成立（turnCount ≥ 1 即证据）。
//
// 【设计原则：日志不是 core 依赖】（rule.core-log，用户 2026-10-15）
//   本模块的状态**自成真源**、可独立序列化；事件（帧）只用于**通知**别的 module / view，
//   丢了不影响运行；横向关联靠**显式 ref**（id / turnId / taskUri），不靠共享日志。
//
// 【与既有四张表的关系】（body「概念架构定稿」§1）
//   改造前同一 `taskUri` 摊在 sessions / turns / activeTurns / feeds 四张表上，各有各的口径。
//   本模块把「会话事实」收成一处：`sessions`（内容装载态）、`turns`（在途轮次驱动）**继续归
//   local-agent**（它们描述的是"怎么跑"，不是"有哪些会话"）；`feeds`（op 广播）归 ops-feed
//   （##307，本任务**不动**）。本表只回答：**有哪些会话、各自现在什么状态、谁在看、排了几条**。
//
//   `runtime-context.activeTurns`（「此刻在跑」）**已收敛为本表的投影**（review1 P2-3 选 A）：
//   它原来是第二份"轮次在跑"的真源，与这里由同一批调用点驱动、随时可能漂移。现在它只剩
//   `lastRendererTouch`（崩溃现场的另一维），`activeTurnList()` 直接读本模块的 `turn != null`
//   条目 —— R1「会话事实只存一处」在文字上成立。
//
// 【R3 观测不污染】本模块的订阅者（`sessions` / `--watch`）**不计入 `viewers`** ——
//   `viewers` 只由**内容**订阅者（chat 流 + op 流）构成，答案必须由 local-agent 注入（见 deps）。
//   否则注册表一开，全库会话都显示「有人看」。

import type { TurnEndReason } from "./local-blocks";
import { AsyncQueue, withCleanup } from "./async-queue";
import { opsFeed } from "./ops-feed";
import { sessionIdOf } from "../core/local-paths";
import type { RegistryFrame, SessionEntry, SessionRef, SessionTurn } from "../../shared/registry-frame";

export type { RegistryFrame, SessionEntry, SessionRef, SessionTurn };

/**
 * 活态属性的取值器（由 local-agent **覆盖**，见下方 defaultDeps）。
 *
 * 为什么注入而不是 import local-agent：反向依赖会成环（local-agent 已经要 import 本模块去
 * noteTurnStart）。这两个值**不是注册表的状态**，是"此刻的事实"（R2：状态 ⊥ 内容），
 * 每次构造条目视图时现算。
 */
export interface SessionRegistryDeps {
  /** 内容观察者数（chat 流 `run.subs` + op 流订阅者；见 LocalAgentManager.watchers） */
  viewersOf(taskUri: string): number;
  /** 待投递留言条数（steer 队列，##306） */
  queueOf(taskUri: string): number;
}

/**
 * 缺省取值器 —— **不是"没有观察者"**。
 *
 * `viewers` 的两个来源里，op 流订阅者属于 ops-feed（与 LocalAgentManager 是否实例化无关：
 * UI 打开某会话只是想看内容时，manager 往往还没被构造出来）。缺省直接问 ops-feed，
 * 于是"只被打开、没说过话"的会话也能报出真观察者数（review1 P2-1 缺口 C）。
 * 另一半（chat 流订阅者 `run.subs`）只存在于 manager 里，故 manager 注入的是它的超集。
 */
const defaultDeps: SessionRegistryDeps = {
  viewersOf: (uri) => opsFeed.subscriberCount(uri),
  queueOf: () => 0, // 待投递留言队列归 manager；manager 未构造 = 没有队列，0 是事实而非占位
};

/** 注册表内核条目（不含活态属性 viewers / queue —— 那两个是取值器给的） */
interface CoreEntry {
  /** 内部键（= taskUri）；对外 id 由 sessionIdOf 派生，见 `SessionEntry.id` */
  uri: string;
  refs: SessionRef[];
  turn: {
    turnId: string;
    steps: number;
    tokens: number;
    /** 心跳（每步刷新）—— 卡死/无进展判据的输入 */
    lastOpAt: string;
    /** 起始时刻（不随步进变）；`agent.local.running.since` 与崩溃现场都读它 */
    startedAt: string;
    model?: string;
    cwd?: string;
  } | null;
  firstSeenAt: string;
  lastActivity: string;
  turnCount: number;
  lastEndReason: TurnEndReason | null;
  totalSteps: number;
  totalTokens: number;
}

class SessionRegistry {
  /** uri → 条目（只增不减：轮次结束清 turn 但**不删条目**，R5） */
  private entries = new Map<string, CoreEntry>();
  /** 注册表订阅者（**不等于** viewers，R3） */
  private subs = new Set<AsyncQueue<RegistryFrame>>();
  private deps: SessionRegistryDeps = defaultDeps;

  constructor() {
    // 「谁在看」是活态属性 → 内容订阅者增 / 退必须**变化即推帧**（review1 P2-1 缺口 A/B）：
    //   ① 订阅发生 = 一次真实的"活跃"（会话被打开）⇒ `noteActivity` 会建档，
    //      "打开·未通讯"这一格才有东西可显示；
    //   ② viewers 归零 / 翻 detached 也能在一行内被 `--watch` 看到。
    // 挂在**内容总线**上而不是 RPC 绑定处：所有内容订阅（UI 窗口 / CLI / 别的 agent）都经它，
    // 而注册表自身的订阅者不经它 ⇒ R3「观测不污染」天然成立。
    opsFeed.setSubsChangedListener((uri) => this.noteActivity(uri));
  }

  /** local-agent 启动时注入活态取值器（测试可直接摆桩） */
  setDeps(deps: SessionRegistryDeps): void {
    this.deps = deps;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private entry(uri: string): CoreEntry {
    let e = this.entries.get(uri);
    if (!e) {
      const t = this.now();
      e = {
        uri,
        refs: [{ kind: "task", uri }],
        turn: null,
        firstSeenAt: t,
        lastActivity: t,
        turnCount: 0,
        lastEndReason: null,
        totalSteps: 0,
        totalTokens: 0,
      };
      this.entries.set(uri, e);
    }
    return e;
  }

  /** 内核条目 + 活态属性 → 对外视图（订阅 / 快照唯一出口） */
  private view(e: CoreEntry): SessionEntry {
    const viewers = this.deps.viewersOf(e.uri);
    return {
      id: sessionIdOf(e.uri),
      refs: e.refs.map((r) => ({ ...r })),
      turn: e.turn ? { ...e.turn, state: viewers > 0 ? "active" : "detached" } : null,
      queue: this.deps.queueOf(e.uri),
      viewers,
      firstSeenAt: e.firstSeenAt,
      lastActivity: e.lastActivity,
      turnCount: e.turnCount,
      lastEndReason: e.lastEndReason ? { ...e.lastEndReason } : null,
      totalSteps: e.totalSteps,
      totalTokens: e.totalTokens,
    };
  }

  /** 推一条变更（订阅者为空时只更新状态，不构造帧 —— 与 ops-feed 同策略） */
  private emit(uri: string): void {
    const e = this.entries.get(uri);
    if (!e || this.subs.size === 0) return;
    const frame: RegistryFrame = { kind: "upsert", entry: this.view(e) };
    for (const q of this.subs) q.push(frame);
  }

  /** 一条会话开始活动就被"见过"（轮次开始 / 留言 / 任何 noteX 都会建条目） */
  private touch(e: CoreEntry): void {
    e.lastActivity = this.now();
    this.emit(e.uri);
  }

  // ─── 变更入口（local-agent 驱动显式调用；数据来源是内存态，不靠日志反推）───

  /**
   * 轮次开始：建 turn（steps=0 / tokens=0），条目"见过即留痕"。
   *
   * `turnId` 可省（生成一个）—— 调用方（local-agent）总有真 turnId；省缺只服务"只想表达
   * 有一轮在跑"的调用方（如崩溃现场的单测）。`model` / `cwd` 是**该轮的事实**，必须收下并
   * 出现在 `SessionEntry.turn` 里，否则 `agent.local.running` 的消费方要再拉一次做字段合并
   * （review1 P2-2）。
   */
  noteTurnStart(uri: string, opts: { turnId?: string; model?: string; cwd?: string }): void {
    const e = this.entry(uri);
    const t = this.now();
    e.turn = {
      turnId: opts.turnId ?? `t${Date.now()}`,
      steps: 0,
      tokens: 0,
      lastOpAt: t,
      startedAt: t,
      model: opts.model,
      cwd: opts.cwd,
    };
    this.touch(e);
  }

  /** 步进（每步 start-step）：更新已跑步数与心跳 */
  noteTurnStep(uri: string, steps: number): void {
    const e = this.entries.get(uri);
    if (!e || !e.turn) return;
    e.turn.steps = steps;
    e.turn.lastOpAt = this.now();
    this.touch(e);
  }

  /** 本轮 tokens（每步 finish-step 后同步账本值） */
  noteTurnUsage(uri: string, tokens: number): void {
    const e = this.entries.get(uri);
    if (!e || !e.turn) return;
    e.turn.tokens = tokens;
    e.turn.lastOpAt = this.now();
    this.touch(e);
  }

  /**
   * 轮次结束（R5）：**只清 turn、条目保留**，turnCount +1、记末轮 endReason。
   * 累计 steps / tokens 累进（跨轮）。
   *
   * 幂等：turn 已清（closeTurn 已收口）时再调只更新 lastActivity —— driveTurn 的兜底注销
   * 与 runTurn 的 closeTurn 收口路径会各调一次，不许因此把 turnCount 加两遍。
   */
  noteTurnEnd(uri: string, endReason: TurnEndReason, info?: { steps?: number; tokens?: number }): void {
    const e = this.entries.get(uri);
    if (!e) return;
    if (!e.turn) {
      this.touch(e);
      return;
    }
    const steps = info?.steps ?? e.turn.steps;
    const tokens = info?.tokens ?? e.turn.tokens;
    e.totalSteps += steps;
    e.totalTokens += tokens;
    e.turn = null;
    e.turnCount += 1;
    e.lastEndReason = endReason;
    this.touch(e);
  }

  /** 活态属性变化（留言入队 / 出队；viewers 变化留缝）—— 让订阅方拿到新快照值 */
  noteActivity(uri: string): void {
    const e = this.entries.get(uri);
    if (!e) {
      // 从未见过的会话被留言 = 一次真实的"活跃"，值得建条目
      this.touch(this.entry(uri));
      return;
    }
    this.touch(e);
  }

  /**
   * 此刻**在跑**的轮次（`turn != null` 的条目），按起始时间升序。
   *
   * ⚠️ 与 `snapshot()` 的关键差别：**不碰 deps**（不查 viewers、不读 queue 落盘）。
   * 它的读路是 `agent.local.running` 与崩溃现场（`crashScene`）—— 后者跑在崩溃钩子里，
   * 同步、不许任何 I/O，更不能去碰 manager。故这里只做纯内存读。
   */
  activeTurnList(): Array<{
    uri: string;
    turnId: string;
    model?: string;
    cwd?: string;
    since: string;
    steps: number;
    tokens: number;
  }> {
    const out: Array<{
      uri: string;
      turnId: string;
      model?: string;
      cwd?: string;
      since: string;
      steps: number;
      tokens: number;
    }> = [];
    for (const e of this.entries.values()) {
      const t = e.turn;
      if (!t) continue;
      out.push({ uri: e.uri, turnId: t.turnId, model: t.model, cwd: t.cwd, since: t.startedAt, steps: t.steps, tokens: t.tokens });
    }
    return out.sort((a, b) => a.since.localeCompare(b.since));
  }

  // ─── 读侧 ───

  /** 全量快照（按 firstSeenAt 升序 = 人读顺序） */
  snapshot(): SessionEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))
      .map((e) => this.view(e));
  }

  /** 注册表自身的订阅者数（测试用；**不许**混进 viewers，R3） */
  subscriberCount(): number {
    return this.subs.size;
  }

  /**
   * 订阅注册表（`agent.local.sessions` 的实现）：
   *   ① 首帧 `snapshot`（全量）；
   *   ② `watch=true` 时持续推 upsert；否则**只给一份快照就结束**（CLI 无参即此路径）。
   *
   * ⚠️ 本订阅**不进 `viewers`**（R3）：注册表是"看状态"，不是"看内容"。
   */
  subscribe(opts: { watch?: boolean; signal?: AbortSignal } = {}): AsyncIterable<RegistryFrame> {
    const q = new AsyncQueue<RegistryFrame>();
    q.push({ kind: "snapshot", entries: this.snapshot() });
    if (!opts.watch) {
      q.close();
      return q;
    }
    this.subs.add(q);
    // signal：传输断开时即时退订（否则悬挂的 next() 会让订阅滞留到下一次 emit）
    return withCleanup(q, () => {
      this.subs.delete(q);
    }, opts.signal);
  }

  /** 测试用：清空全部内存态（生产不调用 —— 生产靠进程退出，这正是"本次启动"语义） */
  reset(): void {
    this.entries.clear();
    for (const q of this.subs) q.close();
    this.subs.clear();
    this.deps = defaultDeps;
  }
}

export const sessionRegistry = new SessionRegistry();
