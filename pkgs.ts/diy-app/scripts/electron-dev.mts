/**
 * electron-dev.mts — Vite 8 + shadcn 开发编排脚本
 */
import { build, createServer, type ViteDevServer, type Rollup } from "vite";
import { spawn, type ChildProcess } from "node:child_process";
import electronPath from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

// ── CLI 参数解析 ──
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const explicitPort = portIdx >= 0 ? args[portIdx + 1] : null;

const electronArgs: string[] = [];
if (explicitPort) electronArgs.push("--port", explicitPort);

// DIY_HOME 默认指向仓库根 build/home，与 diy.sh 保持一致
const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(scriptDir, ".."); // pkgs.ts/diy-app
const repoRoot = join(scriptDir, "..", "..", "..");
const defaultHome = join(repoRoot, "build", "home");
if (!process.env["DIY_HOME"]) {
  mkdirSync(defaultHome, { recursive: true });
  process.env["DIY_HOME"] = defaultHome;
}

let electronProc: ChildProcess | null = null;
let rendererServer: ViteDevServer | null = null;
let cleaningUp = false;

// ── CDP endpoint 探测 ──
// Chromium 在 --remote-debugging-port=0 时把实际端口与 browser path 写进
// userData/DevToolsActivePort（两行）。这是唯一不干扰子进程 stdio 的取址方式。

/** userData 目录，与 src/main 的 setPath("userData") 契约一致 */
function devToolsPortFile(): string {
  return join(process.env["DIY_HOME"]!, "electron_user_data", "DevToolsActivePort");
}

/** 清掉上一轮残留，避免读到旧端口 */
function clearDevToolsActivePort(): void {
  try {
    rmSync(devToolsPortFile(), { force: true });
  } catch {
    /* 不存在即可 */
  }
}

/** 轮询 DevToolsActivePort 出现，打印 playwright-cli 连接提示 */
function announceCdpEndpoint(timeoutMs = 20000): void {
  const file = devToolsPortFile();
  const start = Date.now();
  const poll = () => {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      if (Date.now() - start > timeoutMs) return; // CDP 未启用：静默跳过
      setTimeout(poll, 200);
      return;
    }
    const [portLine, pathLine] = raw.split("\n").map((s) => s.trim());
    if (!portLine || !pathLine) {
      setTimeout(poll, 200);
      return;
    }
    const wsUrl = `ws://127.0.0.1:${portLine}${pathLine}`;
    console.log(`\n[dev] ═══════════════════════════════════════`);
    console.log(`[dev]   CDP  ws://127.0.0.1:${portLine}`);
    console.log(`[dev]   连接: playwright-cli attach --cdp=${wsUrl}`);
    console.log(`[dev]   注意: attach 会注入 colorScheme:'light' 仿真（Playwright 默认）`);
    console.log(`[dev] ═══════════════════════════════════════\n`);
  };
  poll();
}

function startElectron(url: string) {
  if (electronProc) {
    console.log("[dev] restarting electron...");
    electronProc.kill();
    electronProc = null;
  }

  // CDP 端口 0 = 随机空闲端口。实际地址由 Chromium 写入 userData/DevToolsActivePort，
  // 不去解析子进程 stderr —— 那样必须把 stdio 改成 pipe，一旦本进程的 stderr 无人读取
  // （后台任务/管道对端退出），写满管道缓冲会反向阻塞 Electron 主进程事件循环。
  const cdpArgs = ["--remote-debugging-port=0"];
  clearDevToolsActivePort();

  const proc = spawn(String(electronPath), ["out/main/index.mjs", url, ...electronArgs, ...cdpArgs], {
    stdio: "inherit",
    // 注入运行时契约变量（src/runtime.ts 读取）：dev 加载 URL + 产物根 + 数据根
    env: {
      ...process.env,
      DIY_DEV_SERVER_URL: url,
      DIY_MIRROR_DISPLAY: "1",
    },
  });
  electronProc = proc;

  // 只有「当前仍存活的实例」意外退出才整体收尾。
  // watch 重建 main 时会先 kill 旧进程，其 close 事件晚于新进程 spawn 到达；
  // 若不区分，主动重启会被误判为用户退出 → 整个 dev 会话被 cleanup 打死。
  proc.on("close", () => {
    if (electronProc !== proc) return; // 已被新实例替换：属于主动重启
    electronProc = null;
    console.log("[dev] electron exited, shutting down...");
    cleanup();
  });

  announceCdpEndpoint();
}

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  if (electronProc) electronProc.kill();
  if (rendererServer) rendererServer.close();
  process.exit(0);
}

process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());

// 1. 启动 Renderer 开发服务器
console.log("[dev] starting renderer dev server...");
rendererServer = await createServer({ configFile: "vite.renderer.config.ts" });
await rendererServer.listen();
const rendererUrl = rendererServer.resolvedUrls!.local[0];
console.log(`[dev] renderer: ${rendererUrl}`);

let mainReady = false;
let preloadReady = false;

function onBundleReady() {
  if (mainReady && preloadReady) {
    startElectron(rendererUrl);
  }
}

// 2. Main 进程 watch 模式
console.log("[dev] building main (watch)...");
const mainWatcher: Rollup.RollupWatcher = (await build({
  configFile: "vite.main.config.ts",
  build: { watch: {} },
})) as unknown as Rollup.RollupWatcher;

mainWatcher.on("event", (e: Rollup.RollupWatcherEvent) => {
  if (e.code === "BUNDLE_END") {
    console.log(`[dev] main built in ${e.duration}ms`);
    mainReady = true;
    onBundleReady();
  }
  if (e.code === "ERROR") {
    console.error("[dev] main build error:", e.error);
  }
});

// 3. Preload watch 模式
console.log("[dev] building preload (watch)...");
const preloadWatcher: Rollup.RollupWatcher = (await build({
  configFile: "vite.preload.config.ts",
  build: { watch: {} },
})) as unknown as Rollup.RollupWatcher;

preloadWatcher.on("event", (e: Rollup.RollupWatcherEvent) => {
  if (e.code === "BUNDLE_END") {
    console.log(`[dev] preload built in ${e.duration}ms`);
    preloadReady = true;
    onBundleReady();
  }
  if (e.code === "ERROR") {
    console.error("[dev] preload build error:", e.error);
  }
});

console.log("[dev] waiting for main + preload to finish first build...");
