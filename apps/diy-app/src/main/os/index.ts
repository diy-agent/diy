// src/main/os/index.ts
// ⚠️ 实现已迁到 `@diy-agent/os`（OS 平台差异的唯一真源）。
//
// 为什么迁：posix / win32 的策略分歧、shell 探测、进程树、进程采样 —— 这些是**平台约束**，
// 不是 diy-app 的业务。留在要废弃的 app 里 ⇒ 新宿主（apps/chat / web）拿不到，
// 遇到 Windows 差异只能重新踩一遍（`win32.ts` 408 行全是这类实测）。
//
// 这里只做转发，保住 diy-app 里所有 `from "../os"` 的调用点。
export * from "@diy-agent/os";
