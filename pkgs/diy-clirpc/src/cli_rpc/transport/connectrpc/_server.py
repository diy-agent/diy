"""ConnectRPC 传输层 — RoutedCliRpcService

依赖关系：core（Dispatch 接口 + 类型 + drain）→ connect（传输层实现）。
对 Cyclopts 零依赖——CLI 框架通过 Dispatch 抽象注入。
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from cli_rpc.core._dispatch import Dispatch
from cli_rpc.core._drain import (
    _control_frame,
    _drain_response_frames,
    _drain_response_text,
    _frame_logger,
    _make_request_response,
    _stdin_reader,
)
from cli_rpc.core._protocol import (
    CHANNEL_STDERR,
    CHANNEL_STDIN,
    RawFrame,
    RawRequest,
    RawResponse,
)
from cli_rpc.core._wire import _msg_to_json, _wire_log
from cli_rpc.transport.connectrpc.gen.cli_rpc_connect import (
    CliRpcService,
    CliRpcServiceASGIApplication,
)
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Mount, Route

if TYPE_CHECKING:
    from connectrpc.request import RequestContext

_log = logging.getLogger("cli_rpc")
_log.setLevel(logging.WARNING)
if not _log.handlers:
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("%(message)s"))
    _log.addHandler(_h)


# ── 传输层辅助 ──


def _argv_from_headers(ctx: RequestContext) -> list[str]:
    raw = ctx.request_headers.get("diy-cli-argv", "[]")
    try:
        return json.loads(raw)
    except Exception:
        return []


def _all_headers(ctx: RequestContext) -> dict[str, str]:
    return dict(ctx.request_headers)


def _ctx_dump(ctx: RequestContext) -> dict:
    d = {"http_method": ctx.http_method, "headers": _all_headers(ctx)}
    try:
        m = ctx.method
        d["method"] = {"name": m.name}
        if hasattr(m, "service"):
            d["method"]["service"] = str(m.service)
    except Exception:
        d["method"] = str(ctx.method)
    if ctx.timeout_ms is not None:
        d["timeout_ms"] = ctx.timeout_ms
    return d


# ════════════════════════════════════════════════════════════
# RoutedCliRpcService
# ════════════════════════════════════════════════════════════


class RoutedCliRpcService(CliRpcService):
    """通过 Dispatch 接口将 RPC 请求路由到命令 handler。

    纯传输层职责：
    - 创建 per-request stdin 队列 + Request/Response
    - 调用 dispatch.execute 执行命令
    - 将 response 队列输出转为 RawFrame/RawResponse
    - 转发 exit_code

    注入 dispatch 实例实现 CLI 框架无关性。
    """

    def __init__(self, dispatch: Dispatch):
        self._dispatch = dispatch

    # ── unary ────────────────────────────────────────────────

    async def unary(self, request: RawRequest, ctx: RequestContext) -> RawResponse:
        _wire_log(
            "unary.ctx",
            _side="server",
            ctx=_ctx_dump(ctx),
            request=_msg_to_json(request),
        )
        argv = _argv_from_headers(ctx) or (list(request.argv) if request.argv else [])

        stdin_q = asyncio.Queue()
        req, resp = _make_request_response(argv, _all_headers(ctx), stdin_q)

        try:
            await self._dispatch.execute(argv, req, resp)
            handler_out, handler_err = _drain_response_text(resp)
            return RawResponse(
                exit_code=resp.exit_code,
                stdout=handler_out.encode(),
                stderr=handler_err.encode(),
            )
        except Exception as e:
            _wire_log("unary.exception", _side="server", error=str(e))
            err_text = f"{type(e).__name__}: {e}\n"
            return RawResponse(exit_code=1, stderr=err_text.encode())

    # ── serverStream ─────────────────────────────────────────

    def server_stream(
        self, request: RawRequest, ctx: RequestContext
    ) -> AsyncIterator[RawFrame]:
        async def gen():
            send = _frame_logger("serverStream", "send")
            _wire_log(
                "server_stream.ctx",
                _side="server",
                ctx=_ctx_dump(ctx),
                request=_msg_to_json(request),
            )
            argv = _argv_from_headers(ctx) or (
                list(request.argv) if request.argv else []
            )

            stdin_q = asyncio.Queue()
            req, resp = _make_request_response(argv, _all_headers(ctx), stdin_q)

            try:
                await self._dispatch.execute(argv, req, resp)
                async for frame in _drain_response_frames(resp):
                    yield send(frame)
                yield send(_control_frame(resp.exit_code))
            except Exception as e:
                _wire_log("server_stream.exception", _side="server", error=str(e))
                err_text = f"{type(e).__name__}: {e}\n"
                yield send(RawFrame(channel=CHANNEL_STDERR, data=err_text.encode()))
                yield send(_control_frame(1))

        return gen()

    # ── clientStream ─────────────────────────────────────────

    async def client_stream(
        self, request: AsyncIterator[RawFrame], ctx: RequestContext
    ) -> RawResponse:
        _wire_log("client_stream.ctx", _side="server", ctx=_ctx_dump(ctx))
        argv = _argv_from_headers(ctx)
        stdin_data = await _stdin_reader(request)

        stdin_q = asyncio.Queue()
        req, resp = _make_request_response(argv, _all_headers(ctx), stdin_q)
        for chunk in [
            stdin_data[i : i + 4096] for i in range(0, len(stdin_data), 4096)
        ]:
            stdin_q.put_nowait(chunk)
        stdin_q.put_nowait(None)

        try:
            await self._dispatch.execute(argv, req, resp)
            handler_out, handler_err = _drain_response_text(resp)
            return RawResponse(
                exit_code=resp.exit_code,
                stdout=handler_out.encode(),
                stderr=handler_err.encode(),
            )
        except Exception as e:
            _wire_log("client_stream.exception", _side="server", error=str(e))
            err_text = f"{type(e).__name__}: {e}\n"
            return RawResponse(exit_code=1, stderr=err_text.encode())

    # ── duplexStream ─────────────────────────────────────────

    def duplex_stream(
        self, request: AsyncIterator[RawFrame], ctx: RequestContext
    ) -> AsyncIterator[RawFrame]:
        async def gen():
            send = _frame_logger("duplexStream", "send")
            recv = _frame_logger("duplexStream", "recv")

            _wire_log("duplex_stream.ctx", _side="server", ctx=_ctx_dump(ctx))
            argv = _argv_from_headers(ctx)

            stdin_q = asyncio.Queue()
            req, resp = _make_request_response(argv, _all_headers(ctx), stdin_q)

            try:
                # duplex: 先喂 stdin，再执行
                async for frame in request:
                    recv(frame)
                    if frame.channel == CHANNEL_STDIN:
                        stdin_q.put_nowait(frame.data)
                stdin_q.put_nowait(None)

                await self._dispatch.execute(argv, req, resp)

                async for frame in _drain_response_frames(resp):
                    yield send(frame)
                yield send(_control_frame(resp.exit_code))
            except Exception as e:
                _wire_log("duplex_stream.exception", _side="server", error=str(e))
                err_text = f"{type(e).__name__}: {e}\n"
                yield send(RawFrame(channel=CHANNEL_STDERR, data=err_text.encode()))
                yield send(_control_frame(1))

        return gen()


# ════════════════════════════════════════════════════════════
# Factory 函数
# ════════════════════════════════════════════════════════════


def make_service(dispatch: Dispatch) -> RoutedCliRpcService:
    """创建 RoutedCliRpcService 实例。

    Args:
        dispatch: CLI 框架的 Dispatch 实现（如 CycloptsDispatch）
    """
    return RoutedCliRpcService(dispatch)


def make_app(svc: RoutedCliRpcService, *, healthz_path: str = "/healthz") -> Starlette:
    """包装 RoutedCliRpcService 为 Starlette ASGI app。"""
    rpc_app = CliRpcServiceASGIApplication(svc)
    routes = [
        Route(healthz_path, lambda _: PlainTextResponse("OK")),
        Mount(rpc_app.path, rpc_app),
    ]
    return Starlette(routes=routes)


__all__ = [
    "RoutedCliRpcService",
    "make_service",
    "make_app",
]
