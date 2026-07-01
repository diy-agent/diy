"""core — 传输层和 CLI 框架无关的核心抽象"""

from cli_rpc.core._dispatch import Dispatch, DispatchResult
from cli_rpc.core._drain import (
    _control_frame,
    _drain_queue,
    _drain_response_frames,
    _drain_response_text,
    _frame_logger,
    _make_request_response,
    _stdin_feeder,
    _stdin_reader,
)
from cli_rpc.core._protocol import (
    CHANNEL_CONTROL,
    CHANNEL_STDERR,
    CHANNEL_STDIN,
    CHANNEL_STDOUT,
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
from cli_rpc.core._wire import _client_wire_log, _msg_to_json, _wire_enabled, _wire_log

__all__ = [
    "RpcIn",
    "RpcOut",
    "RpcErr",
    "Request",
    "Response",
    "CliOutput",
    "StreamResult",
    "Channel",
    "RawFrame",
    "RawRequest",
    "RawResponse",
    "CHANNEL_STDIN",
    "CHANNEL_STDOUT",
    "CHANNEL_STDERR",
    "CHANNEL_CONTROL",
    "_wire_log",
    "_wire_enabled",
    "_msg_to_json",
    "_client_wire_log",
    "_drain_queue",
    "_drain_response_text",
    "_drain_response_frames",
    "_make_request_response",
    "_control_frame",
    "_frame_logger",
    "_stdin_reader",
    "_stdin_feeder",
    "Dispatch",
    "DispatchResult",
]
