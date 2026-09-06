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
  });

  app.on("render-process-gone", (_event, _webContents, details) => {
    console.error(`[crash] 渲染进程消亡 reason=${details.reason} exitCode=${details.exitCode}`);
  });
}
