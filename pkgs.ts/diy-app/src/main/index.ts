// src/main/index.ts
// 🎯 Electron 主进程入口
//
// 运行配置统一由 src/runtime.ts readRuntimeConfig() 从入口注入的环境变量装配：
//   DIY_HOME            → 数据根（.diy.sh: build/home，测试: mkdtemp，生产: ~/.diy）
//   DIY_PORT            → 首选端口
//   DIY_DEV_SERVER_URL  → dev 时加载 Vite URL；缺省 → loadFile 编译产物
//
// 启动流程:
//   1. readRuntimeConfig + AppConfig.fromRuntime
//   2. requestSingleInstanceLock → 同 userData 只一个实例
//   3. 创建窗口 + IPC transport
//   4. 端口绑定 → 18888（或 DIY_PORT 覆盖）

import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type { ServerBinding } from "@diy/rpc";
import { createMainTransport } from "@diy/rpc/electron";
import { RpcPortService } from "./services/rpc-port";
import { AppConfig } from "./core/app-config";
import { bindApi, bindAppHandlers, setRpcPort } from "./services/api-impl";
import { installDiagnostics } from "./services/diagnostics";
import { installCrashReporting } from "./services/crash-reporting";
import { readRuntimeConfig } from "../runtime";
import { homedir, hostname, platform, arch, release, totalmem, freemem } from "node:os";

// ── 共享全局信息（给 IPC 用） ──
let rpcPort: RpcPortService | null = null;
let ipcBinding: ServerBinding | null = null;
let mainWindow: BrowserWindow | null = null;
let appConfig: AppConfig;
let httpPort = 0;

// getAppInfo 已迁到 RPC（api-def / api-impl），Electron、serve、CLI 共用一份实现；
// 这里只保留 httpPort 供启动横幅与端口复用逻辑使用。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dev GUI 加载 URL 由入口注入（electron-dev.mts），缺省 → loadFile 编译产物
const cfg = readRuntimeConfig();
const devUrlArg = cfg.devServerUrl ?? "";
const isDev = !!devUrlArg;

// ── 1. AppConfig ──
// 单根模型：所有数据落在 DIY_HOME 下（diy.sh: ./build/home，测试: mkdtemp）
// 同时把 Electron 的 userData/cache 也指向该根，实现锁隔离。
appConfig = AppConfig.fromRuntime(cfg);
for (const p of [appConfig.electronUserData, appConfig.cache, appConfig.diyHome]) {
  mkdirSync(p, { recursive: true });
}
app.setPath("userData", appConfig.electronUserData);
app.setPath("cache", appConfig.cache);

// 诊断设施必须早于任何 console 输出安装：EPIPE 防护 + 日志落 DIY_HOME/log/main.log
installDiagnostics(appConfig.diyHome);
// 原生崩溃采集：Crashpad minidump → <DIY_HOME>/log/crashes + 子进程消亡日志进 main.log
installCrashReporting(appConfig.diyHome);

// ── 系统信息 ──
console.log("═══════════════════════════════════════");
console.log("  diy 管控台");
console.log("═══════════════════════════════════════");
console.log(`  Electron:     ${process.versions.electron}`);
console.log(`  Chrome:       ${process.versions.chrome}`);
console.log(`  Node.js:      ${process.versions.node}`);
console.log(`  V8:           ${process.versions.v8}`);
console.log(`  Platform:     ${platform()} ${arch()} (${release()})`);
console.log(`  Hostname:     ${hostname()}`);
console.log(`  User:         ${process.env["USER"] ?? "?"}`);
console.log(`  Home:         ${homedir()}`);
console.log(
  `  Memory:       ${(totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB total, ${(freemem() / 1024 / 1024 / 1024).toFixed(1)} GB free`,
);
console.log(`  PID:          ${process.pid}`);
console.log(`  CWD:          ${process.cwd()}`);
console.log(`  Home:         ${appConfig.diyHome}`);
console.log("─── AppDir ────────────────────────────");
console.log(`  diyHome:      ${appConfig.diyHome}`);
console.log(`  cache:        ${appConfig.cache}`);
console.log(`  userData:     ${appConfig.electronUserData}`);
console.log("───────────────────────────────────────");

// ── 2. 单实例锁 ──
const gotLock = app.requestSingleInstanceLock();
console.log(`  SingleInstanceLock: ${gotLock ? "acquired" : "failed (second instance, quitting)"}`);

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// ── 窗口 ──

/**
 * 测试/开发时把窗口定位到「非主工作屏」，避免遮挡用户正在干活的屏幕。
 * 仅在 DIY_MIRROR_DISPLAY=1 时生效；检测不到合适副屏则回退空对象（默认主屏定位）。
 * 返回窗口 options 子集（width/height/x/y），尺寸自动适配目标屏 workArea。
 */
function mirrorWindowPos(
  width: number,
  height: number,
): Record<string, number> {
  if (process.env["DIY_MIRROR_DISPLAY"] !== "1") return {};
  try {
    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    // 目标 = 非主屏：优先 Sidecar iPad（macOS），否则第一个非主屏（跨平台，内外置均可）。
    // 「非主屏」是避开主工作屏的唯一可靠信号——主工作屏可能就是外接屏，故不按 internal 判断。
    const target =
      displays.find((d) => d.id !== primaryId && d.label.toLowerCase().includes("sidecar")) ??
      displays.find((d) => d.id !== primaryId) ??
      null;
    if (!target) return {}; // 单屏：只有主屏，回退默认定位
    const { x, y, width: w, height: h } = target.workArea;
    const winW = Math.min(width, w);
    const winH = Math.min(height, h);
    return {
      width: winW,
      height: winH,
      x: x + Math.max(0, Math.floor((w - winW) / 2)),
      y: y + Math.max(0, Math.floor((h - winH) / 2)),
    };
  } catch {
    return {}; // screen 不可用（如无显示器）时回退默认
  }
}

function loadMainApp(): void {
  if (isDev && devUrlArg) {
    mainWindow?.loadURL(devUrlArg);
  } else {
    mainWindow?.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function createWindow(): { binding: ServerBinding; ipcTransport: import("@diy/rpc").EnvelopeTransport } {
  const WIDTH = 1200;
  const HEIGHT = 800;
  mainWindow = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    ...mirrorWindowPos(WIDTH, HEIGHT),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // RPC Server — 渲染进程 ↔ 主进程通信
  const ipcTransport = createMainTransport(() => mainWindow!.webContents);
  const binding = bindApi(ipcTransport);

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  if (isDev) {
    mainWindow.webContents.on("before-input-event", (_, input) => {
      if (input.key === "F12") mainWindow?.webContents.toggleDevTools();
      if (input.key === "r" && (input.meta || input.control)) mainWindow?.reload();
    });
  }

  return { binding, ipcTransport };
}

// ── RPC 端口服务（外部 CLI 接入） ──

async function startRpcPort(ipcTransport: import("@diy/rpc").EnvelopeTransport): Promise<boolean> {
  // 优先级: DIY_PORT（入口注入） > app.port 文件（上次实例） > rpc 兜底 18888
  const preferredPort = cfg.port ?? appConfig.readPort() ?? undefined;
  console.log(
    `  Port:         ${preferredPort ?? "auto"}${cfg.port !== undefined ? ` (DIY_PORT=${cfg.port})` : ` (from ${appConfig.diyHome}/app.port)`}`,
  );

  rpcPort = new RpcPortService();

  try {
    await rpcPort.start(bindAppHandlers, appConfig, preferredPort, ipcTransport);
    httpPort = rpcPort.port;
    setRpcPort(httpPort); // getAppInfo 走 RPC，端口需回填给 api-impl
    return true;
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.log(`  ⚠ Port ${preferredPort} 被占`);
    }
    // TODO(端口竞争)：dev watcher 热重启时，旧 Electron 刚被 kill、18888 的 socket 还没
    //   完全释放，新实例首次 bind 就 EADDRINUSE，于是**立刻**回落到随机端口 —— 实测
    //   13 次热重启里有 3 次落到随机端口（见 main.log 的「→ 尝试随机端口」），
    //   破坏了「dev 恒在 18888」的约定。CLI 靠 app.port 文件仍能找到，所以不致命但很烦。
    //   修法：回落随机之前，对 preferredPort 做几轮短重试（如 5 × 200ms），
    //   只在重试耗尽后才认定确有外部进程占用。注意别把「真的端口冲突」也拖成慢启动。
    console.log("  → 尝试随机端口...");
    try {
      await rpcPort.start(bindAppHandlers, appConfig, 0, ipcTransport);
      httpPort = rpcPort.port;
      setRpcPort(httpPort);
      console.log(`  RPC Port:     http://127.0.0.1:${httpPort} (random)`);
      return true;
    } catch (e) {
      console.error("  RPC Port:     FAILED", e);
      return false;
    }
  }
}

// ── 生命周期 ──

app.whenReady().then(async () => {
  // 先创建窗口（产生 IPC transport），再启动 HTTP/2 端口
  // CLI 连接时会桥接到 IPC transport，故 IPC 必须就绪
  const { binding, ipcTransport } = createWindow();
  ipcBinding = binding;

  const ok = await startRpcPort(ipcTransport);

  if (ok) {
    loadMainApp();
    console.log("═══════════════════════════════════════");
  } else {
    loadMainApp();
    console.warn("[diy] RPC 服务器启动失败，GUI 功能受限");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  ipcBinding?.destroy();
  rpcPort?.stop();
  if (process.platform !== "darwin") app.quit();
});
