"""HTTP/2 RPC 协议定义 — 纯 JSON 帧格式，零 protobuf 依赖。

协议概览:
  Unary (POST /v1/unary):  JSON request/response
  Stream (POST /v1/stream): JSON 或 NDJSON → JSON 帧流

帧格式:
  {"ch": <int>, "d": "..."}     ← STDOUT/STDERR
  {"ch": <int>, "exit": N}      ← CONTROL（exit_code）
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from cli_rpc.core._protocol import (
    CHANNEL_CONTROL,
    CHANNEL_STDERR,
    CHANNEL_STDIN,
    CHANNEL_STDOUT,
    RawFrame,
)


def _ch_int(channel) -> int:
    """Enum member → int（用于 JSON 序列化）"""
    return channel.value if hasattr(channel, "value") else channel


def _ch_from_int(val: int):
    """int → Enum member"""
    for c in (CHANNEL_CONTROL, CHANNEL_STDIN, CHANNEL_STDOUT, CHANNEL_STDERR):
        if _ch_int(c) == val:
            return c
    return CHANNEL_STDERR


def encode_frame(frame: RawFrame) -> bytes:
    """RawFrame → JSON 行"""
    ch = _ch_int(frame.channel)
    obj: dict = {"ch": ch}
    if frame.channel == CHANNEL_CONTROL:
        obj["exit"] = frame.exit_code
    else:
        obj["d"] = frame.data.decode("utf-8", errors="replace") if frame.data else ""
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


def decode_frame(line: str) -> RawFrame | None:
    """JSON 行 → RawFrame"""
    line = line.strip()
    if not line:
        return None
    obj = json.loads(line)
    ch = obj["ch"]
    channel = _ch_from_int(ch)
    if channel == CHANNEL_CONTROL:
        return RawFrame(channel=channel, exit_code=obj.get("exit", 0))
    data = obj.get("d", "")
    return RawFrame(channel=channel, data=data.encode("utf-8"))


async def encode_frames(frames: AsyncIterator[RawFrame]) -> AsyncIterator[bytes]:
    """Yield JSON lines for each RawFrame."""
    async for frame in frames:
        yield encode_frame(frame)


# ── 端点 ──

UNARY_ENDPOINT = "/v1/unary"
STREAM_ENDPOINT = "/v1/stream"
SERVICE_PATH = "/v1"

__all__ = [
    "UNARY_ENDPOINT",
    "STREAM_ENDPOINT",
    "SERVICE_PATH",
    "encode_frame",
    "decode_frame",
    "encode_frames",
]
