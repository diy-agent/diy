#!/usr/bin/env node
/**
 * bin/diy2.mjs — diy2 CLI 入口
 *
 * 入口查找策略（按优先级）：
 *   1. out/cli/index.js  — Vite 编译产物（生产环境）
 *   2. src/cli/index.ts   — 源码 + tsx（开发环境，npm workspaces 兼容）
 *   3. tsx (PATH)         — 全局 tsx fallback
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findEntry() {
  // 1. 优先编译产物
  const built = join(__dirname, "..", "out", "cli", "index.js");
  if (existsSync(built)) {
    return { entry: built, runner: process.execPath };
  }

  // 2. 源码 + tsx（开发模式）
  const src = join(__dirname, "..", "src", "cli", "index.ts");
  const tsxCandidates = [
    join(__dirname, "..", "node_modules", ".bin", "tsx"),
    join(__dirname, "..", "..", "..", "node_modules", ".bin", "tsx"),
  ];
  for (const tsx of tsxCandidates) {
    if (existsSync(tsx)) {
      return { entry: src, runner: tsx };
    }
  }

  // 3. PATH 上的 tsx
  return { entry: src, runner: "tsx" };
}

const { entry, runner } = findEntry();
const result = spawnSync(runner, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
