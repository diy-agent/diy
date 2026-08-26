#!/usr/bin/env node
// src/cli/index.ts — diy CLI 入口
//
// 运行配置统一由 src/runtime.ts readRuntimeConfig() 从入口注入的环境变量装配，
// 本文件不做任何路径/模式派生（无 isProduction / appRootDir 探测）。
// 入口脚本: worktree 开发 → ./diy.sh；发布 → bin/diy。
//
// 职责:
//   1. ensureAppPort: 复用已运行 app（app.port 文件）或 spawn Electron 守护进程
//   2. CliApp: RPC 客户端，把 CLI 命令转发到 app（HTTP/2）

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import electronPath from "electron";
import { HttpClientBinding } from "@diy/rpc/http";
import { CliApp } from "@diy/rpc/cli";
import { apiDef } from "../main/services/api-def";
import { readRuntimeConfig, type RuntimeConfig } from "../runtime";
import { AppConfig } from "../main/core/app-config";

/** app 就绪等待上限 */
const APP_READY_TIMEOUT_MS = 30_000;
/** 轮询间隔 */
const POLL_INTERVAL_MS = 200;

function readPort(cfg: RuntimeConfig): number | null {
  return new AppConfig(cfg.home).readPort();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 探测某端口上是否已有可用的 diy app */
async function probePort(port: number): Promise<boolean> {
  const c = new HttpClientBinding(`http://127.0.0.1:${port}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      c.ready(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("timeout")), 1500);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    c.dispose();
  }
}

/** 定位 Electron 主进程产物入口（CLI spawn app 用）。返回包根（out/ 的父目录）。
 * import.meta.url 源码模式为 src/cli/index.ts、编译模式为 out/cli/index.js，
 * 均为 appRoot 下 2 级，需 3 次 dirname 回到 pkgs.ts/diy-app */
function appRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function mainEntry(): string {
  return join(appRoot(), "out", "main", "index.mjs");
}

/** 启动 diy 管控台（Electron 主进程产物），作为独立进程持续运行 */
function launchApp(cfg: RuntimeConfig): ChildProcess {
  const main = mainEntry();
  if (!existsSync(main)) {
    throw new Error(`diy 管控台未构建: ${main}（先 npm run build）`);
  }

  // 保留 stderr 供排障，stdout 丢弃；detached+unref 让 app 在 CLI 退出后继续存活
  const child = spawn(String(electronPath), [main], {
    cwd: appRoot(),
    env: { ...process.env },
    stdio: ["ignore", "ignore", "inherit"],
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
async function ensureAppPort(cfg: RuntimeConfig): Promise<number> {
  const existing = readPort(cfg);
  if (existing !== null && (await probePort(existing))) return existing;

  const child = launchApp(cfg);
  // spawn 失败（ENOENT 等）只发 error 事件，回调内 throw 无法进外层 catch；
  // 用 Promise 监听快速失败，避免空转 30s 才超时。
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", reject);
  });

  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const p = readPort(cfg);
      if (p !== null) {
        const ok = await Promise.race([probePort(p), spawnError]);
        if (ok) return p;
      }
      await Promise.race([delay(POLL_INTERVAL_MS), spawnError]);
    }
  } catch (e) {
    // 启动期 spawn 失败，尝试清理孤儿进程
    try { child.kill(); } catch { /* ignore */ }
    throw e;
  }
  try { child.kill(); } catch { /* ignore */ }
  throw new Error(`diy 管控台启动超时（${APP_READY_TIMEOUT_MS}ms）`);
}

async function main() {
  const cfg = readRuntimeConfig();
  const argv = process.argv.slice(2);

  const port = await ensureAppPort(cfg);
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
  console.error(`致命错误: ${msg}`);
  process.exit(1);
});