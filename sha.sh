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
# ##512 另有一类：旧布局的包目录留下 lib/（含 npm-publish 生成的 package.json），
# 例如 pkgs.ts/diy-rpc/lib/package.json —— 既会被当成 workspace 跑 sha.sh（不存在 → exit 127），
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
    # `--include-workspace-root` 不能省：`npm i --workspaces` 把安装范围限定在 workspace，
    # **漏装只在根 package.json 声明的依赖**（remark-gfm / playwright-core 等）—— 干净
    # worktree 上 100% 复现，症状是 renderer build 报 `Failed to resolve import "remark-gfm"`。
    # 详见 ##255。
    run npm i --workspaces --include-workspace-root
    # npm i 只补缺失、**不清改名残留**（实测留着旧的 `node_modules/@diy-agent/rpc`）——
    # 残留会让包级构建护栏继续报「未同步」，故精准清一道（只删 lock 不认可的 workspace 软链接）
    run node scripts/check-sync.mjs --fix
    run git submodule update --init --recursive

    _ws_run command ./sha.sh sync;

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

# mono所有workspaced的sync（= 依赖 + dev 数据根配置投影）
#
# ##452：**幂等短路**。原先每调一次就是 `npm i --workspaces` + 子模块 + electron 检查 +
# 各包 sync + 真配置投影 ≈ 45s，而 agent 每轮验前都会 sync 一次 —— 其中 99% 的调用
# 什么都没变。现在先做一个毫秒级判断（`_sync_uptodate`）：
#   stamp 存在 且 比 lock / 根与各包 package.json 都新 且 workspace 软链齐全 且子模块已 init
# ⇒ 直接返回（实测 ~30ms），不碰 node_modules 一下。
# 判据故意**只用 mtime 与 exists**（不重算哈希）：宁可误判「不新鲜」走全量，
# 也不许误判「新鲜」跳过真正的变更 —— 内容哈希那份权威判断在 check-sync.mjs 里，
# 全量路径仍会跑它；`--force` 强制无条件全量。
sha.def "sync" \
  --desc "依赖同步：npm i + workspace 链接 + 配置同步到 lab 数据根"

sync()  {
    case "${1:-}" in
        --force|-f) ;;
        "")        if _sync_uptodate; then
                       echo "${info}依赖未变（stamp 命中、workspace 链接齐全）→ 跳过 npm i${reset}"
                       sync-dev-home
                       return 0
                   fi ;;
        *) echo "${error}用法：./sha.sh sync [--force]${reset}" >&2; return 2 ;;
    esac

    sync-deps

    # 本 worktree 的变体数据根缺「真配置」（真账号 / 投递划分 / 真人物），
    # 补齐它 —— 见下条 sync-dev-home
    sync-dev-home
}

# sync 的幂等快判：**只读、不写任何东西**，ms 级（sync 自己不能挂 ensure-sync，故这里自判）
_sync_uptodate() {
    local stamp="node_modules/.diy-sync.stamp"
    [[ -f "$stamp" ]] || return 1
    local f ws
    for f in package.json package-lock.json; do
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
    # 子模块已 init：看每个 submodule 目录下的 `.git`（init 过的子模块是个 gitfile）
    # 不用 `git submodule status`：实测 0.59s，光它就吃掉了整个预算
    if [[ -f .gitmodules ]]; then
        local sub
        while IFS= read -r sub; do
            [[ -e "$sub/.git" ]] || return 1
        done < <(sed -n 's/^[[:space:]]*path[[:space:]]*=[[:space:]]*//p' .gitmodules)
    fi
    return 0
}

# ── 同步闸门：入口前置「没 sync 就先 sync」 ────────────────────────────────────
# 判据 = scripts/check-sync.mjs（只读快检、毫秒级）：workspace 链接缺失/过期（如包改名后
# 残留的 `node_modules/@diy-agent/rpc`）、sync 印记落后、submodule 未 init；electron 二进制的
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
    # 编能力包：各包 exports 指 lib/*.js，类型解析要靠它（#365 前置）
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
    # 编能力包：tsc 要靠 lib/*.js 的类型（#365 前置）。data 分支不跑 tsc ⇒ 不编
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
  run npx oxlint pkgs.ts/ apps/
  run npx tsc --noEmit -p pkgs.ts/core/rpc/tsconfig.browser.json
  # 产物护栏：TS 包源码目录旁不得出现编译产物（实现见 scripts/check-no-emit.sh）
  run bash scripts/check-no-emit.sh
  # 生成物过期护栏（2026-11-06）：`src/gen/*.generated.d.ts` 是 `src/api.ts` 的**派生**。
  # apiDef 改了忘跑生成器 ⇒ 留下「看着有类型、实际是旧的」文件，比没有类型更危险。
  # 实现：重新生成到内存与磁盘 diff，不为空即 exit 1（见 pkgs.ts/core/rpc/scripts/gen-service-types.ts）
  run node_modules/.bin/tsx pkgs.ts/core/rpc/scripts/gen-service-types.ts --check
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
  # 且对外包不许依赖 @diy-agent/* 内部包（否则使用时 registry 找不到）。实现见 scripts/check-pkg-visibility.mjs
  run node scripts/check-pkg-visibility.mjs
  # runtime 依赖闭包（##455 #5）：runtime/node_modules 里每个包 dependencies 的 @diy-agent/* 必须也在其中；
  # 缺失 = 运行时才炸（WORKSPACE_TS_DEPS 那类事故）。runtime/ 未生成时自动跳过。
  # 实现见 scripts/check-runtime-closure.mjs
  run node scripts/check-runtime-closure.mjs
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
  # tsconfig.build-all.json 都是**生成物**（node scripts/gen-tsconfig-build-all.mjs）——手改就报
  run node scripts/gen-tsconfig-build-all.mjs --check
  # 各领域规范索引护栏（##388）：~/SPECS.md 的 key 唯一 / 指针可解析 / 链上新增未收录（ratchet：存量基线 scripts/specs-unindexed.txt）
  #（实现见 scripts/check-specs.mts；**总表缺失 = skip + 提示、不算失败**，跨机器 / CI 没有家目录那份文件）
  run npx tsx scripts/check-specs.mts
  # 事实库真源护栏（##404）：schema / claim 冲突 / 边悬空 / subject 词表 / 证据可解析（掉文件即 error）
  #（实现见 scripts/facts-index.mts；真源 knowledge/facts/*.yaml，内核 pkgs.ts/core/facts）
  run npx tsx scripts/facts-index.mts
}
# 全仓唯一自动修复入口：格式化 + lint 可修项，能修的全修
sha.def "fix" \
  --desc "格式化 + lint 自动修（oxfmt / oxlint --fix）"

fix() {
  run npx oxfmt --write pkgs.ts/ apps/
  run npx oxlint --fix pkgs.ts/ apps/
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
  # diy-app 最后跑（含意图测试，起隔离 Electron，最慢）——它自己的 `test` = unit + os + intent
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
vendor.exec()    { _vendors_run command "$@"; }
vendor.status()  { _vendors_run git status; }
vendor.update() {  run git submodule update --init --recursive --remote --merge; }

####################################################
# Python 包发布
####################################################
# 编各能力包的 lib/（Node 可直接 import 的 ESM + .d.ts，##453）。
# 名单与顺序都由 scripts/build-order.mjs 算：入选 = pkgs.ts/* 里 main 指 ./lib/ 的包；
# 顺序 = 内部 @diy/* · @diy-agent/* 依赖的拓扑序（各包 tsc 要靠被依赖包的 lib/*.d.ts 做类型
# 解析，故不能乱序、也不能并行）。
# 为什么不再手写数组：这里原先是一行 `_pkg_order=(...)`，**两次漏登记新包**（#465
# model-catalog、#469 bot）。漏登记的报错长在别处 —— build-runtime 撞见缺 lib/index.js 就喊
# 「先跑根 ./sha.sh build」，正是刚失败的那条命令，人被引去原地重跑。
# 能力包构建：**一次 `tsc -b` 编全部**（单进程 + 增量 + 依赖 DAG）。
#
# 为什么改（2026-10-31 实测本机）：原先是 bash 循环、每包一个 `bash sha.sh build`（内含 `npx tsc`）——
# 每包光进程启动就 ~1.9s（bash + sha 引擎 1.0s、node + npx + tsc 0.9s），25 个包 ≈ 60s，
# 真正在编译的不到三分之一。改成单进程后：冷 ~4s / 热 ~0.4s，改一个包只重编它与**依赖它的**。
# 顺序与 references 由 `scripts/gen-tsconfig-build-all.mjs` 生成（幂等；手改漂移由 check 拦）。
sha.def "build-pkgs" \
  --desc "只编能力包（pkgs.ts/*）的 lib/ —— 改包后单独跑它最快"

#: 子模块同步：把 vendor/（sha 脚本框架等）对齐到仓库记录的提交
#: 用法: ./sha.sh submodule update [--remote]
#: 缺省只对到「当前记录」的提交；--remote 跟到该 submodule 的上游分支最新。
sha.def "submodule.update" --opt "--remote:bool:跟到上游分支最新" --desc "更新子模块"
submodule.update() {
  local remote
  sha.parse "$@" || return $?
  case "${remote:-}" in
    1 | true | yes) run git submodule update --init --recursive --remote ;;
    *) run git submodule update --init --recursive ;;
  esac
  run git submodule status
}

build-pkgs() {
    run node scripts/gen-tsconfig-build-all.mjs
    run npx tsc -b build/tsconfig.build-all.json
    # tsc 之后的**额外**步骤（生成发行形态 package.json）：只有这几个包有，仍由各包自己拥有。
    # 为什么不跟 tsc 一起批：它们是 npm 发行物的事（scripts/npm-publish.mjs），不是编译。
    # 为什么从仓根直接 node、不平进包目录再 `./sha.sh build-artifact`：后者每包多一个
    # bash + sha 引擎（~1s），三个包就是 3s —— 实测占了热构建的一半（2026-10-31）。
    local _p
    for _p in pkgs.ts/core/rpc pkgs.ts/ui/core pkgs.ts/ui/workbench-plugin pkgs.ts/core/dev-paths; do
        run node scripts/npm-publish.mjs "$_p" --prepare-only --out=lib
    done
    # profile（apps/*）**不进** build-pkgs：它们是产物入口不是能力包，按需各自 ./sha.sh build
}

sha.def "build" \
  --desc "全量构建：能力包 lib/ → apps"

build() {
    ensure-sync
    # ① 先编能力包的 lib/。为什么必须先编：各包 package.json 的 main/exports 已指 lib/*.js，
    #    类型检查（tsc -b）与 diy-app 打包 resolve 它们时都命中 lib/ ⇒ 缺 lib 就红一片
    #    （这正是「开发也读 lib」的代价，见 ##453 方案 B）。
    build-pkgs
    # ② 再构建 diy-app（含 cli 产物），细节见 apps/diy-app/sha.sh build
    run ./apps/diy-app/sha.sh build
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
_npm_publish_pkgs=(
  pkgs.ts/core/rpc pkgs.ts/ui/core pkgs.ts/agent/session pkgs.ts/agent/store-jsonl
  pkgs.ts/ui/workbench pkgs.ts/ui/workbench-ui pkgs.ts/model/catalog pkgs.ts/ui/model-config
  pkgs.ts/model/provider pkgs.ts/agent/bot pkgs.ts/ui/chat-page pkgs.ts/ui/workbench-plugin apps/chat
  pkgs.ts/core/dev-paths
)

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
# lab [--app <name>]：缺省起 diy-app（行为不变）；`--app minimal` 起 apps/minimal（##458）
#   ./sha.sh lab                  → apps/diy-app/sha.sh lab
#   ./sha.sh lab --app minimal    → apps/minimal/sha.sh lab（lab 变体下拉 CDP 9222）
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
