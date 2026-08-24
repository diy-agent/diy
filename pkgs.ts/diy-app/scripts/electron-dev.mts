/**
 * electron-dev.mts — Vite 8 + shadcn 开发编排脚本
 */
import { build, createServer, type ViteDevServer, type Rollup } from "vite";
import { spawn, type ChildProcess } from "node:child_process";
import electronPath from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

// ── CLI 参数解析 ──
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const explicitPort = portIdx >= 0 ? args[portIdx + 1] : null;

const electronArgs: string[] = [];
if (explicitPort) electronArgs.push("--port", explicitPort);

// DIY_HOME 默认指向仓库根 build/home，与 diy.sh 保持一致
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const defaultHome = join(repoRoot, "build", "home");
if (!process.env["DIY_HOME"]) {
  mkdirSync(defaultHome, { recursive: true });
  process.env["DIY_HOME"] = defaultHome;
}

let electronProc: ChildProcess | null = null;
let rendererServer: ViteDevServer | null = null;
let cleaningUp = false;

function startElectron(url: string) {
  if (electronProc) {
    console.log("[dev] restarting electron...");
    electronProc.kill();
    electronProc = null;
  }

  electronProc = spawn(String(electronPath), ["out/main/index.mjs", url, ...electronArgs], {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });

  electronProc.on("close", () => {
    console.log("[dev] electron exited, shutting down...");
    cleanup();
  });
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
