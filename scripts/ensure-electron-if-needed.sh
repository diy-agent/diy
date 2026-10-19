#!/usr/bin/env bash
# scripts/ensure-electron-if-needed.sh — CLI 入口的 electron 二进制快检（缺/悬空才起 node 补）。
#
# 为什么 CLI 入口要自己查（2026-10 实测）：src/cli/index.ts 顶层 `import electronPath from "electron"`
# ⇒ **每条命令**（连 `task list`）都要经 electron 的 getElectronPath()。缺二进制时它不提示也不报错：
#   · dist 是**悬空软链**（全机 store 被清 / 被缓存清理工具删）→ install.js 失败
#     `failed to create destination ...: File exists (os error 17)`，还指引「删掉 node_modules/electron」
#     （照做要重装包）—— 即「缺了不会自己重下」；
#   · dist 整个缺失 → **无超时静默下载**（实测卡数分钟、CPU 0%）。
# 修这两种状态的是 scripts/ensure-electron.mjs（重建 store + 重写 path.txt + 重挂软链）。
#
# 快检用**纯 bash**（读 path.txt + test 可执行文件），只有真缺了才起 node ——
# 不给每条 CLI 命令加 node 启动开销。调用方：diy.sh（dev 客户端）· pkgs.ts/diy-app/bin/diy（全局 diy）。
# 用法：<repo>/scripts/ensure-electron-if-needed.sh（仓库根 = 本文件上一级）；就绪则静默退出 0。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/node_modules/electron"

# 包不在这儿（没装 / 装在子层）：交给 Node 自己的解析规则，不猜
if [[ ! -f "$PKG/package.json" ]]; then exit 0; fi

EXE=""
if [[ -f "$PKG/path.txt" ]]; then EXE="$(cat "$PKG/path.txt")"; fi
if [[ -n "$EXE" && -e "$PKG/dist/$EXE" ]]; then exit 0; fi

echo "[ensure-electron] electron 二进制缺失/失效 → 先补（$ROOT/scripts/ensure-electron.mjs）" >&2
exec node "$ROOT/scripts/ensure-electron.mjs" --quiet
