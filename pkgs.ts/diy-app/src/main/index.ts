// src/main/index.ts
// 🎯 Electron 主进程入口
//
// 启动流程:
//   1. AppConfig.default() → 读 DIY_HOME（diy.sh 设为 ./build/home，测试为 mkdtemp）
//   2. requestSingleInstanceLock → 同 userData 只一个实例
//   3. 创建窗口 + IPC transport
//   4. 端口绑定 → 18888（或 --port 覆盖）

import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type { ServerBinding } from "@diy/rpc";
import { createMainTransport } from "@diy/rpc/electron";
import { RpcPortService } from "./services/rpc-port";
import { AppConfig } from "./core/app-config";
import { bindApi, bindAppHandlers } from "./services/api-impl";
import { homedir, hostname, platform, arch, release, totalmem, freemem } from "node:os";

// ── 共享全局信息（给 IPC 用） ──
let rpcPort: RpcPortService | null = null;
let ipcBinding: ServerBinding | null = null;
let mainWindow: BrowserWindow | null = null;
let appConfig: AppConfig;
let httpPort = 0;

function getAppInfo() {
  return {
    mode: appConfig.isTemp ? "temp" : "production",
    port: httpPort,
    diyHome: appConfig.diyHome,
    cache: appConfig.cache,
    userData: appConfig.electronUserData,
    isTemp: appConfig.isTemp,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: `${platform()} ${arch()}`,
    pid: process.pid,
    memory: `${(totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB total`,
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devUrlArg = process.argv[2] || process.env.VITE_DEV_SERVER_URL || "";
const isDev = !app.isPackaged && !!devUrlArg;

// 显式端口（覆盖缺省值，用于测试端口冲突）
const portArg = process.argv.indexOf("--port");
const explicitPort = portArg >= 0 ? parseInt(process.argv[portArg + 1] ?? "", 10) : NaN;
const overridePort = Number.isFinite(explicitPort) ? explicitPort : null;

// ── 1. AppConfig ──
// 单根模型：所有数据落在 DIY_HOME 下（diy.sh: ./build/home，测试: mkdtemp）
// 同时把 Electron 的 userData/cache 也指向该根，实现锁隔离。
appConfig = AppConfig.default();
for (const p of [appConfig.electronUserData, appConfig.cache, appConfig.diyHome]) {
  mkdirSync(p, { recursive: true });
}
app.setPath("userData", appConfig.electronUserData);
app.setPath("cache", appConfig.cache);

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
console.log(`  Mode:         ${appConfig.isTemp ? "TEMP" : "PRODUCTION"} (${appConfig.diyHome})`);
console.log("─── AppDir ────────────────────────────");
console.log(`  diyHome:      ${appConfig.diyHome}`);
console.log(`  cache:        ${appConfig.cache}`);
console.log(`  userData:     ${appConfig.electronUserData}`);
console.log(`  isTemp:       ${appConfig.isTemp}`);
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

function loadMainApp(): void {
  if (isDev && devUrlArg) {
    mainWindow?.loadURL(devUrlArg);
  } else {
    mainWindow?.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function createWindow(): { binding: ServerBinding; ipcTransport: import("@diy/rpc").EnvelopeTransport } {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
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
  const preferredPort = overridePort ?? appConfig.readPort();
  console.log(
    `  Port:         ${preferredPort}${overridePort !== null ? ` (--port, conflict = kill or change)` : ` (from ${appConfig.diyHome}/app.port)`}`,
  );

  rpcPort = new RpcPortService();

  try {
    await rpcPort.start(bindAppHandlers, appConfig, preferredPort, ipcTransport);
    httpPort = rpcPort.port;
    return true;
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.log(`  ⚠ Port ${preferredPort} 被占`);
      if (overridePort !== null) {
        console.error(`  ✗ --port ${preferredPort} 被占，无法启动`);
        return false;
      }
    }
    console.log("  → 尝试随机端口...");
    try {
      await rpcPort.start(bindAppHandlers, appConfig, 0, ipcTransport);
      httpPort = rpcPort.port;
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
  // 注册 app 信息 IPC（独立通道，不走 RPC router）
  ipcMain.handle("getAppInfo", () => getAppInfo());

  // 先创建窗口（产生 IPC transport），再启动 HTTP/2 端口
  // CLI 连接时会桥接到 IPC transport，故 IPC 必须就绪
  const { binding, ipcTransport } = createWindow();
  ipcBinding = binding;

  const ok = await startRpcPort(ipcTransport);

  if (ok) {
    loadMainApp();
    console.log("═══════════════════════════════════════");
  } else if (overridePort !== null) {
    app.quit();
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
