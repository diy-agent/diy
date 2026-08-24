// src/main/core/app-config.ts
// 🎯 AppConfig — 应用目录配置（纯数据，不依赖 Electron）
//
// 单根模型：所有数据落在 DIY_HOME 下，不再分散到 ~/.config / ~/.cache。
//   diyHome:          ~/.diy 或 $DIY_HOME（worktree: ./build/home，测试: mkdtemp）
//   electronUserData: <diyHome>/electron_user_data  ← app.setPath("userData")
//   cache:            <diyHome>/cache               ← app.setPath("cache")
//   port:             18888
//
// 旧路径 ~/.config/diy-app / ~/.cache/diy-app 已废弃，首次启动时如存在可手动迁移。

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const ENV_HOME = "DIY_HOME";
const DEFAULT_PORT = 18888;

export class AppConfig {
  readonly diyHome: string;
  readonly cache: string;
  readonly electronUserData: string;
  readonly isTemp: boolean;
  readonly defaultPort: number;

  constructor(home: string, cache: string, userData: string, isTemp: boolean) {
    this.diyHome = home;
    this.cache = cache;
    this.electronUserData = userData;
    this.isTemp = isTemp;
    this.defaultPort = isTemp ? 0 : DEFAULT_PORT;
  }

  /** 默认：基于 $DIY_HOME 或 ~/.diy，派生 cache/userData 到同一根下 */
  static default(): AppConfig {
    const home = process.env[ENV_HOME] ?? join(homedir(), ".diy");
    // tmpdir 下视为临时隔离，端口用 0 随机，避免与生产 18888 冲突
    const isTemp = home.startsWith(tmpdir() + "/");
    return new AppConfig(
      home,
      join(home, "cache"),
      join(home, "electron_user_data"),
      isTemp,
    );
  }

  /** 临时模式：/tmp/diy-<name>/{diy_home,cache,electron_user_data}（仅测试/隔离场景，保留兼容） */
  static createTemp(name: string): AppConfig {
    const root = join(tmpdir(), `diy-${name}`);
    const dirs = {
      diyHome: join(root, "diy_home"),
      cache: join(root, "cache"),
      electronUserData: join(root, "electron_user_data"),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    return new AppConfig(dirs.diyHome, dirs.cache, dirs.electronUserData, true);
  }

  /** Electron 环境覆盖 cache/userData */
  withElectronPaths(cache: string, userData: string): AppConfig {
    return new AppConfig(this.diyHome, cache, userData, this.isTemp);
  }

  readPort(): number {
    const p = join(this.diyHome, "app.port");
    if (!existsSync(p)) return this.defaultPort;
    try {
      const port = parseInt(readFileSync(p, "utf-8").trim(), 10);
      return Number.isFinite(port) ? port : this.defaultPort;
    } catch {
      return this.defaultPort;
    }
  }

  writePort(port: number): void {
    writeFileSync(join(this.diyHome, "app.port"), String(port), "utf-8");
  }
}

/** 便捷函数：获取当前 diyHome（兼容 CLI / 测试 / Electron） */
export function resolveHome(): string {
  return process.env[ENV_HOME] ?? AppConfig.default().diyHome;
}
