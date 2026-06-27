"""
Agent 后端统一接口 — 所有后端（hermes acp / pi rpc）都实现此接口。

App UI / CLI 只依赖这个接口，不关心具体实现。
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field

# ════════════════════════════════════════════════════════════════
# 数据模型
# ════════════════════════════════════════════════════════════════


@dataclass
class Message:
    """单条对话消息。"""

    role: str = "assistant"  # "user" | "assistant" | "tool"
    content: str = ""
    reasoning: str = ""
    tool_calls: list[dict] = field(default_factory=list)
    timestamp: str = ""


@dataclass
class AgentState:
    """agent 运行时快照。"""
    task_uri: str
    session_id: str = ""
    state: str = "idle"  # "starting" | "idle" | "running" | "error" | "stopped"
    message_count: int = 0
    # ── 诊断字段（PiRpcAgent / AcpAgent 按需填充） ──
    provider: str = ""
    model: str = ""
    pid: int = 0
    event_count: int = 0  # 本次 prompt 收到的事件总数
    last_event_type: str = ""  # 最后一个事件类型（text_delta / toolcall_start / agent_end 等）
    last_event_age: float = 0  # 距最后事件的秒数（0 = 刚收到）
    prompt_elapsed: float = 0  # 当前 prompt 已运行秒数（0 = idle）


# ════════════════════════════════════════════════════════════════
# 回调类型
# ════════════════════════════════════════════════════════════════

DeltaCallback = Callable[[str], None]
ReasoningCallback = Callable[[str], None]
ToolStartCallback = Callable[[str, str, dict], None]  # (name, id, args)
ErrorCallback = Callable[[str], None]
FinishCallback = Callable[[str], None]  # stop_reason


@dataclass
class AgentCallbacks:
    """agent 事件回调集合。"""

    on_delta: DeltaCallback | None = None
    on_reasoning: ReasoningCallback | None = None
    on_tool_start: ToolStartCallback | None = None
    on_error: ErrorCallback | None = None
    on_finished: FinishCallback | None = None


# ════════════════════════════════════════════════════════════════
# AgentBackend — 抽象接口
# ════════════════════════════════════════════════════════════════


class AgentBackend(ABC):
    """Agent 后端统一接口。

    所有后端（AcpAgent / PiRpcAgent）都实现此接口。
    """

    # ── 只读属性 ──

    @property
    @abstractmethod
    def task_uri(self) -> str:
        """任务标识。"""
        ...

    @property
    @abstractmethod
    def session_id(self) -> str:
        """当前 ACP / Pi 会话 ID。"""
        ...

    @property
    @abstractmethod
    def history(self) -> list[Message]:
        """完整对话历史（内存）。"""
        ...

    @property
    @abstractmethod
    def state(self) -> str:
        """当前状态: starting | idle | running | error | stopped。"""
        ...

    @property
    @abstractmethod
    def ready(self) -> asyncio.Event:
        """就绪事件 — run() 中设置，等待方 await 此事件。"""
        ...

    # ── 生命周期 ──

    @abstractmethod
    async def run(self, cwd: str | None = None) -> None:
        """常驻入口。启动后端子进程 → 握手 → 服务循环。

        调用方通常用 asyncio.create_task(agent.run()) 启动。
        run() 会在后台持续运行直到 stop() 被调用。
        """
        ...

    @abstractmethod
    async def stop(self) -> None:
        """停止 agent，清理子进程。"""
        ...

    # ── 交互 ──

    @abstractmethod
    async def send(self, text: str) -> str:
        """发送用户消息，等待完成。返回 stop_reason。

        流式事件通过回调（on_delta / on_reasoning / on_tool_start）实时推送。
        """
        ...

    @abstractmethod
    async def cancel(self) -> None:
        """取消当前正在执行的 prompt。"""
        ...

    def set_callbacks(self, callbacks: AgentCallbacks) -> None:
        """替换回调接口。用于 task 切换时更新 SignalBridge 回调。

        默认实现覆盖 self._callbacks，子类如需要额外逻辑可 override。
        """
        self._callbacks = callbacks

    # ── 快照 ──

    @abstractmethod
    def state_snapshot(self) -> AgentState:
        """返回当前状态快照。"""
        ...

    @property
    @abstractmethod
    def is_alive(self) -> bool:
        """agent 是否还在运行（未 stop / 未崩溃）。"""
        ...
