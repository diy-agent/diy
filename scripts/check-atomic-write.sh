#!/usr/bin/env bash
# scripts/check-atomic-write.sh —— 整文件覆盖写护栏入口（草案，##383）
#
# 两步：
#   ① `--self-test` 正反例自检（护栏本身坏了要立刻发现，不能静默放行）
#   ② 扫 `src/main`（含 serve/preload/renderer_solid）实际调用点
# 判据与豁免见 scripts/check-atomic-write.mjs 头注。
#
# 接入（##383 第二阶段）：根 `sha.sh check()` 里加一行
#   run bash scripts/check-atomic-write.sh
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/check-atomic-write.mjs --self-test
node scripts/check-atomic-write.mjs
