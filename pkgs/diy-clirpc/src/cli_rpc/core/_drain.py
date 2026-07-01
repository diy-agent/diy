"""Drain 工具 + per-request 初始化 — 传输层无关。

包含：共享队列 drain、Response 帧读取、stdin 处理、内联辅助函数。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from cli_rpc.core._protocol import (
    CHANNEL_CONTROL,
    CHANNEL_STDIN,
    CHANNEL_STDOUT,
    RawFrame,
)
from cli_rpc.core._types import Request, Response, RpcErr, RpcIn, RpcOut
from cli_rpc.core._wire import _msg_to_json, _wire_log

# ── 队列 drain ──


def _drain_queue(q: asyncio.Queue) -> str:
    """读取队列全部内容为字符串（用于 Cyclopts Console 输出）"""
    parts = []
    while not q.empty():
        try:
            parts.append(q.get_nowait())
        except asyncio.QueueEmpty:
            break
    return "".join(parts)


def _drain_response_text(response: Response) -> tuple[str, str]:
    """同步 drain 共享队列，按 channel 分拣为 (stdout_text, stderr_text)"""
    out_parts = []
    err_parts = []
    while not response.out._queue.empty():
        try:
            frame = response.out._queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        text = frame.data.decode("utf-8", errors="replace")
        if frame.channel == CHANNEL_STDOUT:
            out_parts.append(text)
        else:
            err_parts.append(text)
    return "".join(out_parts), "".join(err_parts)


async def _drain_response_frames(response: Response) -> AsyncIterator[RawFrame]:
    """异步读取共享队列，按入队顺序 yield RawFrame"""
    while not response.out._queue.empty():
        try:
            yield response.out._queue.get_nowait()
        except asyncio.QueueEmpty:
            break


# ── per-request 初始化 ──


def _make_request_response(argv, headers, stdin_queue):
    """创建 per-request Request/Response（out/err 共享同一队列，保持帧顺序）"""
    request = Request(
        stdin=RpcIn(stdin_queue),
        headers=headers,
        argv=argv,
    )
    shared_q = asyncio.Queue()
    response = Response(
        out=RpcOut(shared_q),
        err=RpcErr(shared_q),
    )
    return request, response


# ── 内联辅助 ──


def _control_frame(code: int) -> RawFrame:
    return RawFrame(channel=CHANNEL_CONTROL, exit_code=code)


def _frame_logger(method: str, direction: str):
    """创建帧日志记录器（wire log）"""
    seq = [0]

    def _log(frame):
        seq[0] += 1
        entry = {
            "method": method,
            "dir": direction,
            "seq": seq[0],
            "raw": _msg_to_json(frame),
        }
        if frame.data is not None and len(frame.data) > 0:
            entry["data_text"] = frame.data.decode("utf-8", errors="replace")
        _wire_log("frame", _side="server", **entry)
        return frame

    return _log


# ── stdin 处理 ──


async def _stdin_reader(request: AsyncIterator[RawFrame]) -> bytearray:
    """收集 request stream 中所有 STDIN 帧到单个 bytearray"""
    buf = bytearray()
    async for frame in request:
        if frame.channel == CHANNEL_CONTROL:
            continue
        buf.extend(frame.data)
    return buf


async def _stdin_feeder(request: AsyncIterator[RawFrame], queue: asyncio.Queue):
    """将 request stream 中的 STDIN 帧推入 RpcIn 的队列"""
    async for frame in request:
        if frame.channel == CHANNEL_STDIN:
            queue.put_nowait(frame.data)
    queue.put_nowait(None)  # EOF sentinel


__all__ = [
    "_drain_queue",
    "_drain_response_text",
    "_drain_response_frames",
    "_make_request_response",
    "_control_frame",
    "_frame_logger",
    "_stdin_reader",
    "_stdin_feeder",
]
