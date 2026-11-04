// src/main/core/rm.ts
// ⚠️ 实现已迁到 `@diy-agent/os`（rm.ts —— Windows 两段式删除是**平台约束**）。
// 这里只做转发，保住 project.ts / fs-lock.ts 的调用点。
export { removeDirRobust } from "@diy-agent/os";
