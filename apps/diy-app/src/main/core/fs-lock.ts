// src/main/core/fs-lock.ts
// ⚠️ 实现已迁到 `@diy-agent/os`（文件锁：pid 文件 + 原子 mkdir，防多实例冲突）。
// 这里只做转发，保住 diy-app 的调用点。
export * from "@diy-agent/os";
