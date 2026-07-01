#!/usr/bin/env bash
# run_h2rpc.sh — HTTP/2 集成测试
#
# 启动 hypercorn 服务端 → 运行全部 RPC 模式 → 断言结果 → 清理
# 环境变量:
#   CLI_RPC_WIRE=1  显示 JSON 线格式日志 (stderr)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT=19322
SERVER_PID=

cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# ── 启动 hypercorn 服务端（真实 HTTP/2） ──
echo "  [server] 启动 hypercorn (端口 $PORT) ..." >&2
CLI_RPC_WIRE="${CLI_RPC_WIRE:-0}" uv run --directory "$ROOT" python -c "
import asyncio
from hypercorn.config import Config
from hypercorn.asyncio import serve
from cli_rpc.cli.cyclopts._dispatch import CycloptsDispatch
from cli_rpc.cli.cyclopts._commands import diy
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

# ── 运行测试（使用 h2 库客户端，真实 HTTP/2） ──
CLI_RPC_WIRE="${CLI_RPC_WIRE:-0}" uv run --directory "$ROOT" python -c "
import asyncio, os, sys
os.environ.setdefault('CLI_RPC_WIRE', '${CLI_RPC_WIRE:-0}')

async def main():
    from cli_rpc.transport.http2._client import H2RpcClient
    passed = failed = 0
    def ch(label, ok):
        nonlocal passed, failed
        if ok: passed += 1; print(f'  [PASS] {label}')
        else: failed += 1; print(f'  [FAIL] {label}')

    async with H2RpcClient('http://127.0.0.1:$PORT') as cli:
        # Unary
        r = await cli.unary('task-list')
        ch('unary exit=0', r.exit_code == 0)
        ch('unary stdout', '任务列表' in r.stdout.decode('utf-8'))

        r = await cli.unary('task-detail', 'task/001')
        ch('unary arg exit=0', r.exit_code == 0)
        ch('unary arg uri', 'task/001' in r.stdout.decode('utf-8'))

        r = await cli.unary('ui', 'tree')
        ch('unary nested exit=0', r.exit_code == 0)

        # Unknown
        r = await cli.unary('nonexistent-cmd')
        ch('unknown exit=1', r.exit_code == 1)
        ch('unknown stderr', len(r.stderr) > 0)

        # ServerStream
        stream = cli.stream('log-tail')
        n = 0
        async for _ in stream: n += 1
        ch('sstream frames', n >= 3)
        ch('sstream exit=0', stream.exit_code == 0)

        # DuplexStream chat
        async def stdin1(): yield b'hello\n'; yield b'world\n'
        stream = cli.stream('chat', stdin=stdin1())
        n = 0
        async for _ in stream: n += 1
        ch('duplex chat frames', n >= 2)
        ch('duplex exit=0', stream.exit_code == 0)

        # DuplexStream count
        async def stdin2(): yield b'abc\n'; yield b'def\n'
        stream = cli.stream('count-bytes', stdin=stdin2())
        texts = []
        async for out in stream: texts.append(out.text)
        ch('duplex count', any('bytes' in t for t in texts))

        # Stream unknown
        stream = cli.stream('nonexistent-cmd')
        async for _ in stream: pass
        ch('sstream unknown exit=1', stream.exit_code == 1)

    total = passed + failed
    print(f'\n{passed}/{total} passed')
    sys.exit(0 if failed == 0 else 1)

asyncio.run(main())
"
