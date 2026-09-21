#!/usr/bin/env bash
# scripts/check-no-emit.sh — 产物护栏：TS 包源码目录旁不得出现编译产物。
#
# 为什么必须有这一步：`.js/.jsx/.d.ts` 一旦落在 `.ts/.tsx` 旁边，
# vite/vitest/node 的无扩展名解析会**优先命中产物**（resolve.extensions 里 .js 在 .ts 前），
# 于是 dev / 构建 / 单测全都在静默跑旧代码（症状：「改了源码没反应」、单测测的不是源码）。
# 类型检查不会因此报错，所以只能在门口拦一道。
#
# 范围：pkgs.ts/*/{src,tests,test,scripts}（只扫 TS 包源码目录，不碰仓库根 scripts/ 与其它产物目录）。
# 处置：删掉产物后重跑 check；类型检查一律用 `tsc --noEmit`（各包 tsconfig 已 noEmit:true）。
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC2046
dirs=$(ls -d pkgs.ts/*/src pkgs.ts/*/tests pkgs.ts/*/test pkgs.ts/*/scripts 2>/dev/null || true)
if [ -z "$dirs" ]; then
  echo "check-no-emit: 未找到扫描目录（配置漂移？）" >&2
  exit 1
fi

# shellcheck disable=SC2086
bad=$(find $dirs -type f \
  \( -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.d.ts' \) \
  2>/dev/null | sort || true)

if [ -n "$bad" ]; then
  echo "✗ 发现误 emit 产物（裸 tsc / IDE emit）：" >&2
  echo "$bad" >&2
  echo "" >&2
  echo "  处置：git clean -f pkgs.ts/*/src pkgs.ts/*/tests pkgs.ts/*/scripts" >&2
  echo "  类型检查请用 tsc --noEmit（各包 tsconfig 已 noEmit:true）" >&2
  exit 1
fi
exit 0
