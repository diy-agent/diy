#!/usr/bin/env python
"""test_connect — 真正的 ConnectRPC 闭环测试

用 CycloptsCommandsClient 调 CycloptsConnectServicer。

用法:
    uv run python demo/test_connect.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent


async def _wait_ready(port: int, timeout: float = 15) -> bool:
    import urllib.request

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1)
            if r.status == 200:
                return True
        except Exception:
            pass
        await asyncio.sleep(0.3)
    return False


async def main():
    PORT = 18323
    BASE = f"http://127.0.0.1:{PORT}"

    # ── 启动 ConnectRPC server ──
    print("  [server] 启动 ConnectRPC typed server ...")
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "uvicorn",
        "demo.connect_servicer:app",
        "--host", "127.0.0.1", "--port", str(PORT),
        "--log-level", "warning",
        cwd=PKG,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def _drain(stream):
        while True:
            line = await stream.readline()
            if not line:
                break
    asyncio.create_task(_drain(proc.stdout))
    asyncio.create_task(_drain(proc.stderr))

    ready = await _wait_ready(PORT)
    assert ready, "服务端启动超时"
    print(f"  [server] 就绪 (PID={proc.pid})")

    passed = failed = 0
    def ok(label):
        nonlocal passed, failed
        passed += 1
        print(f"  [PASS] {label}")
    def fail(label, detail=""):
        nonlocal passed, failed
        failed += 1
        msg = f"  [FAIL] {label}"
        if detail:
            msg += f"  ({detail})"
        print(msg)

    from connectrpc.codec import proto_json_codec

    from demo.gen.gen.cli_rpc_gen_connect import CycloptsCommandsClient
    from demo.gen.gen.cli_rpc_gen_pb import (
        ChatRequest,
        CountBytesRequest,
        LogTailRequest,
        TaskDetailRequest,
        TaskListRequest,
        UiStatusRequest,
        UiTreeRequest,
    )

    async with CycloptsCommandsClient(
        address=BASE,
        codec=proto_json_codec(),
    ) as client:

        # ── 1. TaskList (unary) ──
        resp = await client.task_list(request=TaskListRequest())
        ok("TaskList exit=0") if resp.exit_code == 0 else fail("TaskList exit=0")
        ok("TaskList stdout") if "任务列表" in resp.stdout else fail("TaskList stdout")

        # ── 2. TaskDetail (unary with arg) ──
        resp = await client.task_detail(request=TaskDetailRequest(uri="task/001"))
        ok("TaskDetail exit=0") if resp.exit_code == 0 else fail("TaskDetail exit=0")
        ok("TaskDetail stdout") if "task/001" in resp.stdout else fail("TaskDetail stdout")

        # ── 3. LogTail (serverStream) ──
        frames = []
        async for frame in client.log_tail(request=LogTailRequest()):
            frames.append(frame)
        ok(f"LogTail frames={len(frames)}") if len(frames) >= 5 else fail("LogTail frames", str(len(frames)))
        # 最后一帧含 exit_code（成功时=0）
        ok("LogTail exit frame") if len(frames) >= 1 and frames[-1].exit_code == 0 else fail("LogTail exit frame")

        # ── 4. Chat (clientStream) ──
        async def chat_stdin():
            yield ChatRequest(stdin=b"hello\n")
            yield ChatRequest(stdin=b"world\n", eof=True)
        resp = await client.chat(request=chat_stdin())
        ok("Chat exit=0") if resp.exit_code == 0 else fail("Chat exit=0")
        ok("Chat echo") if "hello" in resp.stdout else fail("Chat echo", resp.stdout)

        # ── 5. CountBytes (clientStream) ──
        async def count_stdin():
            yield CountBytesRequest(stdin=b"hello\n")
            yield CountBytesRequest(stdin=b"world\n", eof=True)
        resp = await client.count_bytes(request=count_stdin())
        ok("CountBytes exit=0") if resp.exit_code == 0 else fail("CountBytes exit=0")
        ok("CountBytes stdout") if "bytes" in resp.stdout else fail("CountBytes stdout", resp.stdout)

        # ── 6. UiStatus (unary, nested) ──
        resp = await client.ui_status(request=UiStatusRequest())
        ok("UiStatus exit=0") if resp.exit_code == 0 else fail("UiStatus exit=0")

        # ── 7. UiTree (unary, nested) ──
        resp = await client.ui_tree(request=UiTreeRequest())
        ok("UiTree exit=0") if resp.exit_code == 0 else fail("UiTree exit=0")

    # ── 清理 ──
    try:
        proc.terminate()
        await proc.wait()
    except Exception:
        proc.kill()

    total = passed + failed
    print(f"\n{'='*40}")
    print(f"  {passed}/{total} 通过")
    if failed > 0:
        sys.exit(1)
    print("✓ ConnectRPC 闭环完成")


if __name__ == "__main__":
    asyncio.run(main())
