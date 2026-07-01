"""HTTP/2 客户端 — 使用 h2 库实现真实的 HTTP/2 cleartext (h2c) 连接。

与 httpx 不同，h2 不依赖 TLS 协商，直接发 HTTP/2 前言帧，
适用于 hypercorn 等服务端。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import h2.config
import h2.connection
import h2.events
from cli_rpc.core._protocol import (
    RawResponse,
)
from cli_rpc.core._types import StreamResult
from cli_rpc.core._wire import _client_wire_log, _msg_to_json
from cli_rpc.transport.http2._protocol import (
    STREAM_ENDPOINT,
    UNARY_ENDPOINT,
    decode_frame,
)


class H2RpcClient:
    """HTTP/2 RPC 客户端 — 使用 h2 库实现真实 HTTP/2 (h2c)。

    不依赖 httpx，直接通过 h2 库在 TCP 上建立 HTTP/2 连接。
    """

    def __init__(self, addr: str):
        self._addr = addr.rstrip("/")
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._conn: h2.connection.H2Connection | None = None

    async def _connect(self):
        host, port = self._addr.replace("http://", "").split(":")
        port = int(port) if port else 8321
        self._reader, self._writer = await asyncio.open_connection(host, port)
        cfg = h2.config.H2Configuration(client_side=True, header_encoding="utf-8")
        self._conn = h2.connection.H2Connection(config=cfg)
        self._conn.initiate_connection()
        self._writer.write(self._conn.data_to_send())
        await self._writer.drain()
        # 读 SETTINGS
        data = await asyncio.wait_for(self._reader.read(65535), timeout=10)
        events = self._conn.receive_data(data)
        self._writer.write(self._conn.data_to_send())
        await self._writer.drain()
        return events

    async def _send_request(
        self, path: str, body: bytes, headers: list
    ) -> tuple[int, bytes]:
        """在 HTTP/2 流上发送请求并读取完整响应。"""
        sid = self._conn.get_next_available_stream_id()
        self._conn.send_headers(sid, headers, end_stream=False)
        self._conn.send_data(sid, body, end_stream=True)
        self._writer.write(self._conn.data_to_send())
        await self._writer.drain()

        status = 0
        resp_data = b""
        while True:
            d = await asyncio.wait_for(self._reader.read(65535), timeout=30)
            if not d:
                break
            for ev in self._conn.receive_data(d):
                if isinstance(ev, h2.events.ResponseReceived):
                    headers_dict = dict(ev.headers)
                    status = int(headers_dict.get(":status", 0))
                elif isinstance(ev, h2.events.DataReceived):
                    resp_data += ev.data
                    self._conn.acknowledge_received_data(
                        ev.flow_controlled_length, ev.stream_id
                    )
                elif isinstance(ev, h2.events.StreamEnded):
                    pass
            self._writer.write(self._conn.data_to_send())
            await self._writer.drain()
            # 检查流是否关闭
            stream = self._conn.streams.get(sid)
            if stream and stream.closed:
                break
            if resp_data:
                # 收到了数据就退出（unary 完整响应）
                break
        return status, resp_data

    async def _send_request_stream(
        self,
        path: str,
        body: bytes,
        headers: list,
    ) -> tuple[int, AsyncIterator[bytes]]:
        """发送请求并返回流式响应迭代器。"""
        sid = self._conn.get_next_available_stream_id()
        self._conn.send_headers(sid, headers, end_stream=False)
        self._conn.send_data(sid, body, end_stream=True)
        self._writer.write(self._conn.data_to_send())
        await self._writer.drain()

        async def _stream():
            nonlocal sid
            buf = b""
            while True:
                d = await asyncio.wait_for(self._reader.read(65535), timeout=30)
                if not d:
                    break
                for ev in self._conn.receive_data(d):
                    if isinstance(ev, h2.events.ResponseReceived):
                        pass  # status headers, ignore
                    elif isinstance(ev, h2.events.DataReceived):
                        buf += ev.data
                        self._conn.acknowledge_received_data(
                            ev.flow_controlled_length, ev.stream_id
                        )
                        # 按行 yield
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            yield line + b"\n"
                    elif isinstance(ev, h2.events.StreamEnded):
                        if buf:  # 剩余数据
                            yield buf
                        return
                self._writer.write(self._conn.data_to_send())
                await self._writer.drain()

        return sid, _stream()

    async def __aenter__(self):
        await self._connect()
        return self

    async def __aexit__(self, *args):
        if self._writer:
            self._writer.close()
        self._reader = None
        self._writer = None
        self._conn = None

    # ── Unary ──

    async def unary(self, *argv: str) -> RawResponse:
        body = json.dumps({"argv": list(argv)}).encode("utf-8")
        headers = [
            (":method", "POST"),
            (":path", UNARY_ENDPOINT),
            (":authority", self._addr.lstrip("http://")),
            (":scheme", "http"),
            ("content-type", "application/json"),
            ("content-length", str(len(body))),
        ]
        _client_wire_log(
            "frame", seq=1, method="unary", dir="send", data_text=body.decode("utf-8")
        )
        status, data = await self._send_request(UNARY_ENDPOINT, body, headers)
        _client_wire_log(
            "frame", seq=2, method="unary", dir="recv", data_text=data.decode("utf-8")
        )
        result = json.loads(data)
        resp = RawResponse(
            exit_code=result.get("exit_code", 1),
            stdout=result.get("stdout", "").encode("utf-8"),
            stderr=result.get("stderr", "").encode("utf-8"),
        )
        _client_wire_log("unary.recv", resp=_msg_to_json(resp), argv=list(argv))
        return resp

    # ── Stream ──

    def stream(
        self,
        *argv: str,
        stdin: AsyncIterator[bytes] | None = None,
    ) -> StreamResult:
        if stdin is None:
            body = json.dumps({"argv": list(argv)}).encode("utf-8")
            headers = [
                (":method", "POST"),
                (":path", STREAM_ENDPOINT),
                (":authority", self._addr.lstrip("http://")),
                (":scheme", "http"),
                ("content-type", "application/json"),
                ("content-length", str(len(body))),
            ]
            return StreamResult(self._stream_inner(body, headers))
        else:
            # NDJSON: 提前读取 stdin（stream() 是同步方法）
            return StreamResult(self._stream_duplex(argv, stdin))

    async def _stream_duplex(self, argv: list[str], stdin: AsyncIterator[bytes]):
        lines = [json.dumps({"argv": argv})]
        async for chunk in stdin:
            lines.append(
                json.dumps({"ch": 0, "d": chunk.decode("utf-8", errors="replace")})
            )
        lines.append(json.dumps({"ch": 3, "exit": 0}))
        body = ("\n".join(lines) + "\n").encode("utf-8")
        headers = [
            (":method", "POST"),
            (":path", STREAM_ENDPOINT),
            (":authority", self._addr.lstrip("http://")),
            (":scheme", "http"),
            ("content-type", "application/x-ndjson"),
            ("content-length", str(len(body))),
        ]
        sid = self._conn.get_next_available_stream_id()
        self._conn.send_headers(sid, headers, end_stream=False)
        self._conn.send_data(sid, body, end_stream=True)
        self._writer.write(self._conn.data_to_send())
        await self._writer.drain()

        async for frame in self._read_stream_frames(sid):
            yield frame

    async def _read_stream_frames(self, sid: int):
        """Read frames from a stream until end, logging wire frames."""
        seq = [0]
        buf = b""
        while True:
            d = await asyncio.wait_for(self._reader.read(65535), timeout=30)
            if not d:
                break
            for ev in self._conn.receive_data(d):
                if isinstance(ev, h2.events.DataReceived):
                    buf += ev.data
                    self._conn.acknowledge_received_data(
                        ev.flow_controlled_length, ev.stream_id
                    )
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        frame = decode_frame(line.decode("utf-8"))
                        if frame is not None:
                            seq[0] += 1
                            _client_wire_log(
                                "frame",
                                seq=seq[0],
                                method="stream",
                                dir="recv",
                                data_text=line.decode("utf-8", errors="replace"),
                            )
                            yield frame
                elif isinstance(ev, h2.events.StreamEnded):
                    if buf:
                        line = buf.strip()
                        if line:
                            frame = decode_frame(line.decode("utf-8"))
                            if frame is not None:
                                seq[0] += 1
                                _client_wire_log(
                                    "frame",
                                    seq=seq[0],
                                    method="stream",
                                    dir="recv",
                                    data_text=line.decode("utf-8", errors="replace"),
                                )
                                yield frame
                    return
            self._writer.write(self._conn.data_to_send())
            await self._writer.drain()

    async def _stream_inner(self, body: bytes, headers: list):
        sid = self._conn.get_next_available_stream_id()
        self._conn.send_headers(sid, headers, end_stream=False)
        self._conn.send_data(sid, body, end_stream=True)
        self._writer.write(self._conn.data_to_send())
        await self._writer.drain()

        async for frame in self._read_stream_frames(sid):
            yield frame


__all__ = ["H2RpcClient"]
