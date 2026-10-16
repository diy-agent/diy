// src/main/index.ts
// 🎯 Electron 主进程入口
//
// 运行配置统一由 src/runtime.ts readRuntimeConfig() 从入口注入的环境变量装配：
//   DIY_HOME            → 数据根（.diy.sh: build/<variant>/home，测试: mkdtemp，生产: ~/.diy）
//   DIY_PORT            → 首选端口
//   DIY_DEV_SERVER_URL  → dev 时加载 Vite URL；缺省 → loadFile 编译产物
//
// 启动流程:
//   1. readRuntimeConfig + AppConfig.fromRuntime
//   2. requestSingleInstanceLock → 同 userData 只一个实例
//   3. 创建窗口 + IPC transport
//   4. 端口绑定 → DIY_PORT > app.port 文件 > defaultPort(env)（生产 18888；dev/test 随机）

import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { setDefaultAutoSelectFamily } from "node:net";
import { setDefaultResultOrder } from "node:dns";
// ⚠️ 网络兜底：本机 Node 的 Happy Eyeballs（双栈竞态，autoSelectFamily 默认启用）
// 对全部公网 HTTPS 地址 ETIMEDOUT，而单地址连接/其他栈（bun/curl/rawTCP）正常，
// 实测 setDefaultAutoSelectFamily(false) 后恢复。只改地址选择策略，不改协议。
// 全局行为变更必须留痕：启动日志明示，便于排查「为什么网络行为不同」。
setDefaultAutoSelectFamily(false);
console.log("[net] 已关闭 Happy Eyeballs（setDefaultAutoSelectFamily(false)）：本机双栈竞态致公网 HTTPS 超时，改回单地址顺序连接");
// ⚠️ 与上一条配套（关掉 Happy Eyeballs 后只连 DNS 返回的第一个地址，顺序就成了单点故障）：
// 本机没有 IPv6 出口（ping6 不通），而 opencode.ai 的 AAAA（2606:4700:78::/48）在解析结果里
// 一直存在。默认顺序 verbatim 跟随解析器返回序，一旦 AAAA 排头就必连 ENETUNREACH、3 次重试
// 全废：09-13~09-15 共 12 次，agent 表现为「突然聊不动了」，且与上下文大小无关，极易误判。
// 钉死 v4 优先消除这个依赖；纯 v6 网络下没有 A 记录会自动回退 AAAA，不会因此断网。
setDefaultResultOrder("ipv4first");
console.log('[net] 已钉死 IPv4 优先（setDefaultResultOrder("ipv4first")）：本机无 IPv6 出口，避免 AAAA 排头时 ENETUNREACH');
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type { ServerBinding } from "@diy/rpc";
import { createMainTransport } from "@diy/rpc/electron";
import { RpcPortService } from "./services/rpc-port";
import { AppConfig } from "./core/app-config";
import { bindApi, bindAppHandlers, setRpcPort } from "./services/api-impl";
import { installDiagnostics } from "./services/diagnostics";
import { traffic } from "./core/traffic";
import { installCrashReporting } from "./services/crash-reporting";
import { detectGpu } from "./core/gpu-detect";
import { readRuntimeConfig, resolvePort } from "../runtime";
import { instanceTitle } from "../shared/instance-title";
import { cliEntryForRepo, findRepoRoot, homeDisplayOf, repoDisplayOf } from "./core/instance-identity";
import { SINGLETON_LOCK, classifyLock, lockAdvice, readLock } from "./core/single-instance";

// Chromium 开关必须走 app.commandLine（ready 之前），跟在 app 路径后传 argv 无效。
// 之前 cli/electron-dev 把 --disable-features=RustPng 放 spawn argv 里，Chromium 根本没吃到，rust_png 照崩。
app.commandLine.appendSwitch("disable-features", "RustPng");
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
// CLI 入口（提示词模版里的「命令行入口」）自证，**但只在未注入时**（`||=`）。
// 为什么是 `||=` 而不是无条件覆盖：本进程的启动者（CLI 入口脚本）已经声明过正确的入口，
// 无条件覆盖会误伤生产 GUI —— `bin/diy` 注入的 `$0` 会被改成 `<repo>/diy.sh`（数据根
// build/home），模型于是去敲一个连不上当前生产实例的入口（##255）。
// 缺失时按**数据根**推导：生产根 → "diy"；隔离/开发/测试 → <repo>/diy.sh（见 cliEntryForRepo）。
// 打包后的 app 不自带 CLI 入口（asar 内不可执行），生产用全局安装的 diy（PATH 解析）。
const cfg = readRuntimeConfig();
const home = cfg.home;
if (app.isPackaged) {
  // 日志必须收在 if 里：`bin/diy` 会注入 `DIY_CLI=$0` 并被 CLI spawn 继承，
  // 那时它已经注入过，再喊「未注入」就是假日志（日志在 `||=` 之外）。
  if (!process.env["DIY_CLI"]) {
    process.env["DIY_CLI"] = "diy";
    console.log('[runtime] 打包模式未注入 DIY_CLI：显式回落为 PATH 上的 "diy"');
  }
} else {
  const repoRoot = findRepoRoot(__dirname);
  if (repoRoot) process.env["DIY_CLI"] ||= cliEntryForRepo(repoRoot, home);
}
// dev GUI 加载 URL 由入口注入（electron-dev.mts），缺省 → loadFile 编译产物
const devUrlArg = cfg.devServerUrl ?? "";
const isDev = !!devUrlArg;

// ── 1. AppConfig ──
// 单根模型：所有数据落在 DIY_HOME 下（diy.sh: ./build/<variant>/home，测试: mkdtemp）
// 同时把 Electron 的 userData/cache 也指向该根，实现锁隔离。
appConfig = AppConfig.fromRuntime(cfg);
for (const p of [appConfig.electronUserData, appConfig.cache, appConfig.diyHome]) {
  mkdirSync(p, { recursive: true });
}
app.setPath("userData", appConfig.electronUserData);
app.setPath("cache", appConfig.cache);

// 诊断设施必须早于任何 console 输出安装：EPIPE 防护 + 日志落 DIY_HOME/log/main.log
installDiagnostics(appConfig.diyHome);
// 流量观测：订阅 undici diagnostics_channel，早于任何请求（见 core/traffic.ts）
traffic.init();
// 原生崩溃采集：Crashpad minidump → <DIY_HOME>/log/crashes + 子进程消亡日志进 main.log
installCrashReporting(appConfig.diyHome);

// GPU 防御性开关：诊断设施就绪后再探测，保证 [gpu] 日志进 main.log。仍在 ready 之前，appendSwitch 有效。
try {
  if (detectGpu().shouldUseAngle) app.commandLine.appendSwitch("use-gl", "angle");
} catch { /* GPU 探测失败就跳过，不挡启动 */ }

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
  // 「被锁拒」不再沉默：告诉用户是谁占着、下一步干什么（诊断见 core/single-instance.ts）
  const lockPath = path.join(appConfig.electronUserData, SINGLETON_LOCK);
  console.error(`[diy] ${lockAdvice(classifyLock(readLock(lockPath)), lockPath)}`);
  app.quit();
} else {
  // 撞到第二个实例 = 用户想看到它（多半是「窗口已关 + 再启动一次」）。activate 与本处
  // 同一个诉求：把窗口请出来。抽成 ensureWindow()，两条路共用（见其定义）。
  app.on("second-instance", () => {
    console.log(`[diy] 收到 second-instance（再启动一次）→ ensureWindow()`);
    ensureWindow();
  });
}

// ── 窗口 ──

// ##87：macOS 视「尺寸恰好 = 标准帧（workArea）」的窗口为「出生即已 zoom」。双击标题栏是
// toggle，这次走的是 un-zoom，而它的还原目标是「从未被记录过的用户帧」——窗口遂塌成只剩
// 标题栏的最小值（实测 1×29@0,815，贴在**主屏**工作区左下角）；且它并不是最小化，点 Dock
// 也救不回来。故命中 workArea 时内缩一圈，让窗口出生就是普通窗口。
const ZOOM_INSET = 48;

/** 最小可用尺寸：即便将来有别的路径把窗口压小，也不至于塌成 1px。 */
const WINDOW_MIN_WIDTH = 480;
const WINDOW_MIN_HEIGHT = 320;

/**
 * 测试/开发时把窗口定位到「非主工作屏」，避免遮挡用户正在干活的屏幕。
 * 仅当非 production（dev/test 就地判 cfg.env）时生效；检测不到合适副屏则回退空对象（默认主屏定位）。
 * 返回窗口 options 子集（width/height/x/y），尺寸自动适配目标屏 workArea。
 */
function mirrorWindowPos(
  width: number,
  height: number,
): Record<string, number> {
  if (cfg.env === "production") return {};
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
    const fitW = Math.min(width, w);
    const fitH = Math.min(height, h);
    // 尺寸恰好 = workArea 会被 macOS 判为「出生即已 zoom」（双击标题栏 → 塌成最小值，##87），
    // 命中时统一内缩一点，让窗口出生就是普通窗口。
    // ⚠️ 宽度**不**内缩，只内缩高度（##297）：宽度一旦掉到 Tailwind 的 lg 断点（1024）以下，
    // App 根节点的 `lg:drawer-open`（App.tsx）就失效 → DaisyUI 抽屉关闭、侧栏被挪到画面外
    // （实测 x=-224 / visibility:hidden）。宽 1024 的屏上 dev/preview/lab 窗口正好 1024−48=976，
    // 掉进去 —— 当时侧栏**没有任何可见的打开入口**，7 个 nav 意图测试全红。
    // 窄窗本身已有兜底（##297：`.diy-nav-rail` 让 rail 常驻占列 + ◉ 点开浮层，见 index.css
    // 与 App.tsx 的 NARROW_MQ），但窄窗终究只剩 40px rail，不如完整侧栏 —— 宽度没必要牺牲。
    // 高度内缩已足以避免「出生即已 zoom」：macOS 的标准帧 = 工作区**整块**，高度不同即不等。
    const winW = fitW;
    const winH = fitH === h ? Math.max(WINDOW_MIN_HEIGHT, h - ZOOM_INSET) : fitH;
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

/**
 * 「本实例是谁」的标题（与 renderer 的 document.title 同源同格式，见 shared/instance-title）。
 * 端口未知时传 null（创建窗口那一刻 RPC 端口还没绑定）。
 */
function windowTitle(port: number | null): string {
  return instanceTitle({
    repoDisplay: repoDisplayOf(),
    homeDisplay: homeDisplayOf(appConfig.diyHome),
    env: cfg.env,
    port,
    pid: process.pid,
  });
}

/**
 * 设置窗口标题并落一行日志。
 *
 * 为什么要日志：原生窗口标题只有人眼能看到（CDP 读到的 targetInfo.title 是页面标题），
 * 不起眼地失效了没人发现。落进 main.log 后，意图测试能直接断言「main 真的设成了什么」。
 */
function applyWindowTitle(): void {
  const title = windowTitle(httpPort || null);
  mainWindow?.setTitle(title);
  console.log(`[diy] 窗口标题: ${title}`);
}

function createWindow(): { binding: ServerBinding; ipcTransport: import("@diy/rpc").EnvelopeTransport } {
  const WIDTH = 1200;
  const HEIGHT = 800;
  // 窗口标题 = 实例标识（`diy(<数据根>) [dev|test] <分支> :<端口> pid <PID>`）。
  // 放在 main 而非只靠 renderer：renderer 崩溃/加载失败时标题仍要能告诉你这是哪个实例
  // —— 那正是最需要它的时候。此刻端口尚未绑定，故先不带端口段，就绪后 applyWindowTitle() 补。
  const title = windowTitle(httpPort || null);
  mainWindow = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    // 最小尺寸兜底：macOS un-zoom（双击标题栏）曾把窗口塌成 1×29，无此下限则不可用（##87）。
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title,
    show: false,
    ...mirrorWindowPos(WIDTH, HEIGHT),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 页面里的 <title>（静态的 "diy"）会在加载完成后把上面的窗口标题顶掉 ——
  // 这里拦掉：「本窗口属于哪个实例」由 main 决定，不随页面内容变。
  // （renderer 自己也设一份 document.title，同源同值：serve 模式的浏览器标签、
  //   以及 CDP 断言都读它。此处拦掉的只是「页面 → 窗口标题」这条通路。）
  mainWindow.on("page-title-updated", (e) => e.preventDefault());

  // 几何留痕（##87）：出生 / 可见 / zoom 切换各记一行，便于事后从 main.log 还原现场。
  traceWindowState(mainWindow);

  // RPC Server — 渲染进程 ↔ 主进程通信
  const ipcTransport = createMainTransport(() => mainWindow!.webContents);
  const binding = bindApi(ipcTransport);

  // test：只渲染窗口不激活 app —— 测试实例不能抢走正在运行的生产 app 的焦点。
  // dev/prod：保持 show()，用户自己起的窗口应当被激活。
  mainWindow.once("ready-to-show", () => {
    if (cfg.env === "test") mainWindow?.showInactive();
    else mainWindow?.show();
  });

  // ── 渲染进程 console 捕获 ──
  // renderer 是独立上下文，未捕获异常 / console.error 不会进主进程诊断日志。
  // 挂 console-message 只收 error/warning 级（节流 500ms），转写到 main.log。
  let _lastRendererLog = 0;
  mainWindow.webContents.on("console-message", (_ev, level, msg, line, sourceId) => {
    // level: 0=verbose 1=info 2=warning 3=error
    if (level < 2) return;
    const now = Date.now();
    if (now - _lastRendererLog < 500) return; // 节流：避免洪水
    _lastRendererLog = now;
    const tag = level === 3 ? "ERROR" : "WARN";
    console.error(`[renderer:${tag}] ${msg} (${sourceId}:${line})`);
  });

  // 渲染进程崩溃/无响应诊断（render-process-gone 已在 crash-reporting 挂了，
  // 这里补 unresponsive —— 长时间 JS 阻塞触发，通常意味着内存/GC 风暴）
  mainWindow.webContents.on("unresponsive", () => {
    console.error("[renderer] 进程无响应 (unresponsive) —— 可能 JS 长时间阻塞或 GC 风暴");
  });
  if (isDev) {
    mainWindow.webContents.on("before-input-event", (_, input) => {
      if (input.key === "F12") mainWindow?.webContents.toggleDevTools();
      if (input.key === "r" && (input.meta || input.control)) mainWindow?.reload();
    });
  }

  return { binding, ipcTransport };
}

// ── 渲染进程自愈 ──
// renderer 被外部杀掉（例如 agent 的 bash 工具误杀宿主子进程，见 agent-guard.ts）
// 后 Electron 不会自动重建 → 窗口永久白屏（用户说的"app 挂了"）。这里节流重载。
const reloadStamps: number[] = [];
app.on("render-process-gone", (_event, webContents, details) => {
  if (!mainWindow || webContents !== mainWindow.webContents) return; // 窗口已关闭：没什么可自愈
  const now = Date.now();
  while (reloadStamps.length > 0 && now - (reloadStamps[0] ?? 0) > 60_000) reloadStamps.shift();
  if (reloadStamps.length >= 3) {
    console.error("[renderer] 60s 内已重建 3 次，暂停自愈（疑似崩溃循环）");
    return;
  }
  reloadStamps.push(now);
  console.error(`[renderer] 进程消亡 reason=${details.reason}，500ms 后重载自愈`);
  setTimeout(() => {
    try {
      mainWindow?.reload();
    } catch (e) {
      console.error("[renderer] 自愈重载失败:", e);
    }
  }, 500);
});

// ── RPC 端口服务（外部 CLI 接入） ──

async function startRpcPort(ipcTransport: import("@diy/rpc").EnvelopeTransport): Promise<boolean> {
  // 裁决逻辑（含「非生产不沿用记录里的 18888」）在 runtime.ts::resolvePort —— 纯函数、可单测。
  const resolved = resolvePort({
    env: cfg.env,
    cliPort: cfg.port,
    recordedPort: appConfig.readPort(),
  });
  const preferredPort = resolved.port;
  const portSource =
    resolved.source === "cli"
      ? `DIY_PORT=${resolved.port}`
      : resolved.source === "recorded"
        ? `from ${appConfig.diyHome}/app.port`
        : `${cfg.env} 缺省`;
  console.log(`  Port:         ${preferredPort === 0 ? "auto(随机)" : preferredPort} (${portSource})`);

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
    // TODO(端口竞争)：热重启时旧 Electron 刚被 kill、socket 还没完全释放，新实例首次 bind
    //   就 EADDRINUSE，于是**立刻**回落到随机端口。开发态已无所谓（缺省本来就是随机，见
    //   runtime.ts::defaultPort）—— 但 production（18888）与显式 DIY_PORT 仍值得几轮短重试
    //   （如 5 × 200ms）再回落，别把「真的端口冲突」也拖成慢启动。
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
  // 端口已定（含 EADDRINUSE 后的随机端口兜底）→ 重设标题补上 `:<port>`
  applyWindowTitle();

  if (ok) {
    loadMainApp();
    console.log("═══════════════════════════════════════");
  } else {
    loadMainApp();
    console.warn("[diy] RPC 服务器启动失败，GUI 功能受限");
  }

  // macOS 惯例：窗口关掉后 app 仍在 Dock，点图标（activate）= 把窗口请出来
  app.on("activate", () => ensureWindow());
});

// ⚠️ 窗口关闭 ≠ 服务停止（这里曾经埋着一个僵尸实例的坑，改前务必读完）：
// agent 会话跑在 main 进程里，CLI/RPC 是常驻服务，窗口只是视图。以前这里顺手
// `rpcPort.stop()`，后果是留下一个「仍持单实例锁、但 RPC 端口已关」的进程：
// 此后每条 `./diy.sh` 都 probe 失败 → 拉起新实例 → 新实例被那把单实例锁拒绝并退出
// → CLI 死等 30s 报「启动超时」；用户视角是「app 明明还在跑，CLI 却说启动不了」。
// 现在：窗口的 IPC 通道随 webContents 一起清掉（重建窗口时会新建），RPC 服务留到真正退出。
app.on("window-all-closed", () => {
  // 落一行日志：这条路径上「进程还在、界面没了」是个容易误判的状态
  // （排查 ./diy.sh 超时时，先看这里有没有记录就知道窗口是不是被关过）
  console.log("[diy] 所有窗口已关闭：RPC 服务继续运行（进程常驻，点 Dock 图标可重建窗口）");
  ipcBinding?.destroy();
  ipcBinding = null;
  mainWindow = null;
  // diy.ui.* 的转发目标随之失效：让「窗口没了还在调界面 RPC」立刻得到明确错误，
  // 而不是等在死通道上超时（重建窗口时由 activate 换回新通道）
  rpcPort?.clearRendererTransport();
  if (process.platform !== "darwin") app.quit();
});

// RPC 服务与窗口通道的停止点：真正退出前（非 darwin 由 window-all-closed 的 app.quit() 触发；
// darwin 由 Cmd+Q 触发）。这里不 destroy ipcBinding —— 与关窗不同，进程正在退出，
// 无需为「以后还要用」留口子（window-all-closed 才 destroy，因为那时进程还活着）。
app.on("before-quit", () => {
  rpcPort?.stop();
});

/**
 * 几何留痕 —— **不是修复**，只把「窗口出生 / 状态切换」各记一行，让人事后能从 main.log 看懂现场。
 * `created` / `show` 两行是判断「出生即已 zoom」（##87 的触发条件）的直接证据，
 * 无需真的双击：`max=true` 就意味第一次双击会走 un-zoom。
 */
function traceWindowState(win: BrowserWindow): void {
  const dump = (tag: string): void => {
    const b = win.getBounds();
    console.log(
      `[win] ${tag} ${b.width}×${b.height}@${b.x},${b.y} min=${win.isMinimized()} max=${win.isMaximized()}`,
    );
  };
  dump("created");
  win.on("show", () => dump("show"));
  win.on("maximize", () => dump("maximize"));
  win.on("unmaximize", () => dump("unmaximize"));
  win.on("minimize", () => dump("minimize"));
  win.on("restore", () => dump("restore"));
}

/**
 * 确保有窗口（没有就重建）。activate（点 Dock）与 second-instance（再启动一次）共用：
 * 两者本质都是「用户想看到这个常驻实例」，若各自实现就会出现「补了一处漏一处」
 * —— 本 bug 里 activate 补了、second-instance 漏了，正是实测到的「再启动一次没反应」。
 * 窗口已存在时只聚焦；不存在时走完整重建（IPC 转发 + 加载界面）。
 */
function ensureWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  const { binding, ipcTransport } = createWindow();
  ipcBinding = binding;
  // 旧 webContents 已销毁，把 diy.ui.* 的转发目标换到新窗口，否则界面 RPC 归死人
  rpcPort?.setRendererTransport(ipcTransport);
  loadMainApp();
  console.log("[diy] 窗口已重建（diy.ui.* 转发已切到新窗口）");
}
