#!/usr/bin/env bash
# scripts/check-exec-bit.sh — 可执行位护栏：shell 脚本在 git 索引里必须记 100755。
#
# 为什么必须有这一步：Windows 的 NTFS **没有可执行位**，git for Windows 默认
# `core.fileMode=false` —— 工作区 `chmod +x` 记不住，`git add` 新文件一律记 100644。
# 于是从 Windows 新增 / 拷贝进来的脚本会**静默丢可执行位**，别人在新 worktree 上
# `./sha.sh sync` 直接 `Permission denied`（镜像里 `_ws_run` 逐个 `command ./sha.sh`，
# 轮到谁谁炸）。`.gitattributes` 表达不了 file mode，配置层面无解，只能在门口拦一道。
#
# 判据：索引里首行 shebang 解释器是 bash/sh/zsh/dash/ksh 的文件，mode 必须 100755。
#   按 shebang 判而非按 `.sh` 后缀 —— 顺带覆盖 `bin/diy`、`pkgs.ts/diy-dev/bin/dev`
#   这类无扩展名入口；也不会误伤 `#!/usr/bin/env node|python3|npx tsx` 的 `.ts/.mts/.py`
#   （它们由解释器显式调用，不需要 exec 位）。
# 处置：`git update-index --chmod=+x <文件>`（**须在 Windows 之外的平台提交才生效**）。
set -euo pipefail

cd "$(dirname "$0")/.."

bad=()
while IFS= read -r path; do
  [ -n "$path" ] || continue
  mode=$(git ls-files -s -- "$path" | awk '{print $1}')
  [ "$mode" = 100755 ] || bad+=("${path}  (mode ${mode:-未跟踪})")
done < <(git grep --cached -l -E '^#!.*(bash|sh|zsh|dash|ksh)' || true)

if [ ${#bad[@]} -gt 0 ]; then
  echo "✗ shell 脚本在 git 索引里丢了可执行位：" >&2
  printf '  %s\n' "${bad[@]}" >&2
  echo "" >&2
  echo "  处置：git update-index --chmod=+x <文件>（须在 Windows 之外的平台提交才生效）" >&2
  echo "  根因：NTFS 无可执行位 + git for Windows 默认 core.fileMode=false，详见 ##304(Windows 提交丢可执行位)。" >&2
  exit 1
fi
exit 0
