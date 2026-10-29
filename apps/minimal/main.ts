// main.ts — Electron 主进程入口（本 app 的装配入口）。
//
// 只做装配：把清单交给外壳，外壳负责窗口 / IPC / 插件装配。
// 产物 = build/<variant>/main/index.mjs（esbuild 打包；@diy/* 与 electron 走运行时解析）。

import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkbench } from "@diy/workbench";
import { ASSEMBLY } from "./index.js";

// ##458 ③：lab 变体开 CDP（缺省 9222），agent 用 `curl 127.0.0.1:9222/json` / playwright
// 连上来查 DOM。必须在 app ready 之前 append。
// `DIY_CDP_PORT` 只为「9222 被本机别的调试进程占用」时留的口子（实测 Chrome 常占 9222）。
// 命令行已显式给 `--remote-debugging-port` 时不覆盖（smoke / 外部测试自己挑随机端口；
// 两处都设会让 Electron 只绑先到那个，9222 被占时整条 CDP 就废了）。
const cdpFromArgv = process.argv.some((arg) => arg.startsWith("--remote-debugging-port"));
if (process.env["DIY_VARIANT"] === "lab" && !cdpFromArgv) {
    app.commandLine.appendSwitch("remote-debugging-port", process.env["DIY_CDP_PORT"] ?? "9222");
}

const here = dirname(fileURLToPath(import.meta.url)); // build/<variant>/main

// ⚠️ 不要用**顶层 await**（`const wb = await createWorkbench(...)`）：Electron 的 ESM 入口
// 里顶层 await 会让模块求值卡在事件循环启动之前 —— app ready 永不触发、窗口不出现、
// CDP 端口也不监听（实测：进程活着、零输出、`lsof` 连 9222 都不 bind）。改成 promise 链。
createWorkbench({
    title: ASSEMBLY.title,
    plugins: ASSEMBLY.plugins,
    preloadFile: join(here, "../preload/index.cjs"),
    rendererFile: join(here, "../renderer/index.html"),
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
