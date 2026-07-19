// src/main/core/app-config.ts
// 🎯 AppConfig — 应用目录配置（纯数据，不依赖 Electron）
//
// 统一管理 diyHome / cache / electronUserData 三条路径。
// CLI、测试、Electron 主进程都用同一个类，不分裂。
//
// 生产默认:
//   diyHome:  ~/.diy                    ($DIY_HOME)
//   cache:    ~/.cache/diy-desktop2     (Electron 默认可覆盖)
//   userData: ~/.config/diy-desktop2    (Electron 默认可覆盖)
//   port:     18888

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

  /** 生产默认：基于 $DIY_HOME 或 ~/.diy */
  static default(): AppConfig {
    return new AppConfig(
      process.env[ENV_HOME] ?? join(homedir(), ".diy"),
      join(homedir(), ".cache", "diy-desktop2"),
      join(homedir(), ".config", "diy-desktop2"),
      false,
    );
  }

  /** 临时模式：/tmp/diy-<name>/{diy_home,cache,electron_user_data} */
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
