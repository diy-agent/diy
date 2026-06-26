"""LogPanel — VSCode Output Panel 风格的日志视图。

用法:
  panel = LogPanel()
  some_tab_widget.addTab(panel, "输出")
"""

from __future__ import annotations

import logging
import re
from collections import Counter

from PySide6.QtGui import QFont, QTextCursor  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QCheckBox,
    QComboBox,
    QHBoxLayout,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from diy.app._app_log import get_qt_handler, logger

_LOG_LEVELS = [
    ("ALL", 0),
    ("ERROR", 40),
    ("WARN ", 30),
    ("INFO ", 20),
    ("DEBUG", 10),
]

_SOURCE_ALL = "(所有来源)"

_CLASSIC = QFont("Menlo", 11)

# 从完整格式化消息中提取 [category] 前缀
# 输入: "18:30:15 [INFO ] [diy.app] [watcher] 消息正文"
# 输出: "watcher"（取最后一个带括号的标识符）
_RE_SOURCE = re.compile(r"\[(\w+)\]")


def _extract_source(message: str) -> str:
    matches = _RE_SOURCE.findall(message)
    return matches[-1] if matches else ""


class LogPanel(QWidget):
    """日志输出视图，实时显示 app 日志，可过滤级别和来源。

    消息中的 [category] 前缀自动提取为来源过滤选项。
    格式示例:
      18:30:15 [INFO ] [diy.app] [watcher] 文件变化 → 全量重载
    """

    MAX_LINES = 5000

    def __init__(self, parent=None):
        super().__init__(parent)

        self._line_count = 0
        self._seen_sources: Counter[str] = Counter()

        # ── 控件 ──
        self._text = QPlainTextEdit()
        self._text.setReadOnly(True)
        self._text.setFont(_CLASSIC)
        self._text.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self._text.setMaximumBlockCount(self.MAX_LINES)
        self._text.setStyleSheet("""
            QPlainTextEdit {
                background: #1e1e2e;
                color: #cdd6f4;
                selection-background-color: #45475a;
            }
        """)

        # 级别过滤
        self._level_filter = QComboBox()
        for label, lvl in _LOG_LEVELS:
            self._level_filter.addItem(label, lvl)
        self._level_filter.currentIndexChanged.connect(self._apply_filter)

        # 来源过滤
        self._source_filter = QComboBox()
        self._source_filter.addItem("(所有来源)", _SOURCE_ALL)
        self._source_filter.currentIndexChanged.connect(self._apply_filter)

        # 自动滚
        self._auto_scroll = QCheckBox("自动滚动")
        self._auto_scroll.setChecked(True)

        # 清空
        clear_btn = QPushButton("清空")
        clear_btn.clicked.connect(self._clear)

        # ── Toolbar ──
        toolbar = QHBoxLayout()
        toolbar.setContentsMargins(4, 2, 4, 2)
        toolbar.addWidget(self._level_filter)
        toolbar.addWidget(self._source_filter)
        toolbar.addWidget(self._auto_scroll)
        toolbar.addStretch()
        toolbar.addWidget(clear_btn)

        # ── 布局 ──
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addLayout(toolbar)
        layout.addWidget(self._text)

        # ── 连接 QtLogHandler → GUI（回放缓存 + 实时接收） ──
        qt_handler = get_qt_handler()
        if qt_handler:
            qt_handler.connect_listener(self._on_record)

    # ── slots ──

    def _on_record(self, _name: str, levelno: int, message: str) -> None:
        """从 QtLogHandler 接收日志记录（跨线程安全）。"""
        # 级别过滤
        min_level = self._level_filter.currentData()
        if min_level and levelno < min_level:
            return

        # 来源过滤（首次出现的来源自动加入下拉）
        source = _extract_source(message)
        if source and source not in self._seen_sources:
            self._seen_sources[source] = 0
            self._source_filter.addItem(source, source)
        if source:
            self._seen_sources[source] += 1

        filter_source = self._source_filter.currentData()
        if filter_source != _SOURCE_ALL and source != filter_source:
            return

        color = _level_color(levelno)
        html = f'<pre style="color:{color};margin:0;font-family:Menlo;font-size:11px;">{_esc_html(message)}</pre>'
        self._text.appendHtml(html)

        if self._auto_scroll.isChecked():
            cursor = self._text.textCursor()
            cursor.movePosition(QTextCursor.MoveOperation.End)
            self._text.setTextCursor(cursor)

    def _apply_filter(self) -> None:
        min_level = self._level_filter.currentData()
        filter_source = self._source_filter.currentData()
        logger.debug(
            "[panel] 过滤切换: level=%s source=%s", min_level or "ALL", filter_source
        )

        # 重绘 — 重新从缓存加载所有匹配的记录
        qt_handler = get_qt_handler()
        if not qt_handler:
            return
        self._text.clear()
        for entry in qt_handler._buffer:
            _name, levelno, msg = entry
            if min_level and levelno < min_level:
                continue
            src = _extract_source(msg)
            if filter_source != _SOURCE_ALL and src != filter_source:
                continue
            color = _level_color(levelno)
            html = f'<pre style="color:{color};margin:0;font-family:Menlo;font-size:11px;">{_esc_html(msg)}</pre>'
            self._text.appendHtml(html)
        logger.debug("[panel] 重绘完成, 显示 %d 条", self._text.blockCount())

    def _clear(self) -> None:
        self._text.clear()
        self._seen_sources.clear()
        logger.debug("[panel] 日志已清空")

    def append_log(self, message: str) -> None:
        """手动追加一条日志（供外部直接调用）。"""
        self._on_record("", 20, message)


def _level_color(levelno: int) -> str:
    if levelno >= logging.ERROR:
        return "#f38ba8"
    if levelno >= logging.WARNING:
        return "#fab387"
    if levelno >= logging.INFO:
        return "#a6e3a1"
    return "#6c7086"


def _esc_html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
