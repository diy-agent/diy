#!/usr/bin/env bash
# 把生产数据根（~/.diy）的真配置**填充**进测试实例的数据根（`run/<app>/<label>`）。
#
# 清单只 3 份，且**只有 model.yaml 是必需的**（见下方「内容」）。
#
# 为什么是拷贝而不是运行时直读（2026-11-23 定）：测试实例必须**完整依赖自己的数据根**。
# 运行时若回落 `~/.diy/model.yaml`，lab 里改模型 / 存凭据就会写生产文件 —— 隔离是假的
# （diy2 里 `<provider>/<account>` 的 key 读的就是它）。所以真配置只在**准备**阶段复制，
# 之后实例只认 `$DIY_HOME/model.yaml`。
#
# 内容（**只有 model.yaml 是必需的**，2026-11-23 实测：空数据根只放它就能起服务）：
#   model.yaml（provider + key，缺了模型全部不可用）
#   personas.yaml / providers.custom.yaml（可选：缺 personas 走内置人物；customProviders 为空时
#   providers.custom.yaml 根本没人读）
#   input-limit / auto-compact / cache-hint / context / tools-surface —— 都有默认值且是
#   **运行时写入式**，不种子（`~/.diy` 里本来也没有 input-limit.yaml）
#
# 语义：
#   · 无参数 → 扫 `run/<app>/<label>` 里**已存在的数据根**（有 diy2.db / electron_user_data /
#     rooms / local 之一）；含 key 的副本只落在 .gitignore 内的 run/
#   · `--defaults` → 另外**建出**每个 app 的默认开发数据根 `run/<app>/lab`（新 worktree 里
#     跑一次 `./sha.sh sync` 就能直接 `./sha.sh lab`，不用先起一次空实例）
#   · 目标缺文件 → 拷；已存在 → 只在源更新（`-nt`）时覆盖；`--force` 无条件覆盖
#   · 源缺某份 → 跳过 + 提示，不整体失败（换机 / 首装时正常）
#   · `DIY_SYNC_HOME_SRC` 换源；`DIY_SYNC_HOME=0` 关掉（sync 里用）
#
# 用法：
#   ./scripts/seed-run-home.sh              # 扫 run/*/* 填充
#   ./scripts/seed-run-home.sh --defaults   # 扫 + 建出 run/<app>/lab（sync 用）
#   ./scripts/seed-run-home.sh --force      # 强制覆盖
#   ./scripts/seed-run-home.sh run/diy2/lab # 只填指定数据根
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT_DIR" ]]; then
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$ROOT_DIR"

SRC="${DIY_SYNC_HOME_SRC:-$HOME/.diy}"
# model.yaml 必需；另两份有默认/条件生效，跟生产一致时才拷（清单收窄见头注）
FILES=(model.yaml personas.yaml providers.custom.yaml)
FORCE=0
DEFAULTS=0
HOMES=()
for arg in "$@"; do
  case "$arg" in
    --force | -f) FORCE=1 ;;
    --defaults | -D) DEFAULTS=1 ;;
    -h | --help)
      sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) echo "✗ 未知参数：${arg}（可用：--force / --defaults / --help）" >&2; exit 2 ;;
    *) HOMES+=("$arg") ;;
  esac
done

if [[ ! -d "$SRC" ]]; then
  echo "源数据根不存在（${SRC}）→ 跳过" >&2
  exit 0
fi

# 无参：扫 run/<app>/<label> 里像数据根的目录（不递归更深，避免吃到 run/config 之类）
if ((${#HOMES[@]} == 0)); then
  shopt -s nullglob
  for d in run/*/*; do
    [[ -d "$d" ]] || continue
    if [[ -e "$d/diy2.db" || -d "$d/electron_user_data" || -d "$d/rooms" || -d "$d/local" ]]; then
      HOMES+=("$d")
    fi
  done
  shopt -u nullglob
fi

# --defaults：**建出**每个 app 的默认开发数据根 `run/<app>/lab`（幂等：已存在就只补缺文件）。
# app 列表按 apps/*/ 探（只认带 sha.sh 的），不硬编码包名。
if ((DEFAULTS == 1)); then
  shopt -s nullglob
  for app_dir in apps/*/; do
    [[ -f "${app_dir}sha.sh" ]] || continue
    HOMES+=("run/$(basename "$app_dir")/lab")
  done
  shopt -u nullglob
fi

if ((${#HOMES[@]} > 0)); then
  # 去重：扫描与 --defaults 可能指向同一个数据根。
  # 用换行拼接的字符串判重而不是 `declare -A` —— macOS 自带的是 **bash 3.2**，没有关联数组
  # （实测：`declare -A` 被当成普通数组，`_seen[$h]` 走算术求值报 `home…: unbound variable`）。
  _uniq=()
  _uniq_lines=""
  for h in "${HOMES[@]}"; do
    case $'\n'"${_uniq_lines}" in
      *$'\n'"$h"$'\n'*) continue ;;
    esac
    _uniq_lines="${_uniq_lines}${h}"$'\n'
    _uniq+=("$h")
  done
  HOMES=("${_uniq[@]}")
fi

if ((${#HOMES[@]} == 0)); then
  echo "没有要填充的数据根（run/<app>/<label> 下先起一次实例，或直接给目录）"
  exit 0
fi

copied=0
missing=()
for home in "${HOMES[@]}"; do
  if [[ ! -d "$home" ]]; then
    mkdir -p "$home"
    [[ -z "${DIY_SYNC_QUIET:-}" ]] && echo "+ ${home}（新建数据根）"
  fi
  for f in "${FILES[@]}"; do
    if [[ ! -f "${SRC}/${f}" ]]; then
      missing+=("$f")
      continue
    fi
    dst="$home/$f"
    if ((FORCE == 0)) && [[ -f "$dst" ]] && [[ ! "${SRC}/${f}" -nt "$dst" ]]; then
      continue
    fi
    cp -p "${SRC}/${f}" "$dst"
    echo "+ $dst"
    copied=$((copied + 1))
  done
done

if ((${#missing[@]} > 0)); then
  # shellcheck disable=SC2207
  printf '%s\n' "warn: 源缺 $(printf '%s\n' "${missing[@]}" | sort -u | tr '\n' ' ')（${SRC}）→ 已跳过" >&2
fi
if ((copied == 0)); then
  echo "已是最新（${#HOMES[@]} 个数据根；--force 可覆盖）"
else
  echo "⚠️  真配置（含 API key）已填充到 run/ —— gitignore 内，勿提交、勿外传；已跑的实例要重启才生效"
fi
