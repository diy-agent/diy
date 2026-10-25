#!/usr/bin/env bash
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. `:` 在 bash 函数名非法，原 scripts 的 `:` 用 `-` 代替：`build:renderer` → `./sha.sh build-renderer`
# 3. 用 `run` 执行外部命令（带彩色日志）：`run npx vitest run`
# 4. 可用颜色变量：$primary $secondary $error $info $reset
# 5. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 执行链 ──────────────────────────────────────
# sha.sh → source ../../sha.common.sh → source vendor/sha/sha.bash
#        → sha "$@" 解析命令 → 调用对应函数
#
# ── 说明 ────────────────────────────────────────
# 全部命令原是 package.json scripts（2026-09 迁入，package.json 不再管理脚本）。
# 全部用 npx 直调本地 .bin（原来 npm run 隐式提供的 PATH，外面自己加 npx）。
# 命令间依赖直接调函数（如 build 调 build-renderer），不再经 npm run 中转。
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

# Get the real path of the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

####################################################################################
# mono必备子命令（根 ./sha.sh check/fix/test/test-unit 组装这些）
####################################################################################

# 产物变体根：prod|test|lab|preview。vite 配置读 DIY_VARIANT 决定输出目录；
# build/<variant>/{main,preload,cli,renderer,serve} 各自独立（见根 AGENTS.md「实例/变体」）。
#
# preview（2026-10-23 恢复，##404）：**编译后运行、无 watch** 的稳定实例。lab 的 HMR 每次改
# src 都重启主进程，把正在进行的 agent 轮次打断（实测 129 轮里 128 轮这么死的）。所以
# 「要持续对话的实例」用 preview（产物冻住，改码不波及它），「边改边看」仍用 lab。
# 二者按变体分根（build/<variant>/** 与 build/<variant>/home），互不抢单实例锁。
export DIY_VARIANT="${DIY_VARIANT:-prod}"
_build_dir() { echo "build/${DIY_VARIANT:-prod}"; }

# electron 二进制就绪（全机共享 store + 本 worktree 软链；缺则下载一次，带超时）。
# 为什么**起 Electron 前必须过这一道**：electron 无 postinstall，dist/path.txt 缺时
# `require('electron')` 会落进**无超时下载**（实测静默卡死 3m40s，日志看着像"在跑"）。
# 实现 `scripts/ensure-electron.mjs`（根目录，头注有判据与 store 布局）。
_ensure_electron() { run node ../../scripts/ensure-electron.mjs --quiet; }

clean() {
  run rm -rf ./build ./dist
}

# 本包检查：类型 + lint（全仓 check 另含 rpc 浏览器安全，见根 sha.sh）
check() {
  typecheck
  lint
}
# 本包自动修复：格式化 + lint 可修项
fix() {
  fmt-fix
  lint-fix
}
sync() { :; }

# 本包构建：main + preload + renderer（根 build 调这个；cli 产物另见 build-cli）
build() {
  local d; d="$(_build_dir)"
  # 依赖没同步（包改名 / 加依赖后 node_modules 落后）时构建会报**远离根因**的 resolve 错
  # （如 `Rolldown failed to resolve import "@diy-agent/rpc/electron"`）—— 先做一个只读快检。
  # 同步是**根级**动作（要重装根 node_modules），故这里只拦不修：根目录 ./sha.sh sync，
  # 或根 ./sha.sh build（它的 ensure-sync 会自动补）。判据实现见 scripts/check-sync.mjs。
  if [[ -f ../../scripts/check-sync.mjs ]] && ! node ../../scripts/check-sync.mjs --quiet; then
    echo "${error} ✗ 以上是依赖未同步（不是本包代码问题）→ 根目录跑：./sha.sh sync${reset}"
    return 1
  fi
  run npx vite build --config vite.main.config.ts
  # 内置数据三件（models.dev.json + models.dev.diy.json + calendars.json，均 fs 惰性读）
  # 随 main 产物走：build/<V>/main/data/（通配拷贝 —— 加文件不用改这里，但改名要同步）
  run mkdir -p "$d/main/data" && cp src/main/data/*.json "$d/main/data/"
  run npx vite build --config vite.preload.config.ts
  run npx vite build --config vite.cli.config.ts
  # CLI 产物也带内置数据：否则打包安装（无源树）时 build/<V>/cli 找不到数据，模型目录退化为空（##275 R1-5）
  run mkdir -p "$d/cli/data" && cp src/main/data/*.json "$d/cli/data/"
  build-renderer
}

# 本包全部测试：快速单测 → 构建 → 意图测试（起隔离 Electron，慢）
test() {
  test-unit
  # 按前缀全收 tests/cli.intent.*：不点名文件，新增用例自动纳入
  test-intent
}
# 编程中快速验证：不构建，跳过意图测试
# 并行策略**与 intent 分开**（##266 测试提速）：
#   · intent → 必须串行（真实 Electron 抢 CPU/端口，见 vitest.config.ts 注释），入口见 `test-intent`；
#   · unit   → 可并行：不拉 Electron、各文件独立隔离 HOME。实测 40 个 core 文件 27.0s → 8.1s（3.3x），
#              全量 98s → 约 30s。
# 为什么在命令行给而**不改** vitest.config.ts 的 `fileParallelism: false`：裸跑 `npx vitest run`
# 会同时命中 intent 文件，那份默认必须留给它。
# `--no-isolate`（##402）：每个 worker 共享一份模块图，省掉**每文件**的
# transform + setup + import 固定成本（实测占单文件工作量 ~71%：834ms 里 tests 只 344ms）。
# 前提是**没有 vi.mock**（它改全局模块表，isolate:false 下会静默失效）——
# `rg -l 'vi\.mock\(' tests --glob '*.test.ts'` 必须是 0 命中（tests/ 下有护栏注释说明替代注入法）。
test-unit() { run npx vitest run --exclude '**/cli.intent*' --fileParallelism --no-isolate; }

####################################################################################
# 子项目自己的命令（原 package.json scripts）
####################################################################################

# 开发实例：renderer dev server + watch main/preload + electron（HMR，免构建）——
# 人看效果、agent 快速验证/debug 都用它。产物/数据根 build/lab/{main,preload,home}，
# 与 test 互不干扰，可同时运行（单实例锁 per-home）。透传参数，如 --port 18888
lab() { _ensure_electron; run env DIY_VARIANT=lab npx tsx scripts/electron-dev.mts "$@"; }
# 编译后运行的**稳定实例**（无 watch）：跑 build/preview/** 的产物，改 src 不会重启它。
# 用途：人要持续对话 / 长会话（lab 的 watch 重启会打断正在进行的轮次）。
# 数据根 build/preview/home（按变体分根，不与 lab 抢单实例锁）。
#   ./sha.sh preview                # 产物缺失才编译，然后起/连实例
#   ./sha.sh preview --build        # 强制重新编译后再起
#   ./sha.sh preview --from lab     # **首次**把 lab 的数据根克隆过来（续用那里的任务/会话）
preview() {
  _ensure_electron
  local do_build=0 from=""
  while (($#)); do
    case "$1" in
      --build) do_build=1; shift ;;
      --from) from="${2:?--from 需要变体名（lab|test|prod）}"; shift 2 ;;
      *) echo "✗ 未知参数：$1（可用：--build / --from <variant>）" >&2; return 1 ;;
    esac
  done
  export DIY_VARIANT=preview
  # 产物在 <包>/build/<variant>/（vite outDir），数据根在**仓库根** build/<variant>/home
  # （core/dev-home 的缺省，见其头注）——两处基准不同，别照着产物那个路径写。
  local repo_root; repo_root="$(cd "$SCRIPT_DIR/../.." && pwd)"
  local home="$repo_root/build/preview/home"
  if [[ -n "$from" ]]; then
    local src="$repo_root/build/$from/home"
    [[ -d "$src" ]] || { echo "✗ 源数据根不存在：$src" >&2; return 1; }
    if [[ -d "$home" ]] && [[ -n "$(ls -A "$home" 2>/dev/null)" ]]; then
      echo "✗ 目标数据根非空，拒绝覆盖：$home（要重建先 rm -rf 它）" >&2
      return 1
    fi
    mkdir -p "$home"
    # 不搬 electron_user_data（单实例锁 / GPU 缓存）、app.port（那是**上一个实例**的端口）、
    # cache（可重建；模型目录也在里面）—— 只带走真正是「数据」的部分。
    run rsync -a --exclude 'electron_user_data/' --exclude 'app.port' --exclude 'cache/' "$src/" "$home/"
  fi
  if ((do_build)) || [[ ! -f build/preview/main/index.mjs ]]; then
    build
  fi
  echo "── preview（编译产物，无 watch）"
  echo "   数据根：$home"
  # 起/连都交给 CLI 的 ensureAppPort（探活 → 验身份 → 复用或拉起，##328）：
  # 不要在这里自己 spawn —— 否则锁冲突诊断 / CDP 提示 / 身份校验会两处分叉。
  run env DIY_VARIANT=preview DIY_ENV=development DIY_HOME="$home" node ./build/preview/cli/index.js getAppInfo
  echo "   与它对话：DIY_VARIANT=preview DIY_HOME=$home ../../diy.sh agent local chat <taskUri>"
}
# 开发期跑 CLI 源码：./sha.sh cli task list
cli() { run npx tsx src/cli/index.ts "$@"; }
# 纯 Web 服务（先构建 renderer，透传参数，如 --port <port>）
serve() {
  build-renderer
  run npx tsx src/serve/index.ts "$@"
}
serve-build() {
  build-renderer
  run npx vite build --config vite.serve.config.ts
}
build-cli() { run npx vite build --config vite.cli.config.ts; }
build-renderer() { run npx vite build --config vite.renderer.config.ts; }
# 运行生产构建（先构建，变体 prod）
start() {
  build
  _ensure_electron
  run npx electron "$(_build_dir)/main/index.mjs" "$@"
}
link() { run npm link; }

test-watch() { run npx vitest "$@"; }
# 意图测试：先构建（起隔离 Electron，最慢放最后）
# CLI 默认走 server /cli http 端点（单条 ~41ms vs 编译产物 ~300ms vs tsx ~600ms，intent 全量 ~140s vs ~300s）。
# 无 app.port / curl 不支持 h2 时自动回退直连 CLI，不会失败。排查需要可覆盖：DIY_CLI_MODE=compiled|tsx ./sha.sh test-intent
test-intent() {
  # 测试实例独占 build/test/**：与 lab 的 watch 产物不撞（##184 实例分根）
  export DIY_VARIANT=test
  _ensure_electron
  build
  export DIY_CLI_MODE="${DIY_CLI_MODE:-http}"
  # 位置参数 = 只跑匹配的文件（片段 / 相对路径 / 文件名），无参数 = 全量。
  #   例：./sha.sh test-intent ui-find          → tests/cli.intent.ui-find
  #       ./sha.sh test-intent ui-find task     → 两个文件
  #       ./sha.sh test-intent tests/cli.intent.ui-find.test.ts → 原样
  # 为什么不能写成 `... tests/cli.intent "$@"`：vitest 多个 filter 取**并集**，
  #   写死的全量 filter 会让任何单文件参数都退化成全量（##255 §2 的成因）。
  local filters=() arg
  for arg in "$@"; do
    if [[ "$arg" == */* || "$arg" == *.test.ts || "$arg" == cli.intent.* ]]; then
      filters+=("$arg")
    else
      filters+=("tests/cli.intent.$arg")
    fi
  done
  if [[ ${#filters[@]} -eq 0 ]]; then
    filters=("tests/cli.intent")
  fi
  run npx vitest run --no-file-parallelism "${filters[@]}"
}

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/ tests/; }
lint-fix() { run npx oxlint --fix src/ tests/; }
fmt() { run npx oxfmt --check src/ tests/; }
fmt-fix() { run npx oxfmt --write src/ tests/; }

# 打包：先构建（透传 electron-builder 参数）
dist() {
  build
  run npx electron-builder "$@"
}
dist-mac() {
  build
  run npx electron-builder --mac "$@"
}
dist-linux() {
  build
  run npx electron-builder --linux "$@"
}
dist-win() {
  build
  run npx electron-builder --win "$@"
}

# 内置数据同步：models.dev 快照（上游产物，**整份覆盖**；diy 扩展层 models.dev.diy.json 不生成、手维护）
# 用法：./sha.sh models-sync [源]   源缺省 https://models.dev/api.json（也收本地文件路径，如先 curl 落盘再传）
# 产物：src/main/data/models.dev.json（唯一改动文件）→ 有 diff 就 commit。
# 生效：snapshot 进程内缓存一次 ⇒ 需**重启实例**；prod 走源树兜底（build/<V>/main 无 data/ 时），免 build。
# 自动化（定时 workflow 开 PR）见 ##107(models 数据同步)。
models-sync() { run npx tsx scripts/gen-models-dev.mts "$@"; }

icon() { run python3 scripts/gen-icon.py; }


sha "$@"
