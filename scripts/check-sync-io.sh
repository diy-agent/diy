#!/usr/bin/env bash
# scripts/check-sync-io.sh —— 「app 里不许有同步 IO」护栏入口（##408 刀 16）
#
# 两步：
#   ① `--self-test` 正反例自检（护栏本身坏了要立刻发现，不能静默放行）
#   ② 扫 `pkgs.ts/diy-app/src/{main,shared,preload}`，与 LEGACY_SYNC_IO_BASELINE
#      （按文件钉数、只许减）比对
# 判据、逃生口、基线刷新方式见 scripts/check-sync-io.mjs 头注。
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/check-sync-io.mjs --self-test
node scripts/check-sync-io.mjs
