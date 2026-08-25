// src/main/core/app-config.ts
// 🎯 AppConfig — 应用目录配置（纯数据，不依赖 Electron）
//
// 单根模型：所有数据落在 DIY_HOME 下，不再分散到 ~/.config / ~/.cache。
//   diyHome:          $DIY_HOME（worktree: ./build/home，测试: mkdtemp，生产: ~/.diy）
//   electronUserData: <diyHome>/electron_user_data  ← app.setPath("userData")
//   cache:            <diyHome>/cache               ← app.setPath("cache")
//
// 端口不再由 isTemp 派生：首选端口由入口注入（DIY_PORT，测试 0=随机），
// app.port 文件记录实际监听端口（运行时状态，CLI 据此复用已运行实例）。
//
// 旧路径 ~/.config/diy-app / ~/.cache/diy-app 已废弃，首次启动时如存在可手动迁移。

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { RuntimeConfig } from "../../runtime";

export class AppConfig {
  readonly diyHome: string;
  readonly cache: string;
  readonly electronUserData: string;

  /** 单根模型：cache/userData 从 diyHome 同一根派生 */
  constructor(home: string) {
    this.diyHome = home;
    this.cache = join(home, "cache");
    this.electronUserData = join(home, "electron_user_data");
  }

  /** 由运行时配置构造（home 来自入口注入的 DIY_HOME） */
  static fromRuntime(cfg: RuntimeConfig): AppConfig {
    return new AppConfig(cfg.home);
  }

  /** 读取上次实际监听端口；无记录返回 null（由调用方给定默认/兜底） */
  readPort(): number | null {
    const p = join(this.diyHome, "app.port");
    if (!existsSync(p)) return null;
    try {
      const port = parseInt(readFileSync(p, "utf-8").trim(), 10);
      return Number.isFinite(port) ? port : null;
    } catch {
      return null;
    }
  }

  writePort(port: number): void {
    writeFileSync(join(this.diyHome, "app.port"), String(port), "utf-8");
  }
}