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
#
# 只收**真正的 workspace**（有 package.json **且有 sha.sh**）：目录残留不该把整套命令拖死。
# 实测 ##501 把 diy-dev 迁出主仓后，本地留下的 pkgs.ts/diy-dev/ 只剩 node_modules，
# glob 仍会命中 → `./sha.sh sync` 报 "No such file or directory" → build 直接 exit 127。
# ##512 另有一类：旧布局的包目录留下产物目录（含 npm-publish 生成的 package.json，
# 2026-11-15 前是 lib/，之后是 dist/）—— 既会被当成 workspace 跑 sha.sh（不存在 → exit 127），
# 又会被 npm 当成重复 workspace（报 EDUPLICATEWORKSPACE）。sha.sh 是 workspace 目录的标志。
_pick_workspaces() {
  local w
  # ##512 起 pkgs.ts 分层（pkgs.ts/<组>/<包>），另有单包分组 pkgs.ts/flow、pkgs.ts/room 留在一层
  for w in pkgs.ts/*/ pkgs.ts/*/*/ apps/*/; do
    [[ -f "$w/package.json" && -f "$w/sha.sh" ]] && echo "$w"
  done
}
shopt -s extglob

# Get the real path of the script directory
# 用 dirname 直接取脚本所在目录：`command -v "${BASH_SOURCE[0]}"` 在 `bash sha.sh` 形态下
# （BASH_SOURCE[0] 不带斜杠、脚本又不在 PATH）返回空 → realpath "" 报错 → set -e 立刻退 1。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"
source sha.common.sh

# _workspaces=(pkgs/*/)
readarray -t _workspaces < <(_pick_workspaces)
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

# 各包的 `./sha.sh sync`：**只跑真有实现的包**。
#
# 为什么：49 个包里 48 个的 sync() 是空实现（`sync() { :; }`，模板自带的占位），
# 逐个起一个 bash + sha 引擎只为跑一个 `:` —— 实测 49 个子进程合计 2.67s，几乎全是启动开销。
# 静态看一眼包级 sha.sh 就能筛掉；有实现的（如 pkgs.ts/ui/core）照旧跑。
# 判据写成「精确匹配空实现」而不是「猜有没有逻辑」：匹配不上就走子进程，宁可多跑不漏跑。
_ws_run_sync() {
  local ws
  for ws in "${_workspaces[@]}"; do
    [[ -f "$ws/sha.sh" ]] || continue
    if grep -qE '^[[:space:]]*sync\(\)[[:space:]]*\{[[:space:]]*:[[:space:]]*;?[[:space:]]*\}' "$ws/sha.sh"; then
      continue
    fi
    (
      cd "$ws"
      echo "${inverse_surface}info: workspace: Running './sha.sh sync' in '$ws'${reset}"
      run command ./sha.sh sync
    )
  done
}

# mono所有workspaced项目上执行一条命令
exec()  {  _ws_run command "$@"; }
# build() {  _ws_run command ./sha.sh build; }
# mono所有workspaced的clean,包括删除build/dist等
#（各包 build/ 产物由自家 ./sha.sh clean 负责，见 pkgs.ts/*/sha.sh）
sha.def "clean" \
  --desc "清空 build / dist / .venv / node_modules（含各 workspace 的）"

clean() {
    run rm -rf ./build
    run rm -rf ./dist
    run rm -rf .venv
    run rm -rf .nodemodules
    _ws_run command ./sha.sh clean;
}

# mono所有workspaced的sync,包括uv sync、ln软链接到全局执行文件等
sync-deps() {
    # 装依赖用 **bun install**（2026-11-28 换掉 npm，##44 实测本机：清空 node_modules 重装
    # 4.5s vs npm 45s、幂等 0.34s vs 5.9s；bun 的 hoisted 布局与 npm 一致，所以
    # check-sync.mjs 那套「读 package-lock 的 link 条目」的判据原样可用）。
    # 附带好处：bun 按 package.json 的 workspaces 装、**根依赖一起装** —— npm 那边必须加
    # `--include-workspace-root`，漏了就漏装 remark-gfm / playwright-core（##255，干净
    # worktree 上 100% 复现），这个坑在 bun 下不存在。
    # 没装 bun 的机器回落 npm：功能等价，只是慢（多机 / CI 未铺 bun 时的逃生口）。
    if command -v bun >/dev/null 2>&1; then
        run bun install
    else
        echo "${warning}bun 未安装 → 回落 npm i --workspaces --include-workspace-root（慢但等价）${reset}" >&2
        run npm i --workspaces --include-workspace-root
    fi
    # 装依赖只补缺失、**不清改名残留**（实测 npm 会留着旧的 `node_modules/@diy-agent/rpc`，bun 同理
    # 不保证清）—— 残留会让包级构建护栏继续报「未同步」，故精准清一道（只删 lock 不认可的 workspace 软链接）
    run node scripts/check-sync.mjs --fix
    # vendor/sha 是 git subtree：内容随 checkout 下来，这里不再需要任何 submodule init。

    _ws_run_sync;

    # electron 二进制：全机一份 store + 本 worktree 只留软链（细节见 scripts/ensure-electron.mjs
    # 头注）。这里**不联网**（--no-download）：构建/检查用不到二进制，缺就一行提示；
    # 真起 Electron 的入口（apps/diy-app/sha.sh 的 lab/test-intent/start）会硬校验。
    run node scripts/ensure-electron.mjs --no-download --soft --quiet

    # 生成物冲突免手解：注册 merge=ours（见 scripts/ensure-merge-driver.mjs；本地仓库配置，幂等）
    run node scripts/ensure-merge-driver.mjs

    # 记下本次同步覆盖的 lock/manifest 指纹：build/check/test/lab 入口的
    # ensure-sync 拿 scripts/check-sync.mjs 比对它，判「有没有落后」
    run node scripts/check-sync.mjs --write-stamp
}

# mono所有workspaced的sync（= 依赖 + 测试数据根：建出 run/<app>/lab 并填真配置）
#
# ##452：**幂等短路**。原先每调一次就是依赖安装 + 子模块 + electron 检查 +
# 各包 sync + 真配置投影 ≈ 45s，而 agent 每轮验前都会 sync 一次 —— 其中 99% 的调用
# 什么都没变。现在先做一个毫秒级判断（`_sync_uptodate`）：
#   stamp 存在 且 比 lock（bun.lock / package-lock.json）/ 根与各包 package.json 都新 且 workspace 软链齐全
# ⇒ 直接返回（实测 ~30ms），不碰 node_modules 一下。
# 判据故意**只用 mtime 与 exists**（不重算哈希）：宁可误判「不新鲜」走全量，
# 也不许误判「新鲜」跳过真正的变更 —— 内容哈希那份权威判断在 check-sync.mjs 里，
# 全量路径仍会跑它；`--force` 强制无条件全量。
sha.def "gen-models" \
  --desc "拉取 models.dev 模型规格快照到包内 dist/（一天内自动跳过；新 worktree / 新机器靠它才有模型目录）"

# 包内快照 = 目录的离线兜底（2026-11-27）：没有它，模型面板一家服务商都没有。
# 快照不进 git，所以**每个新 worktree 都得由这一步生成**。sync 会自动调，
# 平时想手动刷新就 ./sha.sh gen-models [--force]。
gen-models()  {
    local target="pkgs.ts/model/models-dev-snapshot/dist/models.dev.json"
    local force=0
    case "${1:-}" in
        --force|-f) force=1 ;;
        "") ;;
        *) echo "${error}用法：./sha.sh gen-models [--force]${reset}" >&2; return 2 ;;
    esac
    if (( force == 0 )) && [[ -f "$target" ]]; then
        # bash 层先挡一道：gen 里也有 24h 判断，但那是起一个 node 进程
        local mtime age
        mtime=$(stat -f %m "$target" 2>/dev/null || stat -c %Y "$target" 2>/dev/null || echo 0)
        age=$(( $(date +%s) - mtime ))
        if (( age < 86400 )); then
            echo "${info}模型规格快照在一天内 → 跳过（要重拉加 --force）${reset}"
            return 0
        fi
    fi
    [[ -d node_modules ]] || { echo "${error}还没装依赖：先跑 ./sha.sh sync${reset}" >&2; return 2; }
    if (( force == 1 )); then
        run env MODELS_DEV_FORCE=1 npm run gen -w @diy-agent/models-dev-snapshot
    else
        run npm run gen -w @diy-agent/models-dev-snapshot
    fi
}

sha.def "sync" \
  --desc "依赖同步：bun install + workspace 链接 + 测试数据根（run/<app>/lab）建与真配置填充"

sync()  {
    # 真配置**填充**进 run/<app>/<label>（毫秒级、幂等；与 sync 的幂等短路无关，先跑）。
    # `--defaults`：每个 app 的默认开发数据根 `run/<app>/lab` 也在这一步**建出来** —— 新 worktree
    # 里跑一次 sync 就能直接 `./sha.sh lab`，不必先起一次空实例再补配置。
    # 拷而不是直读：测试实例必须完整依赖自己的数据根（理由见 scripts/seed-run-home.sh 头注）。
    if [[ "${DIY_SYNC_HOME:-1}" != "0" ]]; then
        run bash scripts/seed-run-home.sh --defaults
    fi

    case "${1:-}" in
        --force|-f) ;;
        "")        if _sync_uptodate; then
                       echo "${info}依赖未变（stamp 命中、workspace 链接齐全）→ 跳过依赖安装${reset}"
                       return 0
                   fi ;;
        *) echo "${error}用法：./sha.sh sync [--force]${reset}" >&2; return 2 ;;
    esac

    sync-deps
    # 装完依赖再补快照（fresh worktree 的 dist 是空的；bun 也会跑 workspace 的 prepare，但不能靠）
    gen-models
}

# sync 的幂等快判：**只读、不写任何东西**，ms 级（sync 自己不能挂 ensure-sync，故这里自判）
_sync_uptodate() {
    local stamp="node_modules/.diy-sync.stamp"
    [[ -f "$stamp" ]] || return 1
    # 模型规格快照（包内兜底，不进 git）：没有它 sync 就不算新鲜 —— 否则 stamp 命中后
    # 永远补不上，新 worktree 的模型面板会一直空着
    [[ -f "pkgs.ts/model/models-dev-snapshot/dist/models.dev.json" ]] || return 1
    local f ws
    # 锁文件：bun.lock 是主用的，package-lock.json 留着给 npm 兜底，两个都看（有就比）
    for f in package.json package-lock.json bun.lock; do
        [[ -e "$f" ]] || continue
        # stamp 必须比每个 manifest 都新（`-nt` = 严格更新；同秒也判「不新鲜」，保守）
        [[ "$stamp" -nt "$f" ]] || return 1
    done
    for ws in "${_workspaces[@]}"; do
        [[ "$stamp" -nt "$ws/package.json" ]] || return 1
    done
    # workspace 软链齐全（包改名 / node_modules 被部分清掉时这里会漏，交给全量）
    # 名字用 sed 直接抠（不起 node：13 个包 × node 启动 ~60ms 就吃掉了整个预算）
    local name
    for ws in "${_workspaces[@]}"; do
        name=$(sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' "$ws/package.json" | head -1)
        [[ -n "$name" ]] || return 1
        [[ -e "node_modules/$name" ]] || return 1
    done
    # 曾经这里还查「子模块已 init」：vendor/sha 2026-11-28 改成 git subtree（##44）后
    # 内容随 checkout 下来，没有子模块要 init，这段已删。
    return 0
}

# ── 同步闸门：入口前置「没 sync 就先 sync」（公开命令；实现见 sha.common.sh::ensure_sync）──
# 只挂 build/check/test/lab 入口；**sync 自身不挂**（否则递归）。
# 判据 / 处置策略**不在这里写** —— 包级 sha.sh（apps/{diy-app,diy2}）也用同一份实现，
# 否则「包级入口能不能自动补」又会两边各说一套（##536）。
ensure-sync() { ensure_sync; }

# 只看同步状态（只读、不改任何东西，含 electron 等只提示项）；落后时非零退出
sync-status() {  node scripts/check-sync.mjs "$@"; }

# 全局 bin 目录：Windows 的 `npm prefix -g` 本身就是 bin 目录（%APPDATA%\npm）；
# POSIX 下 bin 在 prefix/bin。
_link_global_bin() {
  local prefix
  prefix="$(npm prefix -g)"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s\n' "$prefix" ;;
    *) printf '%s\n' "$prefix/bin" ;;
  esac
}

# 本仓各 workspace 声明的 bin 名（`package.json.bin` 的对象键；字符串形态取包名末段）。
_ws_bin_names() {
  node -e '
    const fs = require("fs"), path = require("path");
    const out = [];
    // ##512 起 pkgs.ts 分层（pkgs.ts/<组>/<包>），故每个根都要“先看一眼自己、再看下一层”
    const walk = (dir) => {
      const p = path.join(dir, "package.json");
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (j.bin) {
          if (typeof j.bin === "string") out.push(String(j.name).split("/").pop());
          else out.push(...Object.keys(j.bin));
        }
      }
      for (const d of fs.readdirSync(dir)) {
        const sub = path.join(dir, d);
        if (d.startsWith(".") || !fs.statSync(sub).isDirectory()) continue;
        if (d === "node_modules" || d === "src" || d === "tests" || d === "test" || d === "build" || d === "lib") continue;
        walk(sub);
      }
    };
    for (const root of ["pkgs.ts", "apps"]) {
      if (!fs.existsSync(root)) continue;
      for (const d of fs.readdirSync(root)) {
        const sub = path.join(root, d);
        if (d.startsWith(".") || !fs.statSync(sub).isDirectory()) continue;
        walk(sub);
      }
    }
    console.log(out.join("\n"));
  '
}

# npm link 在 Windows 上**不覆盖**已存在的全局 shim（EEXIST: %APPDATA%\npm\<bin>）。
# 先删掉本仓会生成的那几个入口（<bin> / <bin>.cmd / <bin>.ps1）再 link，保证可重复执行。
link() {
  local bindir name
  bindir="$(_link_global_bin)"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    rm -f "$bindir/$name" "$bindir/$name.cmd" "$bindir/$name.ps1"
  done < <(_ws_bin_names)
  _ws_run command npm link
}
unlink() {    _ws_run command npm unlink -g ; }
# 全仓唯一检查入口：全项目类型 + 全仓 lint + rpc 浏览器安全 + 产物护栏 + 可执行位护栏
#（子包目录下单用见 pkgs.ts/*/sha.sh check）
#
# ##452：`--changed` 只跑**受影响的那部分**（判据在 scripts/changed-plan.mjs，头注有全部规则）
#   ./sha.sh check                      # 全量（CI / 提交前 / 拿不准）—— **行为与以前完全一致**
#   ./sha.sh check --changed            # 按 git 改动裁剪（基线缺省 origin/main → main → HEAD~1）
#   ./sha.sh check --changed --base m   # 换基线
# 2026-11-05：改用 `sha.def` + `sha.parse`（vendor/sha bed317f 起）。
# 以前是手写 case，且**必须 `exit`** —— 否则 vendor 会把 `--changed` 当成下一级子命令，
# 报 unknown command（##452 记的坑）。新引擎在 `sha.parse` 里一次解析完，
# 不会再往下层注册，那个 exit 也不需要了。
# 顺带白拿：`./sha.sh check -h` 有完整帮助（选项说明 + 自动 usage）。
sha.def "check" \
  --opt "--changed:bool:只跑受 git 改动影响的部分（判据在 scripts/changed-plan.mjs）" \
  --opt "--base:string:--changed 的基线引用（缺省依次取 origin/main → main → HEAD~1）" \
  --desc "类型检查 + lint + 各处护栏（全量，或按改动裁剪）"

check() {
  local changed base
  sha.parse "$@" || return $?
  if [[ "$changed" == "1" ]]; then
    if [[ -n "$base" ]]; then _check_changed --base "$base"; else _check_changed; fi
  else
    _check_full
  fi
}

# 读 scripts/changed-plan.mjs 的 shell 片段（plan_* 变量）
_plan_load() {
  eval "$(node scripts/changed-plan.mjs --sh "$@")"
}

# 相对基线有没有任何改动：**只走 git 内建**（不启 node = 不白花 0.3s）。
# Review 第 2 轮 ② 要的就是这条：无改动直接跑全量，别先算一遍 plan。
_has_changes() {
  local base="${DIY_CHECK_BASE:-origin/main}"
  git rev-parse --verify --quiet "$base" >/dev/null || return 0  # 认不出基线 ⇒ 当作有改动（保守）
  local f
  for f in "$@"; do
    [[ "$f" == --base ]] && return 0   # 显式给了基线就别猜（交给 --class 统一定面）
  done
  git diff --quiet "$base"...HEAD -- . || return 0   # 已提交部分（三点 = merge-base 比）
  git diff --quiet -- . || return 0                  # 未暂存
  git diff --quiet --cached -- . || return 0         # 已暂存
  f=$(git ls-files --others --exclude-standard | head -1)
  [[ -n "$f" ]] && return 0                          # 未跟踪
  return 1
}

# 增量检查：先问「这轮跑多大面」（`--class`，只看路径、毫秒级），再按面跑
_check_changed() {
  ensure-sync
  if ! _has_changes "$@"; then
    echo "${info}相对基线没有任何改动 → 直接全量（判据：--changed ≤ 全量）${reset}"
    _check_full_body
    return $?
  fi
  # 第一步：只花几个 git 调用定面（不做包图 / 护栏计算）——
  # 干净 worktree 里 `check --changed` 曾因「先算 plan 再退回全量」比全量还慢 2s（##452 Review ①）
  local mode
  mode=$(node scripts/changed-plan.mjs --class "$@") || { echo "${error}changed-plan --class 失败${reset}" >&2; return 1; }
  # full / none 都直接走全量本体：
  #   full —— 碰了根级配置 / 脚本，或不含 pkgs.ts/**（无法按包收敛）
  #   none —— 没有任何改动（Review 第 2 轮 ②：无改动不白算，直接跑全量；它本身 ~10s，
  #           但比「按面裁剪 + 一堆空跑」更可信，且 `--changed ≤ 全量` 自然成立）
  # 注意：`_check_full_body` 而不是 `_check_full` —— ensure-sync 上面已经跑过（差 0.5~0.9s）
  if [[ "$mode" == full || "$mode" == none ]]; then
    if [[ "$mode" == full ]]; then
      echo "${warning}↑ 改动碰了根级配置 / 脚本，或根本不含 pkgs.ts/**（无法按包收敛）→ 直接全量${reset}"
    else
      echo "${info}相对基线没有任何改动 → 直接全量（--changed ≤ 全量）${reset}"
    fi
    # 编能力包：各包 exports 指 dist/*.js，类型解析要靠它（#365 前置）
    build-pkgs
    _check_full_body
    return $?
  fi
  # data：纯数据改动（knowledge/ · docs/ · *.md）连 tsc / oxlint 都不用跑（Review ②）
  # none：没有改动 —— 但仍要跑「扫文件系统」的护栏（产物护栏：误 emit 的 .js 常被 .gitignore
  # 吞掉，git 改动集里根本看不见它），故不在这里直接返回
  _plan_load "$@"
  local g skip
  echo "${secondary}改动面：${plan_summary}（面=${mode}）${reset}"
  for skip in "${plan_skip[@]:-}"; do
    [[ -n "$skip" ]] && echo "${secondary}  · 跳过 ${skip}${reset}"
  done

  if [[ "$plan_mode" != data ]]; then
    # 编能力包：tsc 要靠 dist/*.js 的类型（#365 前置）。data 分支不跑 tsc ⇒ 不编
    build-pkgs
    # 类型检查：**全图**（不收窄）。理由实测（##452）：tsc -b 自己有增量（.tsbuildinfo
    # 命中就跳过该 project）—— 改一个包内文件后全图 1.9s、只跑受影响包 1.6~4.6s，没差；
    # 而自己维护「受影响包 + 反向闭包」漏一个依赖方就是漏报。故「只跑该跑的」交给 TS 自己。
    run npx tsc -b tsconfig.all.json --noEmit
    # rpc 浏览器安全用的是非 composite 的独立 config（不写 buildinfo、每次全量 ~2s），
    # 而它只读 diy-rpc ⇒ 只在 diy-rpc 受影响时跑
    if ((plan_browser)); then
      run npx tsc --noEmit -p pkgs.ts/core/rpc/tsconfig.browser.json
    fi
    # lint：逐文件判据，只需受影响包的目录
    if (( ${#plan_lint[@]} > 0 )); then
      run npx oxlint "${plan_lint[@]}"
    fi
  fi
  # 护栏：只跑扫描根与改动集相交的（每条跳过都带 why，上面的 · 行）
  local -a argv=()
  for g in "${plan_guard_cmds[@]:-}"; do
    [[ -n "$g" ]] || continue
    read -r -a argv <<<"$g"
    run "${argv[@]}"
  done
}

# 全量检查（`check` 不带参数 = 这条：CI / 提交前 / 拿不准时用；判据**不得**为提速而缩小）
_check_full() {
  ensure-sync
  _check_full_body
}

# 全量检查的本体（不含 ensure-sync：给已经做过前置检查的调用方复用，避免重复付 0.5~0.9s）
_check_full_body() {
  run npx tsc -b tsconfig.all.json --noEmit
  # `apps/diy-app/` 跳过：diy1 时代的 Electron 应用，**只作参考保留、不再启动**（2026-11-27 用户裁）。
  # 它那 297 条 warning 是历史死代码，不清；格式化也一并跳过（见 .prettierignore）。
  run npx oxlint pkgs.ts/ apps/ --ignore-pattern 'apps/diy-app/**'
  run npx tsc --noEmit -p pkgs.ts/core/rpc/tsconfig.browser.json
  # 产物护栏：TS 包源码目录旁不得出现编译产物（实现见 scripts/check-no-emit.sh）
  run bash scripts/check-no-emit.sh
  # dist 保鲜护栏（2026-11-26 事故）：运行时读 dist 的包，dist 不许比 src 旧 ——
  # 否则本地跑的是旧产物，而 check / dev 都看不出来（`@diy-agent/tools` 的 dist 停在 11-24，
  # 少了 await 让每次多步工具轮都被网关 400）。实现与判据见 scripts/check-dist-fresh.mjs
  run node scripts/check-dist-fresh.mjs
  # 可执行位护栏：shell 脚本在 git 索引里必须 100755（Windows 提交会静默丢位，实现见 scripts/check-exec-bit.sh，详见 ##304(Windows 提交丢可执行位)）
  run bash scripts/check-exec-bit.sh
  # 本机 git 状态（##534）：hooksPath 是否还有效（坏路径会让钩子**静默**全部失效）+ local main
  # vs origin/main 漂移。**只告警不失败** —— 实现见 scripts/check-git-state.sh
  run bash scripts/check-git-state.sh
  # 原子写护栏：src/main 下整文件覆盖写必须走 core/atomic-write.ts 的 writeFileAtomic（实现见 scripts/check-atomic-write.sh，详见 ##383(整文件覆盖写加固)）
  run bash scripts/check-atomic-write.sh
  # vi.mock 禁令护栏（##402）：test-unit 跑 `--no-isolate`，vi.mock 改全局模块表会**静默失效**
  #（实现见 scripts/check-no-vi-mock.sh；替代写法 = 注入 / 手写假对象 / server.deps.inline alias）
  run bash scripts/check-no-vi-mock.sh
  # 异常码护栏（##394）：新增 `throw new` 必须带 code（<域>/<kebab-case>）；存量按 LEGACY_THROW_BASELINE 比例递减
  #（实现见 scripts/check-error-code.sh，判据见 rule.err-triage；**别改成整文件豁免** —— 那会让新代码永远不被拦）
  run bash scripts/check-error-code.sh
  # 包可见性白名单：对外发布只有 @diy-agent/rpc 与 @diy-agent/ui（不许 private），其余必须 private；
  # 且对外包不许依赖 @diy-agent/* 内部包（否则使用时 registry 找不到）。实现见 scripts/check-pkg-visibility.mjs
  run node scripts/check-pkg-visibility.mjs
  # runtime 依赖闭包（##455 #5）：runtime/node_modules 里每个包 dependencies 的 @diy-agent/* 必须也在其中；
  # 缺失 = 运行时才炸（WORKSPACE_TS_DEPS 那类事故）。runtime/ 未生成时自动跳过。
  # 实现见 scripts/check-runtime-closure.mjs
  run node scripts/check-runtime-closure.mjs
  # 迁移指纹表（Flyway 式 checksum）：改了迁移文件却没重新生成 → 运行时「文件被改过」就查不出来。
  # 生成：node scripts/gen-migration-checksums.mjs
  run node scripts/check-migration-checksums.mjs
  # 产物态迁移闸门 e2e（2026-11-27 事故：源码态全绿、产物态 spawn 不了 migrate-worker）：
  # 用 build/prod 起真服务，验「老库拦 / 迁完直进 / 真缺才拦」。产物没构建时自己跳过。
  run node scripts/check-migration-gate.mjs
  # 同步 IO 护栏（##408 刀 16）：主进程 / shared / preload 里新增 `*Sync` 的磁盘或子进程调用一律 ✗
  #（实现见 scripts/check-sync-io.sh；用户口径「app 不允许有 sync 的 io 操作」；存量按
  # LEGACY_SYNC_IO_BASELINE 棘轮递减，逃生口 `// sync-io-ok: <理由>`）
  run bash scripts/check-sync-io.sh
  # OS 边界护栏（2026-10-31）：系统假设（process.platform / wmic / taskkill / powershell /
  # osascript / /bin/bash …）只许出现在 apps/diy-app/src/main/os/**；实现见 scripts/check-os-boundary.mjs
  run node scripts/check-os-boundary.mjs
  # renderer 图里不许出现 node/electron（2026-11-04 黑屏事故：barrel 带出 node:child_process）；
  # 实现见 scripts/check-renderer-boundary.mjs。tsc/oxlint/check-os-boundary 都抓不到
  # 「经由哪个包拉进来的」，只有遍历 import 图才行。
  run node scripts/check-renderer-boundary.mjs
  # 构建配置漂移护栏（2026-10-31）：各包 tsconfig.build.json 的 composite/references 与
  # tsconfig.build-all.json 都是**生成物**（node scripts/gen-tsconfig-build-all.mjs）——手改就报。
  # 文件**不存在**时先生成、不判漂移：它落在 build/ 里，而 clean / 全新 worktree 都没有 build/ ——
  # 2026-11-23 实测，干净 worktree 上 `./sha.sh clean && ./sha.sh check` 必红，人第一反应是去
  # 重跑 gen（提示说的就是那句），跑了才发现「本来就没有，不是被人改坏」。
  if [[ -f build/tsconfig.build-all.json ]]; then
    run node scripts/gen-tsconfig-build-all.mjs --check
  else
    echo "${secondary}build/tsconfig.build-all.json 不存在（clean 后 / 新 worktree）→ 先生成再比${reset}"
    run node scripts/gen-tsconfig-build-all.mjs
  fi
  # 各领域规范索引护栏（##388）：~/SPECS.md 的 key 唯一 / 指针可解析 / 链上新增未收录（ratchet：存量基线 scripts/specs-unindexed.txt）
  #（实现见 scripts/check-specs.mts；**总表缺失 = skip + 提示、不算失败**，跨机器 / CI 没有家目录那份文件）
  run npx tsx scripts/check-specs.mts
}
# 全仓唯一自动修复入口：格式化 + lint 可修项，能修的全修
sha.def "fix" \
  --desc "格式化 + lint 自动修（oxfmt / oxlint --fix）"

fix() {
  # oxfmt 自己会读 .prettierignore（里面排掉了 apps/diy-app/，理由见那个文件）
  run npx oxfmt --write pkgs.ts/ apps/
  run npx oxlint --fix pkgs.ts/ apps/ --ignore-pattern 'apps/diy-app/**'
}
# 全部测试：各包 test 子命令（diy-app 含意图测试，起隔离 Electron，最慢放最后）
#
# ##452：`test --related <改动文件…>` 只跑**导入链上受影响的测试**（静态 import 图反查）
#   ./sha.sh test --related pkgs.ts/x/src/a.ts   # 给文件
#   ./sha.sh test --related                      # 不给 = 用当前 git 改动集（判据同 check --changed）
#   ./sha.sh test --related --dry-run            # 只列选中哪些，不跑（排查「怎么没选我这条」）
# 判据在 scripts/related-tests.mjs（头注：为什么不用 vitest related —— 它要跑全套模块图，
# 实测 diy-app 上 92s ≈ 全量，等于没省）。
# 直接跑各 workspace 的 vitest（**不经** `<ws>/sha.sh`）——
#
# 为什么（2026-10-31 实测本机）：`_ws_run command ./sha.sh test-unit` 每个包都要起一个 bash 并
# `source` 整个 sha 引擎（vendor/sha 很大）：**~1.0s/包** × 24 个包 = 24s 纯启动，而 vitest 自己
# 启动只要 ~0.4s。语义不变：仍然**每包一个独立进程**（一个包红了不影响其余、也不会把别人拖崩），
# 只是去掉中间那一层脚本。
#
# 唯一例外：diy-app 有专属目标（unit / os / intent 三套，各自的排除与 Electron 准备都在它自己
# 的 sha.sh 里）——仍调它自己的 `./sha.sh test`，不在这里重复一份 flag（重复 = 必然漂移）。
# 逐包结果汇总：**默认跑完再报**（2026-10-31）——
# 以前遇红即停（`set -e` 一刀切），实测把 **14 个从没跑过的包 + 22 条红**一起藏掉：
# 人只看到「第一个红的包」，会以为那就是全部。现在默认继续跑、末尾列失败清单，
# 有失败就非零退出；要旧行为传 `--fail-fast`。
_ws_report() {
    if [[ $# -eq 0 ]]; then
        echo "${info}✓ 所有 workspace 测试通过${reset}"
        return 0
    fi
    echo "${error}✗ ${#} 个 workspace 有失败（清单如下；--fail-fast 可改回遇红即停）：${reset}" >&2
    local ws
    for ws in "$@"; do echo "  ${error}·${reset} $ws" >&2; done
    return 1
}

# $1 = fail_fast（1 = 遇到第一个红就收工）
_ws_vitest() {
    local fail_fast="${1:-0}" ws rc=0
    local failed=()
    for ws in "${_workspaces[@]}"; do
        [[ -f "$ws/vitest.config.ts" ]] || continue
        # 有 config 不等于有测试（diy-compact / diy-context / workbench-plugin …）：vitest 在
        # 「一个测试文件都没找到」时退出码 1，会让整串跑不动 —— 直接跳过（旧路径
        # `<ws>/sha.sh test-unit` 也是直接退 1，只是那时被包一层看着像“跑过了”）。
        [[ -d "$ws/tests" ]] || continue
        case "$ws" in apps/diy-app/) continue ;; esac
        echo "${inverse_surface}info: workspace: test '$ws'${reset}"
        if run node_modules/.bin/vitest run --root "$ws"; then
            :
        else
            failed+=("$ws")
            if [[ "$fail_fast" == "1" ]]; then
                _ws_report "${failed[@]}" || rc=1
                return "$rc"
            fi
        fi
    done
    _ws_report "${failed[@]}" || return 1
    return 0
}

# 2026-11-05：手写 for 循环 → sha.def + sha.parse（同 check 的改动）。
# `--related` 后面跟的是**文件路径**（可以有多个），所以声明成变长位置参数。
sha.def "test" \
  --opt "--fail-fast:bool:第一个包失败就停（不再跑后面的）" \
  --opt "--related:bool:只跑与改动相关的测试（后面跟文件路径）" \
  --arg "FILES...:配合 --related：改动过的文件（缺省 = 按 git 改动推）" \
  --desc "跑测试：缺省 = 全仓（pkgs.ts + apps，最后跑 diy-app 的意图测试）"

test() {
  local fail_fast related
  local -a FILES=()
  sha.parse "$@" || return $?
  if [[ "$related" == "1" ]]; then
    _test_related "${FILES[@]:-}"
    return $?
  fi
  ensure-sync
  local rc=0
  local ff=0; [[ "$fail_fast" == "1" ]] && ff=1
  _ws_vitest "$ff" || rc=1
  # diy-app 最后跑 —— 它自己的 `test` = unit + os。
  # **UI 意图测试（tests/cli.intent.*）2026-11-06 起默认停跑**（##518）：单文件 80~140s、全量 1h+，
  # 慢因是每条断言新起一个 `./diy.sh`（0.68s）而不是用例深度。要跑须显式：
  #   DIY_INTENT_ENABLE=1 ./sha.sh test-intent <片段>
  # 所以这行只花 unit + os 的时间（实测 ~30s + ~10s），不会把整串拖成一小时。
  if ( cd apps/diy-app && ./sha.sh test ); then :; else
      rc=1
      echo "${error}✗ apps/diy-app 有失败${reset}" >&2
      [[ "$ff" == "1" ]] && return 1
  fi
  return "$rc"
}

_test_related() {
  ensure-sync
  local has_files=0
  local a
  for a in "$@"; do
    case "$a" in --*) ;; *) has_files=1 ;; esac
  done
  if ((has_files)); then
    run node scripts/related-tests.mjs --files "$@"
  else
    run node scripts/related-tests.mjs "$@"
  fi
}

# 编程中快速验证：各包单测，不构建、不起 Electron
# 默认**跑完再汇总**（`--fail-fast` 改回遇红即停）
test-unit() {
  local fail_fast=0
  local a
  for a in "$@"; do [[ "$a" == "--fail-fast" ]] && fail_fast=1; done
  ensure-sync
  local rc=0
  _ws_vitest "$fail_fast" || rc=1
  if ( cd apps/diy-app && ./sha.sh test-unit ); then :; else
      rc=1
      echo "${error}✗ apps/diy-app 有失败${reset}" >&2
  fi
  return "$rc"
}

_vendors_run() {
  for v in "${_vendors[@]}"; do
    (
      cd "$v"
      run "$@"
    )
  done
}

# vendor/* 是 **git subtree**（2026-11-28 从 submodule 改来，##44）：内容是本仓历史的一部分，
# 没有独立的 .git、没有指针要更新 —— 新 worktree checkout 完就躺在盘上，**不需要联网**。
#   升级上游：./sha.sh vendor pull   （git subtree pull --squash；只在想升级时跑，需要网络）
#   改 vendor 代码：直接改 → 当普通文件提交（想回推上游才用 git subtree push）
# 为什么换：submodule 每次新 worktree 都要 `submodule update --init` 走一遍网络，弱网下
# 挂几十秒到失败，而内容其实本可以随 checkout 一起下来。
vendor.exec()   { _vendors_run command "$@"; }
vendor.status() { _vendors_run git status; }
# 注册在文件下方的命令区（`vendor.pull`），这里只放实现。
vendor.pull() {
  run git subtree pull --prefix=vendor/sha git@github.com:diy-agent/sha.git main --squash
}

####################################################
# Python 包发布
####################################################
# 编各能力包的 dist/（Node 可直接 import 的 ESM + .d.ts，##453；产物一律落临时目录）。
# 名单与顺序都由 scripts/build-order.mjs 算：入选 = pkgs.ts/* 里 main 指 ./dist/ 的包；
# 顺序 = 内部 @diy/* · @diy-agent/* 依赖的拓扑序（各包 tsc 要靠被依赖包的 dist/*.d.ts 做类型
# 解析，故不能乱序、也不能并行）。
# 为什么不再手写数组：这里原先是一行 `_pkg_order=(...)`，**两次漏登记新包**（#465
# model-catalog、#469 bot）。漏登记的报错长在别处 —— build-runtime 撞见缺 dist/index.js 就喊
# 「先跑根 ./sha.sh build」，正是刚失败的那条命令，人被引去原地重跑。
# 能力包构建：**一次 `tsc -b` 编全部**（单进程 + 增量 + 依赖 DAG）。
#
# 为什么改（2026-10-31 实测本机）：原先是 bash 循环、每包一个 `bash sha.sh build`（内含 `npx tsc`）——
# 每包光进程启动就 ~1.9s（bash + sha 引擎 1.0s、node + npx + tsc 0.9s），25 个包 ≈ 60s，
# 真正在编译的不到三分之一。改成单进程后：冷 ~4s / 热 ~0.4s，改一个包只重编它与**依赖它的**。
# 顺序与 references 由 `scripts/gen-tsconfig-build-all.mjs` 生成（幂等；手改漂移由 check 拦）。
sha.def "build-pkgs" \
  --desc "只编能力包（pkgs.ts/*）的 dist/ —— 改包后单独跑它最快"

#: vendor/sha（git subtree）升级：把上游拉到当前
#: 用法: ./sha.sh vendor pull
#: 只在想升级框架时跑（需要网络）；新 worktree 建出来就有内容，不跑这个。
sha.def "vendor.pull" --desc "把 vendor/sha 上游拉到当前（git subtree --squash，需要网络）"

build-pkgs() {
    run node scripts/gen-tsconfig-build-all.mjs
    run npx tsc -b build/tsconfig.build-all.json
    # tsc 之后的**额外**步骤（生成发行形态 package.json）：只有这几个包有，仍由各包自己拥有。
    # 为什么不跟 tsc 一起批：它们是 npm 发行物的事（scripts/npm-publish.mjs），不是编译。
    # 为什么从仓根直接 node、不平进包目录再 `./sha.sh build-artifact`：后者每包多一个
    # bash + sha 引擎（~1s），三个包就是 3s —— 实测占了热构建的一半（2026-10-31）。
    local _p
    for _p in pkgs.ts/core/rpc pkgs.ts/ui/core pkgs.ts/ui/workbench-plugin pkgs.ts/core/dev-paths; do
        run node scripts/npm-publish.mjs "$_p" --prepare-only --out=dist
    done
    # 模型规格快照也住在 dist/ 里：tsc 只写 .js/.d.ts，不会生成它。
    # 缺了就是「编译成功、目录空着」这种最难查的状态，所以这里补一道（一天内自动跳过）。
    gen-models
    # profile（apps/*）**不进** build-pkgs：它们是产物入口不是能力包，按需各自 ./sha.sh build
}

sha.def "dist-fresh" \
  --opt "--build:bool:发现不新就先 build-pkgs（增量）再复查" \
  --desc "查 dist 是否新于源码（运行时读 dist；dev 与 check 都靠它）"

# 为什么要这个命令：dev / check 都只看 src 的类型，而 30+ 个包**运行时读 dist** ——
# 合了别人的改动却没 build 时，本地跑的是旧产物，且没有任何提示（2026-11-26 实测事故）。
# `--build` 是 dev 用的姿势（发现不新就补一次，热路径 ~0.4s）；check 用裸跑 = 只拦不修。
dist-fresh() {
  local build
  sha.parse "$@" || return $?
  if node scripts/check-dist-fresh.mjs; then return 0; fi
  if (( build )); then
    echo "── dist 不新，先重建能力包（增量）"
    build-pkgs
    return
  fi
  return 1
}

sha.def "build" \
  --desc "全量构建：能力包 dist/ → 各 profile（apps/*）"

build() {
    ensure-sync
    # ① 先编能力包的 dist/。为什么必须先编：各包 package.json 的 main/exports 已指 dist/*.js，
    #    类型检查（tsc -b）与 diy-app 打包 resolve 它们时都命中 dist/ ⇒ 缺 dist 就红一片
    #    （这正是「开发也读产物目录」的代价，见 ##453 方案 B）。
    build-pkgs
    # ② 再构建各 profile（apps/*）的产物。
    #    判据：apps/<名>/sha.sh 里**声明了 build()**（= 有产物要建）。
    #    为什么不显式列：手写清单会漏登记 —— build-order.mjs 的由来正是 `_pkg_order`
    #    数组两次漏登记新包（#465 model-catalog、#469 bot）；apps 侧 2026-11-22 又重演一次：
    #    根 build 只建 diy-app、漏了 apps/diy2 ⇒ 改完 pkgs 后 `./sha.sh build && diy2 --restart`
    #    跑的还是旧 bundle（时间戳停在改动之前），rebuild 后才发现。故改成机器发现。
    _build_apps
}

# ── 发布打包（dist）───────────────────────────────────────────────────────────
#
# 为什么需要一个**根** dist：发布物不止「编译一下」——
#   ① 生成物（假日表 / 主题 CSS …）必须先重算，否则打进去的是旧数据；
#   ② 能力包 dist 必须先编（apps 的 build 读 pkgs 的 dist）；
#   ③ 各 app 的打包姿势不同（diy-app 是 electron-builder，diy2 是 build/prod）。
# 这些步骤靠人记一定会漏；机器发现（哪个 workspace 声明了 gen() / dist() 就跑哪个）不会。
#
# 用法：./sha.sh dist [--app <name>] [--skip-gen] [-- <app dist 参数>]
#   --app     只打某个 app（缺省：所有声明了 dist() 或 build() 的 apps）
#   --skip-gen 跳过 gen（离线 / 已确认生成物新鲜时用）
#   -- 之后原样透传给 app 的 dist（例如 electron-builder 的 --mac --dir）
sha.def "dist" \
  --opt "--app:string:只打某个 app（缺省全部）" \
  --opt "--skip-gen:bool:跳过生成物重算（离线）" \
  --desc "发布打包：重算生成物（gen）→ 能力包 dist → 各 app 的打包产物"

# 所有声明了 gen() 的 workspace 都重算一遍（顺序 = _workspaces 的顺序）
_run_gens() {
    local ws
    for ws in "${_workspaces[@]}"; do
        [[ -f "${ws}sha.sh" ]] || continue
        grep -qE '^gen\(\)' "${ws}sha.sh" || continue
        echo "${info}gen（发布前重算生成物）：${ws}${reset}"
        run "${ws}sha.sh" gen
    done
}

# 各 app 的打包：有 dist() 用 dist()，否则至少 build()（没有可选）
_dist_apps() {
    local only="$1"
    shift
    local a name
    for a in apps/*/; do
        [[ -f "${a}sha.sh" ]] || continue
        name="$(basename "$a")"
        [[ -z "$only" || "$only" == "$name" ]] || continue
        if grep -qE '^dist\(\)' "${a}sha.sh"; then
            echo "${info}dist：${name}${reset}"
            run "${a}sha.sh" dist "$@"
        elif grep -qE '^build\(\)' "${a}sha.sh"; then
            echo "${info}dist：${name}（无 dist()，只 build）${reset}"
            run "${a}sha.sh" build
        fi
    done
}

dist() {
    local app="" skip_gen=0
    local -a rest=()
    while (($#)); do
        case "$1" in
            --app)
                [[ -n "${2:-}" ]] || { echo "${error}用法：./sha.sh dist --app <name>${reset}" >&2; return 2; }
                app="$2"
                shift 2
                ;;
            --app=*) app="${1#--app=}"; shift ;;
            --skip-gen) skip_gen=1; shift ;;
            --) shift; rest+=("$@"); break ;;
            *) rest+=("$1"); shift ;;
        esac
    done

    ensure-sync
    if (( !skip_gen )); then
        _run_gens
        echo "${info}gen 完成：若生成物有更新，发布前记得一起提交（git status）${reset}"
    else
        echo "${warning}跳过 gen（--skip-gen）${reset}"
    fi
    # ① 能力包先编：apps 的 build 会读 pkgs 的 dist/
    build-pkgs
    # ② 各 app：dist() 自带 build；没有 dist() 的只 build
    _dist_apps "$app" "${rest[@]}"

    echo "${info}发布打包完成${reset}"
    [[ -d apps/diy-app/release ]] && run ls -lh apps/diy-app/release
}

# profile 构建：只挑 apps/* 里声明了 build() 的（= 有产物要建）。
# apps/chat|minimal|web 是历史残留（git 无跟踪、无 package.json / sha.sh），自然跳过。
_build_apps() {
    # 各 app 的 build **并行**：两个 app 都是各自独立的 vite 打包（互不读对方产物），
    # 串着跑 = 白白相加。实测热态：diy-app ~12s + diy2 ~12s，串行 24s → 并行 ~13s。
    # 输出会交错，但每行都带 app 路径前缀（run 打印的命令），出错时看 `✗` 行定位。
    local a p rc=0
    local -a pids=()
    for a in apps/*/; do
        [[ -f "${a}sha.sh" ]] || continue
        grep -qE '^build\(\)' "${a}sha.sh" || continue
        ( run "${a}sha.sh" build ) &
        pids+=("$!")
    done
    for p in "${pids[@]:-}"; do
        [[ -n "$p" ]] || continue
        wait "$p" || rc=1
    done
    return "$rc"
}

ci() {
    clean
    test
    build
    # test: 验证构建产物
    echo "${info}构建产物:${reset}"
    run ls -lh ./dist/
}

# 发布到 npm（@diy-agent scope）。清单**只在一处**（scripts/publish-targets.mjs）：
# 发版工具 release.mjs 也要用它挑 bump 对象，两份必漂。
# 为什么不用 _ws_run：只有做过 npm 分发准备的包才有 publish 子命令，其余包会「未知命令」中止。

# 发版工具（##522）：bump 版本 + 同步仓内引用 + 看谁还没发。改文件不提交，发布仍走 publish。
sha.def "release" --desc "发版工具：status | bump patch|minor|major [--only a,b] [--set 包=版本] [--dry-run] | self-test"
release() { run node scripts/release.mjs "$@"; }

publish() {
  # 清单懒加载（每个子命令都起一个 node 进程不值）：只在真发布时才读。
  local -a _npm_publish_pkgs
  readarray -t _npm_publish_pkgs < <(node scripts/publish-targets.mjs)
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

# lab：HMR 开发实例（人看效果 / agent 实验都用它），数据根 run/diy-app/lab，与 test/staging 隔离。
# lab [--app <name>]：缺省起 diy-app；其它 app 走 apps/<name>/sha.sh lab
lab()     {
    local app_name="diy-app"
    while (($#)); do
        case "$1" in
            --app) [[ -n "${2:-}" ]] || { echo "${error}用法：./sha.sh lab --app <name>（可用：diy-app $(_apps_list)）${reset}" >&2; exit 2; }
                   app_name="$2"; shift 2 ;;
            --app=*) app_name="${1#--app=}"; shift ;;
            *) break ;;
        esac
    done
    ensure-sync
    if [[ "$app_name" == "diy-app" ]]; then
        apps/diy-app/sha.sh lab "$@"
        exit $?
    fi
    if [[ -x "apps/$app_name/sha.sh" ]]; then
        "apps/$app_name/sha.sh" lab "$@"
        exit $?
    fi
    echo "${error}✗ 没有这个 app：${app_name}（可用：diy-app $(_apps_list)）${reset}" >&2
    exit 2
}
# apps/ 下可起的 app 名（给 --app 的报错与提示用）
_apps_list() { for d in apps/*/; do [[ -f "$d/sha.sh" ]] && basename "$d"; done | tr '\n' ' '; }
# preview：编译后运行（无 watch）的稳定实例 —— 长会话 / 人要持续对话时用它，改码不打断。
preview() {  ensure-sync; DIY_VARIANT=preview apps/diy-app/sha.sh preview "$@"; }


####################################################
# app entry script & _root cmd
####################################################

# preview（2026-10-23 恢复，##404）：编译后运行的稳定实例，无 watch。见 diy-app/sha.sh::preview。

sha "$@"
