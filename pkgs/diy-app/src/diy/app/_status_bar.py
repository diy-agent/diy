"""StatusBar — 底栏，Zed 风格。

布局：
  [📋 输出]  [✅ 0 错误]  [🤖 3 agent]  [🔄 5秒前]  ———  [Ln 12]

左侧按钮 toggle 底部面板。
中/右侧显示实时状态信息。
"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QLabel,
    QStatusBar,
    QToolButton,
    QWidget,
)


class StatusBarButton(QToolButton):
    """紧凑底栏按钮 — 14px emoji，28×24。"""

    def __init__(self, emoji: str, tooltip: str, parent=None):
        super().__init__(parent)
        self.setText(emoji)
        self.setToolTip(tooltip)
        self.setCheckable(True)
        self.setChecked(False)
        self.setFixedSize(28, 24)
        self.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setStyleSheet("""
            QToolButton {
                font-size: 13px;
                background: transparent;
                border: none;
                border-radius: 3px;
                color: #6c7086;
            }
            QToolButton:hover {
                background: #313244;
                color: #cdd6f4;
            }
            QToolButton:checked {
                background: #313244;
                color: #89b4fa;
            }
        """)


class StatusLabel(QLabel):
    """状态信息标签 — 紧凑灰色文本。"""

    def __init__(self, text: str = "", parent=None):
        super().__init__(text, parent)
        self.setStyleSheet("""
            QLabel {
                color: #6c7086;
                font-size: 12px;
                padding: 0 6px;
            }
        """)


class StatusBar(QStatusBar):
    """底栏 — 输出按钮 + 实时状态。

    信号:
        toggle_area(aid, panel_id): 点击按钮时发出
        update_status(dict): 外部更新状态字段
    """

    toggle_area = Signal(str, str)  # aid, panel_id

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(28)
        self.setStyleSheet("""
            QStatusBar {
                background: #181825;
                border: none;
                border-top: 1px solid #45475a;
                padding: 0;
            }
            QStatusBar::item {
                border: none;
            }
        """)
        self.setSizeGripEnabled(False)

        # ── 左侧：输出面板按钮 ──
        self._output_btn = StatusBarButton("📋", "输出")
        self._output_btn.clicked.connect(
            lambda: self.toggle_area.emit("bottom", "output_log")
        )
        self.addPermanentWidget(self._output_btn)

        # ── 状态信息标签 ──
        self._error_label = StatusLabel("✅ 0 错误")
        self.addPermanentWidget(self._error_label)

        self._agent_label = StatusLabel("🤖 0 agent")
        self.addPermanentWidget(self._agent_label)

        self._refresh_label = StatusLabel("🔄 —")
        self.addPermanentWidget(self._refresh_label)

        # ── 弹性空间 → 右侧信息 ──
        spacer = QWidget()
        spacer.setSizePolicy(
            QWidget().sizePolicy().Policy.Expanding,
            QWidget().sizePolicy().Policy.Preferred,
        )
        self.addPermanentWidget(spacer)

        self._focus_label = StatusLabel("")
        self.addPermanentWidget(self._focus_label)

    def set_button_checked(self, visible: bool) -> None:
        self._output_btn.setChecked(visible)

    def update_status(
        self,
        *,
        errors: int | None = None,
        agents: int | None = None,
        last_refresh: str | None = None,
        focus: str | None = None,
    ) -> None:
        if errors is not None:
            icon = "✅" if errors == 0 else "⚠️"
            self._error_label.setText(f"{icon} {errors} 错误")

        if agents is not None:
            self._agent_label.setText(f"🤖 {agents} agent")

        if last_refresh is not None:
            self._refresh_label.setText(f"🔄 {last_refresh}")

        if focus is not None:
            self._focus_label.setText(focus)
