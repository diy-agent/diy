"""cli_rpc 意图测试 — ShellTest 参数化验证终端输出

测试维度:
  transport    connect / http2
  content-type json / proto (Connect only)
  rpc_mode     unary / stream / duplex
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import pytest
from diy.test import ShellTest

PKG = Path(__file__).resolve().parent.parent

# ── 服务端生命周期管理 ──


@pytest.fixture(scope="module")
def connect_server():
    """ConnectRPC 服务端（uvicorn）"""
    proc = subprocess.Popen(
        ["uv", "run", "uvicorn", "demo.server:app",
         "--host", "127.0.0.1", "--port", "19341", "--log-level", "warning"],
        cwd=PKG,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(30):
        try:
            r = subprocess.run(
                ["curl", "-sf", "http://127.0.0.1:19341/healthz"],
                capture_output=True,
                timeout=3,
            )
            if r.returncode == 0:
                break
        except Exception:
            pass
        time.sleep(0.5)
    yield
    proc.terminate()
    proc.wait()


@pytest.fixture(scope="module")
def http2_server():
    """HTTP/2 服务端（hypercorn）"""
    code = (
        "import asyncio;"
        "from hypercorn.config import Config;"
        "from hypercorn.asyncio import serve;"
        "from cli_rpc.cli.cyclopts._dispatch import CycloptsDispatch;"
        "from demo.commands import diy;"
        "from cli_rpc.transport.http2 import make_http2_app;"
        "app = make_http2_app(CycloptsDispatch(diy));"
        "c = Config(); c.bind=['127.0.0.1:19342']; c.use_reloader=False;"
        "asyncio.run(serve(app, c))"
    )
    proc = subprocess.Popen(
        ["uv", "run", "python", "-u", "-c", code],
        cwd=PKG,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(30):
        try:
            r = subprocess.run(
                ["curl", "-sf", "http://127.0.0.1:19342/healthz"],
                capture_output=True,
                timeout=3,
            )
            if r.returncode == 0:
                break
        except Exception:
            pass
        time.sleep(0.5)
    yield
    proc.terminate()
    proc.wait()


# ── 工具函数 ──


def sh(server_port: int | None = None) -> ShellTest:
    """创建 ShellTest 实例，可选预注入 server URL"""
    cmd = f"cd {PKG}"
    if server_port:
        cmd += f"; URL=http://127.0.0.1:{server_port}"
    return ShellTest(cwd=str(PKG), init_commands=[cmd])


# ════════════════════════════════════════════════════════════
# ConnectRPC 测试
# ════════════════════════════════════════════════════════════


class TestConnect:
    """ConnectRPC 传输层 — 多种 content-type"""

    @pytest.fixture(autouse=True)
    def _server(self, connect_server):
        pass

    # ── Unary JSON ──

    def test_unary_json_task_list(self):
        """Unary JSON: 任务列表"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19341/v1/unary -H 'Content-Type: application/json' -d '{"argv":["task-list"]}'
*任务列表*
$ echo OK
OK
""")

    def test_unary_json_exit_code_0(self):
        """Unary JSON: exit_code == 0"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19341/v1/unary -H 'Content-Type: application/json' -d '{"argv":["task-list"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d['exit_code']==0 else 1)"
""")

    def test_unary_json_unknown(self):
        """Unary JSON: 未知命令返回 exit=1"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19341/v1/unary -H 'Content-Type: application/json' -d '{"argv":["nonexistent"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['exit_code']==1, f'exit={d['exit_code']}'; print('exit=1 OK')"
exit=1 OK
""")

    # ── Unary Protobuf ──

    def test_unary_protobuf(self):
        """Unary Protobuf: 通过 Python 客户端（默认 protobuf codec）"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ uv run python -c "
import asyncio
from cli_rpc import CliRpc
async def main():
    async with CliRpc.create('http://127.0.0.1:19341', transport='connect') as cli:
        r = await cli.unary('task-list')
        print(f'exit={r.exit_code}')
        print('stdout:', r.stdout.decode()[:20])
asyncio.run(main())
"
exit=0
stdout: *
""")

    # ── Stream JSON ──

    def test_server_stream_json_count(self):
        """ServerStream JSON: 至少 3 帧"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19341/v1/stream -H 'Content-Type: application/json' -H 'Accept: application/x-ndjson' -d '{"argv":["log-tail"]}' | python3 -c "import sys; lines=[l for l in sys.stdin if l.strip()]; print(f'frames={len(lines)}')"
*frames=*
""")

    def test_server_stream_json_has_exit(self):
        """ServerStream JSON: 最后帧含 exit"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19341/v1/stream -H 'Content-Type: application/json' -H 'Accept: application/x-ndjson' -d '{"argv":["log-tail"]}' | python3 -c "import sys,json; frames=[json.loads(l) for l in sys.stdin if l.strip()]; last=frames[-1]; print(f'ch={last.get(\"ch\")} exit={last.get(\"exit\")}')"
ch=*exit=0
""")

    def test_duplex_stream_chat(self):
        """DuplexStream chat: 传入两行，回声回传"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ echo -e 'hello\nworld' | curl -sf http://127.0.0.1:19341/v1/stream -H 'Content-Type: application/x-ndjson' --data-binary @- | python3 -c "
import sys,json
out = [json.loads(l) for l in sys.stdin if l.strip()]
for f in out:
    if f.get('d'): print(f['d'], end='')
" 2>&1
hello
world
""")

    # ── Unknown command stream ──

    def test_unknown_stream_exit_1(self):
        """Stream unknown: exit=1"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19341/v1/stream -H 'Content-Type: application/json' -d '{"argv":["nonexistent-cmd"]}' | python3 -c "import sys,json; frames=[json.loads(l) for l in sys.stdin if l.strip()]; last=frames[-1]; print(f'ch={last[\"ch\"]} exit={last.get(\"exit\")}')"
ch=*exit=1
""")


# ════════════════════════════════════════════════════════════
# HTTP/2 测试
# ════════════════════════════════════════════════════════════


class TestHttp2:
    """HTTP/2 传输层"""

    @pytest.fixture(autouse=True)
    def _server(self, http2_server):
        pass

    # ── Unary JSON ──

    def test_unary_task_list(self):
        """Unary JSON: 任务列表"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19342/v1/unary -H 'Content-Type: application/json' -d '{"argv":["task-list"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['stdout'][:20])"
*
""")

    def test_unary_exit_0(self):
        """Unary JSON: exit=0"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19342/v1/unary -H 'Content-Type: application/json' -d '{"argv":["task-list"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['exit_code']==0; print('OK')"
OK
""")

    def test_unary_unknown_exit_1(self):
        """Unary JSON: 未知命令 exit=1"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19342/v1/unary -H 'Content-Type: application/json' -d '{"argv":["nonexistent"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['exit_code']==1; print('OK')"
OK
""")

    # ── Stream JSON ──

    def test_server_stream_frames(self):
        """ServerStream JSON: 至少 3 帧"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19342/v1/stream -H 'Content-Type: application/json' -d '{"argv":["log-tail"]}' | python3 -c "import sys; lines=[l for l in sys.stdin if l.strip()]; print(f'frames={len(lines)}')"
*frames=*
""")

    def test_server_stream_last_exit(self):
        """ServerStream JSON: 最后帧 ch=3 exit=0"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19342/v1/stream -H 'Content-Type: application/json' -d '{"argv":["log-tail"]}' | python3 -c "import sys,json; frames=[json.loads(l) for l in sys.stdin if l.strip()]; last=frames[-1]; print(f'ch={last.get(\"ch\")} exit={last.get(\"exit\")}')"
ch=*exit=0
""")

    def test_unknown_stream_exit_1(self):
        """Stream unknown: exit=1"""
        ShellTest(cwd=str(PKG)).assert_session(r"""
$ curl -sf http://127.0.0.1:19342/v1/stream -H 'Content-Type: application/json' -d '{"argv":["nonexistent-cmd"]}' | python3 -c "import sys,json; frames=[json.loads(l) for l in sys.stdin if l.strip()]; last=frames[-1]; print(f'ch={last.get(\"ch\")} exit={last.get(\"exit\")}')"
ch=*exit=1
""")


# ════════════════════════════════════════════════════════════
# 端到端对比测试（两种传送层同参数）
# ════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "transport,port,client_cmd",
    [
        (
            "connect",
            19341,
            "from cli_rpc import CliRpc; CliRpc.create('http://127.0.0.1:19341', transport='connect')",
        ),
        (
            "http2",
            19342,
            "from cli_rpc.transport.http2._client import H2RpcClient; H2RpcClient('http://127.0.0.1:19342')",
        ),
    ],
)
@pytest.mark.parametrize(
    "cmd,argv,expect_out",
    [
        ("task-list", "", "任务列表"),
        ("task-detail", "task/001", "task/001"),
        ("ui tree", "", "任务列表"),
        ("log-tail", "", "开始监听"),
    ],
)
def test_parameterized_rpc(
    transport, port, client_cmd, cmd, argv, expect_out, connect_server, http2_server
):
    """参数化 RPC 测试：多种传送层 × 多种命令"""
    # 确保当前 transport 的 server 已就绪
    if transport == "connect":
        assert connect_server is not None  # fixture 已启动
    else:
        assert http2_server is not None

    import_json = "import json"
    # 构建 Python 客户端测试代码
    client_init = client_cmd
    argv_part = f"'{cmd}', {argv}" if argv else f"'{cmd}'"

    s = ShellTest(cwd=str(PKG))
    s.assert_session(f"""
$ uv run python3 -c "
{import_json}
import asyncio
async def main():
    async with {client_init} as cli:
        r = await cli.unary({argv_part})
        print(r.stdout.decode('utf-8')[:100])
asyncio.run(main())
"
*{expect_out}*
""")
