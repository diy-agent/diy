"""业务层类型 — RpcIn/RpcOut/RpcErr/Request/Response/CliOutput/StreamResult

这些是 handler 面向的 API（response.out.print / async for chunk in request.stdin），
对传输层和 CLI 框架都保持中立。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from cli_rpc.core._protocol import (
    CHANNEL_CONTROL,
    CHANNEL_STDERR,
    CHANNEL_STDOUT,
    RawFrame,
)


class RpcIn:
    """stdin reader — 语义对标 asyncio.StreamReader"""

    def __init__(self, queue: asyncio.Queue):
        self._queue = queue
        self._buffer = bytearray()

    async def readline(self) -> str:
        """读一行（直到 \\n），返回 str。"""
        while True:
            idx = self._buffer.find(b"\n")
            if idx >= 0:
                line = self._buffer[: idx + 1]
                self._buffer = self._buffer[idx + 1 :]
                return line.decode("utf-8", errors="replace")
            chunk = await self._queue.get()
            if chunk is None:
                rest = bytes(self._buffer)
                self._buffer.clear()
                if rest:
                    return rest.decode("utf-8", errors="replace")
                raise EOFError
            self._buffer.extend(chunk if isinstance(chunk, bytes) else chunk.encode())

    async def read(self, n: int = -1) -> bytes:
        """读最多 n 字节。n=-1 读至 EOF。返回 bytes。"""
        if n == -1:
            parts = [bytes(self._buffer)]
            self._buffer.clear()
            while True:
                chunk = await self._queue.get()
                if chunk is None:
                    break
                parts.append(chunk if isinstance(chunk, bytes) else chunk.encode())
            return b"".join(parts)
        while len(self._buffer) < n:
            chunk = await self._queue.get()
            if chunk is None:
                break
            self._buffer.extend(chunk if isinstance(chunk, bytes) else chunk.encode())
        result = bytes(self._buffer[:n])
        self._buffer = self._buffer[n:]
        return result

    async def read_chunk(self) -> bytes | None:
        """读一个 RawFrame 分片，返回 bytes。EOF 返回 None。"""
        if self._buffer:
            result = bytes(self._buffer)
            self._buffer.clear()
            return result
        chunk = await self._queue.get()
        if chunk is None:
            return None
        return chunk if isinstance(chunk, bytes) else chunk.encode()

    def __aiter__(self):
        return self._async_gen()

    async def _async_gen(self):
        while True:
            chunk = await self._queue.get()
            if chunk is None:
                break
            yield chunk


class RpcOut:
    """stdout — supports strings / rich objects / typed objects"""

    def __init__(self, queue: asyncio.Queue):
        self._queue = queue

    def print(self, *objects, **kwargs):
        if objects:
            sep = kwargs.get("sep", " ")
            text = sep.join(str(o) for o in objects)
            if text:
                self._queue.put_nowait(
                    RawFrame(channel=CHANNEL_STDOUT, data=text.encode())
                )

    def write(self, data: bytes):
        """写入原始字节"""
        if data:
            self._queue.put_nowait(RawFrame(channel=CHANNEL_STDOUT, data=data))


class RpcErr:
    """stderr — strings only"""

    def __init__(self, queue: asyncio.Queue):
        self._queue = queue

    def print(self, *objects, **kwargs):
        if objects:
            sep = kwargs.get("sep", " ")
            text = sep.join(str(o) for o in objects)
            if text:
                self._queue.put_nowait(
                    RawFrame(channel=CHANNEL_STDERR, data=text.encode())
                )


@dataclass
class Request:
    """handler 输入上下文"""

    stdin: RpcIn = field(default=None)
    headers: dict[str, str] = field(default_factory=dict)
    argv: list[str] = field(default_factory=list)


@dataclass
class Response:
    """handler 输出上下文"""

    out: RpcOut = field(default=None)
    err: RpcErr = field(default=None)
    exit_code: int = 0


@dataclass
class CliOutput:
    """CLI output chunk (no protocol awareness)"""

    text: str
    is_stderr: bool = False


class StreamResult:
    """Async iterable stream; read .exit_code after iteration."""

    def __init__(self, source: AsyncIterator[RawFrame]) -> None:
        self._source = source
        self.exit_code: int = 0

    def __aiter__(self) -> AsyncIterator[CliOutput]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[CliOutput]:
        self.exit_code = 0
        async for frame in self._source:
            if frame.channel == CHANNEL_CONTROL:
                self.exit_code = frame.exit_code
                continue
            text = frame.data.decode("utf-8", errors="replace")
            yield CliOutput(text=text, is_stderr=frame.channel == CHANNEL_STDERR)


__all__ = [
    "RpcIn",
    "RpcOut",
    "RpcErr",
    "Request",
    "Response",
    "CliOutput",
    "StreamResult",
]
