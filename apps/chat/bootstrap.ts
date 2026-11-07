// bootstrap.ts — Electron 主进程的启动样板（##505）。
// 不含业务：OTel 日志 + workbench 窗口 + 退出 flush。
//
// ⚠️ 不要用顶层 await：Electron ESM 入口里它会让模块求值卡在事件循环启动之前（窗口永不出现）。
// ⚠️ 产物在 `<out>/main[-memory]/index.mjs`，`import.meta.url` 的 `../` 就是 preload / renderer 目录。

import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logs } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { child, FileLogRecordExporter, isLogLevel, severityOf } from "@diy-agent/log";
import { createWorkbench, type PluginEntry } from "@diy-agent/workbench";

export interface RunWorkbenchOptions {
    /** `<out>/../renderer/` 下的 html 文件名（缺省 index.html） */
    readonly rendererFile?: string;
    /** OTel 日志 source（缺省 main:chat） */
    readonly logSource?: string;
    /** 实例注册表里的 app 短名（dev 启动器靠它认「这个 app 活着」） */
    readonly app?: string;
    /** launch id（app.yaml 里那条启动命令）；缺省读 DIY_LAUNCH，再缺省 lab（手工跑就是 lab） */
    readonly launch?: string;
}

/** 起一个 workbench 窗口（生命周期挂在 app 事件上） */
export function runWorkbench(
    assembly: { readonly title: string; readonly plugins: readonly PluginEntry[] },
    options: RunWorkbenchOptions = {},
): void {
    // ##458 ③：lab 变体开 CDP（缺省 9222）；命令行显式给了就不覆盖（smoke 自挑随机端口）
    const cdpFromArgv = process.argv.some((arg) => arg.startsWith("--remote-debugging-port"));
    if (process.env["DIY_VARIANT"] === "lab" && !cdpFromArgv) {
        app.commandLine.appendSwitch("remote-debugging-port", process.env["DIY_CDP_PORT"] ?? "9222");
    }

    // ##482：应用日志 = OTel API + 文件导出器（只有装配层 import SDK）。DIY_HOME 缺席 ⇒ userData
    const logLevel = isLogLevel(process.env["DIY_LOG_LEVEL"]) ? process.env["DIY_LOG_LEVEL"] : "info";
    const logDir = join(process.env["DIY_HOME"] ?? app.getPath("userData"), "log", "app");
    const logProvider = new LoggerProvider({
        processors: [new BatchLogRecordProcessor({ scheduledDelayMillis: 200, exporter: new FileLogRecordExporter({ dir: logDir }) })],
        loggerConfigurator: () => ({ enabled: true, minimumSeverity: severityOf(logLevel), traceBased: false }),
    });
    logs.setGlobalLoggerProvider(logProvider);
    const log = child(options.logSource ?? "main:chat");
    log.info("应用启动", { variant: process.env["DIY_VARIANT"] ?? "", pid: process.pid });

    const here = dirname(fileURLToPath(import.meta.url));
    createWorkbench({
        title: assembly.title,
        // 实例注册表：app 短名 + launch id 缺一不可，否则 dev 启动器里永远显示「未启动」
        app: options.app ?? "diy2",
        launch: options.launch ?? process.env["DIY_LAUNCH"] ?? "lab",
        plugins: assembly.plugins,
        preloadFile: join(here, "../preload/index.cjs"),
        rendererFile: join(here, "../renderer", options.rendererFile ?? "index.html"),
    })
        .then((workbench) => {
            app.on("window-all-closed", () => {
                log.info("窗口全部关闭，退出");
                workbench.dispose();
                // 先 flush 再退（写盘失败走 onError，不 reject）
                void logProvider.shutdown().finally(() => app.quit());
            });
        })
        .catch((cause: unknown) => {
            log.error("工作台启动失败", undefined, cause);
            console.error("✗ 工作台启动失败：", cause);
            void logProvider.shutdown().finally(() => app.exit(1));
        });
}
