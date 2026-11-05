// node.ts — 只有 Node 侧能用的一半（2026-11-05 A5）。
//
// 拆出来之前，`@diy-agent/jobs` 的 index.ts 直接 `export * from "./run-registry.js"`，
// 而 run-registry 一上来就 `import { spawn } from "node:child_process"`。
// renderer 只要碰一下这个包（哪怕只为了一个 `stateLabel()`），整份图就被拖进浏览器 →
// 求值即 `process is not defined` → 白屏（2026-11-04 真炸过一次）。
//
// 现在的分界按**依赖性质**，不按业务领域：
//   @diy-agent/jobs         纯判据（run-status / output-ring）—— 谁都能引
//   @diy-agent/jobs/node    账本与工具面（run-registry / job-tool）—— 只有 Node 侧
//
// 判据：一个入口能不能被 renderer 引，只看它自己的依赖图里有没有 node:* / electron。

export * from "./run-registry.js";
export * from "./job-tool.js";
