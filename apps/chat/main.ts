// main.ts — Electron 主进程入口（**落盘模式**装配，##505）。
//
// 只剩两件事：拿装配清单（index.ts）、交给外壳启动（bootstrap.ts）。
// 业务（bot / 会话 / 模型解析 / 成本）全在 @diy-agent/bot 与 @diy-agent/model-catalog。

import { setDefaultAutoSelectFamily } from "node:net";
import { setDefaultResultOrder } from "node:dns";
import { ASSEMBLY } from "./index.js";
import { runWorkbench } from "./bootstrap.js";

// ⚠️ 网络兜底，与 diy-app 的 main 同一份判据（那边实测过，这边漏了 ⇒ 发消息必超时）：
//   ① 关 Happy Eyeballs：本机 Node 的双栈竞态对公网 HTTPS 一律 ETIMEDOUT（curl / bun 正常）；
//   ② 钉死 IPv4 优先：本机没有 IPv6 出口，AAAA 排头就 ENETUNREACH。
// 症状极具误导性：界面表现为「发消息没回复 / 请求超时」，而 curl 同一个 URL 秒回 200。
setDefaultAutoSelectFamily(false);
setDefaultResultOrder("ipv4first");
console.log("[net] 已关闭 Happy Eyeballs + IPv4 优先（与 diy-app 同判据）");

runWorkbench(ASSEMBLY);
