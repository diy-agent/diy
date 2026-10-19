/**
 * 输入框补全的**共享源**（##377 第 11 刀 / ##166 §37.2 A）。
 *
 * 机制在 `MdEditor` 一处（可选 prop `completions`），源由调用方注入 ——
 * **不传 = 行为逐字不变**（任务对话页 / prompt lab 零影响）。
 *
 * 加一个新 trigger = 加一个文件（`task.ts` / `member.ts` 即两份样板）。
 */
export { taskCompletion } from "./task";
export { memberCompletion } from "./member";
