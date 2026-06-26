"""OverlayPanel — 右侧滑入面板（GitHub Projects v2 风格）。

特性：
- 从右侧滑入/缩回，推挤布局（非遮罩覆盖）
- 全高度
- Esc / 点击树区域 → 关闭
- QPropertyAnimation 宽度过渡
- 内含 QTabWidget：任务详情 | Agent 对话
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import (  # type: ignore[import-untyped]
    QEasingCurve,
    QPropertyAnimation,
    Qt,
    Signal,
)
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QFrame,
    QHBoxLayout,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from diy.app._app_log import logger

if TYPE_CHECKING:
    from diy.app._agent_chat import AgentChatPanel
    from diy.app.main import DetailView


class OverlayPanel(QFrame):
    """右侧滑入面板容器。

    由 Screen 控制显隐，Qt 动画驱动宽度过渡。
    内部是 QTabWidget 承载 DetailView + AgentChatPanel。

    信号:
        panel_closed: 面板关闭时发出（用于同步按钮状态）
        task_changed(uri): 上下键切换任务时发出
    """

    panel_closed = Signal()
    task_changed = Signal(str)  # new_uri

    ANIM_DURATION = 200  # ms
    DEFAULT_WIDTH = 480

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("OverlayPanel")
        self.setMinimumWidth(0)
        self.setMaximumWidth(self.DEFAULT_WIDTH)
        self.setStyleSheet("""
            #OverlayPanel {
                background: #1e1e2e;
                border-left: 1px solid #45475a;
            }
        """)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── Tab 栏（紧凑 + 关闭按钮） ──
        tab_bar = QWidget()
        tab_bar.setFixedHeight(32)
        tab_bar.setStyleSheet("background: #181825; border-bottom: 1px solid #313244;")
        tab_lay = QHBoxLayout(tab_bar)
        tab_lay.setContentsMargins(6, 0, 4, 0)
        tab_lay.setSpacing(0)

        self._tab = QTabWidget()
        self._tab.setDocumentMode(True)
        self._tab.setStyleSheet("""
            QTabWidget::pane {
                background: #1e1e2e;
                border: none;
            }
            QTabBar::tab {
                background: transparent;
                color: #6c7086;
                padding: 4px 12px;
                font-size: 12px;
                border: none;
                border-bottom: 2px solid transparent;
            }
            QTabBar::tab:selected {
                color: #cdd6f4;
                border-bottom: 2px solid #89b4fa;
            }
            QTabBar::tab:hover {
                color: #a6adc8;
            }
        """)

        # 关闭按钮
        self._close_btn = QToolButton()
        self._close_btn.setText("✕")
        self._close_btn.setToolTip("关闭 (Esc)")
        self._close_btn.setFixedSize(24, 24)
        self._close_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        self._close_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._close_btn.clicked.connect(self.close_panel)
        self._close_btn.setStyleSheet("""
            QToolButton {
                font-size: 13px;
                background: transparent;
                border: none;
                border-radius: 4px;
                color: #6c7086;
            }
            QToolButton:hover {
                background: #313244;
                color: #f7768e;
            }
        """)

        tab_lay.addWidget(self._tab)
        tab_lay.addWidget(self._close_btn)

        layout.addWidget(tab_bar)
        layout.addWidget(self._tab, 1)

        # ── 动画 ──
        self._anim = QPropertyAnimation(self, b"maximumWidth")
        self._anim.setDuration(self.ANIM_DURATION)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._anim.finished.connect(self._on_anim_finished)

        # ── 状态 ──
        self._visible = False
        self._animating = False
        self._show_count = 0  # 调试计数

    # ── 公开接口 ──

    def set_panels(
        self,
        detail_view: DetailView,
        agent_chat: AgentChatPanel,
    ) -> None:
        """设置内部 tab 页。"""
        self._tab.addTab(detail_view, "📄 详情")
        self._tab.addTab(agent_chat, "💬 Agent")
        self._detail = detail_view
        self._agent_chat = agent_chat

    def show_panel(self, tab_index: int = 0) -> None:
        """动画展开面板到指定 tab。"""
        if self._visible and not self._animating:
            # 已展开且动画完成，仅切 tab
            self._tab.setCurrentIndex(tab_index)
            return
        self._visible = True
        self._animating = True
        self._show_count += 1
        self._anim.stop()
        self._anim.setStartValue(self.width())
        self._anim.setEndValue(self.DEFAULT_WIDTH)
        self._anim.start()
        self._tab.setCurrentIndex(tab_index)
        logger.debug("[overlay] 展开 → tab=%d count=%d", tab_index, self._show_count)

    def close_panel(self) -> None:
        """动画缩小面板。"""
        if not self._visible and not self._animating:
            return
        self._visible = False
        self._animating = True
        self._anim.stop()
        self._anim.setStartValue(self.width())
        self._anim.setEndValue(0)
        self._anim.start()
        logger.debug("[overlay] 缩小")

    def toggle(self, tab_index: int = 0) -> None:
        """切换显隐。"""
        if self._visible and self._tab.currentIndex() == tab_index:
            self.close_panel()
        elif self._visible:
            self._tab.setCurrentIndex(tab_index)
        else:
            self.show_panel(tab_index)

    def is_visible(self) -> bool:
        return self._visible

    def switch_tab(self, tab_index: int) -> None:
        """切换到指定 tab（面板已打开时）。"""
        if self._visible:
            self._tab.setCurrentIndex(tab_index)

    def set_task(self, uri: str) -> None:
        """设置当前任务 URI — 传递到 detail view 和 agent chat。"""
        if hasattr(self, "_detail"):
            self._detail.show_task(uri)
        if hasattr(self, "_agent_chat"):
            self._agent_chat.set_task(uri)

    def state(self) -> dict:
        """返回面板状态快照（供 dai ui 查询）。"""
        return {
            "visible": self._visible,
            "animating": self._animating,
            "width": self.width(),
            "max_width": self.maximumWidth(),
            "tab_index": self._tab.currentIndex(),
            "show_count": self._show_count,
        }

    # ── 内部 ──

    def _on_anim_finished(self) -> None:
        """动画完成统一回调 — 在 __init__ 中一次性连接，避免 handler 堆积。"""
        self._animating = False
        if not self._visible:
            logger.debug("[overlay] 缩小完成 → panel_closed")
            self.panel_closed.emit()
        else:
            logger.debug("[overlay] 展开完成 width=%d", self.width())
