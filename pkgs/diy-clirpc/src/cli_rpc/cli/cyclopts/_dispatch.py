"""CycloptsDispatch — Cyclopts CLI 框架的 Dispatch 实现。

依赖关系：core → cyclopts（Dispatch 接口的 Cyclopts 实现）。
"""

from __future__ import annotations

import asyncio
import contextvars
import inspect
from typing import Annotated

from cli_rpc.core._protocol import CHANNEL_STDERR, CHANNEL_STDOUT, RawFrame
from cli_rpc.core._types import Request, Response

from cyclopts import App, Group, Parameter

# ════════════════════════════════════════════════════════════
# Context vars — per-request 透传（set 在 dispatch.execute，get 在 meta launcher）
# ════════════════════════════════════════════════════════════

_current_request = contextvars.ContextVar[Request]("_current_request")
_current_response = contextvars.ContextVar[Response]("_current_response")
_current_console = contextvars.ContextVar("_current_console")
_current_error_console = contextvars.ContextVar("_current_error_console")


# ════════════════════════════════════════════════════════════
# ConsoleToResponse — 将 Cyclopts 框架输出直接写入 Response 共享队列
# ════════════════════════════════════════════════════════════


class ConsoleToResponse:
    """Rich Console 的 file 参数，直接将框架输出写入 Response 共享队列。

    这样 handler 的输出和框架输出（help/error）都在同一个队列里，
    按写入顺序排列，传输层不用手动合并。
    """

    def __init__(self, queue: asyncio.Queue, channel: int):
        self._queue = queue
        self._channel = channel

    def write(self, data: str) -> None:
        if data:
            self._queue.put_nowait(RawFrame(channel=self._channel, data=data.encode()))

    def flush(self) -> None:
        pass


# ════════════════════════════════════════════════════════════
# Cyclopts dispatch 辅助
# ════════════════════════════════════════════════════════════


def _make_consoles(response: Response):
    """创建 per-request Cyclopts Console，直接写入 Response 共享队列。

    不再需要额外的 cyc_q_out/cyc_q_err 队列——框架输出直接进 response 共享队列。
    """
    from rich.console import Console

    con_out = Console(
        file=ConsoleToResponse(response.out._queue, CHANNEL_STDOUT),
        force_terminal=False,
        color_system=None,
        width=120,
    )
    con_err = Console(
        file=ConsoleToResponse(response.err._queue, CHANNEL_STDERR),
        force_terminal=False,
        color_system=None,
        width=120,
    )
    return con_out, con_err


def _dispatch_meta(app: App, argv: list[str], cyc_con_out, cyc_con_err):
    """通过 meta app parse_args 解析 argv，返回 (func, bound, ignored)。"""
    func, bound, ignored = app.meta.parse_args(
        argv,
        console=cyc_con_out,
        error_console=cyc_con_err,
        exit_on_error=False,
        print_error=True,
        help_on_error=False,
    )
    return func, bound, ignored


# ════════════════════════════════════════════════════════════
# Meta launcher
# ════════════════════════════════════════════════════════════


def install_meta_launcher(app: App):
    """在 app 上安装 @app.meta.default launcher。

    Launcher 从 context vars 读取 per-request Request/Response 并注入 handler。
    """
    app.meta.group_parameters = Group("RPC Parameters", sort_key=0)

    @app.meta.default
    def launcher(
        *tokens: Annotated[str, Parameter(show=False, allow_leading_hyphen=True)],
    ):
        argv = list(tokens)
        app_name = app.name if isinstance(app.name, tuple) else (app.name,)
        if argv and argv[0] in app_name:
            argv = argv[1:]

        console = _current_console.get(None)
        error_console = _current_error_console.get(None)
        additional_kwargs = {}
        try:
            command, bound, ignored = app.parse_args(
                argv,
                console=console,
                error_console=error_console,
                print_error=True,
                exit_on_error=False,
            )
            if "request" in ignored:
                additional_kwargs["request"] = _current_request.get()
            if "response" in ignored:
                additional_kwargs["response"] = _current_response.get()
            return command(*bound.args, **bound.kwargs, **additional_kwargs)
        except Exception as exc:
            raise exc

    return launcher


# ════════════════════════════════════════════════════════════
# CycloptsDispatch
# ════════════════════════════════════════════════════════════


class CycloptsDispatch:
    """Dispatch implementation using Cyclopts CLI framework。

    Usage:
        dispatch = CycloptsDispatch(diy_app)
        svc = RoutedCliRpcService(dispatch)
    """

    def __init__(self, app: App):
        self._app = app
        # install_meta_launcher 在 demo/commands.py 中已调用

    async def execute(
        self, argv: list[str], request: Request, response: Response
    ) -> int:
        """解析 argv，执行命令，返回 exit_code。

        所有输出写入 response 共享队列，传输层无需额外合并。
        """
        cyc_con_out, cyc_con_err = _make_consoles(response)

        _current_request.set(request)
        _current_response.set(response)
        _current_console.set(cyc_con_out)
        _current_error_console.set(cyc_con_err)

        func, bound, ignored = _dispatch_meta(
            self._app,
            argv,
            cyc_con_out,
            cyc_con_err,
        )

        result = func(*bound.args, **bound.kwargs)
        if inspect.isawaitable(result):
            await result

        return response.exit_code


__all__ = [
    "CycloptsDispatch",
    "install_meta_launcher",
    "_current_request",
    "_current_response",
    "_current_console",
    "_current_error_console",
]
