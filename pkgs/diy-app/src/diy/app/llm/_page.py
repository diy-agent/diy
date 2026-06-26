"""LLMPage — LLM 管理主页面，三栏布局。"""

from __future__ import annotations

from diy.app.llm._model_list import ModelListWidget
from diy.app.llm._monitor import ProxyMonitorWidget
from diy.app.llm._provider_list import ProviderListWidget
from PySide6.QtCore import Qt  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QSplitter,
    QVBoxLayout,
    QWidget,
)


class LLMPage(QWidget):
    """LLM 管理页面 — 三栏：Provider 列表 | 模型详情 | Proxy 监控。"""

    def __init__(self, parent=None):
        super().__init__(parent)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── 三栏 Splitter ──
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        splitter.setStyleSheet(
            "QSplitter::handle { background: #45475a; }"
            "QSplitter { background: #1e1e2e; }"
        )

        # 左栏：Provider 列表
        self._providers = ProviderListWidget()
        splitter.addWidget(self._providers)

        # 中栏：模型详情
        self._models = ModelListWidget()
        splitter.addWidget(self._models)

        # 右栏：Proxy 监控
        self._monitor = ProxyMonitorWidget()
        splitter.addWidget(self._monitor)

        splitter.setStretchFactor(0, 1)  # provider 列表
        splitter.setStretchFactor(1, 2)  # 模型详情
        splitter.setStretchFactor(2, 2)  # proxy 监控
        splitter.setSizes([200, 350, 350])

        layout.addWidget(splitter, 1)

        # ── 信号连接 ──
        self._providers.provider_selected.connect(self._on_provider_selected)

    def _on_provider_selected(self, provider_name: str) -> None:
        """选中 provider → 加载模型列表。"""
        provider = self._providers.get_selected_provider()
        if provider and provider["models"]:
            self._models.show_models(provider_name, provider["models"])
        else:
            self._models.clear()
