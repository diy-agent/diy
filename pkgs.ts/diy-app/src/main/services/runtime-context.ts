// src/main/services/runtime-context.ts
// 🎯 崩溃现场的「内存权威」里的**渲染进程维度** + 活跃轮次的**投影读口**
//
// 为什么需要它 —— 旧实现只从 agent 审计文件尾部取「最后一条 turn-start + 最后一条 bash」，
// 两者是**独立**取的，可能属于不同任务，多任务并发时必然张冠李戴。真实案例（2026-09-15 06:25）：
// 渲染进程崩溃时 task=100 与 task=113 的轮次在并发跑，日志拼出「task=100 的轮次 + task=113 的命令」，
// 一个根本不存在的组合，把排查引向错误方向。
//
// 内存里其实有权威答案，且拿得到：
//   activeTurns  —— 主进程此刻真正在跑的本地 agent 轮次（**数据在 `session-registry`**，此处只是投影读口）
//   lastRenderer —— 渲染进程最后一次 RPC 交互（它死前 UI 在动哪个任务）
// 崩溃钩子同步读取即可：无 I/O、无解析、无猜测，也不受日志轮转/截断影响。
//
// 【##240 review1 P2-3：activeTurns 的数据**不在本模块了**】
//   本模块曾经自持一张 `activeTurns` 的 Map —— 那就是"轮次在跑"的**第二份真源**，
//   与 `session-registry` 由同一批调用点驱动，随时可能漂移（R1 要的是"会话事实只存一处"）。
//   现在它**只是投影**：轮次事实由 `session-registry` 持有（含 turnId / steps / tokens /
//   model / cwd / startedAt），`activeTurnList()` 现读它的 `turn != null` 条目。
//   本模块只剩「渲染进程最后交互」这一维（注册表里没有、也不该有 —— 那是 UI 进程的事实）。
//   于是——**不许再出现第三份"谁在跑"**：要么进注册表，要么进这里，不许两处都存。
//
// 纯内存、不落盘：进程死亡即消失 —— 这正是「崩溃现场」应有的时效语义；
// 需要跨进程死亡留痕的场景仍由 agent-audit 的 write-ahead 日志负责（两者互补，不是替代）。

import { sessionRegistry } from "./session-registry";

export interface ActiveTurn {
  taskUri: string;
  model?: string;
  cwd?: string;
  /** 轮次起始 ISO 时间 */
  since: string;
}

export interface LastRendererTouch {
  /** RPC channel 全名（如 diy.agent.local.chat） */
  channel: string;
  /** 该次调用涉及的任务（能从入参取到才有） */
  taskUri?: string;
  at: string;
}

let lastRendererTouch: LastRendererTouch | null = null;

/**
 * 当前活跃轮次快照（按起始时间升序，便于人读）—— **投影**：读注册表里 `turn != null` 的条目。
 *
 * ⚠️ 读路会走到崩溃钩子（`crashScene`）：注册表的 `activeTurnList()` 是纯内存读
 * （不查 viewers、不读 queue 落盘），故这里同样无 I/O。
 */
export function activeTurnList(): ActiveTurn[] {
  return sessionRegistry.activeTurnList().map((t) => ({
    taskUri: t.uri,
    model: t.model,
    cwd: t.cwd,
    since: t.since,
  }));
}

/** 渲染进程交互留痕（主进程 RPC 入口调用）：它崩了之后我们才知道 UI 最后在动哪个任务 */
export function noteRendererTouch(channel: string, taskUri?: string): void {
  lastRendererTouch = { channel, taskUri, at: new Date().toISOString() };
}

export function lastRenderer(): LastRendererTouch | null {
  return lastRendererTouch;
}

/**
 * 测试用：清空全部内存态（生产不调用）。
 * 活跃轮次归注册表 ⇒ 这里连带清它（否则单测之间会串"僵尸轮次"）。
 */
export function resetRuntimeContext(): void {
  sessionRegistry.reset();
  lastRendererTouch = null;
}
