"""
cli_rpc 意图测试 — 启动真实服务端，验证 4 种 RPC 模式。

运行:
    uv run python -m pytest cli_rpc/test_cli_rpc.py -v
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import urllib.request

import pytest

from cli_rpc import CliRpc


@pytest.fixture(scope="module")
def server_port():
    return 18321  # 避开默认 8321，避免冲突


@pytest.fixture(scope="module")
def server_proc(server_port):
    """启动实际 uvicorn 服务端（子进程）"""
    proc = asyncio.run(_start_server(server_port))
    ready = asyncio.run(_wait_ready(server_port, proc))
    assert ready, "服务端启动超时"
    yield proc
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()


async def _start_server(port: int):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "uvicorn",
        "cli_rpc.server_demo:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "warning",
        cwd=root,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # drain pipes to prevent blocking
    async def _drain(stream):
        while True:
            line = await stream.readline()
            if not line:
                break

    asyncio.create_task(_drain(proc.stdout))
    asyncio.create_task(_drain(proc.stderr))
    return proc


async def _wait_ready(port: int, proc, timeout: float = 15):
    url = f"http://127.0.0.1:{port}/healthz"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.returncode is not None:
            return False
        try:
            r = urllib.request.urlopen(url, timeout=1)
            if r.status == 200:
                return True
        except Exception:
            pass
        await asyncio.sleep(0.3)
    return False


# ════════════════════════════════════════════════════════════════
# 测试用例
# ════════════════════════════════════════════════════════════════


async def test_unary(server_proc, server_port):
    """unary: task-list / task-detail / ui status"""
    url = f"http://127.0.0.1:{server_port}"
    async with CliRpc(url) as cli:
        # basic list
        resp = await cli.unary("diy", "task-list")
        assert resp.exit_code == 0
        assert "任务列表" in resp.stdout.decode()

        # with arg
        resp = await cli.unary("diy", "task-detail", "task/001")
        assert resp.exit_code == 0
        assert "task/001" in resp.stdout.decode()

        # nested subcommand
        resp = await cli.unary("diy", "ui", "status")
        assert resp.exit_code == 0
        assert "管控台" in resp.stdout.decode()


async def test_server_stream(server_proc, server_port):
    """serverStream: log-tail"""
    url = f"http://127.0.0.1:{server_port}"
    async with CliRpc(url) as cli:
        frames = []
        async for chunk in cli.stream("diy", "log-tail"):
            frames.append(chunk)
        assert len(frames) >= 2
        all_text = "".join(f.text for f in frames)
        assert "日志结束" in all_text


async def test_duplex_chat(server_proc, server_port):
    """duplexStream: chat（echo stdin）"""
    url = f"http://127.0.0.1:{server_port}"
    async with CliRpc(url) as cli:

        async def stdin():
            yield b"hello\n"
            yield b"world\n"

        got = []
        async for chunk in cli.stream("diy", "chat", stdin=stdin()):
            got.append(chunk.text.rstrip())
        assert any("hello" in g for g in got)
        assert any("对话结束" in g for g in got)


async def test_duplex_count_bytes(server_proc, server_port):
    """duplexStream: count-bytes"""
    url = f"http://127.0.0.1:{server_port}"
    async with CliRpc(url) as cli:

        async def stdin():
            yield b"hello\n"
            yield b"world\n"

        frames = []
        async for chunk in cli.stream("diy", "count-bytes", stdin=stdin()):
            frames.append(chunk.text)
        combined = "".join(frames)
        assert "11" in combined or "12" in combined


async def test_unknown_command(server_proc, server_port):
    """未知命令返回 exit_code=1"""
    url = f"http://127.0.0.1:{server_port}"
    async with CliRpc(url) as cli:
        resp = await cli.unary("diy", "nonexistent-cmd")
        assert resp.exit_code == 1
        assert len(resp.stderr) > 0


async def test_stream_unknown_command(server_proc, server_port):
    """stream 模式下未知命令返回 exit_code=1 + stderr"""
    url = f"http://127.0.0.1:{server_port}"
    async with CliRpc(url) as cli:
        stream = cli.stream("diy", "nonexistent-cmd")
        frames = []
        async for chunk in stream:
            frames.append(chunk)
        assert stream.exit_code == 1
        stderr_text = "".join(f.text for f in frames if f.is_stderr)
        assert len(stderr_text) > 0
