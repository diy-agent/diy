#!/usr/bin/env bash
# migrate-diy2-home.sh —— 把 diy2 的数据根从 `~/.diy/diy2` 迁到 `~/.diy2`（2026-11-26 裁）
#
# 为什么要在**实例外**跑：它第一步就停实例（含正在跑的生产 5192）。在实例里跑 = 自己停自己，
# 跑一半的连接全断（bot 的对话也断），后续步骤没人继续。
#
# 为什么是「先构建、再搬」：顺序反过来旧产物会去旧路径找不到库，直接建一个空库；
# 而构建（tsc / vite）不能与运行中的 lab 抢同一 outDir（见 rule/dev#dev-concurrent），
# 所以构建必须排在「实例全停」之后、「搬数据」之前。
#
# 搬家清单（整目录，同盘 rename 瞬时）：
#   ~/.diy/diy2            → ~/.diy2                 （diy2.db / tasks / rooms / log / toolout / 配置）
#   ~/.diy/knowledge       → ~/.diy2/knowledge        （设备级知识库，真源仍 symlink 到 cops）
#   并在旧位置留 `~/.diy/knowledge -> ~/.diy2/knowledge` 兼容旧读者（diy1 / 旧文档 / 旧脚本）
#
# 可重跑：已迁过的步骤自动跳过；有冲突（目标已存在且不是同一次迁移）就停下报错，不猜。
#
# 用法：
#   ./scripts/migrate-diy2-home.sh            # 真跑
#   DRY_RUN=1 ./scripts/migrate-diy2-home.sh  # 只打印计划与前置检查
set -euo pipefail

REPO="${DIY2_REPO:-$HOME/git/diy/diy}"
OLD="$HOME/.diy/diy2"
NEW="$HOME/.diy2"
OLD_KB="$HOME/.diy/knowledge"
NEW_KB="$NEW/knowledge"
CLI="$REPO/apps/diy2/bin/diy2"
DRY_RUN="${DRY_RUN:-0}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run() {
    if [ "$DRY_RUN" = "1" ]; then note "[dry] $*"; else "$@"; fi
}

# ---- 0. 前置检查 -----------------------------------------------------------
say "0. 前置检查"
[ -d "$REPO/apps/diy2" ] || fail "找不到 diy2 包：$REPO/apps/diy2（用 DIY2_REPO=<仓根> 指路）"

if [ -d "$NEW" ] && [ -f "$NEW/diy2.db" ] && [ ! -d "$OLD" ]; then
    say "看起来已经迁过了：$NEW 有 diy2.db、$OLD 不存在"
    note "下面只做「起实例 + 验证」，想重迁请先手动把 $NEW 挪走"
    SKIP_MOVE=1
else
    SKIP_MOVE=0
    [ -d "$OLD" ] || fail "$OLD 不存在 —— 没有可迁的旧数据根"
    if [ -d "$NEW" ]; then
        # 目标已被占：里面**没有** `diy2.db` = 不是数据根（实测本机是一份 11 月的旧残留：
        # 26M 日志 + 一个 UI 房间，无库）。这种就整目录改名备份，不删、不合并 ——
        # 合并会把两份 model.yaml / personas.yaml 混成「到底哪份生效」说不清的状态。
        if [ -f "$NEW/diy2.db" ]; then
            fail "$NEW 里已有一份 diy2.db —— 那是另一个数据根，先人工确认再动"
        fi
        BACKUP="$NEW.bak-$(date +%Y%m%d-%H%M%S)"
        note "$NEW 已存在但不是数据根（$(du -sh "$NEW" | cut -f1)：$(ls -1 "$NEW" | tr '\n' ' ')）"
        note "→ 整目录改名备份到 ${BACKUP}（不删、不合并；确认没用后你自己删）"
        run mv "$NEW" "$BACKUP"
    fi
    note "旧数据根 ${OLD}（$(du -sh "$OLD" | cut -f1)）→ 新数据根 $NEW"
    if [ -e "$OLD_KB" ] || [ -L "$OLD_KB" ]; then
        note "设备库 $OLD_KB → ${NEW_KB}（旧位置留兼容 symlink）"
    else
        note "设备库 $OLD_KB 不存在 —— 跳过库搬家，$NEW_KB 留空由你后续建"
    fi
fi
note "仓库 ${REPO}；CLI $CLI"
if [ "$DRY_RUN" = "1" ]; then
    note "DRY_RUN=1：只打印，不动手"
fi

# ---- 1. 停实例 -------------------------------------------------------------
say "1. 停本机所有 diy2 实例"
if [ -x "$CLI" ] || [ -f "$CLI" ]; then
    run node "$CLI" stop --all || note "stop --all 返回非零（可能本来就没有实例在跑），继续"
else
    note "没有 CLI 产物（${CLI}）—— 直接用注册表兜底：下面按 pid 停"
    for f in "$HOME/.diy/dev/apps"/*.json; do
        [ -f "$f" ] || continue
        pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$f" | head -1)
        [ -n "${pid:-}" ] || continue
        if kill -0 "$pid" 2>/dev/null; then
            note "kill ${pid}（$(basename "$f")）"
            run kill "$pid" || true
        fi
    done
fi
if [ "$DRY_RUN" != "1" ]; then
    for _ in $(seq 1 40); do
        left=$(pgrep -f "apps/diy2/build/prod/server/index.mjs" || true)
        [ -z "$left" ] && break
        sleep 0.25
    done
    left=$(pgrep -f "apps/diy2/build/prod/server/index.mjs" || true)
    [ -z "$left" ] || fail "实例没停干净（pid: ${left}）—— 手动处理后重跑"
    note "实例已全停"
fi
note "提醒：diy2 的桌面窗口（Electron）如果开着，先关掉；它连的是这份数据根"

# ---- 2. 构建新代码 ---------------------------------------------------------
say "2. 构建（新代码要先认识 ~/.diy2，再搬数据）"
if [ "$DRY_RUN" = "1" ]; then
    note "[dry] (cd $REPO/apps/diy2 && ./sha.sh build)"
else
    (cd "$REPO/apps/diy2" && ./sha.sh build) || fail "构建失败 —— 数据一条没动，修好再重跑"
fi

# ---- 3. 搬数据 -------------------------------------------------------------
if [ "$SKIP_MOVE" = "0" ]; then
    say "3. 搬数据根"
    run mv "$OLD" "$NEW"
    note "$OLD → $NEW"

    if [ -e "$OLD_KB" ] || [ -L "$OLD_KB" ]; then
        say "3b. 搬设备级知识库"
        if [ -e "$NEW_KB" ] || [ -L "$NEW_KB" ]; then
            note "$NEW_KB 已存在 —— 不覆盖，保留原来的"
        else
            run mv "$OLD_KB" "$NEW_KB"
            note "$OLD_KB → ${NEW_KB}（真源仍是它 symlink 指向的 cops 仓）"
        fi
        if [ ! -e "$OLD_KB" ] && [ ! -L "$OLD_KB" ]; then
            run ln -s "$NEW_KB" "$OLD_KB"
            note "旧路径留兼容 symlink：$OLD_KB → $NEW_KB"
        fi
    fi
else
    say "3. 搬数据根 —— 跳过（已迁过）"
fi

# ---- 4. 起实例 + 验证 ------------------------------------------------------
say "4. 起生产实例"
run node "$CLI" web --detach || fail "起实例失败：看 $NEW/log 下的日志"

if [ "$DRY_RUN" != "1" ]; then
    ok=0
    for _ in $(seq 1 60); do
        info=$(curl -s --max-time 1 http://127.0.0.1:5192/api/info || true)
        case "$info" in
            *"$NEW"*) ok=1; break ;;
        esac
        sleep 0.25
    done
    say "5. 验证"
    note "GET /api/info：${info:-（没响应）}"
    [ "$ok" = "1" ] || fail "实例起来了但自报的 home 不是 $NEW —— 看日志 $NEW/log"
    note "数据根文件：$(ls -1 "$NEW" | tr '\n' ' ')"
    if [ -d "$NEW_KB" ]; then
        note "设备库条目：$(find "$NEW_KB" -name '*.md' | wc -l | tr -d ' ') 个 .md"
    fi
    note "旧路径兼容：$(ls -ld "$OLD_KB" 2>/dev/null || echo '（无）')"
    note "注册表死条目会自动清（读侧按 pid 存活过滤）"
fi

say "完成"
cat <<'EOF'
  回滚（任一步出错、或你想退回去）：
    # 先停实例
    node ~/git/diy/diy/apps/diy2/bin/diy2 stop --all
    rm -f ~/.diy/knowledge                 # 兼容 symlink
    mv ~/.diy2 ~/.diy/diy2                 # 数据中心退回
    ln -s ~/.diy/diy2/knowledge ~/.diy/knowledge
    # 再把 apps/diy2/server/config.ts 的 prodHomeDir() 改回 join(realHomeDir(),'.diy','diy2') 并重构建

  迁完请回到任务：diy2 设备级知识库看不见（DIY_HOME 指实例根）—— 验证 kb 段出现 scope=global 条目。
EOF
