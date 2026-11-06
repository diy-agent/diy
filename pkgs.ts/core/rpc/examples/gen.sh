#!/usr/bin/env bash
# gen.sh —— 生成所有示例的 `src/gen/api.generated.d.ts`
#
# 为什么示例也要一条命令：**示例即示范**。如果示例自己都要手工拼一长串命令，
# 抄它的人就会各拼各的（有人在仓根、有人在包目录，路径一错就找不到文件）。
#
# 用法：
#   ./examples/gen.sh           # 生成
#   ./examples/gen.sh --check   # 只校验（CI / 提交前）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
cd "$ROOT"
exec node_modules/.bin/tsx pkgs.ts/core/rpc/scripts/gen-service-types.ts "$@"
