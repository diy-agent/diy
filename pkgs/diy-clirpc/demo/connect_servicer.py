"""connect_servicer — 真正的 ConnectRPC 类型安全 Servicer

实现 CycloptsCommands Protocol（由 buf 从 proto 生成），
内部委托给 CycloptsDispatch。

用法:
    uvicorn demo.connect_servicer:app
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from connectrpc.request import RequestContext
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Mount, Route

from cli_rpc.cli.cyclopts._dispatch import CycloptsDispatch
from cli_rpc.core._drain import (
    _drain_response_frames,
    _drain_response_text,
    _make_request_response,
)
from demo.commands import diy
from demo.gen.gen.cli_rpc_gen_connect import (
    CycloptsCommands,
    CycloptsCommandsASGIApplication,
)
from demo.gen.gen.cli_rpc_gen_pb import (
    ChatRequest,
    ChatResponse,
    CountBytesRequest,
    CountBytesResponse,
    LogTailRequest,
    LogTailResponse,
    RefSyncRequest,
    RefSyncResponse,
    TaskDetailRequest,
    TaskDetailResponse,
    TaskListRequest,
    TaskListResponse,
    UiStatusRequest,
    UiStatusResponse,
    UiTreeRequest,
    UiTreeResponse,
)


class CycloptsConnectServicer(CycloptsCommands):
    """ConnectRPC 类型安全 Servicer — 每个 RPC 方法路由到 Cyclopts 命令。"""

    def __init__(self, dispatch: CycloptsDispatch):
        self._dispatch = dispatch

    # ── unary: task-list ──

    async def task_list(
        self, request: TaskListRequest, ctx: RequestContext[TaskListRequest, TaskListResponse]
    ) -> TaskListResponse:
        argv = ["task-list"]
        stdin_q = asyncio.Queue()
        stdin_q.put_nowait(None)
        req, resp = _make_request_response(argv, dict(ctx.request_headers), stdin_q)
        await self._dispatch.execute(argv, req, resp)
        out_text, err_text = _drain_response_text(resp)
        return TaskListResponse(exit_code=resp.exit_code, stdout=out_text, stderr=err_text)

    # ── unary: task-detail ──

    async def task_detail(
        self, request: TaskDetailRequest, ctx: RequestContext[TaskDetailRequest, TaskDetailResponse]
    ) -> TaskDetailResponse:
        argv = ["task-detail", request.uri]
        stdin_q = asyncio.Queue()
        stdin_q.put_nowait(None)
        req, resp = _make_request_response(argv, dict(ctx.request_headers), stdin_q)
        await self._dispatch.execute(argv, req, resp)
        out_text, err_text = _drain_response_text(resp)
        return TaskDetailResponse(exit_code=resp.exit_code, stdout=out_text, stderr=err_text)

    # ── unary: ref-sync ──

    async def ref_sync(
        self, request: RefSyncRequest, ctx: RequestContext[RefSyncRequest, RefSyncResponse]
    ) -> RefSyncResponse:
        argv = ["ref-sync"]
        stdin_q = asyncio.Queue()
        stdin_q.put_nowait(None)
        req, resp = _make_request_response(argv, dict(ctx.request_headers), stdin_q)
        await self._dispatch.execute(argv, req, resp)
        out_text, err_text = _drain_response_text(resp)
        return RefSyncResponse(exit_code=resp.exit_code, stdout=out_text, stderr=err_text)

    # ── serverStream: log-tail ──

    async def log_tail(
        self, request: LogTailRequest, ctx: RequestContext[LogTailRequest, LogTailResponse]
    ) -> AsyncIterator[LogTailResponse]:
        argv = ["log-tail"]
        stdin_q = asyncio.Queue()
        stdin_q.put_nowait(None)
        req, resp = _make_request_response(argv, dict(ctx.request_headers), stdin_q)
        await self._dispatch.execute(argv, req, resp)
        async for frame in _drain_response_frames(resp):
            yield LogTailResponse(
                channel=frame.channel,
                data=frame.data.decode("utf-8", errors="replace"),
            )
        yield LogTailResponse(exit_code=resp.exit_code)

    # ── clientStream: chat ──

    async def chat(
        self, request: AsyncIterator[ChatRequest], ctx: RequestContext[ChatRequest, ChatResponse]
    ) -> ChatResponse:
        argv = ["chat"]
        stdin_q = asyncio.Queue()
        async for chunk in request:
            if chunk.stdin:
                stdin_q.put_nowait(bytes(chunk.stdin))
        stdin_q.put_nowait(None)
        req, resp = _make_request_response(argv, dict(ctx.request_headers), stdin_q)
        await self._dispatch.execute(argv, req, resp)
        out_text, err_text = _drain_response_text(resp)
        return ChatResponse(exit_code=resp.exit_code, stdout=out_text, stderr=err_text)

    # ── clientStream: count-bytes ──

    async def count_bytes(
        self, request: AsyncIterator[CountBytesRequest], ctx: RequestContext[CountBytesRequest, CountBytesResponse]
    ) -> CountBytesResponse:
        argv = ["count-bytes"]
        stdin_q = asyncio.Queue()
        async for chunk in request:
            if chunk.stdin:
                stdin_q.put_nowait(bytes(chunk.stdin))
        stdin_q.put_nowait(None)
        req, resp = _make_request_response(argv, dict(ctx.request_headers), stdin_q)
        await self._dispatch.execute(argv, req, resp)
        out_text, err_text = _drain_response_text(resp)
        return CountBytesResponse(exit_code=resp.exit_code, stdout=out_text, stderr=err_text)

    # ── unary: ui status ──

    async def ui_status(
        self, request: UiStatusRequest, ctx: RequestContext[UiStatusRequest, UiStatusResponse]
    ) -> UiStatusResponse:
        argv = ["ui", "status"]
        stdin_q = asyncio.Queue()
        stdin_q.put_nowait(None)
        req, resp = _make_request_response(argv, dict(ctx.request_headers), stdin_q)
        await self._dispatch.execute(argv, req, resp)
        out_text, err_text = _drain_response_text(resp)
        return UiStatusResponse(exit_code=resp.exit_code, stdout=out_text, stderr=err_text)

    # ── unary: ui tree ──

    async def ui_tree(
        self, request: UiTreeRequest, ctx: RequestContext[UiTreeRequest, UiTreeResponse]
    ) -> UiTreeResponse:
        argv = ["ui", "tree"]
        stdin_q = asyncio.Queue()
        stdin_q.put_nowait(None)
        req, resp = _make_request_response(argv, dict(ctx.request_headers), stdin_q)
        await self._dispatch.execute(argv, req, resp)
        out_text, err_text = _drain_response_text(resp)
        return UiTreeResponse(exit_code=resp.exit_code, stdout=out_text, stderr=err_text)


# ════════════════════════════════════════════════════════════
# ASGI app
# ════════════════════════════════════════════════════════════

dispatch = CycloptsDispatch(diy)
servicer = CycloptsConnectServicer(dispatch)
rpc_app = CycloptsCommandsASGIApplication(servicer)

app = Starlette(
    routes=[
        Route("/healthz", lambda _: PlainTextResponse("OK")),
        Mount(rpc_app.path, rpc_app),
    ]
)


def main():
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8322, log_level="info")


if __name__ == "__main__":
    main()
