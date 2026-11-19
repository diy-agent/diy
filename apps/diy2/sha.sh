#!/usr/bin/env bash
#
# diy2 的单一入口（##dev-app 构建对齐）。
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. `:` 在 bash 函数名非法，用 `-` 代替（`build-web`）
# 3. 用 `run` 执行外部命令（带彩色日志）：`run npx vite build`
# 4. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 为什么脚本全搬到这里（package.json 不再管脚本）──
# 老形态是 package.json scripts + scripts/dev.sh + sha.sh 三套并存：端口写死在 npm script 里
# （`vite --port 5190`），起停写在 shell 脚本里（按端口 kill），而仓库统一入口 `./sha.sh`
# 连 `dev` / `lab` 都没有 —— 于是 `./sha.sh lab --app diy2` 起不来，人只能记三套命令。
# 现在：**一切入口 = ./sha.sh**（与 apps/diy-app 同构），端口 / 数据根 / 变体的裁决在
# `server/config.ts`（唯一真源），本脚本只决定「用哪个变体、什么环境、前台还是后台」。
#
# ── 四个运行面（变体只决定运行空间，不是构建目标）──
#   ./sha.sh lab       开发：单端口（vite 挂进服务端，HMR），数据根 build/lab/home
#   ./sha.sh staging   验收：prod 产物 + 沙箱数据根 build/staging/home（改码不波及）
#   ./sha.sh start     真生产：全局命令语义（~/.diy/diy2、端口 5192）
#   ./sha.sh build     出产物：build/<variant>/{web,server}
#
# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 变体**不是**全局缺省：产物类命令（build / start）缺省 prod，开发类命令（dev / stop / port…）
# 缺省 lab。写成全局 `export DIY2_VARIANT=${DIY2_VARIANT:-prod}` 会让 `./sha.sh stop` 去找
# 生产的 home（实测：lab 起的实例停不掉，还提示「没有要停的实例」）。
_artifact_variant() { echo "${DIY2_VARIANT:-prod}"; }
_dev_variant() { echo "${DIY2_VARIANT:-lab}"; }

# 依赖没同步（包改名 / 加依赖后 node_modules 落后）时构建会报**远离根因**的 resolve 错。
# 同步是根级动作（要重装根 node_modules），这里只拦不修。
_guard_sync() {
  if [[ -f "$REPO_ROOT/scripts/check-sync.mjs" ]] && ! node "$REPO_ROOT/scripts/check-sync.mjs" --quiet; then
    echo "${error} ✗ 以上是依赖未同步（不是本包代码问题）→ 根目录跑：./sha.sh sync${reset}"
    return 1
  fi
}

####################################################################################
# mono 必备子命令（根 ./sha.sh check/fix/test 组装这些）
####################################################################################

clean() { run rm -rf ./build; }

sync() { :; }

# 本包检查：类型 + lint
check() {
  typecheck
  lint
}

# 本包自动修复：格式化 + lint 可修项
fix() {
  fmt-fix
  lint-fix
}

test() { run npx vitest run "$@"; }
test-unit() { test "$@"; }
test-watch() { run npx vitest "$@"; }

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint server/ src/ tests/ bin/; }
lint-fix() { run npx oxlint --fix server/ src/ tests/ bin/; }
fmt() { run npx oxfmt --check server/ src/ tests/ bin/; }
fmt-fix() { run npx oxfmt --write server/ src/ tests/ bin/; }

####################################################################################
# 构建
####################################################################################

# UI + 服务端两件产物 → build/<variant>/{web,server}
build() {
  _guard_sync
  build-web
  build-server
  build-cli
}
build-web() {
  _guard_sync
  run env DIY2_VARIANT="$(_artifact_variant)" npx vite build
}
build-server() {
  _guard_sync
  run env DIY2_VARIANT="$(_artifact_variant)" npx vite build --config vite.server.config.ts
}
# CLI 产物（build/<variant>/cli/index.mjs）：bin/diy2 的 list/stop/port/home 由它接管
build-cli() {
  _guard_sync
  run env DIY2_VARIANT="$(_artifact_variant)" npx vite build --config vite.cli.config.ts
}

####################################################################################
# 开发（单端口）
####################################################################################

# 单端口开发：一个进程同时供 UI（vite transform + HMR）与 /api。
#
# 与老形态的区别（##dev-app 构建对齐）：
#   · 端口只有一个，且**不在这里写**（DIY2_PORT / 缺省 0 = 内核分配，落 <home>/app.port）；
#     端口有**粘性**：监听成功就把端口写进 <home>/app.port（**退出不删**），之后每次重启
#     （含 exit 75 自动重启）都还回同一个端口，被占用时回落到内核分配并重写 ——
#     书签 / 开着的标签页不会失效。注意那文件只是「上次用的端口」，**不表示有人在跑**。
#   · 同源：没有 /api 代理，SSE 不穿代理；
#   · 起停不再按端口 kill（会误杀长连接的浏览器）：实例自报注册表，停用 ./sha.sh stop。
#
# 重启循环：`server/dev.ts` 在服务端代码（server/** 与 entity-runtime 源码）变化时
# 以退出码 75 收尾 = 「请重起我」；UI 改动走 HMR，不重启。
dev() {
  _guard_sync
  local variant; variant="$(_dev_variant)"
  _dev_env "$variant"
  echo "── diy2 dev（单端口，变体 ${DIY2_VARIANT}）"
  echo "   数据根：${DIY2_HOME}"
  if [[ -n "${DIY2_PORT:-}" ]]; then
    echo "   端口：DIY2_PORT=${DIY2_PORT}（非生产不吃 5192；实际端口看下面打印的 URL）"
  else
    echo "   端口：沿用上次的端口（<home>/app.port）；被占用则自动换一个并重写记录"
  fi
  echo "   停：Ctrl-C / ./sha.sh stop（不按端口 kill —— 会误杀长连接的浏览器）"

  local child="" code
  # 信号必须转发给子进程：直接 kill 本脚本时 bash 会先退，把 tsx 留成孤儿
  # （实测：kill 掉 supervisor 后 dev 服务还在监听，注册表里还挂着）
  trap '[[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null' INT TERM
  while true; do
    code=0
    run npx tsx server/dev.ts "$@" &
    child=$!
    wait "$child" || code=$?
    child=""
    if [[ "$code" -eq 75 ]]; then
      echo "── 服务端代码变了 → 重启"
      continue
    fi
    return "$code"
  done
}

# lab = dev（`./sha.sh lab --app diy2` 从根入口进来时走这里）
lab() { DIY2_VARIANT=lab dev "$@"; }

_dev_env() {
  local variant="$1"
  export DIY2_VARIANT="$variant"
  # dev 入口声明 development：DIY2_ENV 是 dev 专属能力的唯一判据，缺省按 production。
  # 外层 shell / agent 常泄漏 production —— server/dev.ts 会因此拒起（那是对的：否则写脏真库）。
  export DIY2_ENV="${DIY2_ENV:-development}"
  export DIY2_HOME="${DIY2_HOME:-$SCRIPT_DIR/build/$variant/home}"
  export DIY2_LAUNCH="${DIY2_LAUNCH:-$variant}"
  mkdir -p "$DIY2_HOME"
}

####################################################################################
# 起产物（staging / 生产）
####################################################################################

# 验收沙箱：跑**本变体产物**，数据根在 worktree 内（build/staging/home），环境 development。
# 与 start 的区别只有数据根与环境 —— staging 与真生产可以同时跑（端口/数据根都分开）。
#   ./sha.sh staging                # 产物缺失才编译
#   ./sha.sh staging --build        # 强制重编
staging() {
  local do_build=0
  while (($#)); do
    case "$1" in
      --build) do_build=1; shift ;;
      *) echo "${error}✗ 未知参数：$1（可用：--build）${reset}" >&2; return 1 ;;
    esac
  done
  export DIY2_VARIANT=staging
  if ((do_build)) || [[ ! -f "build/staging/server/index.mjs" ]] || [[ ! -d build/staging/web ]]; then
    build
  fi
  _run_built staging
}

# 真生产：全局命令语义（`bin/diy2`）—— 数据根 ~/.diy/diy2、端口 5192、生产环境。
# 要构建产物先 ./sha.sh build。
start() {
  local variant; variant="$(_artifact_variant)"
  if [[ ! -f "build/$variant/server/index.mjs" ]] || [[ ! -d "build/$variant/web" ]]; then
    echo "${error}✗ 还没构建（缺 build/$variant/{server,web}）→ ./sha.sh build${reset}" >&2
    return 1
  fi
  run env DIY2_VARIANT="$variant" node ./bin/diy2 "$@"
}

_run_built() {
  local variant="$1"; shift
  export DIY2_VARIANT="$variant"
  export DIY2_ENV="${DIY2_ENV:-development}"
  export DIY2_HOME="${DIY2_HOME:-$SCRIPT_DIR/build/$variant/home}"
  export DIY2_WEB_DIR="$SCRIPT_DIR/build/$variant/web"
  export DIY2_LAUNCH="$variant"
  mkdir -p "$DIY2_HOME"
  run node "build/$variant/server/index.mjs" "$@"
}

####################################################################################
# 实例控制面（读注册表，不按端口猜）
####################################################################################

# 本机 diy2 实例：pid / 端口 / 数据根 / 变体 / 入口
list() { run node ./bin/diy2 list; }
# 停**本 worktree** 起的全部 diy2 实例（lab / staging 一起停）；`--all` = 本机全部
#
# 为什么按 worktree 而不是按端口/数据根：同一个人在这个 worktree 里可能同时开着 lab 与
# staging，按「我要的都停下」的意图收口；按端口 kill 会误杀连着的浏览器与 SSE。
stop() { run node ./bin/diy2 stop --worktree "$REPO_ROOT" "$@"; }
# 本 worktree × 本变体的数据根 / 端口（脚本用；与 server/config.ts 的缺省一致）
home() { echo "${DIY2_HOME:-$SCRIPT_DIR/build/$(_dev_variant)/home}"; }
port() {
  # 判据必须是**探活**（/api/info 自报的 home + 注册表 pid），不是 app.port：
  # 那个文件只是「上次用的端口」，进程死后它还留着，崩死（SIGKILL / 断电）时也不更新。
  #
  # 必须显式给 `--home`：`bin/diy2` 是发布形态入口，自己会把环境纠正成 production、
  # 数据根缺省成 `~/.diy/diy2` —— 不传就是去探生产根上的实例（dev 永远探不到）。
  run node ./bin/diy2 port --home "$(home)"
}
# 一眼看清：本变体的运行空间 + 本机实例表
status() {
  echo "变体：$(_dev_variant)"
  echo "数据根：$(home)"
  # 「下次连哪」与「现在连哪」分开说：前者是 app.port 记录（不证明存活），后者靠探活
  local next=""
  if [[ -f "$(home)/app.port" ]]; then next="$(cat "$(home)/app.port")"; fi
  echo "上次用的端口：${next:-（无记录）}"
  echo "现在在跑：$(port 2>/dev/null || echo '否（没有本数据根的实例应答）')"
  node ./bin/diy2 list
}

sha "$@"
