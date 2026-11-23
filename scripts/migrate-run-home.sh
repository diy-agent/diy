#!/usr/bin/env bash
# 迁移旧数据根 → run/（一次性；2026-11-23 编译/运行时重构）。
#
# 背景：旧布局把运行时数据放在**产物树**里（`build/<variant>/home`、`apps/diy2/build/prod/home`），
# 而 `clean` = `rm -rf build` —— 一条自愈命令能删掉库。新布局数据根在 `run/<app>/<label>`，
# 产物固定 `apps/<app>/build/prod`。
#
# 语义：
#   · 默认 dry-run，只打印 `源 → 目标`；
#   · `--apply` 才真拷（`rsync -a`，**不删源** —— 确认新实例跑通后自己 rm -rf 旧的）；
#   · 目标已存在且非空 → 跳过并在末尾汇总（不合并、不覆盖）；
#   · 旧目录不存在 → 跳过。
#
# 用法：
#   ./scripts/migrate-run-home.sh              # 看一眼要搬什么
#   ./scripts/migrate-run-home.sh --apply      # 执行
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h | --help)
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "✗ 未知参数：$arg（可用：--apply / --help）" >&2
      exit 2
      ;;
  esac
done

# 源 → 目标（都相对仓库根）。加新条目就在这里加一行。
pairs=(
  "build/lab/home|run/diy-app/lab"
  "build/test/home|run/diy-app/test"
  "build/preview/home|run/diy-app/preview"
  "apps/diy2/build/prod/home|run/diy2/prod"
)
# staging 是多 slot：build/staging/<slot>/home → run/diy-app/staging/<slot>
staging_root="$ROOT_DIR/build/staging"
if [[ -d "$staging_root" ]]; then
  for slot_dir in "$staging_root"/*/; do
    [[ -d "${slot_dir}home" ]] || continue
    slot="$(basename "$slot_dir")"
    pairs+=("build/staging/$slot/home|run/diy-app/staging/$slot")
  done
fi

cd "$ROOT_DIR"
skipped=()
moved=()
for pair in "${pairs[@]}"; do
  src="${pair%%|*}"
  dst="${pair##*|}"
  if [[ ! -d "$src" ]]; then
    continue
  fi
  if [[ -d "$dst" ]] && [[ -n "$(ls -A "$dst" 2>/dev/null)" ]]; then
    skipped+=("$src → $dst（目标非空，跳过）")
    continue
  fi
  moved+=("$src → $dst")
  if ((APPLY)); then
    mkdir -p "$dst"
    # 不搬 electron_user_data 之外的判断一律不做：整个数据根搬走（新路径就是新家）
    rsync -a "$src/" "$dst/"
    echo "✓ $src → $dst"
  else
    echo "· $src → $dst"
  fi
done

if ((${#moved[@]} == 0 && ${#skipped[@]} == 0)); then
  echo "没有需要迁移的旧数据根。"
fi
if ((${#skipped[@]} > 0)); then
  echo
  echo "跳过："
  printf '  %s\n' "${skipped[@]}"
fi
if ((APPLY == 0)) && ((${#moved[@]} > 0)); then
  echo
  echo "（dry-run）确认无误后重跑：./scripts/migrate-run-home.sh --apply"
  echo "源目录保留不删 —— 新实例跑通后自己 rm -rf 旧目录。"
fi
