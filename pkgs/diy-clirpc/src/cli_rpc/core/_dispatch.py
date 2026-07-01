"""Dispatch 抽象 — CLI 框架无关的命令调度接口。

`execute(argv, request, response)` 是传输层与 CLI 框架之间的桥梁。
传输层拿到 argv 后调用 execute，dispatch 负责解析并执行命令，
所有输出写入 response 共享队列。
"""

from __future__ import annotations

from typing import Protocol

from cli_rpc.core._types import Request, Response


class DispatchResult:
    """Dispatch 返回结果"""

    exit_code: int = 0


class Dispatch(Protocol):
    """CLI 命令调度器：解析 argv → 执行 handler → 填充 response。"""

    async def execute(
        self, argv: list[str], request: Request, response: Response
    ) -> int:
        """解析 argv 并执行命令，返回 exit_code。

        dispatch 负责：
        - 解析 argv，定位 handler 函数
        - 注入 request/response 上下文
        - 调用 handler（sync/async）
        - 所有输出写入 response 共享队列

        传输层只需在返回后 drain response.out._queue。
        """
        ...


__all__ = ["Dispatch", "DispatchResult"]
