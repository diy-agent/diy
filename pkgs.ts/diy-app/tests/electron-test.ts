// tests/electron-test.ts
// 🎯 启动隔离 Electron 实例，供 intent 测试连接真实 renderer
//
// 安全：每次启动分配独立临时 HOME（symlink 必要配置但不读写用户数据），
// 绝不触及 ~/.diy / ~/.config/diy-app 等生产数据。
// 依赖：已构建产物（out/main + out/preload + out/renderer），由 npm run build 保证。

import { spawn, type ChildProcess } from "node:child_process";
import { connect, type ClientHttp2Session } from "node:http2";
import { mkdtempSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import electronPath from "electron";

/** 等待 app.port 文件出现并返回端口 */
function waitForPort(home: string, timeoutMs = 30000): Promise<number> {
  const portFile = join(home, "app.port");
  const start = Date.now();
  return new Promise<number>((resolve, reject) => {
    const poll = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
          if (Number.isFinite(port)) return resolve(port);
        } catch {
          /* 重试 */
        }
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`等待 ${portFile} 超时（${timeoutMs}ms）`));
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

/** 就绪探测：HTTP/2 连 port 发一次 diy.doctor，直到可服务或超时。
 *  消化 app.port 文件出现但 RPC handler 尚未完全就绪、以及 HTTP/2 首连偶发失败的时序。
 */
function waitForRpcReady(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  const tryOnce = (): Promise<boolean> =>
    new Promise((resolve) => {
      const client: ClientHttp2Session = connect(`http://127.0.0.1:${port}`);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        client.destroy();
        resolve(ok);
      };
      client.on("error", () => finish(false));
      const req = client.request({ ":path": "/diy.doctor", ":method": "GET" });
      req.on("response", () => finish(true));
      req.on("error", () => finish(false));
      req.end();
      setTimeout(() => finish(false), 1000);
    });

  const loop = async () => {
    for (;;) {
      if (await tryOnce()) return;
      if (Date.now() - start > timeoutMs) throw new Error(`RPC 就绪探测超时（port ${port}，${timeoutMs}ms）`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  return loop();
}

/** 隔离 HOME：临时目录 + symlink 必要配置（不写坏用户数据） */
function makeIsolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "diy-app-test-"));
  const real = homedir();
  for (const d of [".config", ".local", ".ssh", ".cache"]) {
    const src = join(real, d);
    if (existsSync(src)) {
      try { symlinkSync(src, join(home, d)); } catch { /* 忽略重复 */ }
    }
  }
  for (const f of [".gitconfig"]) {
    const src = join(real, f);
    if (existsSync(src)) {
      try { symlinkSync(src, join(home, f)); } catch { /* 忽略 */ }
    }
  }
  return home;
}

export interface ElectronTest {
  /** 隔离 HOME（含 DIY_HOME），供 ./diy.sh 使用 */
  home: string;
  /** RPC 端口 */
  port: number;
  /** CDP WebSocket 地址（可被 playwright-cli attach 连接） */
  cdpUrl: string | null;
  /** 停止并清理 */
  stop(): Promise<void>;
}

/**
 * 等 Chromium 把实际 CDP 端口写入 <home>/electron_user_data/DevToolsActivePort。
 *
 * 为什么不用 stderr 里那句 "DevTools listening on ..."：取 CDP 地址一律走这个文件
 * （见 AGENTS.md「硬性约束：不得管道化子进程 stdio」）。文件由 Chromium 自己写，
 * 与 stdio 怎么接完全解耦，也就不需要为了抓一行日志去 pipe stderr。
 *
 * 拿不到不视为失败 —— 返回 null，测试照常跑（CDP 只是可观测性入口）。
 */
async function waitForCdpBase(home: string, timeoutMs = 8000): Promise<string | null> {
  const file = join(home, "electron_user_data", "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const lines = readFileSync(file, "utf-8").split("\n");
      const port = parseInt(lines[0]?.trim() ?? "", 10);
      const path = lines[1]?.trim();
      if (Number.isFinite(port) && port > 0 && path) {
        // 文件第二行就是 /devtools/browser/<id>，直接拼成 playwright-cli attach 需要的完整 URL
        // （attach 只给 base 会 404，这是踩过的坑）
        return `ws://127.0.0.1:${port}${path}`;
      }
    } catch {
      /* 文件还没写出来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/**
 * 启动隔离 Electron 实例。返回 { home, port, cdpUrl, stop }。
 * 必须在测试后调用 stop() 释放进程。
 */
export async function startElectronTest(): Promise<ElectronTest> {
  const home = makeIsolatedHome();
  const env = { ...process.env, HOME: home, DIY_HOME: home, DIY_MIRROR_DISPLAY: "1" };
  const appDir = join(__dirname, "..");

  const proc: ChildProcess = spawn(String(electronPath), ["out/main/index.mjs", "--remote-debugging-port=0"], {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // stdout/stderr 保持 pipe，但**必须持续 drain** —— 只 pipe 不读会填满管道缓冲把子进程
  // 卡在 write 上。这里不再为了抓 "DevTools listening" 而依赖它，只留一小段尾部用于
  // 启动失败时定位（CDP 地址改由 DevToolsActivePort 文件获取）。
  let stderrTail = "";
  proc.stdout?.on("data", () => {
    /* 纯排空 */
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  try {
    const port = await waitForPort(home);
    // 端口文件出现后再等 RPC 真正可服务，避免首条 CLI 命令偶发空响应
    await waitForRpcReady(port);
    const cdpUrl = await waitForCdpBase(home);
    return {
      home,
      port,
      cdpUrl,
      stop: () =>
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
          proc.once("exit", () => resolve());
          proc.kill("SIGTERM");
        }),
    };
  } catch (err) {
    proc.kill("SIGTERM");
    if (stderrTail.trim()) {
      console.error(`[electron-test] 启动失败，子进程 stderr 尾部：\n${stderrTail}`);
    }
    throw err;
  }
}
