#!/usr/bin/env bash
# http2_demo.sh — HTTP/2 演示
# 启动 hypercorn 服务端 → 展示 4 种 RPC 模式 → 清理
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=19332
SERVER_PID=

cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "  [server] 启动 hypercorn (端口 $PORT) ..." >&2
uv run --directory "$ROOT" python -c "
import asyncio
from hypercorn.config import Config
from hypercorn.asyncio import serve
from cli_rpc.cli.cyclopts._dispatch import CycloptsDispatch
from demo.commands import diy
from cli_rpc.transport.http2 import make_http2_app
app = make_http2_app(CycloptsDispatch(diy))
config = Config()
config.bind = ['127.0.0.1:$PORT']
config.use_reloader = False
asyncio.run(serve(app, config))
" &
SERVER_PID=$!

for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.3
done
echo "  [server] 就绪 (PID=$SERVER_PID)" >&2
echo

# ── 演示 ──
uv run --directory "$ROOT" python -c "
import asyncio
from cli_rpc.transport.http2._client import H2RpcClient

async def demo():
    async with H2RpcClient('http://127.0.0.1:$PORT') as cli:
        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        print('1. Unary: task-list')
        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        r = await cli.unary('task-list')
        print(r.stdout.decode('utf-8'))
        print(f'  ── exit={r.exit_code} ──\n')

        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        print('2. Unary: task-detail task/001')
        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        r = await cli.unary('task-detail', 'task/001')
        print(r.stdout.decode('utf-8'))
        print(f'  ── exit={r.exit_code} ──\n')

        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        print('3. ServerStream: log-tail')
        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        stream = cli.stream('log-tail')
        n = 0
        async for out in stream:
            tag = 'err' if out.is_stderr else 'out'
            print(f'   [{tag}] {out.text}')
            n += 1
        print(f'   --- (共 {n} 帧, exit={stream.exit_code}) ---\n')

        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        print('4. DuplexStream: chat (有 stdin，回声)')
        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        async def stdin1():
            yield b'hello world\n'
            yield b'second line\n'
        stream = cli.stream('chat', stdin=stdin1())
        async for out in stream:
            print(f'   {out.text}')
        print(f'   --- (exit={stream.exit_code}) ---\n')

        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        print('5. Unary: nonexistent-cmd (错误处理)')
        print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        r = await cli.unary('nonexistent-cmd')
        if r.stderr:
            print(f'   stderr: {r.stderr.decode(\"utf-8\").strip()}')
        print(f'   ── exit={r.exit_code} ──\n')

asyncio.run(demo())
"
echo
echo '✓ 演示完成'
