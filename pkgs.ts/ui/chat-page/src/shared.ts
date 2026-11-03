// shared.ts — 主进程与 renderer 之间的线上形状（两端共用）。
//
// ##505：形状的真源搬到 `@diy-agent/bot/protocol` —— `createBotChat()` 产出的就是它，
// 会话消息 → 消息线的归一化（`wireOf`）也在那一侧的主进程里做。本文件只做 re-export，
// 让既有 import（`./shared.js`）原地不动。
//
// 子路径 `@diy-agent/bot/protocol` 是**纯的**（无 node:*）：renderer 引它不会把
// 文件系统带进浏览器包。

export * from "@diy-agent/bot/protocol";
