"""
cli_rpc server — Starlette ASGI app backed by demo Cyclopts commands

胶水层: 组合 cli/cyclopts (Cyclopts) 和 transport/connectrpc (传输层)。

用法:
    uvicorn cli_rpc.server_demo:app
"""

from __future__ import annotations

import os
import sys

from cli_rpc.cli.cyclopts._commands import diy
from cli_rpc.cli.cyclopts._dispatch import CycloptsDispatch
from cli_rpc.transport.connectrpc._server import make_app, make_service

SERVICE_PORT = 8321
WIRE = os.environ.get("UVICORN_WIRE", "") == "1"

# ── 创建服务 ──
dispatch = CycloptsDispatch(diy)
svc = make_service(dispatch)
app = make_app(svc)


def main():
    import uvicorn

    print(f"diy RPC server on http://127.0.0.1:{SERVICE_PORT}", file=sys.stderr)
    print(f"  Path: {svc._dispatch._app.meta.path}", file=sys.stderr)  # approximate
    print(f"  Wire: {'ON' if WIRE else 'off'}", file=sys.stderr)
    cmd_names = [k for k in diy._commands.keys() if not k.startswith("-")]
    print(f"  Commands: {', '.join(cmd_names)}", file=sys.stderr)
    uvicorn.run(app, host="127.0.0.1", port=SERVICE_PORT, log_level="info")


if __name__ == "__main__":
    main()
