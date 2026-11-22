#!/usr/bin/env bash
#
# diy2 的单一入口（##dev-app 构建对齐）。
#
# ── 编写规则 ────────────────────────────────────
# 1. 定义函数即为子命令：`foo() { ... }` → `./sha.sh foo`
# 2. `:` 在 bash 函数名非法，用 `-` 代替（`build-web`）
# 3. 用 `run` 执行外部命令（带彩色日志）：`run npx vite build`
# 4. **参数用 `sha.def` 声明、`sha.parse` 解析**（不手写 while/case）：
#    usage / help / 类型 / 枚举 / 默认值 / 必填全由声明生成（vendor/sha/sha_opt.bash）
# 5. 文件末尾保留 `sha "$@"` 调度入口
#
# ── 为什么脚本全搬到这里（package.json 不再管脚本）──
# 老形态是 package.json scripts + scripts/dev.sh + sha.sh 三套并存：端口写死在 npm script 里
# （`vite --port 5190`），起停写在 shell 脚本里（按端口 kill），而仓库统一入口 `./sha.sh`
# 连 `dev` / `lab` 都没有 —— 于是 `./sha.sh lab --app diy2` 起不来，人只能记三套命令。
# 现在：**一切入口 = ./sha.sh**（与 apps/diy-app 同构）。
#
# ── 三个运行面（同一个包 = 一份产物 build/prod/）──
#   ./sha.sh dev       开发：单端口（vite 挂进服务端，HMR），数据根 build/lab/home
#   ./sha.sh staging   验收：build/prod 产物 + 数据根 build/staging/home（改码不波及）
#   ./sha.sh start     真生产：= `diy2 web`（~/.diy/diy2、端口 5192）
#   ./sha.sh build     出产物：build/prod/{web,server,cli}
#
# ── 参数面 ──
# 本脚本**只拼 argv，不 export 任何 DIY2_***：数据根 / 端口 / 环境的裁决在 server/config.ts，
# 输入是显式命令行参数（为什么不用环境变量见那里的文件头：继承 + 看不见 = 串台）。
#
# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 产物根：一个包目录一份产物（多份并存靠 worktree，不靠变体目录）
BUILD_ROOT="$SCRIPT_DIR/build/prod"

# 某个 launch 的数据根（与 server/config.ts 的缺省一致：<appRoot>/build/<launch>/home）
_launch_home() { echo "$SCRIPT_DIR/build/${1:-lab}/home"; }

# 产物齐不齐（静默；返回 1 = 缺）：start / stop / port / list / status 都走 bin/diy2 →
# CLI 产物，staging 走服务端产物 —— 两者都算「已构建」，缺任一个都得先 build。
_has_build() {
  local f
  for f in server/index.mjs cli/index.mjs; do
    [[ -f "$BUILD_ROOT/$f" ]] || return 1
  done
}

# 产物缺失的统一提示（返回 1 + 指出缺哪个）
_need_build() {
  local f missing=()
  for f in server/index.mjs cli/index.mjs; do
    [[ -f "$BUILD_ROOT/$f" ]] || missing+=("$f")
  done
  ((${#missing[@]} == 0)) && return 0
  echo "${error}✗ 还没构建（缺 ${BUILD_ROOT#$SCRIPT_DIR/}/${missing[*]}）→ ./sha.sh build${reset}" >&2
  return 1
}

####################################################################################
# 参数声明（sha.def）：函数体里只 local + 一行 sha.parse
####################################################################################

# dev / lab 共用的选项（两个名字都保留：`lab` 是根入口 `./sha.sh lab --app diy2` 的老姿势）
_DEV_OPTS=(
  --opt "--home:string:数据根（缺省 <appRoot>/build/<launch>/home）"
  --opt "-p,--port:int:端口；0 = 内核分配（缺省沿用 <home>/app.port）"
  --opt "--launch:string=lab[lab|dev|staging]:入口名（注册表自报，缺省 lab）"
  --opt "--name:string:实例名"
  --opt "--reset:bool:先清空数据根再起（会问一次）"
  --arg "REST...:透传给 server/dev.ts 的其余参数（写在 -- 之后）"
)
sha.def "dev" "${_DEV_OPTS[@]}" --desc "开发：单端口（vite 挂进服务端，HMR），数据根 build/lab/home"
sha.def "lab" "${_DEV_OPTS[@]}" --desc "同 dev（保留旧名）"

sha.def "staging" \
  --opt "--home:string:数据根（缺省 build/staging/home）" \
  --opt "-p,--port:int:端口；0 = 内核分配" \
  --opt "--build:bool:先构建产物（缺产物时自动构建）" \
  --arg "REST...:透传给服务端产物的其余参数（写在 -- 之后）" \
  --desc "验收：build/prod 产物 + 沙箱数据根 build/staging/home（改码不波及）"

sha.def "start" \
  --opt "--home:string:数据根（缺省 ~/.diy/diy2）" \
  --opt "-p,--port:int:端口（缺省 5192）" \
  --opt "--name:string:实例名" \
  --opt "--detach:bool:起在后台" \
  --opt "--open:bool:就绪后打开浏览器" \
  --desc "真生产：= diy2 web（~/.diy/diy2、端口 5192）"

sha.def "stop" \
  --opt "--home:string:只停这个数据根的实例" \
  --opt "--all:bool:停本机全部 diy2 实例" \
  --desc "停实例（缺省 = 本 worktree 起的全部；不按端口 kill，见 dev 的注释）"

_QUERY_OPTS=(
  --opt "--home:string:数据根（缺省 build/lab/home）"
  --opt "--launch:string=lab[lab|dev|staging]:入口名（与 dev 缺省一致）"
  --opt "--json:bool:JSON 输出"
)
sha.def "port" "${_QUERY_OPTS[@]}" --desc "本数据根实例的实际端口（给脚本用；没有实例 → 退出码 1）"
sha.def "home" \
  --opt "--home:string:显式给数据根（缺省 build/<launch>/home）" \
  --opt "--launch:string=lab[lab|dev|staging]:入口名（与 dev 缺省一致）" \
  --desc "本数据根路径（与 server/config.ts 的缺省同一规则）"
sha.def "status" \
  --opt "--home:string:数据根（缺省 build/lab/home）" \
  --opt "--launch:string=lab[lab|dev|staging]:入口名（与 dev 缺省一致）" \
  --desc "一眼看清：数据根 + 上次用的端口 + 在跑的实例"

sha.def "list" --opt "--json:bool:JSON 输出" --desc "本机所有 diy2 实例（读注册表）"

sha.def "build" --desc "出产物：build/prod/{web,server,cli}"
sha.def "build-web" --desc "只构建 UI → build/prod/web"
sha.def "build-server" --desc "只构建服务端 → build/prod/server"
sha.def "build-cli" --desc "只构建 CLI → build/prod/cli"
sha.def "clean" --desc "删掉 build/"

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

# 检查类命令**不** sha.parse：参数原样透传给工具（`./sha.sh test -t xxx`）
test() { run npx vitest run "$@"; }
test-unit() { test "$@"; }
test-watch() { run npx vitest "$@"; }

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint server/ src/ tests/ bin/; }
lint-fix() { run npx oxlint --fix server/ src/ tests/ bin/; }
fmt() { run npx oxfmt --check server/ src/ tests/ bin/; }
fmt-fix() { run npx oxfmt --write server/ src/ tests/ bin/; }

####################################################################################
# 构建（产物目录固定 build/prod，见 vite.config.ts）
####################################################################################

# 构建 / dev 入口先 ensure_sync（sha.common.sh 的共享闸门）：依赖没同步（包改名 / 加依赖后
# node_modules 落后）时，build 会报**远离根因**的 resolve 错。闸门与根 ./sha.sh 同一份实现
# （默认自动 sync，DIY_AUTO_SYNC=0 改为报错停）—— 直接进本目录跑也能自修，不靠人记得先回根目录。
build() {
  ensure_sync
  build-web
  build-server
  build-cli
}
build-web() {
  ensure_sync
  run npx vite build
}
build-server() {
  ensure_sync
  run npx vite build --config vite.server.config.ts
}
# CLI 产物（build/prod/cli/index.mjs）：bin/diy2 直接 import 它，命令树在 src/cli
build-cli() {
  ensure_sync
  run npx vite build --config vite.cli.config.ts
}

####################################################################################
# 开发（单端口）
####################################################################################

# 单端口开发：一个进程同时供 UI（vite transform + HMR）与 /api。
#
# 与老形态的区别（##dev-app 构建对齐）：
#   · 端口只有一个，且**不在这里写**（缺省 0 = 内核分配，落 <home>/app.port）；
#     端口有**粘性**：监听成功就把端口写进 <home>/app.port（**退出不删**），之后每次重启
#     （含 exit 75 自动重启）都还回同一个端口，被占用时回落到内核分配并重写 ——
#     书签 / 开着的标签页不会失效。注意那文件只是「上次用的端口」，**不表示有人在跑**。
#   · 同源：没有 /api 代理，SSE 不穿代理；
#   · 起停不再按端口 kill（会误杀长连接的浏览器）：实例自报注册表，停用 ./sha.sh stop。
#
# 重启循环：`server/dev.ts` 在服务端代码（server/** 与 entity-runtime 源码）变化时
# 以退出码 75 收尾 = 「请重起我」；UI 改动走 HMR，不重启。
dev() {
  local home port launch name reset
  local -a REST=()
  sha.parse "$@" || return $?

  ensure_sync
  local -a args=(server/dev.ts --launch "${launch:-lab}")
  [[ -n $home ]] && args+=(--home "$home")
  [[ -n $port ]] && args+=(--port "$port")
  [[ -n $name ]] && args+=(--name "$name")
  args+=("${REST[@]}")

  local data_home="${home:-$(_launch_home "${launch:-lab}")}"
  if (( reset )); then
    printf '%s清空 %s？[y/N]%s ' "$warn" "$data_home" "$reset_color"
    local answer=""
    read -r answer
    [[ $answer == [yY] ]] && run rm -rf "$data_home"
  fi

  echo "── diy2 dev（单端口，launch ${launch:-lab}）"
  echo "   数据根：${data_home}"
  if [[ -n $port ]]; then
    echo "   端口：${port}"
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
    run npx tsx "${args[@]}" &
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
lab() { dev "$@"; }

####################################################################################
# 起产物（staging / 生产）
####################################################################################

# 验收沙箱：跑**本包产物**，数据根在 worktree 内（build/staging/home），环境 development。
# 与 start 的区别只有数据根与环境 —— staging 与真生产可以同时跑（端口/数据根都分开）。
#   ./sha.sh staging                # 产物缺失才编译
#   ./sha.sh staging --build        # 强制重编
staging() {
  local home port build
  local -a REST=()
  sha.parse "$@" || return $?

  if (( build )) || ! _has_build; then
    if ((${#REST[@]})); then
      echo "${error}✗ 这次需要构建（--build 或首次），不能带透传参数：${REST[*]}${reset}" >&2
      return 1
    fi
    build || return $?
  fi

  local -a args=("$BUILD_ROOT/server/index.mjs" --mode development --launch staging)
  [[ -n $home ]] && args+=(--home "$home")
  [[ -n $port ]] && args+=(--port "$port")
  args+=("${REST[@]}")
  run node "${args[@]}"
}

# 真生产：全局命令语义（`bin/diy2`）—— 数据根 ~/.diy/diy2、端口 5192、生产环境。
# 要构建产物先 ./sha.sh build。
start() {
  local home port name detach open
  local -a REST=()
  sha.parse "$@" || return $?

  _need_build || return $?

  local -a args=(web)
  [[ -n $home ]] && args+=(--home "$home")
  [[ -n $port ]] && args+=(--port "$port")
  [[ -n $name ]] && args+=(--name "$name")
  (( detach )) && args+=(--detach)
  (( open )) && args+=(--open)
  run node ./bin/diy2 "${args[@]}" "${REST[@]}"
}

####################################################################################
# 实例控制面（读注册表，不按端口猜）
####################################################################################

# 本机 diy2 实例：pid / 端口 / 数据根 / 入口
list() {
  local json
  sha.parse "$@" || return $?
  local -a args=(list)
  (( json )) && args+=(--json)
  run node ./bin/diy2 "${args[@]}"
}

# 停**本 worktree** 起的全部 diy2 实例（lab / staging 一起停）；`--all` = 本机全部。
#
# 为什么按 worktree 而不是按端口/数据根：同一个人在这个 worktree 里可能同时开着 lab 与
# staging，按「我要的都停下」的意图收口；按端口 kill 会误杀连着的浏览器与 SSE。
stop() {
  local home all
  sha.parse "$@" || return $?
  local -a args=(stop)
  if (( all )); then
    args+=(--all)
  elif [[ -n $home ]]; then
    args+=(--home "$home")
  else
    args+=(--worktree "$REPO_ROOT")
  fi
  run node ./bin/diy2 "${args[@]}"
}

# 本 worktree × 本 launch 的数据根。
#
# 这里**自己算**而不问 `diy2 home`：CLI 是发布形态入口（环境固定 production），它的缺省
# 数据根是 ~/.diy/diy2；dev 的缺省是 <appRoot>/build/<launch>/home —— 两条缺省规则本来
# 就在 server/config.ts（resolveHome），这里只是同一规则的一行投影（--launch 决定目录名）。
home() {
  local home launch
  sha.parse "$@" || return $?
  echo "${home:-$(_launch_home "${launch:-lab}")}"
}

port() {
  # 判据必须是**探活**（/api/info 自报的 home + 注册表 pid），不是 app.port：
  # 那个文件只是「上次用的端口」，进程死后它还留着，崩死（SIGKILL / 断电）时也不更新。
  #
  # 必须显式给数据根：`diy2 port` 缺省是生产根（~/.diy/diy2）—— 不给就是去探生产实例。
  local home launch json
  sha.parse "$@" || return $?
  local -a args=(port)
  (( json )) && args+=(--json)
  run node ./bin/diy2 "${args[@]}" --launch "${launch:-lab}" --home "${home:-$(_launch_home "${launch:-lab}")}"
}

# 一眼看清：本 launch 的运行空间 + 本机实例表
status() {
  local home launch
  sha.parse "$@" || return $?
  local data_home="${home:-$(_launch_home "${launch:-lab}")}"
  echo "launch：${launch:-lab}"
  echo "数据根：${data_home}"
  # 「下次连哪」与「现在连哪」分开说：前者是 app.port 记录（不证明存活），后者靠探活
  if [[ -f "$data_home/app.port" ]]; then
    echo "上次用的端口：$(cat "$data_home/app.port")"
  else
    echo "上次用的端口：（无记录）"
  fi
  echo "现在在跑：$(node ./bin/diy2 port --home "$data_home" 2>/dev/null || echo '否（没有本数据根的实例应答）')"
  node ./bin/diy2 list
}

sha "$@"
