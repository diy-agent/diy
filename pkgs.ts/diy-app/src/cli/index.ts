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

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import electronPath from "electron";
import { HttpClientBinding } from "@diy/rpc/http";
import { CliApp } from "@diy/rpc/cli";
import { apiDef } from "../main/services/api-def";
import { readRuntimeConfig, type RuntimeConfig } from "../runtime";
import { AppConfig } from "../main/core/app-config";
import { installDiagnostics } from "../main/services/diagnostics";
import { SINGLETON_LOCK, classifyLock, lockAdvice, readLock } from "../main/core/single-instance";
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
    throw new Error(`diy 管控台未构建: ${main}（先 ./sha.sh build）`);
  }

  // 副屏定位等 dev/test 专属能力由 DIY_ENV 派生（src/runtime.ts）：入口脚本声明环境，
  // CLI 仅透传 process.env；生产入口 bin/diy 注入 production → 窗口默认落主屏，不切 iPad。
  // --remote-debugging-port=0: 暴露 CDP，支持 playwright-cli attach
  // Chromium 开关（disable-features=RustPng / use-gl=angle）由 src/main/index.ts 经
  // app.commandLine.appendSwitch 生效，跟在 app 路径后传 argv 无效，故此处不传。
  //
  // stdio 必须保持 inherit/ignore：本进程 detached+unref，CLI 随即退出，
  // 一旦把 stdout/stderr 接成 pipe，读端消失后管道缓冲写满会反向阻塞
  // Electron 主进程事件循环（表现为 RPC/CDP 全挂 + 系统「未响应」弹框）。
  // CDP 地址改由 DevToolsActivePort 文件获取，见 printCdpHint()。
  const child = spawn(String(electronPath), [main, "--remote-debugging-port=0"], {
    cwd: appRoot(),
    env: { ...process.env },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });

  child.unref();
  return child;
}

/**
 * app 就绪后提示 CDP 连接方式（供 playwright-cli 驱动真实 Electron 窗口）。
 * 静默失败：CDP 未启用 / 文件未生成时不打扰正常输出，且绝不写 stdout 污染 --json。
 */
function printCdpHint(cfg: RuntimeConfig): void {
  try {
    const raw = readFileSync(join(cfg.home, "electron_user_data", "DevToolsActivePort"), "utf-8");
    const [port, path] = raw.split("\n").map((s) => s.trim());
    if (!port || !path) return;
    console.error(`[diy] CDP: playwright-cli attach --cdp=ws://127.0.0.1:${port}${path}`);
  } catch {
    /* CDP 未启用，忽略 */
  }
}

/**
 * 确保 diy 管控台在运行。
 * 1) 已运行 → 直接复用其端口；2) 未运行 → 自动启动并等待就绪。
 * 起不来则报错（不再回退本地内存执行）。
 */
async function ensureAppPort(cfg: RuntimeConfig): Promise<number> {
  const existing = readPort(cfg);
  if (existing !== null && (await probePort(existing))) return existing;

  // 测试环境：只允许复用，不允许自建。测试用 startElectronTest 启动实例并持有句柄，
  // 此处若在探测超时（如并发抢 CPU 让 probePort 的 1500ms 落空）时另起 detached 实例，
  // 该实例不在测试的句柄集合里，teardown 永远回收不到 → 泄露。
  // 报错而非静默继续：把「app 未就绪」暴露成测试失败，而不是留一个没人管的进程。
  if (cfg.noLaunch) {
    throw new Error(
      `DIY_NO_LAUNCH=1：app 未在 ${cfg.home} 就绪（app.port=${existing ?? "缺失"}）。` +
        `测试环境禁止 CLI 自动拉起实例；请确认 startElectronTest() 已成功启动并传入了同一个 HOME。`,
    );
  }

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
        if (ok) {
          printCdpHint(cfg);
          return p;
        }
      }
      await Promise.race([delay(POLL_INTERVAL_MS), spawnError]);
    }
  } catch (e) {
    // 启动期 spawn 失败，尝试清理孤儿进程
    try { child.kill(); } catch { /* ignore */ }
    throw e;
  }
  try { child.kill(); } catch { /* ignore */ }
  // 「启动超时」对任何成因（陈旧锁/端口被占/构建缺失/hang）都是黑盒 → 按处境给下一步。
  // 锁诊断复用 core/single-instance（dev 与 main 同一套判定）。
  const lockPath = join(new AppConfig(cfg.home).electronUserData, SINGLETON_LOCK);
  const situation = classifyLock(readLock(lockPath));
  throw new Error(
    `diy 管控台启动超时（${APP_READY_TIMEOUT_MS}ms）` +
      (situation.kind === "free"
        ? `。不是单实例锁问题。下一步：看 $DIY_HOME/log/main.log（端口/构建/hang 任一种）`
        : `。${lockAdvice(situation, lockPath).replace(/\n/g, " ")}`),
  );
}

/**
 * 等 stdout 排空再退出。
 * 背景（实测）：stdout 是管道时 node 的写入是异步的，`process.exit()` 会丢掉还没交出去的字节
 * —— 输出超过管道缓冲（65536）时表现为**JSON 被截成一半**（下游 `jq` / 脚本 / 意图测试全炸）。
 * 重定向到文件时是同步写，所以只有管道才暴露。
 */
async function flushStdout(): Promise<void> {
  if (process.stdout.writableLength === 0) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 2000); // 兜底：管道另一端不读时别挂死
    process.stdout.once("drain", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function main() {
  const cfg = readRuntimeConfig();
  // CLI 也走同一套诊断：stdout/stderr 断线不再升级成未捕获异常（父进程/终端消失时），
  // 输出镜像到 <DIY_HOME>/log/cli.log，便于事后还原某次调用的真实行为。
  installDiagnostics(cfg.home, "cli");
  const argv = process.argv.slice(2);

  const port = await ensureAppPort(cfg);
  const transport = new HttpClientBinding(`http://127.0.0.1:${port}`);
  await transport.ready();

  await new CliApp({
    name: "diy",
    version: "0.1.0",
    router: apiDef.diy,
    transport,
    // 路径参数（如 tool read 的 path）按**调用者**目录解析：入口脚本已 cd 到应用目录，
    // 进程 cwd 不再可信，故由 DIY_CALLER_CWD 显式带过来（见 diy.sh / bin/diy）。
    cwd: process.env["DIY_CALLER_CWD"] || process.cwd(),
  }).parse(argv);

  // 清理：关闭 RPC 连接，允许进程正常退出（app 保持运行）
  transport.dispose();
  await flushStdout();
  process.exit(0);
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`致命错误: ${msg}`);
  await flushStdout();
  process.exit(1);
});