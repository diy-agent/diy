// src/main/index.ts
// 🎯 Electron 主进程入口
//
// 启动流程:
//   1. 检查 --temp 参数 → AppConfig.createTemp('dev') 或 AppConfig.default()
//   2. app.setPath('userData')  → 仅 temp 模式（生产用 Electron 默认）
//   3. app.setPath('cache')     → 仅 temp 模式
//   4. requestSingleInstanceLock → 同 userData 只一个实例
//   5. 端口绑定 → 生产 18888，临时 0（随机）
//
// 生产 vs 临时:
//   生产: userData/cache = Electron 默认, 锁基于 appName
//   临时: userData/cache = /tmp/diy-xxx, 锁自然隔离

import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RawServer, RpcServer } from "@diy/rpc";
import { createMainTransport } from "@diy/rpc-transport-electron";
import { RpcPortService } from "./services/rpc-port";
import { AppConfig } from "./core/app-config";
import { setNotifyRenderer } from "./services/ui-bus";
import { api } from "./services/api";
import { homedir, hostname, platform, arch, release, totalmem, freemem } from "node:os";

// ── 共享全局信息（给 IPC 用） ──
let rpcPort: RpcPortService | null = null;
let ipcRpcServer: RpcServer | null = null;
let mainWindow: BrowserWindow | null = null;
let appConfig: AppConfig;
let httpPort = 0;

function getAppInfo() {
  return {
    mode: isTempMode ? "temp" : "production",
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
const isTempMode = isDev && process.argv.includes("--temp");

// 显式端口（覆盖缺省值，用于测试端口冲突）
const portArg = process.argv.indexOf("--port");
const explicitPort = portArg >= 0 ? parseInt(process.argv[portArg + 1] ?? "", 10) : NaN;
const overridePort = Number.isFinite(explicitPort) ? explicitPort : null;

// ── 1. AppConfig ──
if (isTempMode) {
  appConfig = AppConfig.createTemp("dev");
  app.setPath("userData", appConfig.electronUserData);
  app.setPath("cache", appConfig.cache);
} else {
  appConfig = AppConfig.default();
  // 生产模式不 setPath，保持 Electron 默认
}

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
console.log(`  Mode:         ${isTempMode ? "TEMP (--temp)" : "PRODUCTION"}`);
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

function createWindow(): void {
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
  ipcRpcServer = new RpcServer({ router: api, transport: ipcTransport });

  // UI 总线：命令定义层 → 渲染进程
  setNotifyRenderer((cmd) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ui:command", cmd);
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  if (isDev) {
    mainWindow.webContents.on("before-input-event", (_, input) => {
      if (input.key === "F12") mainWindow?.webContents.toggleDevTools();
      if (input.key === "r" && (input.meta || input.control)) mainWindow?.reload();
    });
  }
}

// ── RPC 端口服务（外部 CLI 接入） ──

async function startRpcPort(): Promise<boolean> {
  const preferredPort = overridePort ?? appConfig.readPort();
  console.log(
    `  Port:         ${preferredPort}${overridePort !== null ? ` (--port, conflict = kill or change)` : ` (from ${appConfig.diyHome}/app.port)`}`,
  );

  rpcPort = new RpcPortService();

  try {
    await rpcPort.start(api, appConfig, preferredPort);
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
      await rpcPort.start(api, appConfig, 0);
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

  const ok = await startRpcPort();

  if (ok) {
    createWindow();
    loadMainApp();
    console.log("═══════════════════════════════════════");
  } else if (overridePort !== null) {
    app.quit();
  } else {
    createWindow();
    loadMainApp();
    console.warn("[diy] RPC 服务器启动失败，GUI 功能受限");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  ipcRpcServer?.destroy();
  rpcPort?.stop();
  if (process.platform !== "darwin") app.quit();
});
