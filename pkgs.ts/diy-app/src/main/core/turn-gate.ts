// src/main/core/turn-gate.ts
// 🎯 生产用的开轮准入策略（##400，TurnGate 依赖倒置的**上层那一端**）。
//
// 为什么独立成文件、而不写进 `core/task.ts`：**构建硬约束**（`pit.zod-cli-meta-order` 同款）。
//   `core/task.ts` 带 `TaskStateSchema`（zod）等 schema，被静态 import 进 `local-agent` 会把它
//   提升成**先于 `@diy/rpc` 的 cliArg 原型补丁求值**的共享 chunk —— 启动即
//   `TypeError: TaskStateSchema.cliArg is not a function`（本任务 lab 实测复现）。
//   本文件只依赖 `core/state.getTask`（type-only 引 TaskState，不牵 zod）与 shared 纯函数，
//   判据、文案、终态词表都还在任务域里，只是不把 schema 拖下水。
//
// 依赖方向：内核（`LocalAgentManager`）**不认识**本文件；由装配处（`getLocalAgent`）把本策略
//   作为 `TurnGate` 注入 —— 换一种 session 类型时换一份策略即可，内核一行不动。

import { getTask } from "./state";
import {
  isTerminalSessionState,
  terminalSessionDetail,
  TERMINAL_STATE_REASON,
  type TurnGateDecision,
  type TurnGateInput,
} from "../../shared/turn-gate";

/**
 * 生产策略：**终态任务的会话不许开轮**（`done` ⇒ `session/closed`，`cancelled` / `closed` 同拦）。
 *
 * 为什么按**文件头**判（`getTask`）而不是缓存的注册表：任务状态是用户随时手改的事实，
 * 缓存会漂；这里每轮只多读一份小 frontmatter（`chat()` 本来就要读人物与上下文）。
 *
 * 任务不存在 / 没写状态 ⇒ **放行**：这不是本策略该管的错（缺文件由后续读盘路径如实报错）。
 * 终态词表与文案在 `shared/turn-gate`（UI 的静态提示读同一份，不可能漂）。
 */
export function taskTurnGate(input: TurnGateInput): TurnGateDecision {
  const state = getTask(input.sessionUri)?.state;
  if (!isTerminalSessionState(state)) return { allow: true };
  return {
    allow: false,
    code: "session/closed",
    reason: TERMINAL_STATE_REASON[state],
    detail: terminalSessionDetail(input.sessionUri, state),
  };
}
