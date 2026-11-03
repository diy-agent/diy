#!/usr/bin/env bash
# scripts/watch-agents.sh —— 盯住指定的子任务；停了就唤醒，并提醒它怎么回报。
#
# 为什么需要：子任务的 agent 只把结论写在自己任务的 body 里，主控（##266）收不到通知；
# 而且它跑完一轮就停（不会自己续），没人推就永远停在那。
#
# 用法：
#   ./scripts/watch-agents.sh 514 498                 # 缺省每 300s 查一次
#   ./scripts/watch-agents.sh --interval 120 514
#   ./scripts/watch-agents.sh --stop                  # 停掉后台巡检
#
# 判据（三者同时满足才唤醒）：
#   ① 任务 state = active
#   ② `diy agent local running` 里没有这个 taskUri（真停了）
#   ③ 距上次唤醒 > 冷却时间（缺省 600s，避免风暴）
#
# 唤醒消息里带上「怎么回报主控」—— 这是本脚本存在的第二个理由。

set -uo pipefail

MAIN_TASK="projects/4/tasks/266"
DI="${DIY_CLI:-diy}"
INTERVAL=300
COOLDOWN=600
LOG="${DIY_WATCH_LOG:-/tmp/watch-agents.log}"
STATE="${DIY_WATCH_STATE:-/tmp/watch-agents.state}"
PIDFILE="${DIY_WATCH_PID:-/tmp/watch-agents.pid}"

targets=()
while [ $# -gt 0 ]; do
    case "$1" in
        --interval) INTERVAL="$2"; shift 2 ;;
        --cooldown) COOLDOWN="$2"; shift 2 ;;
        --stop)
            if [ -f "$PIDFILE" ]; then
                kill "$(cat "$PIDFILE")" 2>/dev/null && echo "已停（pid $(cat "$PIDFILE")）"
                rm -f "$PIDFILE"
            else
                echo "没有在跑的巡检"
            fi
            exit 0
            ;;
        -*) echo "未知参数：$1" >&2; exit 1 ;;
        *) targets+=("$1"); shift ;;
    esac
done

if [ ${#targets[@]} -eq 0 ]; then
    echo "用法：$0 [--interval N] [--cooldown N] <任务号>..." >&2
    echo "      $0 --stop" >&2
    exit 1
fi

# 后台运行（自己再拉起来）：第一次调用自动转后台，pid 写 pidfile
if [ "${DIY_WATCH_FOREGROUND:-0}" != "1" ]; then
    DIY_WATCH_FOREGROUND=1 nohup "$0" --interval "$INTERVAL" --cooldown "$COOLDOWN" "${targets[@]}" >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    echo "巡检已起（pid $!），每 ${INTERVAL}s 查一次：${targets[*]}"
    echo "日志：$LOG"
    exit 0
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 正在跑的 taskUri 集合（一行一个）
running_uris() {
    "$DI" agent local running 2>/dev/null | grep -oE '"taskUri":"[^"]*"' | sed 's/.*tasks\///;s/"//'
}

task_state() {
    local f="$HOME/.diy/projects/4/tasks/$1/AGENTS.md"
    [ -f "$f" ] && grep -m1 '^state:' "$f" | awk '{print $2}'
}

# 上次唤醒时间戳（纯文本：<task> <epoch>）
last_woken() {
    [ -f "$STATE" ] && awk -v t="$1" '$1==t{print $2}' "$STATE" | tail -1
}

mark_woken() {
    local now; now=$(date +%s)
    { [ -f "$STATE" ] && grep -v "^$1 " "$STATE"; echo "$1 $now"; } >"$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}

wake() {
    local task="$1"
    local msg="【巡检唤醒 · 别停】你在 ${task} 里还有没做完的活，继续干。

**做完一步必须回报主控**（只写 body 主控收不到）：
  diy agent local chat ${MAIN_TASK} \"${task} 第N步完成：<一句话 + 关键数字>\"

卡住超过 20 分钟也发一条说明卡点。先 git pull 到最新 main 再开工。"
    local out
    out=$("$DI" agent local chat "$task" "$msg" 2>&1 | tail -1)
    mark_woken "$task"
    log "唤醒 $task → $out"
}

log "巡检启动：目标 ${targets[*]}，间隔 ${INTERVAL}s，冷却 ${COOLDOWN}s"
while true; do
    running="$(running_uris)"
    for t in "${targets[@]}"; do
        uri="projects/4/tasks/$t"
        # ① 只有 active 才管
        [ "$(task_state "$t")" = "active" ] || continue
        # ② 在跑就跳过
        if printf '%s\n' "$running" | grep -qx "$uri"; then continue; fi
        # ③ 冷却
        prev="$(last_woken "$t")"
        now=$(date +%s)
        if [ -n "$prev" ] && [ $((now - prev)) -lt "$COOLDOWN" ]; then continue; fi
        wake "$t"
    done
    sleep "$INTERVAL"
done
