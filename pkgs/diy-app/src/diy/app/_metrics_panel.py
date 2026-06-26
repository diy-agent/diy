"""MetricsPanel — 进程内指标面板，显示 counters / gauges。

放在底部面板"输出/Agent"旁边，每 3s 自动刷新。
"""

from __future__ import annotations

from PySide6.QtCore import QTimer  # type: ignore[import-untyped]
from PySide6.QtGui import QFont  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QPlainTextEdit,
    QVBoxLayout,
    QWidget,
)

from diy.app._metrics import MetricsStore


class MetricsPanel(QWidget):
    """简易指标面板，定时快照并渲染。"""

    def __init__(self, metrics: MetricsStore, parent=None):
        super().__init__(parent)
        self._metrics = metrics

        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        self._text = QPlainTextEdit()
        self._text.setReadOnly(True)
        self._text.setFont(QFont("SF Mono", 11))
        self._text.setStyleSheet(
            "QPlainTextEdit { background: #1e1e2e; color: #cdd6f4; border: none; }"
        )
        layout.addWidget(self._text)

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._refresh)
        self._timer.start(3000)

        self._refresh()

    def _refresh(self) -> None:
        snap = self._metrics.snapshot()
        lines: list[str] = []

        counters = snap.get("counters", {})
        if counters:
            lines.append("── Counters ──")
            for name in sorted(counters):
                lines.append(f"  {name:40s} {counters[name]:>8.0f}")
            lines.append("")

        gauges = snap.get("gauges", {})
        if gauges:
            lines.append("── Gauges ──")
            for name in sorted(gauges):
                val = gauges[name]
                if val == int(val):
                    lines.append(f"  {name:40s} {int(val):>8d}")
                else:
                    lines.append(f"  {name:40s} {val:>8.1f}")
            lines.append("")

        histories = snap.get("histories", {})
        if histories:
            lines.append("── Histories (最近值) ──")
            for name in sorted(histories):
                entries = histories[name]
                if entries:
                    last = entries[-1]["v"]
                    if last == int(last):
                        lines.append(f"  {name:40s} {int(last):>8d}")
                    else:
                        lines.append(f"  {name:40s} {last:>8.1f}")

        self._text.setPlainText("\n".join(lines) if lines else "(无指标)")
