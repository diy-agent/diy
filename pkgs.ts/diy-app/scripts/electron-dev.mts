/**
 * electron-dev.mts — Vite 8 + shadcn 开发编排脚本
 */
import { build, createServer, type ViteDevServer, type Rollup } from "vite";
import { spawn, type ChildProcess } from "node:child_process";
import electronPath from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync, type Dirent } from "node:fs";
// 注：Chromium 开关（disable-features=RustPng / use-gl=angle）由 src/main/index.ts 经
// app.commandLine.appendSwitch 生效，此处不再拼 argv（Chromium 不吃 app argv）。
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
// DIY_CLI：当前生效的 CLI 入口（提示词模版 100-diy 消费）。
// dev 只能由本脚本注入 —— 提示词里的入口若缺省，prompt-registry 会兜底成裸 "diy"，
// 在 worktree 里就打到生产数据根（与 diy.sh / bin/diy 同一契约，三处必须都给）。
const cliEntry = process.env["DIY_CLI"] ?? join(repoRoot, "diy.sh");

let electronProc: ChildProcess | null = null;
let rendererServer: ViteDevServer | null = null;
let cleaningUp = false;

// ── dev 编排日志（JSONL，落 $DIY_HOME/log/dev.jsonl）──
// 为什么需要：终端输出不会被保存，而「watcher 卡死」这类故障只能靠事后日志定位。
// 实测教训：main 产物被清空后再不重建，事后只有 app 侧的 main.log（只知道重启过），
// 无法判断是 bundle 失败、build 未完成还是 watcher 死了 —— 所以每一步都落盘。
function devLogger() {
  const dir = join(process.env["DIY_HOME"] ?? defaultHome, "log");
  return join(dir, "dev.jsonl");
}
let devLogReady = false;
function devLog(event: string, fields: Record<string, unknown> = {}): void {
  const row = { ts: new Date().toISOString(), pid: process.pid, event, ...fields };
  try {
    if (!devLogReady) {
      mkdirSync(dirname(devLogger()), { recursive: true });
      devLogReady = true;
    }
    appendFileSync(devLogger(), `${JSON.stringify(row)}\n`, "utf-8");
  } catch {
    /* 日志失败不阻断 dev */
  }
}

/** 目录（或文件）内最新的 mtime；目录不可读/不存在 → 0。
 *  renderer 不参与 watcher 卡死判断（它走 HMR，改 UI 不重建 main）。 */
function newestMtime(path: string): { file: string; mtime: number } {
  let best = { file: "", mtime: 0 };
  const walk = (dir: string): void => {
    let ents: Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        try {
          const m = statSync(p).mtimeMs;
          if (m > best.mtime) best = { file: p, mtime: m };
        } catch {
          /* 文件刚被删除：忽略 */
        }
      }
    }
  };
  let st;
  try {
    st = statSync(path);
  } catch {
    return best;
  }
  if (st.isDirectory()) walk(path);
  else best = { file: path, mtime: st.mtimeMs };
  return best;
}

function bundleMtime(): number {
  try {
    return statSync(join(appDir, "out/main/index.mjs")).mtimeMs;
  } catch {
    return 0;
  }
}

/** 最近一次构建报错的时间：失败构建会让产物落后于源码，属于正常，不应误报 watcher 卡死 */
let lastBuildErrorAt = 0;
/** 首建完成标记（未完成前不判卡死：那时产物本来就不存在） */
let mainBuiltOnce = false;
let preloadBuiltOnce = false;

/** watcher 卡死检测：源码比产物新且持续 → 写 `watch-stall-suspect` 并大声提示重启。
 *  main / preload 各自比对自己的产物（不能交叉：改 preload 不会重建 out/main）。
 *  判据刻意保守：连续 2 次采样（间隔 30s）都成立才报；期间有 build 完成或报错就清空。 */
function installStallDetector(): void {
  const pairs: Array<{ label: string; inputs: string[]; output: string; built: () => boolean }> = [
    {
      label: "main",
      inputs: ["src/main", "vite.main.config.ts"],
      output: "out/main/index.mjs",
      built: () => mainBuiltOnce,
    },
    {
      label: "preload",
      inputs: ["src/preload", "vite.preload.config.ts"],
      output: "out/preload",
      built: () => preloadBuiltOnce,
    },
  ];
  const state = new Map<string, { since: number; warned: string }>();
  setInterval(() => {
    for (const pair of pairs) {
      if (!pair.built()) continue;
      const outMtime = newestMtime(join(appDir, pair.output)).mtime;
      const newest = pair.inputs
        .map((rel) => newestMtime(join(appDir, rel)))
        .reduce((a, b) => (b.mtime > a.mtime ? b : a), { file: "", mtime: 0 });
      const st = state.get(pair.label) ?? { since: 0, warned: "" };
      // 产物缺失（被删/构建没写完）或源码明显更新 → 可疑
      const missing = outMtime === 0;
      const lagging = !missing && newest.mtime > outMtime + 5000;
      if (!missing && !lagging) {
        st.since = 0;
        state.set(pair.label, st);
        continue;
      }
      // 同一次改动已经报过 build error 就不要喊 watcher 死（失败构建会让产物落后）
      if (!missing && newest.mtime <= lastBuildErrorAt) continue;
      const key = missing ? `missing:${pair.output}` : `${newest.file}:${newest.mtime}`;
      if (st.warned === key) continue;
      if (st.since === 0) {
        st.since = Date.now();
        state.set(pair.label, st);
        continue;
      }
      if (Date.now() - st.since < 60_000) continue;
      st.warned = key;
      state.set(pair.label, st);
      const message = missing
        ? `${pair.output} 不存在且 60s 内未重建：watcher 可能已卡死，重启 ./sha.sh dev`
        : `源码比 ${pair.output} 新且持续 60s 未重建：watcher 可能已卡死，重启 ./sha.sh dev`;
      devLog("watch-stall-suspect", {
        pair: pair.label,
        output: pair.output,
        outputMtime: outMtime === 0 ? null : new Date(outMtime).toISOString(),
        newestSource: newest.mtime === 0 ? null : new Date(newest.mtime).toISOString(),
        file: newest.file.replace(appDir, ""),
        message,
      });
      console.error(`\n[dev] ⚠️  ${message}\n[dev]    ${pair.label}: 最新源码 ${newest.file.replace(appDir, "")} → 产物 ${pair.output}\n`);
    }
  }, 30_000).unref();
}

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

/** 轮询 DevToolsActivePort 出现 + 实际可达性，打印 playwright-cli 连接提示。
 *  只读到文件不够：DevToolsActivePort 是 Chromium 写的，输给 SingleInstanceLock 的第二个
 *  实例也会先写自己的端口再退出（同一 userData），文件里可能是「别人的死端口」。
 *  教训：裸读文件让 attach 直接失败（端口看 50636、实际在 50633），三个自测 agent 都被误导过。
 *  所以这里以「/json/version 真能应答」为准，读到死端口就丢弃继续轮询。 */
function announceCdpEndpoint(timeoutMs = 20000): void {
  const file = devToolsPortFile();
  const start = Date.now();
  let sawStale = false;
  const poll = async () => {
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
    // 可达性校验：拿不到 /json/version 就不是当前实例的调试端口
    let alive = false;
    try {
      const res = await fetch(`http://127.0.0.1:${portLine}/json/version`, { signal: AbortSignal.timeout(800) });
      alive = res.ok;
    } catch {
      alive = false;
    }
    if (!alive) {
      sawStale = true;
      if (Date.now() - start > timeoutMs) {
        console.warn(
          `[dev] 警告：DevToolsActivePort 里的 ${portLine} 不可达（可能被 SingleInstanceLock 抢位的实例写过），CDP 自测前请先校验端口`,
        );
        return;
      }
      setTimeout(poll, 200);
      return;
    }
    const wsUrl = `ws://127.0.0.1:${portLine}${pathLine}`;
    devLog("cdp-endpoint", { port: portLine, url: wsUrl, skippedStale: sawStale });
    console.log(`\n[dev] ═══════════════════════════════════════`);
    console.log(`[dev]   CDP  ws://127.0.0.1:${portLine}${sawStale ? "（已跳过文件中过期的端口）" : ""}`);
    console.log(`[dev]   连接: playwright-cli attach --cdp=${wsUrl}`);
    console.log(`[dev]   注意: attach 会注入 colorScheme:'light' 仿真（Playwright 默认）`);
    console.log(`[dev] ═══════════════════════════════════════\n`);
  };
  void poll();
}

function startElectron(url: string) {
  if (electronProc) {
    console.log("[dev] restarting electron...");
    devLog("electron-restart", { oldPid: electronProc.pid });
    electronProc.kill();
    electronProc = null;
  }

  // CDP 端口 0 = 随机空闲端口。实际地址由 Chromium 写入 userData/DevToolsActivePort，
  // 不去解析子进程 stderr —— 那样必须把 stdio 改成 pipe，一旦本进程的 stderr 无人读取
  // （后台任务/管道对端退出），写满管道缓冲会反向阻塞 Electron 主进程事件循环。
  const cdpArgs = ["--remote-debugging-port=0"];
  clearDevToolsActivePort();

  // Chromium 开关由 src/main/index.ts 经 app.commandLine.appendSwitch 生效，此处不传 argv。
  const proc = spawn(String(electronPath), ["out/main/index.mjs", url, ...electronArgs, ...cdpArgs], {
    stdio: "inherit",
    // 注入运行时契约变量（src/runtime.ts 读取）：dev 加载 URL + 产物根 + 数据根
    // DIY_ENV=development：runtime.ts 派生 dev 专属能力（窗口定位副屏等），不遮挡主屏干活区
    env: {
      ...process.env,
      DIY_HOME: process.env["DIY_HOME"],
      DIY_CLI: cliEntry,
      DIY_DEV_SERVER_URL: url,
      DIY_ENV: "development",
    },
  });
  electronProc = proc;
  devLog("electron-spawn", { pid: proc.pid, url, cdpArgs });

  // 只有「当前仍存活的实例」意外退出才整体收尾。
  // watch 重建 main 时会先 kill 旧进程，其 close 事件晚于新进程 spawn 到达；
  // 若不区分，主动重启会被误判为用户退出 → 整个 dev 会话被 cleanup 打死。
  proc.on("close", (code, signal) => {
    if (electronProc !== proc) return; // 已被新实例替换：属于主动重启
    electronProc = null;
    devLog("electron-exit", { pid: proc.pid, code, signal });
    console.log("[dev] electron exited, shutting down...");
    cleanup();
  });

  announceCdpEndpoint();
}

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  devLog("cleanup", { reason: "sigint/sigterm/electron-exit" });
  if (electronProc) electronProc.kill();
  if (rendererServer) rendererServer.close();
  process.exit(0);
}

process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());
// 未捕获异常必须留痕：watcher 静默失效的典型原因就是没人看的 rejection
process.on("uncaughtException", (err) => {
  devLog("uncaught-exception", { error: err?.stack ?? String(err) });
  console.error("[dev] uncaughtException:", err);
  cleanup();
});
process.on("unhandledRejection", (reason) => {
  devLog("unhandled-rejection", { reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
  console.error("[dev] unhandledRejection:", reason);
});

devLog("dev-start", {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  appDir,
  repoRoot,
  home: process.env["DIY_HOME"],
  cliEntry,
  node: process.version,
  electron: String(electronPath),
});

// 1. 启动 Renderer 开发服务器
console.log("[dev] starting renderer dev server...");
rendererServer = await createServer({ configFile: "vite.renderer.config.ts" });
await rendererServer.listen();
const rendererUrl = rendererServer.resolvedUrls!.local[0];
console.log(`[dev] renderer: ${rendererUrl}`);
devLog("renderer-ready", { url: rendererUrl });

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
  // BUNDLE_START 也留痕：卡死的指纹就是「有 bundle-start 没有 bundle-end」（失败会走 ERROR）
  if (e.code === "BUNDLE_START") {
    devLog("main-bundle-start");
  }
  if (e.code === "BUNDLE_END") {
    console.log(`[dev] main built in ${e.duration}ms`);
    devLog("main-bundle-end", { durationMs: e.duration, bundleMtime: bundleMtime() });
    mainBuiltOnce = true;
    mainReady = true;
    onBundleReady();
  }
  if (e.code === "ERROR") {
    lastBuildErrorAt = Date.now();
    devLog("main-bundle-error", { error: String((e.error as { message?: string })?.message ?? e.error) });
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
  if (e.code === "BUNDLE_START") {
    devLog("preload-bundle-start");
  }
  if (e.code === "BUNDLE_END") {
    console.log(`[dev] preload built in ${e.duration}ms`);
    devLog("preload-bundle-end", { durationMs: e.duration });
    preloadBuiltOnce = true;
    preloadReady = true;
    onBundleReady();
  }
  if (e.code === "ERROR") {
    lastBuildErrorAt = Date.now();
    devLog("preload-bundle-error", { error: String((e.error as { message?: string })?.message ?? e.error) });
    console.error("[dev] preload build error:", e.error);
  }
});

// 4. watcher 卡死自检（源码比产物新且持续 → 写 dev.jsonl 并提示重启）
installStallDetector();

console.log("[dev] waiting for main + preload to finish first build...");
