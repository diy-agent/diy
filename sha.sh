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
sync-deps() {
    # `--include-workspace-root` 不能省：`npm i --workspaces` 把安装范围限定在 workspace，
    # **漏装只在根 package.json 声明的依赖**（remark-gfm / playwright-core 等）—— 干净
    # worktree 上 100% 复现，症状是 renderer build 报 `Failed to resolve import "remark-gfm"`。
    # 详见 ##255。
    run npm i --workspaces --include-workspace-root
    # npm i 只补缺失、**不清改名残留**（实测留着旧的 `node_modules/@diy/rpc`）——
    # 残留会让包级构建护栏继续报「未同步」，故精准清一道（只删 lock 不认可的 workspace 软链接）
    run node scripts/check-sync.mjs --fix
    run git submodule update --init --recursive

    _ws_run command ./sha.sh sync;

    # electron 二进制：全机一份 store + 本 worktree 只留软链（细节见 scripts/ensure-electron.mjs
    # 头注）。这里**不联网**（--no-download）：构建/检查用不到二进制，缺就一行提示；
    # 真起 Electron 的入口（pkgs.ts/diy-app/sha.sh 的 lab/test-intent/start）会硬校验。
    run node scripts/ensure-electron.mjs --no-download --soft --quiet

    # 记下本次同步覆盖的 lock/manifest 指纹：build/check/test/lab 入口的
    # ensure-sync 拿 scripts/check-sync.mjs 比对它，判「有没有落后」
    run node scripts/check-sync.mjs --write-stamp
}

# mono所有workspaced的sync（= 依赖 + dev 数据根配置投影）
sync()  {
    sync-deps

    # 本 worktree 的变体数据根缺「真配置」（真账号 / 投递划分 / 真人物），
    # 补齐它 —— 见下条 sync-dev-home
    sync-dev-home
}

# ── 同步闸门：入口前置「没 sync 就先 sync」 ────────────────────────────────────
# 判据 = scripts/check-sync.mjs（只读快检、毫秒级）：workspace 链接缺失/过期（如包改名后
# 残留的 `node_modules/@diy/rpc`）、sync 印记落后、submodule 未 init；electron 二进制的
# dist/path.txt 缺失只提示不判定（它由 `sync-deps` 的 ensure-electron 补，见其末尾）。
#   · 命中 → 自动 sync-deps 后继续；`DIY_AUTO_SYNC=0` 关掉自动修（改为报错停下）
#   · 只挂 build/check/test/lab 入口；**sync 自身不挂**（否则递归）
# 为什么值得：包改名 / 加依赖后 node_modules 落后，症状是构建报**远离根因**的错，如
# `Rolldown failed to resolve import "@diy-agent/rpc/electron"`（人只会去翻代码，
# 不会想到比 package-lock.json 与 node_modules）。
ensure-sync() {
    if node scripts/check-sync.mjs --quiet; then
        return 0
    fi
    case "$(printf '%s' "${DIY_AUTO_SYNC:-1}" | tr '[:upper:]' '[:lower:]')" in
        0 | false | off | no)
            echo "${error}✗ node_modules 落后于 package-lock.json / 源树，且 DIY_AUTO_SYNC=0 关闭了自动同步 → 请手动跑：./sha.sh sync${reset}"
            return 1
            ;;
    esac
    echo "${warning}↑ 检测到 node_modules 落后 → 自动 sync 后继续（DIY_AUTO_SYNC=0 可关）${reset}"
    sync-deps
    echo "${info}✅ sync 完成${reset}"
}

# 只看同步状态（只读、不改任何东西，含 electron 等只提示项）；落后时非零退出
sync-status() {  node scripts/check-sync.mjs "$@"; }

# ── dev 数据根配置同步 ────────────────────────────────────────────────────────
# 把生产数据根（~/.diy）的**真配置**投影进本 worktree 的变体数据根 build/<variant>/home：
#   model.yaml · context.yaml · personas.yaml · providers.custom.yaml（这 4 份 = 真配置的投影）
# 与 seed 的分工：seed 只种**示例 / 测试数据**（示例项目与任务 + 缺省人物 + `$VAR` 占位凭据），
# 真配置（真账号 / 投递划分 / 真人物）由这里来 —— 原先是手工 cp，漏一份实验结论就不可信。
#   · 变体 `DIY_VARIANT`（缺省 lab；与 ./sha.sh lab 配对，见 AGENTS.md entry.variant-match）
#   · **幂等**：每次都整份覆盖这 4 份（`cp -p`，mtime 也随源）；目标 home 的**其余内容**
#     （state.yaml / projects / local / .seed-done）**一律不碰**
#   · 目标 home 不存在则 mkdir -p；源缺某文件 → 跳过 + 提示，**不让 sync 整体失败**
#   · `DIY_SYNC_HOME=0` 关掉这一步；`DIY_SYNC_HOME_SRC` 换源（测试 / 换机）
# ⚠️ 这 4 份含真实 API key，落到 build/**（已 gitignore）：勿提交、勿外传。
sync-dev-home() {
    local variant="${DIY_VARIANT:-lab}"
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
    echo "${info}✅ 本 worktree 已可起 ./sha.sh lab 做真 LLM 实验（变体 ${variant}）${reset}"
}
link() {      _ws_run command npm link; }
unlink() {    _ws_run command npm unlink -g ; }
# 全仓唯一检查入口：全项目类型 + 全仓 lint + rpc 浏览器安全 + 产物护栏 + 可执行位护栏
#（子包目录下单用见 pkgs.ts/*/sha.sh check）
check() {
  ensure-sync
  run npx tsc -b tsconfig.all.json --noEmit
  run npx oxlint pkgs.ts/
  run npx tsc --noEmit -p pkgs.ts/diy-rpc/tsconfig.browser.json
  # 产物护栏：TS 包源码目录旁不得出现编译产物（实现见 scripts/check-no-emit.sh）
  run bash scripts/check-no-emit.sh
  # 可执行位护栏：shell 脚本在 git 索引里必须 100755（Windows 提交会静默丢位，实现见 scripts/check-exec-bit.sh，详见 ##304(Windows 提交丢可执行位)）
  run bash scripts/check-exec-bit.sh
  # 原子写护栏：src/main 下整文件覆盖写必须走 core/atomic-write.ts 的 writeFileAtomic（实现见 scripts/check-atomic-write.sh，详见 ##383(整文件覆盖写加固)）
  run bash scripts/check-atomic-write.sh
  # vi.mock 禁令护栏（##402）：test-unit 跑 `--no-isolate`，vi.mock 改全局模块表会**静默失效**
  #（实现见 scripts/check-no-vi-mock.sh；替代写法 = 注入 / 手写假对象 / server.deps.inline alias）
  run bash scripts/check-no-vi-mock.sh
  # 异常码护栏（##394）：新增 `throw new` 必须带 code（<域>/<kebab-case>）；存量按 LEGACY_THROW_BASELINE 比例递减
  #（实现见 scripts/check-error-code.sh，判据见 rule.err-triage；**别改成整文件豁免** —— 那会让新代码永远不被拦）
  run bash scripts/check-error-code.sh
  # 包可见性白名单：对外发布只有 @diy-agent/rpc 与 @diy-agent/ui（不许 private），其余必须 private；
  # 且对外包不许依赖 @diy/* 内部包（否则使用时 registry 找不到）。实现见 scripts/check-pkg-visibility.mjs
  run node scripts/check-pkg-visibility.mjs
  # 同步 IO 护栏（##408 刀 16）：主进程 / shared / preload 里新增 `*Sync` 的磁盘或子进程调用一律 ✗
  #（实现见 scripts/check-sync-io.sh；用户口径「app 不允许有 sync 的 io 操作」；存量按
  # LEGACY_SYNC_IO_BASELINE 棘轮递减，逃生口 `// sync-io-ok: <理由>`）
  run bash scripts/check-sync-io.sh
  # 各领域规范索引护栏（##388）：~/SPECS.md 的 key 唯一 / 指针可解析 / 链上新增未收录（ratchet：存量基线 scripts/specs-unindexed.txt）
  #（实现见 scripts/check-specs.mts；**总表缺失 = skip + 提示、不算失败**，跨机器 / CI 没有家目录那份文件）
  run npx tsx scripts/check-specs.mts
  # 事实库真源护栏（##404）：schema / claim 冲突 / 边悬空 / subject 词表 / 证据可解析（掉文件即 error）
  #（实现见 scripts/facts-index.mts；真源 knowledge/facts/*.yaml，内核 pkgs.ts/diy-facts）
  run npx tsx scripts/facts-index.mts
}
# 全仓唯一自动修复入口：格式化 + lint 可修项，能修的全修
fix() {
  run npx oxfmt --write pkgs.ts/
  run npx oxlint --fix pkgs.ts/
}
# 全部测试：各包 test 子命令（diy-app 含意图测试，起隔离 Electron，最慢放最后）
test() {
  ensure-sync
  _ws_run command ./sha.sh test
}
# 编程中快速验证：各包单测，不构建、不起 Electron
test-unit() {  ensure-sync; _ws_run command ./sha.sh test-unit; }

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
    ensure-sync
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

# 发布到 npm（@diy-agent scope）。清单单列：**只有**做了 npm 分发准备的包才有 publish 子命令，
# 不能沿用 _ws_run（其余 workspace 包会以「未知命令」中止）。
_npm_publish_pkgs=(pkgs.ts/diy-rpc pkgs.ts/diy-ui pkgs.ts/workbench-plugin)

publish() {
  # CI（github-actions-cicd）里没有 ~/.bashrc 与 token ⇒ 跳过而非报错；本地有 token 照发
  if [[ -z "${NPM_PUBLISH_TOKEN:-}" ]] && ! grep -q '^export NPM_PUBLISH_TOKEN=' "$HOME/.bashrc" 2>/dev/null; then
    echo "${warning}跳过 npm 发布：未找到 NPM_PUBLISH_TOKEN（环境变量或 ~/.bashrc）${reset}"
    return 0
  fi
  for ws in "${_npm_publish_pkgs[@]}"; do
    (
      cd "$ws"
      echo "${info}publish: $ws${reset}"
      run ./sha.sh publish "$@"
    )
  done
}

# mono所有workspace的ci持续集成,包括check;test;
github-actions-cicd()    {
    # github actions 安装 playwright 依赖
    uv run playwright install chromium --with-deps
    ci
    publish
}

# lab：HMR 开发实例（人看效果 / agent 实验都用它），独占 build/lab/**，与 test 互不干扰。
lab()     {  ensure-sync; pkgs.ts/diy-app/sha.sh lab; }
# preview：编译后运行（无 watch）的稳定实例 —— 长会话 / 人要持续对话时用它，改码不打断。
preview() {  ensure-sync; DIY_VARIANT=preview pkgs.ts/diy-app/sha.sh preview "$@"; }


####################################################
# app entry script & _root cmd
####################################################

# preview（2026-10-23 恢复，##404）：编译后运行的稳定实例，无 watch。见 diy-app/sha.sh::preview。

sha "$@"
