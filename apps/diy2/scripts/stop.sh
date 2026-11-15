#!/usr/bin/env bash
# 停掉 diy2 的两个进程。
set -u
for port in 5190 5191; do
    pid="$(lsof -ti ":$port" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
        echo "kill :$port ($pid)"
        # shellcheck disable=SC2086
        kill $pid 2>/dev/null || true
    fi
done
