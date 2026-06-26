"""
SignalBridge — 将 AgentBackend 的纯 Python 回调 → Qt Signal。

用法：
    bridge = SignalBridge()
    bridge.bind(agent)   #  agent.callbacks = bridge.callbacks()
    bridge.delta_received.connect(on_delta)
    bridge.finished.connect(on_finished)
"""

from __future__ import annotations

from PySide6.QtCore import QObject, Signal  # type: ignore[import-untyped]

from diy.core.backend import AgentBackend, AgentCallbacks


class SignalBridge(QObject):
    """ACP 实时事件 → Qt Signal。"""

    # ── 流式事件信号 ──
    delta_received = Signal(str)  # 文本 delta
    reasoning_received = Signal(str)  # 推理过程
    tool_started = Signal(str, str, dict)  # (name, id, args)
    finished = Signal(str)  # stop_reason
    error_occurred = Signal(str)  # 错误消息

    # ── 生命周期信号 ──
    session_ready = Signal(str)  # session_id
    state_changed = Signal(str)  # idle | running | error | stopped

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._callbacks = AgentCallbacks(
            on_delta=self._on_delta,
            on_reasoning=self._on_reasoning,
            on_tool_start=self._on_tool_start,
            on_error=self._on_error,
            on_finished=self._on_finished,
        )

    def callbacks(self) -> AgentCallbacks:
        """获取回调接口，传给 AgentManager.get_or_create(callbacks=...)。"""
        return self._callbacks

    def bind(self, agent: AgentBackend) -> None:
        """绑定到一个活跃 agent（后续状态变化自动发信号）。"""
        self._agent = agent
        self.session_ready.emit(agent.session_id)
        self.state_changed.emit(agent.state)

    # ── 回调实现（emit 时 QObject 可能已被 deleteLater）──

    def _safe_emit(self, sig, *args):
        """安全发射 Qt Signal，QObject 已销毁时静默跳过并记录。"""
        try:
            sig.emit(*args)
        except RuntimeError as e:
            if "already deleted" in str(e):
                import logging as _lg

                _lg.getLogger("diy.app").debug(
                    "[qt-lifecycle] SignalBridge 已销毁，丢弃信号 %s", sig.signalName()
                )
            else:
                raise

    def _on_delta(self, text: str) -> None:
        self._safe_emit(self.delta_received, text)

    def _on_reasoning(self, text: str) -> None:
        self._safe_emit(self.reasoning_received, text)

    def _on_tool_start(self, name: str, tc_id: str, args: dict) -> None:
        self._safe_emit(self.tool_started, name, tc_id, args)

    def _on_error(self, msg: str) -> None:
        self._safe_emit(self.error_occurred, msg)

    def _on_finished(self, stop_reason: str) -> None:
        self._safe_emit(self.finished, stop_reason)
