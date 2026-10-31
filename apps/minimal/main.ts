// main.ts — Electron 主进程入口（本 app 的装配入口）。
//
// 只做装配：把清单交给外壳，外壳负责窗口 / IPC / 插件装配。
// 产物 = build/<variant>/main/index.mjs（esbuild 打包；@diy-agent/* 与 electron 走运行时解析）。

import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logs } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { child, FileLogRecordExporter, isLogLevel, severityOf } from "@diy-agent/log";
import { createWorkbench } from "@diy-agent/workbench";
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
// ##482：应用日志 = OTel 日志 API + 文件导出器（全 app 一份流，按 source 过滤）。
// 只有装配层 import OTel SDK 包；业务包只依赖 api-logs（判据 2）。
// DIY_HOME 缺席（被当纯库 import / 单测）⇒ 落到 Electron 的 userData，绝不写当前目录。
const logLevel = isLogLevel(process.env["DIY_LOG_LEVEL"]) ? process.env["DIY_LOG_LEVEL"] : "info";
const logProvider = new LoggerProvider({
    processors: [
        new BatchLogRecordProcessor({
            // 200ms：日志要「马上能在文件里看到」（排查时不等人），批处理只用来合并高频写入
            scheduledDelayMillis: 200,
            exporter: new FileLogRecordExporter({
                dir: join(process.env["DIY_HOME"] ?? app.getPath("userData"), "log", "app"),
            }),
        }),
    ],
    // 级别过滤交给 SDK（Logger.enabled 按 minimumSeverity 丢记录）
    loggerConfigurator: () => ({ enabled: true, minimumSeverity: severityOf(logLevel), traceBased: false }),
});
logs.setGlobalLoggerProvider(logProvider);
const log = child("main:minimal");

log.info("应用启动", { variant: process.env["DIY_VARIANT"] ?? "", pid: process.pid });

createWorkbench({
    title: ASSEMBLY.title,
    plugins: ASSEMBLY.plugins,
    preloadFile: join(here, "../preload/index.cjs"),
    rendererFile: join(here, "../renderer/index.html"),
})
    .then((workbench) => {
        app.on("window-all-closed", () => {
            log.info("窗口全部关闭，退出");
            workbench.dispose();
            // 先 flush 再退：provider.shutdown 会 flush 批处理器与导出器（写盘失败走 onError，不 reject）
            void logProvider.shutdown().finally(() => app.quit());
        });
    })
    .catch((cause: unknown) => {
        log.error("工作台启动失败", undefined, cause);
        console.error("✗ 工作台启动失败：", cause);
        void logProvider.shutdown().finally(() => app.exit(1));
    });
