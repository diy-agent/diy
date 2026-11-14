#!/usr/bin/env bash
# 起 diy2 的两个进程（UI + API），都在后台跑，日志落 /tmp。
# 用法： ./scripts/dev.sh   （重复执行会先杀掉旧进程）

set -u
cd "$(dirname "$0")/.."

for port in 5190 5191; do
    pid="$(lsof -ti ":$port" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
        echo "kill :$port ($pid)"
        # shellcheck disable=SC2086
        kill $pid 2>/dev/null || true
    fi
done
sleep 1

nohup npx tsx server/index.ts > /tmp/diy2-api.log 2>&1 &
echo $! > /tmp/diy2-api.pid
nohup npx vite --port 5190 --strictPort > /tmp/diy2.log 2>&1 &
echo $! > /tmp/diy2-ui.pid

for _ in $(seq 1 20); do
    sleep 1
    api="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:5191/api/rooms || true)"
    ui="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:5190/ || true)"
    if [ "$api" = "200" ] && [ "$ui" = "200" ]; then
        echo "api http://localhost:5191  ui http://localhost:5190"
        exit 0
    fi
done

echo "起不来，看日志： /tmp/diy2-api.log /tmp/diy2.log"
exit 1
