"""cli_rpc -- CLI-as-API over ConnectRPC / HTTP/2

核心抽象在 cli_rpc.core，Cyclopts 绑定在 cli_rpc.cyclopts，传输层可切换。
本模块提供向后兼容的顶级导出 + CliRpc.create() 工厂。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Literal

from cli_rpc.core._protocol import (
    Channel,
    RawFrame,
    RawRequest,
    RawResponse,
)
from cli_rpc.core._types import (
    CliOutput,
    Request,
    Response,
    RpcErr,
    RpcIn,
    RpcOut,
    StreamResult,
)
from cli_rpc.core._wire import (
    _client_wire_log,
    _msg_to_json,
    _wire_enabled,
    _wire_log,
)
from cli_rpc.transport.connectrpc.gen.cli_rpc_connect import (
    CliRpcService,
    CliRpcServiceASGIApplication,
    CliRpcServiceClient,
)

# -- 通道常量 --
CHANNEL_STDIN = Channel.STDIN
CHANNEL_STDOUT = Channel.STDOUT
CHANNEL_STDERR = Channel.STDERR
CHANNEL_CONTROL = Channel.CONTROL

TransportType = Literal["connect", "http2"]

__all__ = [
    "Channel",
    "RawFrame",
    "RawRequest",
    "RawResponse",
    "Request",
    "Response",
    "RpcIn",
    "RpcOut",
    "RpcErr",
    "CliOutput",
    "StreamResult",
    "CliRpcService",
    "CliRpcServiceASGIApplication",
    "CliRpcServiceClient",
    "CliRpc",
]


# ════════════════════════════════════════════════════════════
# CliRpc -- high-level client (transport-agnostic)
# ════════════════════════════════════════════════════════════


class CliRpc:
    """CLI RPC client — 支持多种传输层后端。

    用法:
        # ConnectRPC 后端（默认）
        async with CliRpc.create("http://127.0.0.1:8321") as cli:
            resp = await cli.unary("task-list")
            async for out in cli.stream("log-tail"):
                ...

        # HTTP/2 纯 JSON 后端
        async with CliRpc.create("http://127.0.0.1:8322", transport="http2") as cli:
            resp = await cli.unary("task-list")
            ...
    """

    def __init__(self, addr: str, transport: TransportType = "connect"):
        self._addr = addr
        self._transport = transport
        self._delegate = None

        if transport == "connect":
            self._delegate = _ConnectDelegate(addr)
        elif transport == "http2":
            from cli_rpc.transport.http2._client import H2RpcClient

            self._delegate = _H2Delegate(H2RpcClient(addr))
        else:
            raise ValueError(f"Unknown transport: {transport}")

    @staticmethod
    def create(addr: str, transport: TransportType = "connect") -> CliRpc:
        """创建 CliRpc 实例"""
        return CliRpc(addr, transport)

    async def __aenter__(self):
        await self._delegate.__aenter__()
        return self

    async def __aexit__(self, *args):
        await self._delegate.__aexit__(*args)

    async def unary(self, *argv: str) -> RawResponse:
        return await self._delegate.unary(*argv)

    def stream(
        self,
        *argv: str,
        stdin: AsyncIterator[bytes] | None = None,
    ) -> StreamResult:
        return self._delegate.stream(*argv, stdin=stdin)


# ── 传输层适配器协议 ──


class _TransportDelegate:
    """传输层后端适配器接口"""

    async def __aenter__(self): ...
    async def __aexit__(self, *args): ...
    async def unary(self, *argv: str) -> RawResponse: ...
    def stream(self, *argv, stdin=None) -> StreamResult: ...


class _ConnectDelegate(_TransportDelegate):
    """ConnectRPC 后端"""

    def __init__(self, addr: str):
        self._addr = addr
        self._client: CliRpcServiceClient | None = None

    async def __aenter__(self):
        from connectrpc.codec import proto_json_codec

        self._client = CliRpcServiceClient(
            address=self._addr,
            codec=proto_json_codec(),
        )
        return self

    async def __aexit__(self, *args):
        if self._client:
            await self._client.__aexit__(*args)
            self._client = None

    async def unary(self, *argv: str) -> RawResponse:
        import json as _json

        from connectrpc._response_metadata import ResponseMetadata

        assert self._client is not None
        headers = {"diy-cli-argv": _json.dumps(list(argv))}
        rm = ResponseMetadata()
        with rm:
            resp = await self._client.unary(RawRequest(), headers=headers)
        _client_wire_log(
            "unary.recv",
            resp=_msg_to_json(resp),
            response_headers=dict(rm.headers) if rm.headers else None,
            response_trailers=dict(rm.trailers) if rm.trailers else None,
        )
        return resp

    def stream(
        self, *argv: str, stdin: AsyncIterator[bytes] | None = None
    ) -> StreamResult:
        import json as _json

        assert self._client is not None
        headers = {"diy-cli-argv": _json.dumps(list(argv))}

        if stdin is None:

            async def _iter():
                n = 0
                async for frame in self._client.server_stream(
                    RawRequest(), headers=headers
                ):
                    n += 1
                    _client_wire_log(
                        "frame",
                        seq=n,
                        method="serverStream",
                        dir="recv",
                        raw=_msg_to_json(frame),
                        data_text=frame.data.decode("utf-8", errors="replace")
                        if frame.data
                        else "",
                    )
                    yield frame

            return StreamResult(_iter())
        else:

            async def _gen():
                n = 0
                async for chunk in stdin:
                    n += 1
                    _client_wire_log(
                        "frame",
                        seq=n,
                        method="duplexStream",
                        dir="send",
                        channel="STDIN",
                        data=chunk.decode("utf-8", errors="replace"),
                    )
                    yield RawFrame(channel=CHANNEL_STDIN, data=chunk)

            async def _iter():
                n = 0
                async for frame in self._client.duplex_stream(_gen(), headers=headers):
                    n += 1
                    _client_wire_log(
                        "frame",
                        seq=n,
                        method="duplexStream",
                        dir="recv",
                        raw=_msg_to_json(frame),
                        data_text=frame.data.decode("utf-8", errors="replace")
                        if frame.data
                        else "",
                    )
                    yield frame

            return StreamResult(_iter())


class _H2Delegate(_TransportDelegate):
    """HTTP/2 h2c 后端（基于 h2 库，真实 HTTP/2）"""

    def __init__(self, client):
        self._client = client

    async def __aenter__(self):
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *args):
        await self._client.__aexit__(*args)

    async def unary(self, *argv: str) -> RawResponse:
        return await self._client.unary(*argv)

    def stream(
        self, *argv: str, stdin: AsyncIterator[bytes] | None = None
    ) -> StreamResult:
        return self._client.stream(*argv, stdin=stdin)
