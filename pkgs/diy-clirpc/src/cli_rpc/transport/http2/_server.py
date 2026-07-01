"""HTTP/2 RPC 服务端 — Starlette ASGI app，纯 JSON 帧协议。"""

from __future__ import annotations

import asyncio
import json
import logging
import sys

from cli_rpc.core._dispatch import Dispatch
from cli_rpc.core._drain import (
    _control_frame,
    _drain_response_frames,
    _drain_response_text,
    _make_request_response,
)
from cli_rpc.core._protocol import (
    CHANNEL_CONTROL,
    CHANNEL_STDERR,
    CHANNEL_STDIN,
    RawFrame,
)
from cli_rpc.core._wire import _wire_log
from cli_rpc.transport.http2._protocol import (
    STREAM_ENDPOINT,
    UNARY_ENDPOINT,
    decode_frame,
    encode_frame,
)
from starlette.applications import Starlette
from starlette.requests import Request as StarletteRequest
from starlette.responses import JSONResponse, PlainTextResponse, StreamingResponse
from starlette.routing import Route

_log = logging.getLogger("cli_rpc.http2")
_log.setLevel(logging.WARNING)
if not _log.handlers:
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("%(message)s"))
    _log.addHandler(_h)


# ── Unary ──


async def _handle_unary(request: StarletteRequest, dispatch: Dispatch):
    """Unary RPC: JSON in → JSON out"""
    body = await request.json()
    argv = body.get("argv", [])
    _wire_log("unary.ctx", _side="server", argv=argv)

    stdin_q = asyncio.Queue()
    req, resp = _make_request_response(argv, dict(request.headers), stdin_q)
    stdin_q.put_nowait(None)

    try:
        exit_code = await dispatch.execute(argv, req, resp)
    except Exception as e:
        _log.warning("unary error: %s", e)
        exit_code = 1

    stdout, stderr = _drain_response_text(resp)
    return JSONResponse(
        {
            "exit_code": exit_code,
            "stdout": stdout,
            "stderr": stderr,
        }
    )


# ── Stream ──


async def _handle_stream(request: StarletteRequest, dispatch: Dispatch):
    """Stream RPC: JSON/NDJSON request → JSON 帧流"""
    content_type = request.headers.get("content-type", "")
    raw_body = await request.body()

    argv = []
    stdin_q = asyncio.Queue()
    is_ndjson = "ndjson" in content_type

    if not is_ndjson:
        obj = json.loads(raw_body)
        argv = obj.get("argv", [])
        _wire_log("stream.ctx", _side="server", argv=argv)
        stdin_q.put_nowait(None)
    else:
        # NDJSON: 按行解析，第一行是 argv，后续是 stdin 帧
        lines = raw_body.decode("utf-8").strip().split("\n")
        if lines and lines[0].strip():
            obj = json.loads(lines[0].strip())
            argv = obj.get("argv", [])
        for line in lines[1:]:
            line = line.strip()
            if not line:
                continue
            frame = decode_frame(line)
            if frame is None:
                continue
            if frame.channel == CHANNEL_STDIN:
                stdin_q.put_nowait(frame.data)
            elif frame.channel == CHANNEL_CONTROL:
                pass  # EOF marker
        stdin_q.put_nowait(None)

    req, resp = _make_request_response(argv, dict(request.headers), stdin_q)

    async def _stream():
        seq = [0]

        def _log_frame(encoded: bytes, frame: RawFrame, direction="send"):
            seq[0] += 1
            _wire_log(
                "frame",
                _side="server",
                method="stream",
                dir=direction,
                seq=seq[0],
                data_text=frame.data.decode("utf-8", errors="replace")
                if frame.data
                else "",
            )
            return encoded

        try:
            exit_code = await dispatch.execute(argv, req, resp)
        except Exception as e:
            _log.warning("stream error: %s", e)
            f = RawFrame(
                channel=CHANNEL_STDERR, data=f"{type(e).__name__}: {e}\n".encode()
            )
            yield _log_frame(encode_frame(f), f)
            c = _control_frame(1)
            yield _log_frame(encode_frame(c), c)
            return

        async for frame in _drain_response_frames(resp):
            yield _log_frame(encode_frame(frame), frame)
        c = _control_frame(resp.exit_code)
        yield _log_frame(encode_frame(c), c)

    return StreamingResponse(
        _stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── App ──


def make_http2_app(dispatch: Dispatch) -> Starlette:
    """创建 HTTP/2 RPC 服务的 Starlette ASGI app。"""

    async def unary_view(request: StarletteRequest):
        return await _handle_unary(request, dispatch)

    async def stream_view(request: StarletteRequest):
        return await _handle_stream(request, dispatch)

    routes = [
        Route("/healthz", lambda _: PlainTextResponse("OK")),
        Route(UNARY_ENDPOINT, unary_view, methods=["POST"]),
        Route(STREAM_ENDPOINT, stream_view, methods=["POST"]),
    ]
    return Starlette(routes=routes)


__all__ = ["make_http2_app"]
