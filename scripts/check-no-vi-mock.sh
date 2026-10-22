#!/usr/bin/env bash
# scripts/check-no-vi-mock.sh —— `vi.mock` 禁令护栏（##402）
#
# 为什么是硬禁令而不是「尽量别用」：
#   `./sha.sh test-unit` 跑 `--no-isolate`（每个 worker 共享一份模块图，省掉每文件
#   transform + setup + import 的固定成本，实测 127.95s → ~13s）。而 `vi.mock` 改的是
#   **全局模块表**，在 `isolate:false` 下会被**先加载的那个实现**静默顶掉 —— 症状是
#   「单独跑绿、一起跑红」，且**没有任何报错指出是 mock 没生效**。
#   同理 `vi.resetModules()` 对 node_modules 里的包默认不重建（见 vitest.config.ts 的
#   `server.deps.inline`）。⇒ 只要有人在 tests/ 下加一条 `vi.mock(`，整套单测的语义就悄悄变了。
#
# 替代写法（见 tests/helpers/renderer-deps.ts）：依赖注入 / 传参 / 手写假对象。
# 逃生口：确实无法注入的（第三方模块顶层副作用），把它 inline 进
#   `vitest.config.ts` 的 `server.deps.inline` 或加 alias，**不要**回到 vi.mock。
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(grep -rn --include='*.test.ts' -E '\bvi\.mock[<(]' pkgs.ts/diy-app/tests || true)
if [ -n "$hits" ]; then
  echo "✗ tests/ 下出现了 vi.mock（test-unit 跑 --no-isolate，它会静默失效）："
  echo "$hits"
  echo "  替代写法见 scripts/check-no-vi-mock.sh 头注（注入 / 手写假对象 / server.deps.inline alias）。"
  exit 1
fi
echo "✓ vi.mock 禁令护栏通过（tests/ 0 命中）"
