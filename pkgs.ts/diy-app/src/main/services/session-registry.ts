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
// 【R3 观测不污染】本模块的订阅者（`sessions` / `--watch`）**不计入 `viewers`** ——
//   `viewers` 只由**内容**订阅者（chat 流 + op 流）构成，答案必须由 local-agent 注入（见 deps）。
//   否则注册表一开，全库会话都显示「有人看」。

import type { TurnEndReason } from "./local-blocks";
import { AsyncQueue, withCleanup } from "./async-queue";
import { sessionIdOf } from "../core/local-paths";
import type { RegistryFrame, SessionEntry, SessionRef, SessionTurn } from "../../shared/registry-frame";

export type { RegistryFrame, SessionEntry, SessionRef, SessionTurn };

/**
 * 活态属性的取值器（由 local-agent 注入）。
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

/** 注册表内核条目（不含活态属性 viewers / queue —— 那两个是取值器给的） */
interface CoreEntry {
  /** 内部键（= taskUri）；对外 id 由 sessionIdOf 派生，见 `SessionEntry.id` */
  uri: string;
  refs: SessionRef[];
  turn: { turnId: string; steps: number; tokens: number; lastOpAt: string } | null;
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
  private deps: SessionRegistryDeps = { viewersOf: () => 0, queueOf: () => 0 };

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

  /** 轮次开始：建 turn（steps=0 / tokens=0），条目"见过即留痕" */
  noteTurnStart(uri: string, opts: { turnId: string; model?: string; cwd?: string }): void {
    const e = this.entry(uri);
    const t = this.now();
    e.turn = { turnId: opts.turnId, steps: 0, tokens: 0, lastOpAt: t };
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
    this.deps = { viewersOf: () => 0, queueOf: () => 0 };
  }
}

export const sessionRegistry = new SessionRegistry();
