"""Agent Pool — 任务级 AIAgent 生命周期管理。

数据模型和池逻辑，不直接 import Hermes。
AIAgent 的实际创建在 _agent_daemon.py（运行在 Hermes venv 中）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ════════════════════════════════════════════════════════════════
# TaskAgentConfig — 每个 agent 可独立覆盖的参数
# ════════════════════════════════════════════════════════════════


@dataclass
class TaskAgentConfig:
    """Per-task agent configuration. None = 继承 daemon 默认值。"""

    model: str | None = None
    provider: str | None = None
    enabled_toolsets: list[str] | None = None
    max_iterations: int | None = None
    skip_context_files: bool | None = None
    skip_memory: bool | None = None
    reasoning_budget: int | None = None
    checkpoints: bool | None = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {}
        for k, v in self.__dict__.items():
            if v is not None:
                d[k] = v
        return d

    @classmethod
    def from_dict(cls, d: dict) -> TaskAgentConfig:
        return cls(
            model=d.get("model"),
            provider=d.get("provider"),
            enabled_toolsets=d.get("enabled_toolsets"),
            max_iterations=d.get("max_iterations"),
            skip_context_files=d.get("skip_context_files"),
            skip_memory=d.get("skip_memory"),
            reasoning_budget=d.get("reasoning_budget"),
            checkpoints=d.get("checkpoints"),
        )


# ════════════════════════════════════════════════════════════════
# AgentStatus — daemon ↔ CLI 的序列化状态
# ════════════════════════════════════════════════════════════════


@dataclass
class AgentStatus:
    task_uri: str
    state: str = "idle"  # idle | running | done | failed | hung | killed
    model: str = ""
    provider: str = ""
    started_at: str = ""
    last_message: str = ""
    output_tail: list[str] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "task_uri": self.task_uri,
            "state": self.state,
            "model": self.model,
            "provider": self.provider,
            "started_at": self.started_at,
            "last_message": self.last_message,
            "output_tail": self.output_tail[-20:],
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, d: dict) -> AgentStatus:
        return cls(
            task_uri=d.get("task_uri", ""),
            state=d.get("state", "idle"),
            model=d.get("model", ""),
            provider=d.get("provider", ""),
            started_at=d.get("started_at", ""),
            last_message=d.get("last_message", ""),
            output_tail=d.get("output_tail", []),
            error=d.get("error", ""),
        )
