#!/usr/bin/env bash

# Command appears to be unreachable. Check usage (or ignore if invoked indirectly).
# shellcheck disable=SC2329 # This function is never invoked. Check usage (or ignored if invoked indirectly).shellcheckSC2329
# shellcheck disable=SC2317
# shellcheck disable=SC2034 #secondary appears unused. Verify use (or export if used externally).shellcheckSC2034
set -o errtrace  # -E trap inherited in sub script
set -o errexit   # -e
set -o functrace # -T If set, any trap on DEBUG and RETURN are inherited by shell functions
set -o pipefail  # default pipeline status==last command status, If set, status=any command fail

## 开启globstar模式，允许使用**匹配所有子目录,bash4特性，默认是关闭的
shopt -s globstar
## 开启后可用排除语法：_workspaces=(~ ~/git/chen56/!(applab)/ ~/git/botsay/*/ )
shopt -s extglob

# Get the real path of the script directory
ROOT_PATH="$(realpath "$(command -v "${BASH_SOURCE[0]}")")"
ROOT_DIR="$(dirname "$C_MAC_PATH")"

cd "$ROOT_DIR"
source sha.common.sh

# _workspaces=(pkgs/*/)
_workspaces=(pkgs.ts/*/)
_vendors=(vendor/*/)

####################################################################################
# app script
# 应用项目补充的公共脚本，不在bake维护范围
# 此位置以上的全都是bake工具脚本，copy走可以直接用，之下的为项目特定cmd，自己弄
####################################################################################

_ws_run() {
  for ws in "${_workspaces[@]}"; do
    (
      cd "$ws"
      echo "${inverse_surface}info: workspace: Running '$@' in '$ws'${reset}"
      run "$@"
    )
  done
}

# mono所有workspaced项目上执行一条命令
exec()  {  _ws_run command "$@"; }
# build() {  _ws_run command ./sha.sh build; }
# mono所有workspaced的clean,包括删除build/dist等
#（各包 build/ 产物由自家 ./sha.sh clean 负责，见 pkgs.ts/*/sha.sh）
clean() {
    run rm -rf ./build
    run rm -rf ./dist
    run rm -rf .venv
    run rm -rf .nodemodules
    _ws_run command ./sha.sh clean;
}

# mono所有workspaced的sync,包括uv sync、ln软链接到全局执行文件等
sync()  {
    # `--include-workspace-root` 不能省：`npm i --workspaces` 把安装范围限定在 workspace，
    # **漏装只在根 package.json 声明的依赖**（remark-gfm / playwright-core 等）—— 干净
    # worktree 上 100% 复现，症状是 renderer build 报 `Failed to resolve import "remark-gfm"`。
    # 详见 ##255。
    run npm i --workspaces --include-workspace-root
    run git submodule update --init --recursive

    _ws_run command ./sha.sh sync;

    # 本 worktree 的变体数据根缺「真配置」（真账号 / 投递划分 / 真人物），
    # 补齐它 —— 见下条 sync-dev-home
    sync-dev-home
}

# ── dev 数据根配置同步 ────────────────────────────────────────────────────────
# 把生产数据根（~/.diy）的**真配置**投影进本 worktree 的变体数据根 build/<variant>/home：
#   model.yaml · context.yaml · personas.yaml · providers.custom.yaml（这 4 份 = 真配置的投影）
# 与 seed 的分工：seed 只种**示例 / 测试数据**（示例项目与任务 + 缺省人物 + `$VAR` 占位凭据），
# 真配置（真账号 / 投递划分 / 真人物）由这里来 —— 原先是手工 cp，漏一份实验结论就不可信。
#   · 变体 `DIY_VARIANT`（缺省 preview；须与 ./sha.sh preview|lab 配对，见 AGENTS.md entry.variant-match）
#   · **幂等**：每次都整份覆盖这 4 份（`cp -p`，mtime 也随源）；目标 home 的**其余内容**
#     （state.yaml / projects / local / .seed-done）**一律不碰**
#   · 目标 home 不存在则 mkdir -p；源缺某文件 → 跳过 + 提示，**不让 sync 整体失败**
#   · `DIY_SYNC_HOME=0` 关掉这一步；`DIY_SYNC_HOME_SRC` 换源（测试 / 换机）
# ⚠️ 这 4 份含真实 API key，落到 build/**（已 gitignore）：勿提交、勿外传。
sync-dev-home() {
    local variant="${DIY_VARIANT:-preview}"
    local src="${DIY_SYNC_HOME_SRC:-$HOME/.diy}"
    local dst="$ROOT_DIR/build/$variant/home"

    case "$(printf '%s' "${DIY_SYNC_HOME:-1}" | tr '[:upper:]' '[:lower:]')" in
        0 | false | off | no)
            echo "${info}dev 数据根配置同步：已按 DIY_SYNC_HOME 关闭（跳过）${reset}"
            return 0
            ;;
    esac

    if [[ ! -d "$src" ]]; then
        echo "${secondary}warn: 源数据根不存在（${src}）→ 跳过 dev 配置同步（seed 仍会种示例数据）${reset}"
        return 0
    fi

    mkdir -p "$dst"
    local f missing=()
    for f in model.yaml context.yaml personas.yaml providers.custom.yaml; do
        if [[ -f "$src/$f" ]]; then
            run cp -p "$src/$f" "$dst/$f"
        else
            missing+=("$f")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "${secondary}warn: 源缺 ${missing[*]}（${src}）→ 已跳过，其余照常${reset}"
    fi
    echo "${error}⚠️  已把真配置（含 API key）同步到 ${dst} —— 该目录在 .gitignore 内，勿提交、勿外传${reset}"
    echo "${secondary}提示：配置是启动时读入的，已在跑的老实例要重启才看得到${reset}"
    echo "${info}✅ 本 worktree 已可起 ./sha.sh preview|lab 做真 LLM 实验（变体 ${variant}）${reset}"
}
link() {      _ws_run command npm link; }
unlink() {    _ws_run command npm unlink -g ; }
# 全仓唯一检查入口：全项目类型 + 全仓 lint + rpc 浏览器安全 + 产物护栏 + 可执行位护栏
#（子包目录下单用见 pkgs.ts/*/sha.sh check）
check() {
  run npx tsc -b tsconfig.all.json --noEmit
  run npx oxlint pkgs.ts/
  run npx tsc --noEmit -p pkgs.ts/diy-rpc/tsconfig.browser.json
  # 产物护栏：TS 包源码目录旁不得出现编译产物（实现见 scripts/check-no-emit.sh）
  run bash scripts/check-no-emit.sh
  # 可执行位护栏：shell 脚本在 git 索引里必须 100755（Windows 提交会静默丢位，实现见 scripts/check-exec-bit.sh，详见 ##304(Windows 提交丢可执行位)）
  run bash scripts/check-exec-bit.sh
}
# 全仓唯一自动修复入口：格式化 + lint 可修项，能修的全修
fix() {
  run npx oxfmt --write pkgs.ts/
  run npx oxlint --fix pkgs.ts/
}
# 全部测试：各包 test 子命令（diy-app 含意图测试，起隔离 Electron，最慢放最后）
test() {
  _ws_run command ./sha.sh test
}
# 编程中快速验证：各包单测，不构建、不起 Electron
test-unit() {  _ws_run command ./sha.sh test-unit; }

_vendors_run() {
  for submodule in "${_vendors[@]}"; do
    (
      cd "$submodule"
      run "$@"
    )
  done
}

# 直接改submoulde代码推荐流程：
#  ```bash
#    # 1. 进入子模块，先切到分支
#    cd vendor/sha
#    git checkout main

#    # 2. 正常改代码、提交、推送
#    git add .
#    git commit -m "feat: xxx"
#    git push origin main

#    # 3. 回到父仓库，更新子模块指针
#    cd ../..
#    git add vendor/sha
#    git commit -m "chore: update vendor/sha"
#  ```
vendor() {
  exec()    { _vendors_run command "$@"; }
  status()  { _vendors_run git status; }
  update() {  run git submodule update --init --recursive --remote --merge; }
}

####################################################
# Python 包发布
####################################################
build() {
    # 构建只在 diy-app（含 cli 产物），细节见 pkgs.ts/diy-app/sha.sh build
    run ./pkgs.ts/diy-app/sha.sh build
}

ci() {
    clean
    test
    build
    # test: 验证构建产物
    echo "${info}构建产物:${reset}"
    run ls -lh ./dist/
}

publish() {
  :
}

# mono所有workspace的ci持续集成,包括check;test;
github-actions-cicd()    {
    # github actions 安装 playwright 依赖
    uv run playwright install chromium --with-deps
    ci
    publish
}

# preview：HMR 预览实例（人看效果）；lab：agent 实验实例。各占 build/<variant>/**，可并行。
preview() { pkgs.ts/diy-app/sha.sh preview; }
lab()     { pkgs.ts/diy-app/sha.sh lab; }


####################################################
# app entry script & _root cmd
####################################################

sha "$@"
