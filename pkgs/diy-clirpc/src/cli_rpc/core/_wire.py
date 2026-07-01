"""Wire logging — 受 CLI_RPC_WIRE 环境变量控制"""

from __future__ import annotations

import json
import os
import sys
import traceback as _tb
from datetime import datetime as _dt

_wire_logger = None


def _wire_enabled() -> bool:
    return os.environ.get("CLI_RPC_WIRE", "") == "1"


def _wire_log(event: str, *, _side: str = "", **kw):
    """Shared wire log — 受 CLI_RPC_WIRE env var 控制。"""
    if not _wire_enabled():
        return
    global _wire_logger
    if _wire_logger is None:
        _wire_logger = __import__("logging").getLogger("cli_rpc.wire")
        if not _wire_logger.handlers:
            _h = __import__("logging").StreamHandler(sys.stderr)
            _h.setFormatter(__import__("logging").Formatter("%(message)s"))
            _wire_logger.addHandler(_h)
            _wire_logger.setLevel(__import__("logging").INFO)
    _frames = _tb.extract_stack(limit=3)
    _caller = f"{_frames[1].filename.split('/')[-1]}:{_frames[1].lineno}"
    entry = {
        "ts": _dt.now().astimezone().isoformat(timespec="milliseconds"),
        "event": event,
        "caller": _caller,
    }
    if _side:
        entry["side"] = _side
    entry.update(kw)
    _wire_logger.info(json.dumps(entry, ensure_ascii=False, default=str))


# backward compat alias: client wire log is just _wire_log with side="client"
_client_wire_log = lambda event, **kw: _wire_log(event, _side="client", **kw)


def _msg_to_json(msg) -> str:
    if msg is None:
        return "null"
    return msg.to_json()


__all__ = ["_wire_log", "_wire_enabled", "_msg_to_json", "_client_wire_log"]
