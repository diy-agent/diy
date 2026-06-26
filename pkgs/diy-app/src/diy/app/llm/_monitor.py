"""ProxyMonitorWidget — 代理监控面板（右栏），含启动/停止控制。"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from diy.app._app_log import logger
from diy.app.llm._proxy_server import SHIM_LOG_DIR, ProxyServer
from PySide6.QtCore import QTimer  # type: ignore[import-untyped]
from PySide6.QtGui import QFont, QTextCursor  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

_STATUS_COLORS = {
    200: "color: #a6e3a1;",
    201: "color: #a6e3a1;",
    400: "color: #f9e2af;",
    401: "color: #f9e2af;",
    403: "color: #f9e2af;",
    404: "color: #f9e2af;",
    429: "color: #fab387;",
    500: "color: #f7768e;",
    502: "color: #f7768e;",
    503: "color: #f7768e;",
}


class ProxyMonitorWidget(QWidget):
    """代理监控 — 启动/停止代理 + 实时日志展示。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._proxy = ProxyServer()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(6)

        # ── 标题行 ──
        header = QLabel("🖥 Proxy 监控")
        header.setStyleSheet(
            "font-size: 13px; font-weight: bold; color: #cdd6f4; padding: 2px 0;"
        )
        layout.addWidget(header)

        # ── 控制行 ──
        ctrl_row = QHBoxLayout()
        ctrl_row.setSpacing(6)

        self._start_btn = QPushButton("▶ 启动")
        self._start_btn.setFixedHeight(26)
        self._start_btn.setStyleSheet(
            "QPushButton { background: #a6e3a1; color: #1e1e2e; border: none;"
            " border-radius: 4px; padding: 2px 12px; font-size: 11px; font-weight: bold; }"
            "QPushButton:hover { background: #94e2d5; }"
            "QPushButton:disabled { background: #45475a; color: #6c7086; }"
        )
        self._start_btn.clicked.connect(self._start_proxy)
        ctrl_row.addWidget(self._start_btn)

        self._stop_btn = QPushButton("⏹ 停止")
        self._stop_btn.setFixedHeight(26)
        self._stop_btn.setEnabled(False)
        self._stop_btn.setStyleSheet(
            "QPushButton { background: #f7768e; color: #1e1e2e; border: none;"
            " border-radius: 4px; padding: 2px 12px; font-size: 11px; font-weight: bold; }"
            "QPushButton:hover { background: #e64553; }"
            "QPushButton:disabled { background: #45475a; color: #6c7086; }"
        )
        self._stop_btn.clicked.connect(self._stop_proxy)
        ctrl_row.addWidget(self._stop_btn)

        self._status_label = QLabel("⏸ 已停止")
        self._status_label.setStyleSheet("color: #6c7086; font-size: 11px;")
        ctrl_row.addWidget(self._status_label)
        ctrl_row.addStretch()

        self._clear_btn = QPushButton("清空")
        self._clear_btn.setFixedHeight(24)
        self._clear_btn.setStyleSheet(
            "QPushButton { background: #45475a; color: #cdd6f4; border: none;"
            " border-radius: 4px; padding: 2px 8px; font-size: 11px; }"
            "QPushButton:hover { background: #585b70; }"
        )
        self._clear_btn.clicked.connect(self._clear_log)
        ctrl_row.addWidget(self._clear_btn)

        layout.addLayout(ctrl_row)

        # ── 统计行 ──
        stats_row = QHBoxLayout()
        stats_row.setSpacing(12)

        self._total_label = QLabel("总计: 0")
        self._ok_label = QLabel("✅ 0")
        self._err_label = QLabel("❌ 0")
        self._avg_label = QLabel("平均: -ms")
        for lbl in (
            self._total_label,
            self._ok_label,
            self._err_label,
            self._avg_label,
        ):
            lbl.setStyleSheet("color: #a6adc8; font-size: 11px;")
            stats_row.addWidget(lbl)
        stats_row.addStretch()
        layout.addLayout(stats_row)

        # ── 日志框 ──
        self._log = QPlainTextEdit()
        self._log.setReadOnly(True)
        self._log.setMaximumBlockCount(500)
        self._log.setFont(QFont("SF Mono", 10))
        self._log.setStyleSheet("""
            QPlainTextEdit {
                background: #11111b; color: #cdd6f4; border: 1px solid #45475a;
                border-radius: 4px; padding: 4px;
            }
        """)
        layout.addWidget(self._log, 1)

        # ── 自动刷新 ──
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._poll_logs)
        self._timer.start(2000)

        # ── 数据 ──
        self._last_pos = 0
        self._today = datetime.now(UTC).strftime("%Y-%m-%d")
        self._entries: list[dict] = []

    # ── 代理生命周期 ──

    def _start_proxy(self) -> None:
        self._proxy.start()
        self._start_btn.setEnabled(False)
        self._stop_btn.setEnabled(True)
        self._status_label.setText(f"▶ 运行中 (port={self._proxy.port})")
        self._status_label.setStyleSheet("color: #a6e3a1; font-size: 11px;")

    def _stop_proxy(self) -> None:
        self._proxy.stop()
        self._start_btn.setEnabled(True)
        self._stop_btn.setEnabled(False)
        self._status_label.setText("⏸ 已停止")
        self._status_label.setStyleSheet("color: #6c7086; font-size: 11px;")

    # ── 日志轮询 ──

    def _poll_logs(self) -> None:
        """轮询当日 JSONL 日志文件。"""
        log_path = Path(SHIM_LOG_DIR) / f"shim-{self._today}.jsonl"
        if not log_path.is_file():
            return

        try:
            with open(log_path) as f:
                f.seek(self._last_pos)
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        self._entries.append(entry)
                        self._append_entry(entry)
                    except json.JSONDecodeError:
                        continue
                self._last_pos = f.tell()
        except (OSError, json.JSONDecodeError) as e:
            logger.debug("[llm] 日志读取失败: %s", e)

        self._update_stats()

    def _append_entry(self, entry: dict) -> None:
        ts = entry.get("ts", "")[11:19] if entry.get("ts") else ""
        method = entry.get("method", "?")
        path = entry.get("path", "")
        status = entry.get("status", 0)
        elapsed = entry.get("elapsed_ms", 0)
        model = entry.get("model") or "N/A"

        style = _STATUS_COLORS.get(status, "color: #cdd6f4;")
        line = (
            f'<span style="color: #6c7086;">{ts}</span> '
            f'<span style="color: #89b4fa;">{method}</span> '
            f'<span style="{style}">{status}</span> '
            f'<span style="color: #a6adc8;">{elapsed:.0f}ms</span> '
            f'<span style="color: #6c7086;">{model}</span> '
            f'<span style="color: #45475a;">{path[:60]}{"..." if len(path) > 60 else ""}</span>'
        )
        self._log.appendHtml(line)
        cursor = self._log.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        self._log.setTextCursor(cursor)

    def _update_stats(self) -> None:
        total = len(self._entries)
        ok = sum(1 for e in self._entries if 200 <= e.get("status", 0) < 400)
        err = total - ok
        avg = (
            round(sum(e.get("elapsed_ms", 0) for e in self._entries) / total, 1)
            if total
            else 0
        )
        self._total_label.setText(f"总计: {total}")
        self._ok_label.setText(f"✅ {ok}")
        self._err_label.setText(f"❌ {err}")
        self._avg_label.setText(f"平均: {avg}ms")
        err_color = "#f7768e" if err > 0 else "#a6adc8"
        self._err_label.setStyleSheet(f"color: {err_color}; font-size: 11px;")

    def _clear_log(self) -> None:
        """清空日志显示。"""
        self._log.clear()
        self._entries.clear()
        self._update_stats()
