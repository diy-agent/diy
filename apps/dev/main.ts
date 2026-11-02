// main.ts — Electron 主进程入口（dev 启动器的装配入口）。
//
// 只做装配：窗口 / IPC / 插件由外壳（@diy-agent/workbench）负责，本文件只交清单。
// 窗口落点与「启动不抢焦点」也由外壳按环境变量统一处理（dev 环境自动开在副屏）。

import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkbench } from "@diy-agent/workbench";
import { ASSEMBLY } from "./index.js";

// lab 变体开 CDP：agent 用 `curl 127.0.0.1:9223/json` / playwright 查 DOM。
// 缺省 9223（9222 留给 diy-app lab，两者经常同时在跑）。必须在 app ready 之前 append。
const cdpFromArgv = process.argv.some((arg) => arg.startsWith("--remote-debugging-port"));
if (process.env["DIY_VARIANT"] === "lab" && !cdpFromArgv) {
    app.commandLine.appendSwitch("remote-debugging-port", process.env["DIY_CDP_PORT"] ?? "9223");
}

const here = dirname(fileURLToPath(import.meta.url)); // build/<variant>/main

// ⚠️ 不要用顶层 await（Electron 的 ESM 入口里会让 app ready 永不触发，见 apps/chat 的同一条注释）
createWorkbench({
    title: ASSEMBLY.title,
    // 实例注册表里的 app 短名：它自己也该出现在「谁活着」里
    app: "diy-dev",
    plugins: ASSEMBLY.plugins,
    preloadFile: join(here, "../preload/index.cjs"),
    rendererFile: join(here, "../renderer/index.html"),
    width: 1180,
    height: 820,
})
    .then((workbench) => {
        app.on("window-all-closed", () => {
            workbench.dispose();
            app.quit();
        });
    })
    .catch((cause: unknown) => {
        console.error("✗ 工作台启动失败：", cause);
        app.exit(1);
    });
