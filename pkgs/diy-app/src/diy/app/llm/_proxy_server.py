"""ProxyServer — 在 app 线程内启动/停止 shim proxy。"""

from __future__ import annotations

import json
import os
import threading
from datetime import UTC, datetime

import httpx
import uvicorn
from diy.app._app_log import logger
from fastapi import FastAPI, Request, Response

SHIM_LOG_DIR = os.environ.get("SHIM_LOG_DIR", "/tmp/shim-logs")
PROXY_PORT = 8000
UPSTREAM_BASE = "https://generativelanguage.googleapis.com"


def _make_app() -> FastAPI:
    """构建 FastAPI 代理应用（每次 start 重新创建）。"""

    app = FastAPI(title="Shim Proxy")

    @app.api_route(
        "/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    )
    async def proxy(path: str, request: Request):
        """透明代理：拦截所有请求，记录日志，转发到上游。"""
        start = datetime.now(UTC)

        body_bytes = await request.body()
        body_str = body_bytes.decode("utf-8") if body_bytes else ""

        upstream_url = f"{UPSTREAM_BASE}/{path}"
        query = str(request.query_params)
        if query:
            upstream_url += f"?{query}"

        headers = dict(request.headers)
        headers.pop("host", None)

        async with httpx.AsyncClient(timeout=60.0) as client:
            upstream_resp = await client.request(
                method=request.method,
                url=upstream_url,
                headers=headers,
                content=body_bytes,
            )

        elapsed = (datetime.now(UTC) - start).total_seconds() * 1000

        resp_body = upstream_resp.content
        resp_text = resp_body.decode("utf-8", errors="replace")

        # 记录日志
        _log_entry(
            {
                "ts": start.isoformat(),
                "method": request.method,
                "path": f"/{path}",
                "query": query or None,
                "status": upstream_resp.status_code,
                "elapsed_ms": round(elapsed, 2),
                "model": _extract_model(path, body_str),
                "request_body": _truncate(body_str, 2000),
                "response_body": _truncate(resp_text, 2000),
            }
        )

        return Response(
            content=resp_body,
            status_code=upstream_resp.status_code,
            headers=dict(upstream_resp.headers),
        )

    return app


def _log_entry(entry: dict) -> None:
    """写 JSONL 日志。"""
    os.makedirs(SHIM_LOG_DIR, exist_ok=True)
    date_str = datetime.now(UTC).strftime("%Y-%m-%d")
    log_path = os.path.join(SHIM_LOG_DIR, f"shim-{date_str}.jsonl")
    try:
        with open(log_path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except OSError:
        pass


def _extract_model(path: str, body: str) -> str | None:
    """从 URL 路径提取模型名。"""
    import re

    m = re.search(r"/models/([^:/?]+)", path)
    if m:
        return m.group(1)
    return None


def _truncate(text: str, max_len: int) -> str:
    return text[:max_len] + "..." if len(text) > max_len else text


class ProxyServer:
    """代理服务器 — 在线程内运行 FastAPI/uvicorn。"""

    def __init__(self, port: int = PROXY_PORT):
        self._port = port
        self._thread: threading.Thread | None = None
        self._running = False
        self._config: uvicorn.Config | None = None
        self._server: uvicorn.Server | None = None

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def port(self) -> int:
        return self._port

    def start(self) -> None:
        """启动代理（非阻塞线程）。"""
        if self._running:
            logger.debug("[proxy] 已在运行，跳过")
            return

        app = _make_app()
        self._config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=self._port,
            log_level="warning",
            access_log=False,
        )
        self._server = uvicorn.Server(self._config)

        self._thread = threading.Thread(target=self._server.run, daemon=True)
        self._thread.start()
        self._running = True
        logger.info("[proxy] 已启动 port=%d", self._port)

    def stop(self) -> None:
        """停止代理。"""
        if not self._running or not self._server:
            return
        self._server.should_exit = True
        self._running = False
        logger.info("[proxy] 已停止")
