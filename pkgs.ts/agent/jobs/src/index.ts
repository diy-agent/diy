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
// 用法：
//   const registry = new RunRegistry({ rootDir, caps, shells, notifier });
//   const job = makeJobTool({ registry, visible: (r) => r.origin?.taskUri === taskUri });

export * from "./run-status.js";
export * from "./run-registry.js";
export * from "./job-tool.js";
