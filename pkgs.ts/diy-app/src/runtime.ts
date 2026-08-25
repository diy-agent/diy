// src/runtime.ts — 运行时配置统一组装点。
//
// 契约：入口脚本（diy.sh / bin/diy / electron-dev.mts / tests/setup）只负责注入环境变量，
// CLI / main / serve 各进程在此一次性读取，不再做路径/标志派生（如 import.meta.url 探测产物、
// app.isPackaged 判定 dev、home 路径派生端口等）。
//
// 环境变量契约：
//   DIY_HOME            数据根（state/task/app.port 落此）
//   DIY_PORT            首选端口（测试注入 0=随机；缺省时靠 app.port 文件 / rpc 兜底 18888）
//   DIY_DEV_SERVER_URL  dev 时 GUI 加载的 Vite URL；缺省 → loadFile 编译产物
//
// 产物根（out/ 所在目录）由各进程自己通过 import.meta.url 计算，不需要环境变量注入。

import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeConfig {
  /** 数据根（state/task/app.port） */
  home: string;
  /** 首选端口（入口注入；无则不固定，由 app.port 文件 / 兜底决定） */
  port?: number;
  /** dev 时 GUI 加载的 Vite URL */
  devServerUrl?: string;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const home = env.DIY_HOME ?? join(homedir(), ".diy");
  const portRaw = env.DIY_PORT;
  const port = portRaw !== undefined && portRaw !== "" ? Number(portRaw) : undefined;
  return {
    home,
    port: port !== undefined && Number.isFinite(port) ? port : undefined,
    devServerUrl: env.DIY_DEV_SERVER_URL || undefined,
  };
}