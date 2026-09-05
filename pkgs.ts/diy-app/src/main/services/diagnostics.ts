// src/main/services/diagnostics.ts
// 🎯 常驻进程可观测性：EPIPE 防护 + 日志落地 + 兜底异常捕获
//
// 为什么需要：此前主进程没有任何 uncaughtException / unhandledRejection 处理器，
// 也没有日志文件。一旦 stderr 管道读端消失（后台任务退出、父进程先走），
// Node 把写失败升级成 uncaughtException，Electron 默认处理器弹**模态异常框** ——
// 既不落地可查证据（不生成 .ips，统一日志也无记录），也无法被远程/CLI 侧观察到。
// 现象是「RPC 与 CDP 同时静默失效 + 屏幕上有框」，排查成本极高。
// 复现与依据：仓库根 scripts/repro-epipe-dialog.mts（EPIPE/throw × 有无防护四场景）。
//
// 三个入口共用本模块，各自独立日志文件：
//   installDiagnostics(home, "main" | "serve" | "cli")
//
// 覆盖面边界（务必别误以为无所不包）：
//   ✅ 第②层 uncaughtException 覆盖**主进程任意来源**的未捕获异常，不限于 EPIPE
//   ⚠️ 第①层 stream error 只挂 stdout/stderr 两条流
//   ❌ 渲染进程 / preload 的异常不在范围内（见 installDiagnostics 内的 TODO）
//   ❌ 原生崩溃（SIGSEGV / OOM / V8 fatal）与主动 process.exit() 不会留痕
//   ❌ 子进程管道需要各自消费，见 createLogSink（ACP agent stderr 已接）

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

/** 单文件上限，超过则滚动为 .1（防止 dev 长跑把磁盘吃满） */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** 日志路径：DIY_HOME/log/<name>.log（name 缺省 main） */
export function logFile(diyHome: string, name = "main"): string {
  return path.join(diyHome, "log", `${name}.log`);
}

/** 主进程日志路径，等价于 logFile(diyHome, "main") */
export function mainLogFile(diyHome: string): string {
  return logFile(diyHome, "main");
}

let logFilePath = "";
let installedHome = "";

/** installDiagnostics() 记下的数据根；未安装则为 "" */
export function getInstalledHome(): string {
  return installedHome;
}

/**
 * 独立的文件日志汇。用于把**外部子进程**（如 ACP agent）的 stderr 转写落盘，
 * 与自家日志分文件，避免对方的输出量把主日志滚掉。
 *
 * 返回的函数自身绝不抛错，可安全用在 stream 'data' 回调里。
 */
export function createLogSink(diyHome: string, name: string): (line: string) => void {
  const file = logFile(diyHome, name);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* 已存在 */
  }
  return (line: string) => {
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, `${line.endsWith("\n") ? line : `${line}\n`}`, "utf-8");
    } catch {
      /* 写不进去就丢掉，绝不能反噬调用方 */
    }
  };
}

/** 追加一行（自身绝不抛错：日志失败不能拖垮主流程） */
function appendLine(line: string): void {
  if (!logFilePath) return;
  try {
    try {
      if (statSync(logFilePath).size > MAX_LOG_BYTES) {
        renameSync(logFilePath, `${logFilePath}.1`);
      }
    } catch {
      /* 文件还不存在 */
    }
    appendFileSync(logFilePath, line, "utf-8");
  } catch {
    /* 磁盘/权限异常：放弃本行 */
  }
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.stack ?? a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/**
 * 安装诊断设施，必须在任何 console 输出之前调用。
 * 幂等：重复调用只刷新路径。
 *
 * @param diyHome 数据根，日志落 <diyHome>/log/<name>.log
 * @param name    日志名（main / serve / cli），用于区分三类常驻进程
 */
export function installDiagnostics(diyHome: string, name = "main"): void {
  logFilePath = logFile(diyHome, name);
  installedHome = diyHome;
  try {
    mkdirSync(path.dirname(logFilePath), { recursive: true });
  } catch {
    /* 已存在 */
  }

  // ── 1. EPIPE 防护 ──
  // stdout/stderr 是对端已关闭的管道时，write 触发 'error' 事件；无监听则升级成
  // uncaughtException。挂上空监听即吞掉：管道断了就安静降级为只写文件日志。
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.("error", () => {});
  }

  // ── 2. tee console → 文件 ──
  // 保留原始 stdout/stderr（终端与 dev 编排仍可见），同时镜像到文件供事后/tailing 排查。
  const originals = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const tee = (level: keyof typeof originals) =>
    (...args: unknown[]) => {
      appendLine(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${fmt(args)}\n`);
      originals[level](...args);
    };
  console.log = tee("log");
  console.info = tee("info");
  console.warn = tee("warn");
  console.error = tee("error");

  // ── 3. 兜底异常 → 文件，且不弹框 ──
  // 覆盖 Electron 默认 uncaughtException 对话框（其内置守卫是
  // process.listenerCount("uncaughtException") > 1，自注册即抑制弹框）。
  // 异常一律落文件、进程继续存活，保持「app 随时可被 CLI / playwright-cli 操作」的常驻性质。
  //
  // TODO(渲染层可观测性): 此处只覆盖主进程 JS。渲染进程是独立上下文，它的未捕获异常、
  //   白屏崩溃（如 window.transport 缺失导致的 ChannelClientBinding TypeError）以及
  //   render-process-gone 目前都无处留痕 —— 只能靠 playwright attach 看 console。
  //   后续接 webContents.on("console-message")（建议只收 error 级 + 节流）
  //   与 on("render-process-gone") 转写进本日志。
  process.on("uncaughtException", (err) => {
    appendLine(`[${new Date().toISOString()}] [FATAL] uncaughtException: ${fmt([err])}\n`);
    originals.error(`[diy] 未捕获异常（已记入 ${logFilePath}，不弹框）:`, err);
  });
  process.on("unhandledRejection", (reason) => {
    appendLine(`[${new Date().toISOString()}] [FATAL] unhandledRejection: ${fmt([reason])}\n`);
    originals.error(`[diy] 未处理 Promise 拒绝（已记入 ${logFilePath}）:`, reason);
  });

  appendLine(
    `\n${"─".repeat(60)}\n[${new Date().toISOString()}] [INFO] === ${name} 进程启动 pid=${process.pid} ===\n`,
  );
}
