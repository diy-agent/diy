"""TitleBar — 顶栏，Zed 风格紧凑按钮 + 过滤栏。

布局：
  [📁≡ 任务树] [🔍___过滤...___________]  [🖥 详情] [💬 Agent]

按钮 24×24，emoji 图标，hover 显背景。
位置感：左侧按钮 ↔ 左侧面板，右侧按钮 ↔ 右侧面板。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import Qt, Signal  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QComboBox,
    QLineEdit,
    QToolBar,
    QToolButton,
    QWidget,
)

if TYPE_CHECKING:
    pass


class TitleBarButton(QToolButton):
    """紧凑 toggle 按钮 — Zed 风格。

    checked 状态用底部强调线（类似 Zed 的选中态）。
    """

    def __init__(self, emoji: str, tooltip: str, parent=None):
        super().__init__(parent)
        self.setText(emoji)
        self.setToolTip(tooltip)
        self.setCheckable(True)
        self.setChecked(False)
        self.setFixedSize(28, 28)
        self.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setStyleSheet("""
            QToolButton {
                font-size: 15px;
                background: transparent;
                border: none;
                border-radius: 4px;
                color: #6c7086;
            }
            QToolButton:hover {
                background: #313244;
                color: #cdd6f4;
            }
            QToolButton:checked {
                background: #313244;
                color: #89b4fa;
                border-bottom: 2px solid #89b4fa;
                border-radius: 4px 4px 0 0;
            }
        """)


class TitleBar(QToolBar):
    """顶栏 — 左侧面板按钮 + 过滤栏 + 右侧面板按钮。

    信号:
        toggle_area(aid, panel_id): 点击按钮时发出
    """

    toggle_area = Signal(str, str)  # aid, panel_id

    def __init__(self, parent=None):
        super().__init__("顶栏", parent)
        self.setMovable(False)
        self.setFloatable(False)
        self.setFixedHeight(36)
        self.setStyleSheet("""
            QToolBar {
                background: #181825;
                border: none;
                border-bottom: 1px solid #45475a;
                spacing: 4px;
                padding: 4px 8px;
            }
        """)

        # ── 左侧：树面板按钮 ──
        self._tree_btn = TitleBarButton("📁", "任务树")
        self._tree_btn.clicked.connect(
            lambda: self.toggle_area.emit("left", "task_tree")
        )
        self.addWidget(self._tree_btn)

        # 小分隔
        sep1 = QWidget()
        sep1.setFixedWidth(1)
        sep1.setFixedHeight(20)
        sep1.setStyleSheet("background: #45475a; margin: 0 4px;")
        self.addWidget(sep1)

        # ── 过滤栏 ──
        self._filter_text = QLineEdit()
        self._filter_text.setPlaceholderText("过滤任务...")
        self._filter_text.setClearButtonEnabled(True)
        self._filter_text.setFixedHeight(26)
        self._filter_text.setMaximumWidth(300)
        self._filter_text.setStyleSheet("""
            QLineEdit {
                background: #1e1e2e;
                color: #cdd6f4;
                border: 1px solid #45475a;
                border-radius: 4px;
                padding: 2px 8px;
                font-size: 12px;
            }
            QLineEdit:focus {
                border: 1px solid #89b4fa;
            }
        """)
        self.addWidget(self._filter_text)

        # ── 状态过滤下拉 ──
        self._filter_state = QComboBox()
        self._filter_state.addItems(
            ["所有状态", "active", "pending", "done", "blocked", "cancelled"]
        )
        self._filter_state.setFixedHeight(26)
        self._filter_state.setMaximumWidth(90)
        self._filter_state.setStyleSheet("""
            QComboBox {
                background: #1e1e2e;
                color: #cdd6f4;
                border: 1px solid #45475a;
                border-radius: 4px;
                padding: 2px 6px;
                font-size: 12px;
            }
            QComboBox:hover { border: 1px solid #585b70; }
            QComboBox::drop-down { border: none; width: 16px; }
            QComboBox QAbstractItemView {
                background: #1e1e2e;
                color: #cdd6f4;
                border: 1px solid #45475a;
                selection-background-color: #45475a;
            }
        """)
        self.addWidget(self._filter_state)

        # ── 弹性空间 ──
        spacer = QWidget()
        spacer.setSizePolicy(
            QWidget().sizePolicy().Policy.Expanding,
            QWidget().sizePolicy().Policy.Preferred,
        )
        self.addWidget(spacer)

        # ── 分隔 ──
        sep2 = QWidget()
        sep2.setFixedWidth(1)
        sep2.setFixedHeight(20)
        sep2.setStyleSheet("background: #45475a; margin: 0 4px;")
        self.addWidget(sep2)

        # ── 右侧：详情面板按钮 ──
        self._detail_btn = TitleBarButton("🖥", "任务详情")
        self._detail_btn.clicked.connect(
            lambda: self.toggle_area.emit("right", "task_detail")
        )
        self.addWidget(self._detail_btn)

        # ── Agent 面板按钮 ──
        self._agent_btn = TitleBarButton("💬", "Agent")
        self._agent_btn.clicked.connect(
            lambda: self.toggle_area.emit("right", "agent_chat")
        )
        self.addWidget(self._agent_btn)

    def set_button_checked(self, aid: str, panel_id: str, visible: bool) -> None:
        """同步按钮状态。

        visible=True  → 该 area 的指定 panel 按钮高亮，同 area 其他按钮取消。
        visible=False → 该 area 所有按钮取消。
        """
        for btn, btn_aid, btn_pid in [
            (self._tree_btn, "left", "task_tree"),
            (self._detail_btn, "right", "task_detail"),
            (self._agent_btn, "right", "agent_chat"),
        ]:
            if btn_aid != aid:
                continue
            if visible and btn_pid == panel_id:
                btn.setChecked(True)
            else:
                btn.setChecked(False)
            # 不主动 uncheck 其他按钮——由 Screen 互斥保证同一组只有一个 visible

    @property
    def filter_text(self) -> QLineEdit:
        return self._filter_text

    @property
    def filter_state(self) -> QComboBox:
        return self._filter_state
