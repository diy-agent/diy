// @diy-agent/tools/shell — shell 工具（bash / pwsh）的**全部内核**：能力事实、执行器、工具定义
//
// 边界（##515）：
//   属于本包：命令拼装（buildInvocation）· 执行器（runBash：超时 / 取消 / 溢出 / 退出宽限 / 转后台句柄）·
//            结果头与语义档（result.ts）· 工具定义与用户可见文案（tool.ts）
//   不属于本包：**探测**（resolveShells —— 平台与安装位置是 OS 策略）· job 账本（background）·
//             审计落盘位置 / 任务身份（taskUri）· 投递层截断（toModelOutput）
//
// 用法：
//   · 只跑命令：`runBash(command, cwd, limits, signal, hooks, timeoutMs, spec, runtime)`
//   · 要一个给模型的工具：`makeShellTool(spec, host)`（host 全可选，见 ShellToolHost）

export * from "./spec.js";
export * from "./detect.js";
export * from "./result.js";
export * from "./run.js";
export * from "./tool.js";
export * from "./guard.js";
