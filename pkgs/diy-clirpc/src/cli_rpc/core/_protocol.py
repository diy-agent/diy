"""协议层类型 — protobuf 生成的 RawFrame/RawRequest/RawResponse + 通道常量。

纯传输层类型，不依赖 Cyclopts 或 handler 抽象。
"""

from __future__ import annotations

from cli_rpc.transport.connectrpc.gen.cli_rpc_pb import (
    Channel,
    RawFrame,
    RawRequest,
    RawResponse,
    desc,
)

# 运行时友好的通道常量
CHANNEL_STDIN = Channel.STDIN
CHANNEL_STDOUT = Channel.STDOUT
CHANNEL_STDERR = Channel.STDERR
CHANNEL_CONTROL = Channel.CONTROL

__all__ = [
    "Channel",
    "RawFrame",
    "RawRequest",
    "RawResponse",
    "desc",
    "CHANNEL_STDIN",
    "CHANNEL_STDOUT",
    "CHANNEL_STDERR",
    "CHANNEL_CONTROL",
]
