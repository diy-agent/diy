// @diy-agent/jobs — 后台任务**账本**（##515 第 3 步从 diy-app 抽出）
//
// 边界一句话：**工具层（@diy-agent/tools）管「一条命令怎么跑」，本包管「后台任务的账」**。
//
//   属于本包：run 表（spawn / adopt / list / get / tail / kill / wait / shutdown / prune）·
//            结局与呈现判据（四态 / 结局 / 时长 / tail 截断 / 结束通知文案）· `job` 工具面
//   不属于本包：平台能力（`JobOsCaps`：进程组 / 杀树 / 判活 / 日志重定向方式 —— 宿主注入）·
//              shell 探测与拼装（`@diy-agent/tools`）· 谁该被叫醒（`notifier`，不传 = silent）·
//              任务身份（`origin.taskUri` 只作为数据流过，不解释）· 前台→后台转交（diy-app 的 UI 能力）
//
// ⚠️ **入口按依赖性质分，不按业务领域**（2026-11-05 A5）：
//
//   `@diy-agent/jobs`       纯判据：run-status / output-ring。零 IO，renderer 也能引
//   `@diy-agent/jobs/node`  账本：RunRegistry / makeJobTool。要 spawn / fs，只有 Node 侧
//
// 之前所有东西都从 `.` 出去，renderer 想用一个 `stateLabel()` 就得把 node:child_process
// 一起拖进浏览器 —— 2026-11-04 真炸过一次（窗口纯黑）。
//
// 用法：
//   Node 侧：import { RunRegistry, makeJobTool } from "@diy-agent/jobs/node";
//   任何侧：import { stateLabel, formatDuration } from "@diy-agent/jobs";

export * from "./run-status.js";
export * from "./output-ring.js";
