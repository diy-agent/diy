#!/usr/bin/env node
/**
 * bin/diy.mjs — diy-app CLI 入口
 *
 * 区分生产 / 开发模式：
 *   - 生产（NODE_ENV=production）：运行编译产物 out/cli/index.js（需先 npm run build:cli）
 *   - 开发（默认）：用 tsx 跑源码 src/cli/index.ts
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const binDir = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";

if (isProd) {
  const built = join(binDir, "..", "out", "cli", "index.js");
  if (!existsSync(built)) {
    console.error("[diy] 生产模式但未找到编译产物 out/cli/index.js，请先 npm run build:cli");
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [built, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

// 开发模式：tsx 跑源码（tsx 取 workspace 根 hoist 的 .bin/tsx，缺失回退 PATH）
const src = join(binDir, "..", "src", "cli", "index.ts");
const tsx = join(binDir, "..", "..", "..", "node_modules", ".bin", "tsx");
const runner = existsSync(tsx) ? tsx : "tsx";
const result = spawnSync(runner, [src, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
