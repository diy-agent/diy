// main.ts — Electron 主进程入口（本包的装配入口）。
//
// 只做装配：把清单交给外壳，外壳负责窗口 / IPC / 插件加载。
// 产物 = build/<variant>/main/index.mjs（esbuild 打包；@diy/* 与 electron 走运行时解析）。

import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkbench } from "@diy/workbench";
import { ASSEMBLY } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url)); // build/<variant>/main

const workbench = await createWorkbench({
    title: ASSEMBLY.title,
    plugins: ASSEMBLY.plugins,
    preloadFile: join(here, "../preload/index.cjs"),
    rendererFile: join(here, "../renderer/index.html"),
});

app.on("window-all-closed", () => {
    workbench.dispose();
    app.quit();
});
