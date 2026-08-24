#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import electronPath from "electron";
import { HttpClientBinding } from "@diy/rpc/http";
import { CliApp } from "@diy/rpc/cli";
import { apiDef } from "../main/services/api-def";

const isProduction = fileURLToPath(import.meta.url).includes("/out/cli/");

/** app 就绪等待上限 */
const APP_READY_TIMEOUT_MS = 30_000;
/** 轮询间隔 */
const POLL_INTERVAL_MS = 200;

function resolveHome(): string {
  return process.env["DIY_HOME"] ?? join(homedir(), ".diy");
}

function readPort(): number | null {
  const portPath = join(resolveHome(), "app.port");
  if (!existsSync(portPath)) return null;
  try {
    const port = parseInt(readFileSync(portPath, "utf-8").trim(), 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

/**
 * diy-app 包根目录。
 * 本文件编译后位于 src/cli/index.ts（开发）或 out/cli/index.js（生产），
 * 向上两级即 pkgs.ts/diy-app。
 */
function appRootDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 探测某端口上是否已有可用的 diy app */
async function probePort(port: number): Promise<boolean> {
  const c = new HttpClientBinding(`http://127.0.0.1:${port}`);
  try {
    await Promise.race([
      c.ready(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    c.dispose();
  }
}

/** 解析 CLI 传入的 --port（供透传给 app） */
function parsePortArg(): string | null {
  const idx = process.argv.indexOf("--port");
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  return v ?? null;
}

/** 启动 diy 管控台（Electron 生产构建），作为独立进程持续运行 */
function launchApp(): ChildProcess {
  const appDir = appRootDir();
  const main = join(appDir, "out", "main", "index.mjs");
  if (!existsSync(main)) {
    throw new Error(`diy 管控台未构建: ${main}（先 npm run build）`);
  }
  const args: string[] = [main];
  const portArg = parsePortArg();
  if (portArg !== null) args.push("--port", portArg);

  const child = spawn(String(electronPath), args, {
    cwd: appDir,
    env: { ...process.env },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child;
}

/**
 * 确保 diy 管控台在运行。
 * 1) 已运行 → 直接复用其端口；2) 未运行 → 自动启动并等待就绪。
 * 起不来则报错（不再回退本地内存执行）。
 */
async function ensureAppPort(): Promise<number> {
  const existing = readPort();
  if (existing !== null && (await probePort(existing))) return existing;

  const child = launchApp();
  // spawn 失败（ENOENT 等）只发 error 事件，回调内 throw 无法进外层 catch；
  // 用 Promise 监听快速失败，避免空转 30s 才超时。
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", reject);
  });

  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const p = readPort();
    if (p !== null) {
      const ok = await Promise.race([probePort(p), spawnError]);
      if (ok) return p;
    }
    await Promise.race([delay(POLL_INTERVAL_MS), spawnError]);
  }
  throw new Error(`diy 管控台启动超时（${APP_READY_TIMEOUT_MS}ms）`);
}

async function main() {
  const argv = process.argv.slice(2);

  const port = await ensureAppPort();
  const transport = new HttpClientBinding(`http://127.0.0.1:${port}`);
  await transport.ready();

  await new CliApp({
    name: "diy",
    version: "0.1.0",
    router: apiDef.diy,
    transport,
  }).parse(argv);

  // 清理：关闭 RPC 连接，允许进程正常退出（app 保持运行）
  transport.dispose();
  process.exit(0);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (isProduction) {
    console.error(msg);
  } else {
    console.error(`致命错误: ${msg}`);
    if (e instanceof Error && e.stack) {
      console.error(e.stack.split("\n").slice(1, 4).join("\n"));
    }
  }
  process.exit(1);
});
