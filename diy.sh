#!/usr/bin/env bash
# diy.sh — worktree 开发入口（测试约定 ./diy.sh，cwd=仓库根）。
#
# 机制（与 src/runtime.ts / src/cli/index.ts / src/main/index.ts 契约一致）：
#   1. CLI：DIY_CLI_MODE=auto（默认）优先用编译产物 out/cli/index.js（实测冷启动
#      ~2.5× 快于 tsx：310ms vs 629ms），只要 CLI 打包源比产物新就自动回退 tsx
#      源码，保持「改完即生效」；DIY_CLI_MODE=tsx 强制源码、=compiled 强制产物；
#      =http 走 server /cli 端点（curl，免 node 启动，~60ms；传输失败自动回退直连）
#   2. GUI：CLI 通过 ensureAppPort() 复用或拉起 Electron 产物
#      out/main/index.mjs + out/preload/index.js + out/renderer/index.html
#      → GUI 必须先构建才会存在，未构建直接报错（见下方检查）
#   3. dev 模式另走：cd pkgs.ts/diy-app && ./sha.sh dev
#      起 Vite dev server 并注入 DIY_DEV_SERVER_URL，走 loadURL 热更新（HMR），无需 build
#   4. 数据隔离：DIY_HOME 默认 ./build/home（本 worktree 独立），注入后由
#      src/runtime.ts readRuntimeConfig() 统一读取；测试用 mkdtemp 隔离
#      环境声明：DIY_ENV 默认 development（dev/test 专属能力的判据，缺省按 production）
#   5. 发布入口：pkgs.ts/diy-app/bin/diy 跑编译产物 out/cli/index.js，数据落 ~/.diy
#
# 前置要求：首次使用或改动 main/preload/renderer 后，需先构建：
#   cd pkgs.ts/diy-app && ./sha.sh build
# 否则 out/main/index.mjs 不存在，CLI 会在 stderr 提示并退出（不污染 stdout JSON）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/pkgs.ts/diy-app"
HOME_DEFAULT="$SCRIPT_DIR/build/home"
mkdir -p "$HOME_DEFAULT"

# 前置检查：GUI 产物必须存在（CLI 本身是 tsx 源码无需构建，但要拉起的 Electron 必须已构建）
if [[ ! -f "$APP_DIR/out/main/index.mjs" ]]; then
  echo "[diy.sh] 未找到 Electron 产物: $APP_DIR/out/main/index.mjs" >&2
  echo "[diy.sh] 机制: CLI(编译产物/tsx 源码) 需拉起 GUI 产物(out/main)才能响应 RPC" >&2
  echo "[diy.sh] 请先构建: cd pkgs.ts/diy-app && ./sha.sh build" >&2
  echo "[diy.sh] 或开发模式（HMR，无需 build）: cd pkgs.ts/diy-app && ./sha.sh dev" >&2
  exit 1
fi

# ── 生产数据保护 ──
# agent / CI / 外层 shell 常导出 DIY_HOME=~/.diy。若直接透传，worktree 里一条
# `./diy.sh project remove <id>` 就会操作生产数据（实测：removeProject 会按 meta.yaml
# 的 path 去摘目标仓库的 diy.yaml 名片，那条路径是真实的 ~/git/...）。
# 因此：继承到的 DIY_HOME 若指向生产数据根（$HOME/.diy），默认拒绝，改用本 worktree 的。
# 测试不受影响：它们显式传 DIY_HOME=<临时目录>，不等于 $HOME/.diy，会正常透传。
# 确实需要指向生产数据时显式 opt-in：DIY_ALLOW_PROD_HOME=1 ./diy.sh ...
if [[ -n "${DIY_HOME:-}" && "${DIY_HOME}" == "${HOME}/.diy" && "${DIY_ALLOW_PROD_HOME:-}" != "1" ]]; then
  # 变量一律用 ${} 界定：紧跟多字节字符时，非 UTF-8 locale 下 bash 会把字符首字节
  # 并入变量名，set -u 下报 "unbound variable"（踩过）
  echo "[diy.sh] 警告: 忽略继承的生产数据目录 DIY_HOME=${DIY_HOME}, 改用本 worktree 的 ${HOME_DEFAULT}" >&2
  echo "[diy.sh] 警告: 确需操作生产数据请显式声明 DIY_ALLOW_PROD_HOME=1 ./diy.sh ..." >&2
  unset DIY_HOME
fi

# DIY_CALLER_CWD：调用者敲命令时的目录。下面的 cd 会把它换掉，而 CLI 的路径参数
# （如 `diy tool read <相对路径>`）必须按**用户的**目录解析 —— 所以先记下来传进去。
# 缺了它，相对路径会落到应用目录（实测：`cd /tmp && diy tool read a.txt` 去找 <app>/a.txt）。
export DIY_CALLER_CWD="$PWD"

# ── DIY_CLI_MODE=http：经 app server 的 /cli 端点执行（任务 223 性能原型）──
# 机制：POST http://127.0.0.1:<port>/cli  body={"argv":[...],"cwd":...}
#       server 进程内跑同一份 CliApp；响应 body=stdout，x-diy-exit=退出码，
#       x-diy-err=stderr(base64)。输出/退出与直连逐字节同源（同一份代码生成）。
# 回退：无端口文件 / curl 缺失或不支持 h2 / 传输失败 → 落到下方直连（含 ensureAppPort spawn）。
# 实测：curl 地板 ~17ms（含 bash 脚本自身开销总计 ~45ms/条；tsx 601、compiled 300）。
# 位置：放在新鲜度 find 之前 —— http 模式不需要选 tsx/compiled，省掉那次 find（~14ms）。
if [[ "$DIY_CLI_MODE" == "http" ]]; then
  _home="${DIY_HOME:-$HOME_DEFAULT}"
  _port=""
  if [[ -f "$_home/app.port" ]]; then
    # 注意：app.port 可能无末尾换行 → read 返回非零但**已赋值**，
    # 故用 `|| true` 保住值（写成 `|| _port=""` 会把刚读到的端口清空，实测踩过）
    IFS= read -r _port < "$_home/app.port" || true
    [[ "$_port" =~ ^[0-9]+$ ]] || _port=""
  fi
  if [[ -n "$_port" ]] && command -v curl >/dev/null 2>&1; then
    # argv → JSON（原型编码：\\ 与引号 + \n/\r/\t；其余控制字符不覆盖——测试命令用不到）
    _json='{"argv":['
    _first=1
    for _a in "$@"; do
      _a=${_a//\\/\\\\}
      _a=${_a//\"/\\\"}
      _a=${_a//$'\n'/\\n}
      _a=${_a//$'\r'/\\r}
      _a=${_a//$'\t'/\\t}
      if [[ $_first == 1 ]]; then _first=0; else _json+=','; fi
      _json+="\"$_a\""
    done
    _cwd="${DIY_CALLER_CWD:-$PWD}"
    _cwd=${_cwd//\\/\\\\}
    _cwd=${_cwd//\"/\\\"}
    _json+="],\"cwd\":\"$_cwd\"}"

    # 用 $$ 而非 mktemp：省两次 fork（实测每次 ~3.5ms）；同进程唯一，够用
    _tmp="${TMPDIR:-/tmp}"
    _hdr="${_tmp%/}/diy-cli-h.$$"
    _body="${_tmp%/}/diy-cli-b.$$"
    # curl 非 0 = 传输层失败（h2 不支持/端口半死）；缺 x-diy-exit = 对端没有 /cli 端点
    # （旧版 server / UNIMPLEMENTED）——两者都回退直连，body 丢弃不污染 stdout。
    if curl -sS --http2-prior-knowledge -D "$_hdr" -o "$_body" -X POST \
        -H 'content-type: application/json' --data-binary "$_json" \
        "http://127.0.0.1:${_port}/cli"; then
      _hdrs="$(< "$_hdr")"
      _hdrs=${_hdrs//$'\r'/}
      _code=""
      _e64=""
      if [[ "$_hdrs" =~ [Xx]-[Dd]iy-[Ee]xit:[[:space:]]*([0-9]+) ]]; then _code=${BASH_REMATCH[1]}; fi
      if [[ -n "$_code" ]]; then
        if [[ "$_hdrs" =~ [Xx]-[Dd]iy-[Ee]rr:[[:space:]]*([A-Za-z0-9+/=]+) ]]; then _e64=${BASH_REMATCH[1]}; fi
        # 顺序：先 stderr 后 stdout —— 与直连 CLI 的错误路径一致
        # （CliApp 错误时先 console.error 报错、再 console.log 出帮助；
        #  以管道/2>&1 合并观察时顺序才一致）
        if [[ -n "$_e64" ]]; then printf '%s' "$_e64" | base64 -d >&2 || true; fi
        rm -f "$_hdr"
        command cat "$_body"      # 正文落 stdout —— 管道/重定向语义与直连一致
        rm -f "$_body"
        exit "${_code:-1}"
      fi
    fi
    rm -f "$_hdr" "$_body"
    # 落到下方 = 回退直连
  fi
fi

cd "$APP_DIR"

# ── CLI 执行方式选择（性能：编译产物冷启动 ~310ms vs tsx ~629ms，实测 ×2.5）──
# auto（默认）：out/cli/index.js 存在且**不比打包源新** → 用编译产物；
#   任一打包源（diy-app/src、diy-rpc/src、diy-template/src —— cli bundle 的输入）
#   比产物新（刚改完码没重新 build）→ 回退 tsx 源码，保住「改完即生效」。
#   新鲜度检查实测 ~14ms，远小于省下的 ~390ms。
# DIY_CLI_MODE=auto|compiled|tsx：compiled 强制产物（测试/CI 跑 build 后用）、tsx 强制源码。
CLI_JS="$APP_DIR/out/cli/index.js"
DIY_CLI_MODE="${DIY_CLI_MODE:-auto}"
DIY_CLI_EFFECTIVE="tsx"
if [[ "$DIY_CLI_MODE" != "tsx" && -f "$CLI_JS" ]]; then
  if [[ "$DIY_CLI_MODE" == "compiled" ]]; then
    DIY_CLI_EFFECTIVE="compiled"
  else
    _stale="$(find "$APP_DIR/src" "$SCRIPT_DIR/pkgs.ts/diy-rpc/src" "$SCRIPT_DIR/pkgs.ts/diy-template/src" \
      -newer "$CLI_JS" -print -quit 2>/dev/null || true)"
    [[ -z "$_stale" ]] && DIY_CLI_EFFECTIVE="compiled"
    unset _stale
  fi
fi

# 机制提示（仅交互终端输出到 stderr，不污染 --json 的 stdout）
if [[ -t 2 ]]; then
  echo "[diy.sh] CLI=${DIY_CLI_MODE:-auto}(${DIY_CLI_EFFECTIVE:-?}) | GUI=out/main产物 | HOME=${DIY_HOME:-$HOME_DEFAULT} | 需先 build（dev 模式除外）" >&2
fi

# DIY_CLI：当前生效的 CLI 入口（提示词模版 100-diy 用它告诉 agent 该敲哪个命令；
# 少了它 agent 只能猜“diy”，在 worktree 里会打到生产数据根）
# DIY_ENV：运行环境声明（development/test/production，缺省 production）
if [[ "$DIY_CLI_EFFECTIVE" == "compiled" ]]; then
  exec env DIY_HOME="${DIY_HOME:-$HOME_DEFAULT}" DIY_CLI="${DIY_CLI:-$SCRIPT_DIR/diy.sh}" DIY_ENV="${DIY_ENV:-development}" \
    node "$CLI_JS" "$@"
else
  exec env DIY_HOME="${DIY_HOME:-$HOME_DEFAULT}" DIY_CLI="${DIY_CLI:-$SCRIPT_DIR/diy.sh}" DIY_ENV="${DIY_ENV:-development}" \
    "$APP_DIR/../../node_modules/.bin/tsx" src/cli/index.ts "$@"
fi