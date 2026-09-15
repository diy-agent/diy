// src/main/services/runtime-context.ts
// 🎯 崩溃现场的「内存权威」：进程还活着时才存在的事实，不靠日志尾部猜
//
// 为什么需要它 —— 旧实现只从 agent 审计文件尾部取「最后一条 turn-start + 最后一条 bash」，
// 两者是**独立**取的，可能属于不同任务，多任务并发时必然张冠李戴。真实案例（2026-09-15 06:25）：
// 渲染进程崩溃时 task=100 与 task=113 的轮次在并发跑，日志拼出「task=100 的轮次 + task=113 的命令」，
// 一个根本不存在的组合，把排查引向错误方向。
//
// 内存里其实有权威答案，且拿得到：
//   activeTurns  —— 主进程此刻真正在跑的本地 agent 轮次（LocalAgentManager 的 running 会话）
//   lastRenderer —— 渲染进程最后一次 RPC 交互（它死前 UI 在动哪个任务）
// 崩溃钩子同步读取即可：无 I/O、无解析、无猜测，也不受日志轮转/截断影响。
//
// 纯内存、不落盘：进程死亡即消失 —— 这正是「崩溃现场」应有的时效语义；
// 需要跨进程死亡留痕的场景仍由 agent-audit 的 write-ahead 日志负责（两者互补，不是替代）。

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

/** 活跃轮次：taskUri → 该任务的在跑轮次（同一任务同时只允许一轮，故单值足够） */
const activeTurns = new Map<string, ActiveTurn>();
let lastRendererTouch: LastRendererTouch | null = null;

/** 轮次开始登记（LocalAgentManager.runTurn 入口调用） */
export function noteTurnStart(t: Omit<ActiveTurn, "since"> & { since?: string }): void {
  activeTurns.set(t.taskUri, { ...t, since: t.since ?? new Date().toISOString() });
}

/** 轮次结束注销（必须放 finally：异常/取消/截断都要摘掉，否则崩溃现场会挂僵尸轮次） */
export function noteTurnEnd(taskUri: string): void {
  activeTurns.delete(taskUri);
}

/** 当前活跃轮次快照（按起始时间升序，便于人读） */
export function activeTurnList(): ActiveTurn[] {
  return [...activeTurns.values()].sort((a, b) => a.since.localeCompare(b.since));
}

/** 渲染进程交互留痕（主进程 RPC 入口调用）：它崩了之后我们才知道 UI 最后在动哪个任务 */
export function noteRendererTouch(channel: string, taskUri?: string): void {
  lastRendererTouch = { channel, taskUri, at: new Date().toISOString() };
}

export function lastRenderer(): LastRendererTouch | null {
  return lastRendererTouch;
}

/** 测试用：清空全部内存态（生产不调用） */
export function resetRuntimeContext(): void {
  activeTurns.clear();
  lastRendererTouch = null;
}
