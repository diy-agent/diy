// main.ts — Electron 主进程入口（**落盘模式**装配，##505）。
//
// 只剩两件事：拿装配清单（index.ts）、交给外壳启动（bootstrap.ts）。
// 业务（bot / 会话 / 模型解析 / 成本）全在 @diy-agent/bot 与 @diy-agent/model-catalog。

import { ASSEMBLY } from "./index.js";
import { runWorkbench } from "./bootstrap.js";

runWorkbench(ASSEMBLY);
