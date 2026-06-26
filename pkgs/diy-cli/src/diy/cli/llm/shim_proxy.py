"""
shim_proxy — 透明拦截代理 for Google Gemini API

用途：拦截 pi/hermes/opencode 到 Gemini API 的请求，用于监控/审计/调试。
定位：协议透传层，不改请求内容，只做日志 + 可扩展拦截。
"""

import os
import json
import time
import logging
from datetime import datetime, timezone

import httpx
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("shim")

app = FastAPI(title="Shim Proxy (Gemini Monitor)")

# ── 目标上游 ──────────────────────────────────────────────
UPSTREAM_BASE = "https://generativelanguage.googleapis.com"

# ── 日志文件（JSONL 格式，按天滚动） ─────────────────────
LOG_DIR = os.environ.get("SHIM_LOG_DIR", "/tmp/shim-logs")
os.makedirs(LOG_DIR, exist_ok=True)


def _log_interaction(entry: dict):
    """记录一次请求-响应交互到 JSONL 文件。"""
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_path = os.path.join(LOG_DIR, f"shim-{date_str}.jsonl")
    with open(log_path, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def proxy(path: str, request: Request):
    """透明代理：拦截所有请求，记录日志，转发到上游。"""
    start = time.time()
    
    # ── 1. 读取请求体 ────────────────────────────────────
    body_bytes = await request.body()
    body_str = body_bytes.decode("utf-8") if body_bytes else ""
    
    # ── 2. 构造上游 URL ──────────────────────────────────
    upstream_url = f"{UPSTREAM_BASE}/{path}"
    query = str(request.query_params)
    if query:
        upstream_url += f"?{query}"
    
    # ── 3. 透传请求头（保留 auth header） ─────────────────
    headers = dict(request.headers)
    # FastAPI 会把 host 改为 proxy 自身的 host，需要恢复
    headers.pop("host", None)
    
    # ── 4. 转发请求 ──────────────────────────────────────
    async with httpx.AsyncClient(timeout=60.0) as client:
        upstream_resp = await client.request(
            method=request.method,
            url=upstream_url,
            headers=headers,
            content=body_bytes,
        )
    
    elapsed = time.time() - start
    
    # ── 5. 读取上游响应体 ────────────────────────────────
    resp_body = upstream_resp.content
    resp_text = resp_body.decode("utf-8", errors="replace")
    
    # ── 6. 记录日志 ──────────────────────────────────────
    log_entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "method": request.method,
        "path": f"/{path}",
        "query": query or None,
        "status": upstream_resp.status_code,
        "elapsed_ms": round(elapsed * 1000, 2),
        "model": _extract_model(path, body_str, resp_text),
        "request_body": _truncate(body_str, 2000),
        "response_body": _truncate(resp_text, 2000),
        "error": resp_text if upstream_resp.status_code >= 400 else None,
    }
    _log_interaction(log_entry)
    
    # 控制台简要输出
    status_icon = "✅" if upstream_resp.is_success else "❌"
    log.info(
        f"{status_icon} {request.method} /{path} → {upstream_resp.status_code} "
        f"({log_entry['elapsed_ms']}ms) "
        f"model={log_entry['model'] or 'N/A'}"
    )
    
    # ── 7. 返回上游响应 ──────────────────────────────────
    return Response(
        content=resp_body,
        status_code=upstream_resp.status_code,
        headers=dict(upstream_resp.headers),
    )


def _extract_model(path: str, req_body: str, resp_body: str) -> str | None:
    """从请求路径或请求/响应体中提取模型名。"""
    # 先尝试从 URL 路径提取: /v1beta/models/gemini-2.5-flash:generateContent
    import re
    m = re.search(r"/models/([^:/?]+)", path)
    if m:
        return m.group(1)
    # 回退：从请求/响应体提取
    for text in (req_body, resp_body):
        try:
            obj = json.loads(text) if text else {}
            if isinstance(obj, dict):
                model = obj.get("model", "")
                if isinstance(model, str) and model:
                    return model.removeprefix("models/")
        except (json.JSONDecodeError, AttributeError):
            pass
    return None


def _truncate(text: str, max_len: int) -> str:
    """截断长文本。"""
    return text[:max_len] + "..." if len(text) > max_len else text


if __name__ == "__main__":
    print(f"🚀 Shim Proxy 启动 — 监听 http://127.0.0.1:8000")
    print(f"📝 日志目录: {LOG_DIR}")
    print(f"⬆️  上游: {UPSTREAM_BASE}")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
