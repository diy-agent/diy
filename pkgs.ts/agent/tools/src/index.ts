// @diy-agent/tools — diy 工具层内核（read / write / edit + 文件读写原语）
//
// 边界一句话：**只依赖 cwd 与可选回调**，不碰任务系统 / Electron / 应用数据根。
// 宿主（apps/diy-app）把 bash / job 这类带进程与任务身份的工具在自己的装配里补上。
//
//   const tools = buildTools({ cwd, limits, onAudit });
//   tools.read / tools.write / tools.edit
export * from "./build.js";
// shell（bash / pwsh）：能力事实 + 执行器 + 工具定义（##515）
export * from "./shell/index.js";
export type { ToolAuditEvent, ToolLimits } from "./types.js";
// 文件读写原语（宿主别的层也用：CLI、投递层截断、草稿/任务写入……）
export * from "./atomic-write.js";
export * from "./file-read.js";
export * from "./file-write.js";
export * from "./file-edit.js";
export * from "./unified-diff.js";
