// main-memory.mjs — Electron 主进程入口（**内存模式**装配，原 ##504 / ##505-E）。
//
// 与 main.ts 的差别只有注入的宿主：bot / 会话全在内存（`$DIY_HOME` 下只读配置）。

import { createBotChat, createMemoryBotStore } from "@diy-agent/bot";
import { openMemorySessionStore } from "@diy-agent/session";
import { runWorkbench } from "./bootstrap.js";
import { createAssembly } from "./index.js";
import { MEMORY_TITLE } from "./title.js";

const home = process.env["DIY_HOME"];

// 一个 store 两个页面共用：聊天页与「Bot 配置」页必须看到同一批 bot（##505 bug）。
const botStore = createMemoryBotStore();
// 空库 ⇒ 照常走首启引导（不偷偷替人建 bot）；store 一个字节都不落盘。
const sessions =
    home === undefined
        ? undefined
        : createBotChat({
              home,
              botStore,
              openSessionStore: () => openMemorySessionStore(),
              // meta.json 也不写：$DIY_HOME/bots 与 $DIY_HOME/sessions 一个字节不碰
              persistMeta: false,
          });

runWorkbench(
    createAssembly({
        ...(sessions === undefined ? {} : { sessions }),
        ...(home === undefined ? {} : { home, botStore }),
        title: MEMORY_TITLE,
    }),
    { rendererFile: "memory.html", logSource: "main:chat-memory" },
);
