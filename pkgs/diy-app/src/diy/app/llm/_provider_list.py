"""ProviderListWidget — 已注册 provider 列表（左栏）。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from diy.app._app_log import logger
from PySide6.QtCore import Qt, QTimer, Signal  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QAbstractItemView,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

MODELS_DIR = Path.home() / ".diy" / "models"


class ProviderListWidget(QWidget):
    """Provider 列表 — 读取 ~/.diy/models/*.json 并展示。"""

    provider_selected = Signal(str)  # provider_name
    sync_started = Signal()
    sync_finished = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(6)

        # ── 标题行 ──
        header = QLabel("📡 Provider")
        header.setStyleSheet(
            "font-size: 13px; font-weight: bold; color: #cdd6f4; padding: 2px 0;"
        )
        layout.addWidget(header)

        # ── 按钮行 ──
        btn_row = QHBoxLayout()
        btn_row.setSpacing(4)

        self._sync_btn = QPushButton("🔄 同步")
        self._sync_btn.setFixedHeight(26)
        self._sync_btn.setStyleSheet(
            "QPushButton { background: #45475a; color: #cdd6f4; border: none;"
            " border-radius: 4px; padding: 2px 10px; font-size: 11px; }"
            "QPushButton:hover { background: #585b70; }"
        )
        self._sync_btn.clicked.connect(self._sync_all)
        btn_row.addWidget(self._sync_btn)

        self._refresh_btn = QPushButton("⟳")
        self._refresh_btn.setFixedSize(26, 26)
        self._refresh_btn.setToolTip("刷新")
        self._refresh_btn.setStyleSheet(
            "QPushButton { background: transparent; color: #a6adc8; border: none;"
            " border-radius: 4px; font-size: 14px; }"
            "QPushButton:hover { background: #45475a; }"
        )
        self._refresh_btn.clicked.connect(self.load_providers)
        btn_row.addWidget(self._refresh_btn)

        btn_row.addStretch()
        layout.addLayout(btn_row)

        # ── Provider 列表树 ──
        self._tree = QTreeWidget()
        self._tree.setHeaderLabels(["Provider", "状态"])
        self._tree.setRootIsDecorated(False)
        self._tree.setAlternatingRowColors(True)
        self._tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._tree.setIndentation(0)
        self._tree.setAnimated(True)
        self._tree.setStyleSheet("""
            QTreeWidget {
                background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a;
                border-radius: 4px; font-size: 12px;
            }
            QTreeWidget::item { padding: 4px 6px; border-bottom: 1px solid #313244; }
            QTreeWidget::item:selected { background: #45475a; color: #89b4fa; }
            QTreeWidget::item:hover { background: #313244; }
            QHeaderView::section {
                background: #181825; color: #a6adc8; border: none;
                padding: 4px 6px; font-size: 11px; font-weight: bold;
            }
        """)

        header = self._tree.header()
        header.setStretchLastSection(False)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)

        self._tree.itemSelectionChanged.connect(self._on_selection)
        layout.addWidget(self._tree, 1)

        # ── 自动刷新 ──
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.load_providers)
        self._timer.start(10000)

        # ── 数据 ──
        self._providers: list[dict[str, Any]] = []
        self.load_providers()

    # ── 加载数据 ──

    def load_providers(self) -> None:
        """读取 ~/.diy/models/*.json 并更新列表。"""
        self._providers = []
        if not MODELS_DIR.is_dir():
            return

        for f in sorted(MODELS_DIR.glob("*.json")):
            try:
                with open(f) as fh:
                    state = json.load(fh)
                source = state.get("source", "?")
                api_base = state.get("api_base", "?")
                models = state.get("models", {})
                enabled = sum(
                    1
                    for m in models.values()
                    if m.get("editable", {}).get("enabled", True)
                    and not m.get("stale")
                    and m.get("status") not in ("error", "exhausted")
                )
                total = len(models)
                self._providers.append(
                    {
                        "name": f.stem,
                        "source": source,
                        "api_base": api_base,
                        "enabled_models": enabled,
                        "total_models": total,
                        "models": models,
                    }
                )
            except Exception as e:
                logger.debug("[llm] 读取 %s 失败: %s", f.name, e)

        self._render()

    def _render(self) -> None:
        self._tree.clear()
        for p in self._providers:
            name = p["name"]
            status = f"{p['enabled_models']}/{p['total_models']} 模型"
            item = QTreeWidgetItem([name, status])
            item.setData(0, Qt.ItemDataRole.UserRole, p)
            self._tree.addTopLevelItem(item)

    # ── 交互 ──

    def _on_selection(self) -> None:
        items = self._tree.selectedItems()
        if items:
            data = items[0].data(0, Qt.ItemDataRole.UserRole)
            if data:
                self.provider_selected.emit(data["name"])

    def _sync_all(self) -> None:
        self.sync_started.emit()
        self._sync_btn.setEnabled(False)
        self._sync_btn.setText("⏳ 同步中...")

        try:
            # 使用 uv run 确保走 worktree 内的 diy CLI
            subprocess.run(
                ["uv", "run", "diy", "llm", "sync", "all", "--proxy"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.load_providers()
        except Exception as e:
            logger.error("[llm] sync 失败: %s", e)
        finally:
            self._sync_btn.setEnabled(True)
            self._sync_btn.setText("🔄 同步")
            self.sync_finished.emit()

    def get_selected_provider(self) -> dict | None:
        items = self._tree.selectedItems()
        if items:
            return items[0].data(0, Qt.ItemDataRole.UserRole)
        return None

    def select_provider(self, name: str) -> None:
        """按名称选中 provider。"""
        for i in range(self._tree.topLevelItemCount()):
            item = self._tree.topLevelItem(i)
            if item.text(0) == name:
                self._tree.setCurrentItem(item)
                return
