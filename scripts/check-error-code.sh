#!/usr/bin/env bash
# scripts/check-error-code.sh —— 「新增异常必须带 code」护栏入口（##394）
#
# 两步：
#   ① `--self-test` 正反例自检（护栏本身坏了要立刻发现，不能静默放行）
#   ② 扫 `pkgs.ts/diy-app/src`，与 LEGACY_THROW_BASELINE（按文件钉数、只许减）比对
# 判据、逃生口、基线刷新方式见 scripts/check-error-code.mjs 头注。
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/check-error-code.mjs --self-test
node scripts/check-error-code.mjs
