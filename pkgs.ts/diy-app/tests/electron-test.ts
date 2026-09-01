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
  /** 停止并清理 */
  stop(): Promise<void>;
}

/**
 * 启动隔离 Electron 实例。返回 { home, port, stop }。
 * 必须在测试后调用 stop() 释放进程。
 */
export async function startElectronTest(): Promise<ElectronTest> {
  const home = makeIsolatedHome();
  const env = { ...process.env, HOME: home, DIY_HOME: home, DIY_MIRROR_DISPLAY: "1" };
  const appDir = join(__dirname, "..");

  const proc: ChildProcess = spawn(String(electronPath), ["out/main/index.mjs"], {
    cwd: appDir,
    env,
    stdio: "ignore",
  });

  try {
    const port = await waitForPort(home);
    // 端口文件出现后再等 RPC 真正可服务，避免首条 CLI 命令偶发空响应
    await waitForRpcReady(port);
    return {
      home,
      port,
      stop: () =>
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
          proc.once("exit", () => resolve());
          proc.kill("SIGTERM");
        }),
    };
  } catch (err) {
    proc.kill("SIGTERM");
    throw err;
  }
}
