// src/shared/persona.ts
// 人物（persona）的 schema / 类型 / 内置缺省值的**唯一源**已移到 `@diy-agent/bot`
// （##470：bot = 人设，一个概念）。本文件只做转发：旧导入路径 `shared/persona` 不动调用方。
//
// 走子路径 `@diy-agent/bot/persona` 而不是包主入口：主入口带文件存储（node:fs），
// renderer 会打进包（见 packages 的 exports）。本文件仍是纯 zod、无 node 依赖。
export * from "@diy-agent/bot/persona";
