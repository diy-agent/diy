// src/runtime.ts — 运行时配置统一组装点。
//
// 契约：入口脚本（diy.sh / bin/diy / electron-dev.mts / tests/setup）只负责注入环境变量，
// CLI / main / serve 各进程在此一次性读取，不再做路径/标志派生（如 import.meta.url 探测产物、
// app.isPackaged 判定 dev、home 路径派生端口等）。
//
// 环境变量契约：
//   DIY_HOME            数据根（state/task/app.port 落此）
//   DIY_CLI             当前生效的 CLI 入口绝对路径（提示词模版自述用；入口脚本自己注入）
//   DIY_PORT            首选端口（测试注入 0=随机；缺省时靠 app.port 文件 / rpc 兜底 18888）
//   DIY_ENV             运行环境（见 DiyEnv）：入口脚本声明"我是什么环境"，业务侧按它派生
//                       dev/test 专属能力（如副屏定位），不再每能力加一个变量。
//                       缺省 = production（生产安全：没人声明就是生产，dev 能力默认全关）。
//   DIY_DEV_SERVER_URL  dev 时 GUI 加载的 Vite URL；缺省 → loadFile 编译产物
//   DIY_NO_LAUNCH       1 = CLI 禁止自动拉起 app（只允许复用已运行实例；探测不到即报错）。
//                       测试环境专用：测试自己用 startElectronTest 启动实例并持有句柄，
//                       CLI 若在探测超时时另起一个 detached 实例，测试无法回收 → 进程泄露。
//                       生产不设，保持「敲 diy 命令顺手把 app 带起来」的既有体验。
//
// 产物根（out/ 所在目录）由各进程自己通过 import.meta.url 计算，不需要环境变量注入。

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 运行环境枚举 —— DIY_ENV 的合法值。
 * - production: 发布态（bin/diy / npm 全局）。dev 便利能力全部关闭。缺省即此。
 * - development: worktree 开发（./diy.sh、./sha.sh dev）。
 * - test: 自动化测试（意图测试 harness）。
 * 刻意不借用 NODE_ENV：那是公共频段（Vite/Express/React 各有语义），DIY_ 前缀自管自用。
 */
export type DiyEnv = "production" | "development" | "test";

/** 从 DIY_ENV 原始值解析；无法识别的值一律按 production（宁可少开能力，不可误开） */
export function parseDiyEnv(raw: string | undefined): DiyEnv {
  return raw === "development" || raw === "test" ? raw : "production";
}

export interface RuntimeConfig {
  /** 数据根（state/task/app.port） */
  home: string;
  /** 当前生效的 CLI 入口绝对路径（入口脚本注入；提示词模版 100-diy 消费） */
  cli?: string;
  /** 首选端口（入口注入；缺省时不固定，由 app.port 文件 / 兜底决定） */
  port?: number;
  /** 运行环境（能力开关的唯一判据；用法 cfg.env === "test"，不设 isDev/isProd helper） */
  env: DiyEnv;
  /** dev 时 GUI 加载的 Vite URL */
  devServerUrl?: string;
  /** 禁止 CLI 自动拉起 app（测试注入，防实例逃逸） */
  noLaunch: boolean;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const home = env.DIY_HOME ?? join(homedir(), ".diy");
  const portRaw = env.DIY_PORT;
  const port = portRaw !== undefined && portRaw !== "" ? Number(portRaw) : undefined;
  return {
    home,
    cli: env.DIY_CLI || undefined,
    port: port !== undefined && Number.isFinite(port) ? port : undefined,
    env: parseDiyEnv(env.DIY_ENV),
    devServerUrl: env.DIY_DEV_SERVER_URL || undefined,
    noLaunch: env.DIY_NO_LAUNCH === "1",
  };
}
