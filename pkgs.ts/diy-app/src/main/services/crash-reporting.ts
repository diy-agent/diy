// src/main/services/crash-reporting.ts
// 🎯 原生崩溃采集：Crashpad minidump + 子进程消亡日志，全部落在 <DIY_HOME>/log/ 下
//
// 背景：Chromium 的 FATAL（如 GPU 初始化失败）直接走 SIGTRAP，JS 层 try/catch 抓不到，
// diagnostics.ts 也覆盖不到 —— 之前只能去 ~/Library/Logs/DiagnosticReports 翻 .ips。
// 接入后：
//   1. minidump → <DIY_HOME>/log/crashes/（uploadToServer:false，只存本地、不上传）
//   2. 子进程/渲染进程消亡 → 'child-process-gone' / 'render-process-gone' 打到 main.log
//      （reason: crashed / oom / launch-failed / killed + exitCode）
//   3. 启动时回看上一次崩溃（getLastCrashReport），main.log 留一行
//
// 约束：只在 Electron 主进程调。serve / CLI 是纯 Node，没有 crashReporter。

import { join } from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { app, crashReporter } from "electron";
import { crashScene } from "./agent-audit";
import { appendAppExit } from "./interrupted-cause";
import { activeTurnList } from "./runtime-context";
import { deferQuitUntilIdle } from "../core/restart-gate";

/** 进程级异常/信号落盘（崩溃诊断的主日志之外的结构化尾巴）。
 *  格式与写盘在 `interrupted-cause.ts::appendAppExit` —— 冷读（##416）要按同一份格式消费，
 *  且 watch 重启路径（`scripts/electron-dev.mts`）也写它，三处不许各写一份。 */
function appendExitLog(home: string, kind: string, detail: string): void {
  appendAppExit(home, kind, detail);
}

export function installCrashReporting(home: string): void {
  const crashDir = join(home, "log", "crashes");
  mkdirSync(crashDir, { recursive: true });

  // minidump 落点改到数据根。必须在 crashReporter.start 之前。
  // （默认跟 userData 走，散落在 electron_user_data/Crashpad 里不好找）
  app.setPath("crashDumps", crashDir);

  crashReporter.start({
    productName: "diy",
    // 不上传，只存本地 minidump（crashes/ 下 .dmp）
    uploadToServer: false,
    // 系统侧 .ips 照常生成（双保险，不独占崩溃处理）
    ignoreSystemCrashHandler: false,
    extra: { diyHome: home },
  });
  console.log(`[crash] Crashpad 就绪，minidump 目录: ${crashDir}`);

  // 上次崩溃回看：数 crashes/ 下的 minidump（uploadToServer:false 时 Crashpad 只存本地，
  // getLastCrashReport 的元数据是空的，直接数 .dmp 文件最可靠）
  try {
    let dumps = 0;
    for (const sub of ["pending", "completed"]) {
      try {
        dumps += readdirSync(join(crashDir, sub)).filter((f) => f.endsWith(".dmp")).length;
      } catch {
        /* 子目录还没建出来 */
      }
    }
    if (dumps > 0) {
      console.log(`[crash] 历史 minidump 共 ${dumps} 个（${crashDir}/pending|completed/*.dmp），含本次启动之前的崩溃`);
    }
  } catch (err) {
    console.log(`[crash] 回看历史崩溃失败: ${err}`);
  }

  app.on("child-process-gone", (_event, details) => {
    console.error(
      `[crash] 子进程消亡 type=${details.type} reason=${details.reason} exitCode=${details.exitCode} ` +
        `service=${details.serviceName ?? "-"} name=${details.name ?? "-"}`,
    );
    // 现场线索：被 SIGKILL 时进程自己写不了日志，靠 agent 执行前的 write-ahead 审计回溯
    console.error(`[crash] 现场: ${crashScene(home)}`);
  });

  app.on("render-process-gone", (_event, webContents, details) => {
    const url = webContents?.getURL?.() ?? "unknown";
    console.error(
      `[crash] 渲染进程消亡 reason=${details.reason} exitCode=${details.exitCode} url=${url}`,
    );
    console.error(`[crash] 现场: ${crashScene(home)}`);
    // 注：传输层（EnvelopeTransport.send）已内置 try-catch 防护，
    // 渲染进程死亡后首次 send 失败会自动标记 dead → 触发 onClose →
    // ChannelServerBinding 自动 destroy（取消所有流），无需在此额外处理。
  });

  // ── 进程级退出留痕 ──
  // kill -9 捕获不到（这也是本文件存在的理由，见 agent-audit.ts），
  // 但 SIGTERM/SIGINT/未捕获异常都能留下退出原因。
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      console.error(`[exit] 收到 ${sig}，准备退出（现场: ${crashScene(home)}）`);
      appendExitLog(home, sig, crashScene(home));
      app.quit();
    });
  }
  // ── 热重启让位（##404）──
  // `SIGUSR2` = 「**换**一份代码」而不是「停」：`scripts/electron-dev.mts` 的 watch 重建用它。
  // 立刻退会把正在跑的本地 agent 轮次砍掉 —— 而一个正在改 `src/**` 的 agent 每改一次就
  // 触发一次重建，等于**它自己把自己的轮次杀掉一次**（lab 实测一天 5 条 `agent/app-restart`）。
  // 所以：有轮次在跑 ⇒ 等它们跑完再退（上限 30 分钟，超时照退并留痕）。
  // SIGTERM/SIGINT/SIGHUP 仍是立刻退：那是用户/编排脚本「停」，让位会让实例停不掉。
  process.on("SIGUSR2", () => {
    console.log(`[exit] 收到 SIGUSR2（热重启请求），在跑的轮次会先跑完`);
    const verdict = deferQuitUntilIdle({
      activeTurns: () => activeTurnList(),
      quit: (why) => {
        // 留痕口径与 dev 脚本一致（kind 属信号族 ⇒ 冷读判重启，不判崩溃）
        appendExitLog(home, "electron-dev-restart", `热重启：${why}`);
        app.quit();
      },
      log: (line) => console.log(line),
    });
    if (!verdict.deferred) {
      appendExitLog(home, "electron-dev-restart", "热重启：此刻空闲，立即退出");
      app.quit();
    }
  });
  process.on("uncaughtException", (err) => {
    console.error(`[exit] 未捕获异常: ${err?.stack ?? err}`);
    appendExitLog(home, "uncaughtException", `${err?.message ?? err}\n${err?.stack ?? ""}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[exit] 未处理的 Promise 拒绝: ${reason}`);
    appendExitLog(home, "unhandledRejection", String(reason));
  });
}
