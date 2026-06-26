"""ModelListWidget — 选定 provider 的模型列表（中栏）。"""

from __future__ import annotations

from PySide6.QtCore import Qt  # type: ignore[import-untyped]
from PySide6.QtGui import QColor  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QAbstractItemView,
    QHeaderView,
    QLabel,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)


class ModelListWidget(QWidget):
    """模型详情列表 — 选中 provider 后展示其所有模型。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(6)

        # ── 标题 ──
        self._title = QLabel("🧠 模型")
        self._title.setStyleSheet(
            "font-size: 13px; font-weight: bold; color: #cdd6f4; padding: 2px 0;"
        )
        layout.addWidget(self._title)

        # ── 占位提示 ──
        self._placeholder = QLabel("请在左侧选择一个 Provider")
        self._placeholder.setStyleSheet(
            "color: #6c7086; font-size: 12px; padding: 20px;"
        )
        self._placeholder.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self._placeholder)

        # ── 模型列表树 ──
        self._tree = QTreeWidget()
        self._tree.setHeaderLabels(
            ["模型", "窗口", "max_tokens", "成本(in/out)", "状态"]
        )
        self._tree.setRootIsDecorated(False)
        self._tree.setAlternatingRowColors(True)
        self._tree.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
        self._tree.setStyleSheet("""
            QTreeWidget {
                background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a;
                border-radius: 4px; font-size: 11px;
            }
            QTreeWidget::item { padding: 3px 6px; border-bottom: 1px solid #313244; }
            QTreeWidget::item:selected { background: #45475a; }
            QTreeWidget::item:alternate { background: #181825; }
            QHeaderView::section {
                background: #181825; color: #a6adc8; border: none;
                padding: 3px 6px; font-size: 11px; font-weight: bold;
            }
        """)

        header = self._tree.header()
        header.setStretchLastSection(False)
        for i in range(5):
            header.setSectionResizeMode(i, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)

        self._tree.hide()
        layout.addWidget(self._tree, 1)

    def show_models(self, provider_name: str, models: dict) -> None:
        """展示指定 provider 的模型。"""
        self._title.setText(f"🧠 {provider_name}")
        self._placeholder.hide()
        self._tree.show()
        self._tree.clear()

        for mid, m in sorted(models.items()):
            editable = m.get("editable", {})
            status = m.get("status", "ok")
            stale = m.get("stale")
            meta = m.get("_meta", {})

            ctx = self._fmt_ctx(meta.get("context_window", 0))
            max_tk = editable.get("max_tokens", meta.get("max_tokens", 4096))
            cost = meta.get("cost", {})
            cost_str = f"{cost.get('input', '?')}/{cost.get('output', '?')}"

            enabled = bool(editable.get("enabled", True))
            if status == "error":
                state_str = "⚠ 废弃"
                color = QColor("#f7768e")
            elif stale:
                state_str = "☒ 过期"
                color = QColor("#6c7086")
            elif enabled:
                state_str = "✓"
                color = QColor("#a6e3a1")
            else:
                state_str = "✗ 禁用"
                color = QColor("#f9e2af")

            item = QTreeWidgetItem([mid, ctx, str(max_tk), cost_str, state_str])
            item.setForeground(4, color)
            self._tree.addTopLevelItem(item)

    def clear(self) -> None:
        """清空回到占位状态。"""
        self._tree.clear()
        self._tree.hide()
        self._placeholder.show()
        self._title.setText("🧠 模型")

    @staticmethod
    def _fmt_ctx(ctx: int) -> str:
        if ctx >= 1_000_000:
            return f"{ctx // 1_000_000}M"
        if ctx >= 1_000:
            return f"{ctx // 1_000}K"
        return str(ctx)
