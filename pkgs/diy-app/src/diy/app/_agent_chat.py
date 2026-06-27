"""Agent 对话面板 — 基于 Hermes 数据库的消息渲染。

数据来源：Hermes state.db（~/.hermes/state.db）
- sessions: id = agent-{task_uri}
- messages: id, role, content, tool_name, tool_calls, reasoning_content

渲染规则：
- role=user → 用户气泡
- role=assistant → 助手气泡（前置 reasoning，后接 content）
- role=tool → 内联到最近一条 assistant 消息（格式化为文本行）
- 按 id 顺序排列，QLabel 自然撑开无滚动条
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt, QTimer, Signal  # type: ignore[import-untyped]
from PySide6.QtWidgets import (  # type: ignore[import-untyped]
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from diy.core._state import diy_home
from diy.app._app_log import logger as _logger
from diy.app.agent_bridge_qt import SignalBridge
from diy.core.backend import AgentCallbacks

_HERMES_DB = Path.home() / ".hermes" / "state.db"

# ═══════════════════════════════════════════════════════
# 色彩常量（Catppuccin Mocha）
# ═══════════════════════════════════════════════════════

_BG = "#1e1e2e"
_BG_DARK = "#181825"
_BG_Surface = "#313244"
_BG_Surface2 = "#45475a"
_TEXT = "#cdd6f4"
_TEXT_DIM = "#a6adc8"
_MAUVE = "#cba6f7"
_BLUE = "#89b4fa"
_GREEN = "#a6e3a1"
_YELLOW = "#f9e2af"
_RED = "#f38ba8"
_PEACH = "#fab387"
_TEAL = "#94e2d5"
_surface0 = "#585b70"
_surface1 = "#6c7086"
_border = "#313244"

_PEACH_DIM = "#a67a5e"

_MAX_RENDER_LINES = 300  # 每次渲染的最大内容行数（短消息几十条，长消息几条）

# ═══════════════════════════════════════════════════════
# Hermes 数据库查询
# ═══════════════════════════════════════════════════════


def _resolve_session_id(task_uri: str) -> str | None:
    """从 task AGENTS.md frontmatter 读取真实 session_id。"""
    try:
        from diy.core._state import get_task

        info = get_task(task_uri)
        if info:
            agent = info.get("agent") or {}
            sid = agent.get("session_id") or info.get("session_id")
            if sid:
                return sid
    except Exception:
        pass
    return None


def _read_messages(session_id: str, after_id: int = 0) -> list[dict]:
    """从 Hermes state.db 读取 session 的消息。

    timeout=3 避免阻塞 Qt 主线程等待写锁；
    read_uncommitted=1 允许读到 agent 未提交的事务写入（rollback journal 模式下）。
    """
    if not session_id or not _HERMES_DB.exists():
        return []
    try:
        conn = sqlite3.connect(str(_HERMES_DB), timeout=3)
        conn.execute("PRAGMA read_uncommitted=1")
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, role, content, tool_name, tool_calls, "
            "reasoning_content, timestamp "
            "FROM messages WHERE session_id=? AND id > ? "
            "ORDER BY id",
            (session_id, after_id),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except sqlite3.OperationalError:
        return []


_MAX_HISTORY_LINES = 2000


def _trim_to_line_limit(
    rows: list[dict], max_lines: int = _MAX_HISTORY_LINES
) -> list[dict]:
    """将消息列表截断到不超过 max_lines 行，保证完整消息体。

    从最新的消息向前累积行数，超过 max_lines 后从前面丢弃，
    但保证第一条保留的消息是 user 角色（完整对话的开头）。
    """
    if not rows:
        return []

    # 从后向前累积行数
    acc_lines = 0
    cutoff = -1  # -1 表示不需要截断
    for i in range(len(rows) - 1, -1, -1):
        content = rows[i].get("content") or ""
        line_count = content.count("\n") + 1
        acc_lines += line_count
        if acc_lines > max_lines:
            cutoff = i
            break

    if cutoff < 0:
        # 总行数未超限，全部保留
        return rows

    # 截断 discard 掉 [0..cutoff-1]，保留 [cutoff..]
    trimmed = rows[cutoff:]

    # 如果第一条不是 user，向后再找一个 user（保证完整对话开头）
    if trimmed and trimmed[0].get("role") != "user":
        for i, r in enumerate(trimmed):
            if r.get("role") == "user":
                trimmed = trimmed[i:]
                break

    return trimmed


def _html_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _render_message_content(content: str) -> str:
    """简易 markdown → HTML（行内格式）。"""
    if not content:
        return ""
    s = _html_escape(content)
    s = s.replace("\n", "<br>")
    s = _apply_inline_md(s)
    return s


def _apply_inline_md(s: str) -> str:
    """行内 markdown 格式。"""
    s = __import__("re").sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = __import__("re").sub(r"__(.+?)__", r"<b>\1</b>", s)
    s = __import__("re").sub(
        r"`([^`]+)`",
        rf'<span style="background:{_BG_Surface};color:{_TEAL};'
        rf'padding:0 3px;border-radius:3px;font-family:monospace;font-size:11px">\1</span>',
        s,
    )
    s = __import__("re").sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        rf'<span style="color:{_BLUE};text-decoration:underline">\1</span>',
        s,
    )
    return s


def _format_tool_calls(tool_calls: str | None, tool_name: str | None) -> str:
    """格式化 tool_calls JSON 为显示文本。"""
    if not tool_calls:
        return ""
    try:
        calls = json.loads(tool_calls)
        if isinstance(calls, list):
            parts = []
            for c in calls:
                name = c.get("function", {}).get(
                    "name", c.get("name", tool_name or "?")
                )
                args = c.get("function", {}).get("arguments", c.get("arguments", ""))
                if isinstance(args, str):
                    try:
                        a = json.loads(args)
                        args = ", ".join(f"{k}={v}" for k, v in list(a.items())[:3])
                    except json.JSONDecodeError:
                        args = args[:60]
                parts.append(f"🔧 {name}({args})")
            return "<br>".join(parts)
        return ""
    except (json.JSONDecodeError, TypeError):
        return ""


def _format_tool_result(content: str | None) -> str:
    """格式化工具执行结果为简短摘要。"""
    if not content:
        return ""
    try:
        data = json.loads(content)
        if isinstance(data, dict):
            # 提取关键字段
            parts = []
            for key in ("output", "stdout", "result", "error", "success"):
                if key in data:
                    val = data[key]
                    if isinstance(val, str) and len(val) > 80:
                        val = val[:80] + "..."
                    parts.append(f"{key}={val}")
            if parts:
                return f"[{' '.join(parts)}]"
        return content[:80]
    except (json.JSONDecodeError, TypeError):
        return content[:80]


# ═══════════════════════════════════════════════════════
# 消息模型
# ═══════════════════════════════════════════════════════


@dataclass
class DisplayMessage:
    """显示用的消息模型。"""

    role: str  # user | assistant | tool
    content: str = ""  # 显示用 HTML
    raw_content: str = ""  # 原始文本
    timestamp: str = ""
    msg_id: int = 0
    # 工具相关
    tool_name: str = ""
    tool_calls_html: str = ""
    tool_result_summary: str = ""
    reasoning_html: str = ""  # 思考过程 HTML
    session_ended: bool = False


def _rows_to_display(
    rows: list[dict], existing_last: DisplayMessage | None = None
) -> list[DisplayMessage]:
    """将 Hermes DB rows 批处理为 DisplayMessage 列表（tool 合并到前一条 assistant）。
    existing_last: 已有会话的最后一条 assistant，新 tool 会合并到它身上。"""
    result: list[DisplayMessage] = []
    last_assistant: DisplayMessage | None = existing_last

    for row in rows:
        role = row.get("role", "")
        msg_id = row["id"]
        content = row.get("content") or ""
        tool_name = row.get("tool_name") or ""
        tool_calls = row.get("tool_calls") or ""
        reasoning = row.get("reasoning_content") or ""
        ts = datetime.fromtimestamp(row["timestamp"]).strftime("%H:%M:%S")

        if role == "user":
            dm = DisplayMessage(
                role="user",
                content=_render_message_content(content),
                raw_content=content,
                timestamp=ts,
                msg_id=msg_id,
            )
            result.append(dm)
            last_assistant = None

        elif role == "assistant":
            reasoning_html = _render_message_content(reasoning) if reasoning else ""
            dm = DisplayMessage(
                role="assistant",
                content=_render_message_content(content),
                raw_content=content,
                timestamp=ts,
                msg_id=msg_id,
                reasoning_html=reasoning_html,
            )
            result.append(dm)
            last_assistant = dm

        elif role == "tool" and last_assistant is not None:
            tc_html = _format_tool_calls(tool_calls, tool_name)
            result_summary = _format_tool_result(content)
            if tc_html:
                last_assistant.tool_calls_html = (
                    last_assistant.tool_calls_html + "<br>" + tc_html
                    if last_assistant.tool_calls_html
                    else tc_html
                )
            if result_summary:
                last_assistant.tool_result_summary = (
                    last_assistant.tool_result_summary + "<br>" + result_summary
                    if last_assistant.tool_result_summary
                    else result_summary
                )

    return result


# ═══════════════════════════════════════════════════════
# ChatMessageWidget — 单条消息气泡
# ═══════════════════════════════════════════════════════


class CollapsibleBlock(QFrame):
    """可折叠块 — 用于 tool call / reasoning。

    默认收起只显示一行摘要，点击展开完整内容。
    """

    def __init__(self, icon: str, summary: str, content_html: str, parent=None):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setStyleSheet("background: transparent;")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 1, 0, 1)
        layout.setSpacing(0)

        # 头部 — 用 QToolButton 实现安全点击
        self._header = QToolButton()
        self._header.setCheckable(True)
        self._header.setChecked(False)
        self._header.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self._header.setFixedHeight(22)
        self._header.setCursor(Qt.CursorShape.PointingHandCursor)
        self._header.setText(f"{icon}  {summary}")
        self._header.setToolTip("点击展开/折叠")
        self._header.setStyleSheet(f"""
            QToolButton {{
                color: {_TEXT_DIM};
                font-size: 11px;
                background: transparent;
                border: none;
                border-radius: 4px;
                padding: 0 4px;
                text-align: left;
            }}
            QToolButton:hover {{
                background: {_BG_Surface};
                color: {_TEXT};
            }}
            QToolButton:checked {{
                color: {_TEXT};
            }}
        """)
        layout.addWidget(self._header)

        # 内容 — 默认隐藏
        self._content = QLabel()
        self._content.setTextFormat(Qt.TextFormat.RichText)
        self._content.setWordWrap(True)
        self._content.setText(content_html)
        self._content.setStyleSheet(f"""
            QLabel {{
                color: {_TEXT_DIM};
                background: {_BG_DARK};
                font-size: 11px;
                font-family: 'SF Mono', 'Menlo', monospace;
                padding: 6px 8px 6px 24px;
                border-radius: 4px;
                border: 1px solid {_border};
            }}
        """)
        self._content.setVisible(False)
        layout.addWidget(self._content)

        self._header.toggled.connect(self._on_toggle)
        self._expanded = False

    def _on_toggle(self, checked: bool) -> None:
        self._expanded = checked
        self._content.setVisible(checked)
        # 更新图标样式
        current = self._header.text()
        # 保持前缀不变，只更新末尾箭头
        self._header.setText(
            current
        )  # text already includes icon+summary, we append later


class ChatMessageWidget(QFrame):
    """单条消息的渲染组件。统一 QLabel，无独立滚动条。"""

    def __init__(self, msg: DisplayMessage, parent=None):
        super().__init__(parent)
        self._msg = msg
        self._setup_ui()

    def _setup_ui(self) -> None:
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setStyleSheet("background: transparent;")

        layout = QHBoxLayout(self)
        layout.setContentsMargins(6, 2, 6, 2)
        layout.setSpacing(6)

        is_user = self._msg.role == "user"
        is_tool = self._msg.role == "tool"

        # 角色图标
        if is_tool:
            icon_char = "⚙"
            icon_color = _PEACH
        else:
            icon_char = "✦" if is_user else "◈"
            icon_color = _MAUVE if is_user else _BLUE

        icon = QLabel(icon_char)
        icon.setStyleSheet(
            f"color: {icon_color}; font-size: 14px; font-weight: bold; "
            f"background: transparent; padding-top: 2px;"
        )
        icon.setFixedWidth(18)
        icon.setAlignment(Qt.AlignmentFlag.AlignTop)
        layout.addWidget(icon)

        # 内容列
        content_widget = QWidget()
        content_widget.setStyleSheet("background: transparent;")
        content_layout = QVBoxLayout(content_widget)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.setSpacing(1)

        # 头部：角色名 + 时间戳
        if not is_tool:
            header = QHBoxLayout()
            header.setContentsMargins(0, 0, 0, 0)
            header.setSpacing(4)

            role_label = QLabel("You" if is_user else "Agent")
            role_color = _MAUVE if is_user else _BLUE
            role_label.setStyleSheet(
                f"color: {role_color}; font-weight: bold; font-size: 10px; "
                f"background: transparent; padding-bottom: 1px;"
            )
            header.addWidget(role_label)

            ts_label = QLabel(self._msg.timestamp)
            ts_label.setStyleSheet(
                f"color: {_TEXT_DIM}; font-size: 9px; background: transparent;"
            )
            header.addWidget(ts_label)
            header.addStretch()
            content_layout.addLayout(header)

        # 思考过程 — 折叠块
        if self._msg.reasoning_html:
            reasoning_short = _truncate_text(self._msg.raw_content, 60)
            block = CollapsibleBlock(
                "💭",
                f"思考: {reasoning_short}",
                self._msg.reasoning_html,
            )
            content_layout.addWidget(block)

        # 工具调用 — 折叠块
        if self._msg.tool_calls_html:
            tool_summary = self._msg.tool_name or "工具调用"
            block = CollapsibleBlock(
                "⚙",
                tool_summary,
                self._msg.tool_calls_html,
            )
            content_layout.addWidget(block)

        # 工具结果 — 折叠块
        if self._msg.tool_result_summary:
            result_short = _truncate_text(self._msg.tool_result_summary, 60)
            block = CollapsibleBlock(
                "📎",
                f"结果: {result_short}",
                self._msg.tool_result_summary,
            )
            content_layout.addWidget(block)

        # 消息正文 — 统一用 QLabel，无独立滚动条
        if self._msg.content:
            body = QLabel()
            body.setTextFormat(Qt.TextFormat.RichText)
            body.setWordWrap(True)
            body.setText(self._msg.content)
            body.setStyleSheet(
                f"color: {_TEXT}; background: transparent; font-size: 12px; padding: 0;"
            )
            body.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
            content_layout.addWidget(body)

        layout.addWidget(content_widget, 1)


def _truncate_text(text: str, max_len: int = 60) -> str:
    """截断文本，显示前 max_len 字符 + ..."""
    clean = text.replace("\n", " ").strip()
    if len(clean) <= max_len:
        return clean
    return clean[:max_len] + "..."


# ═══════════════════════════════════════════════════════
# 主面板
# ═══════════════════════════════════════════════════════


_SESSION_ICONS = {
    "running": "●",
    "idle": "○",
    "done": "✓",
    "failed": "✗",
    "killed": "⊘",
    "interrupted": "◉",
    "waiting_input": "💬",
    "waiting_approval": "🔒",
    "": "○",
}

_PLACEHOLDER_KEY = "placeholder"
_PLUS_KEY = "plus"


def _session_icon(state: str) -> str:
    return _SESSION_ICONS.get(state, "○")


# ═══════════════════════════════════════════════════════
# Pi session 持久化
# ═══════════════════════════════════════════════════════


def _pi_session_path(task_uri: str) -> Path:
    """task URI 对应的 pi session 文件路径（与 PiRpcAgent._session_path 一致）。"""
    safe_name = task_uri.replace("/", "_")
    return diy_home() / "pi-sessions" / f"{safe_name}.jsonl"


def _load_pi_session(task_uri: str) -> list[DisplayMessage]:
    """从 pi session JSONL 读取 user/assistant 对话历史。"""
    path = _pi_session_path(task_uri)
    if not path.exists():
        return []
    msgs: list[DisplayMessage] = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "message":
                    continue
                msg = entry.get("message", {})
                role = msg.get("role", "")
                if role not in ("user", "assistant"):
                    continue
                content = _extract_pi_text(msg.get("content", ""))
                if not content:
                    continue
                ts_ms = msg.get("timestamp", 0)
                ts = (
                    datetime.fromtimestamp(ts_ms / 1000).strftime("%H:%M:%S")
                    if ts_ms
                    else ""
                )
                if role == "user":
                    dm = DisplayMessage(
                        role="user",
                        content=_render_message_content(content),
                        raw_content=content,
                        timestamp=ts,
                    )
                else:
                    reasoning = _extract_pi_thinking(msg.get("content", ""))
                    dm = DisplayMessage(
                        role="assistant",
                        content=_render_message_content(content),
                        raw_content=content,
                        timestamp=ts,
                        reasoning_html=_render_message_content(reasoning)
                        if reasoning
                        else "",
                    )
                msgs.append(dm)
    except OSError:
        pass
    return msgs


def _extract_pi_text(content: Any) -> str:
    """从 pi session 的 content 字段提取纯文本。

    content 可能是字符串，也可能是 [{type, text}, ...] 数组。
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                txt = block.get("text", "")
                if txt:
                    texts.append(txt)
        return "\n".join(texts)
    return ""


def _extract_pi_thinking(content: Any) -> str:
    """从 pi session 的 content 字段提取 thinking 内容。"""
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "thinking":
                txt = block.get("thinking", "")
                if txt:
                    texts.append(txt)
        return "\n".join(texts)
    return ""


class AgentChatPanel(QWidget):
    """Agent 对话面板 — 使用 core.AgentManager + SignalBridge。

    每个 task 对应一个 AgentBackend 实例（通过 AgentManager 管理），
    实时事件通过 SignalBridge 发 Qt Signal，再也不用 QTimer 轮询。
    """

    title_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._task_uri: str | None = None
        self._agent = None  # AgentBackend | None
        self._bridge: SignalBridge | None = None
        self._session_id_for_db: str | None = None
        self._sessions_list: list[dict] = []
        self._selected_idx: int | None = None
        self._placeholder_row: int | None = None
        self._message_widgets: list[ChatMessageWidget] = []
        self._last_msg_id: int = 0
        self._auto_scroll = True
        self._agent_running = False
        # widget 缓存：task_uri → list[ChatMessageWidget]
        self._widget_cache: dict[str, list[ChatMessageWidget]] = {}
        # DisplayMessage 全量缓存：task_uri → list[DisplayMessage]（轻量，可随时重建 widget）
        self._cached_msgs: dict[str, list[DisplayMessage]] = {}
        # 已渲染的消息数（惰性加载用）
        self._rendered_count: int = 0
        self._load_more_btn: QPushButton | None = None
        # 流式缓冲：当前正在接收的 assistant 消息
        self._stream_buffer: str = ""
        self._reasoning_buffer: str = ""

        self._setup_ui()
        self._setup_timers()

    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Session 列表
        self._session_list = QListWidget()
        self._session_list.setFrameShape(QFrame.Shape.NoFrame)
        self._session_list.setMaximumHeight(100)
        self._session_list.setMinimumHeight(50)
        self._session_list.setStyleSheet(
            f"QListWidget {{ background: {_BG_DARK}; border-bottom: 1px solid {_border}; }}"
            f"QListWidget::item {{ padding: 3px 8px; color: {_TEXT}; font-size: 11px; }}"
            f"QListWidget::item:selected {{ background: {_BG_Surface}; border-radius: 4px; }}"
        )
        self._session_list.currentRowChanged.connect(self._on_session_selected)
        layout.addWidget(self._session_list)

        # 消息区（QScrollArea 统一滚动）
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet(
            f"QScrollArea {{ background: {_BG}; border: none; }}"
            f"QScrollBar:vertical {{ background: {_BG_DARK}; width: 6px; }}"
            f"QScrollBar::handle:vertical {{ background: {_surface0}; border-radius: 3px; min-height: 20px; }}"
            f"QScrollBar::handle:vertical:hover {{ background: {_surface1}; }}"
            f"QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}"
        )
        scroll.verticalScrollBar().valueChanged.connect(self._on_scroll)

        self._messages_container = QWidget()
        self._messages_container.setStyleSheet(f"background: {_BG};")
        self._messages_layout = QVBoxLayout(self._messages_container)
        self._messages_layout.setContentsMargins(0, 4, 0, 4)
        self._messages_layout.setSpacing(2)
        self._messages_layout.addStretch()

        scroll.setWidget(self._messages_container)
        self._scroll_area = scroll
        layout.addWidget(scroll, 1)

        # 底部输入区
        bottom = QWidget()
        bottom.setStyleSheet(
            f"background: {_BG_DARK}; border-top: 1px solid {_border};"
        )
        bottom_lay = QVBoxLayout(bottom)
        bottom_lay.setContentsMargins(8, 6, 8, 6)
        bottom_lay.setSpacing(4)

        input_row = QHBoxLayout()
        input_row.setSpacing(6)

        self._input = QLineEdit()
        self._input.setPlaceholderText("输入消息开始新对话...")
        self._input.returnPressed.connect(self._send)
        self._input.setStyleSheet(
            f"QLineEdit {{ background: {_BG_Surface}; color: {_TEXT}; "
            f"border: 1px solid {_BG_Surface2}; border-radius: 6px; "
            f"padding: 6px 10px; font-size: 12px; }}"
            f"QLineEdit:focus {{ border-color: {_MAUVE}; }}"
        )
        input_row.addWidget(self._input)

        self._send_btn = QPushButton("发送")
        self._send_btn.setFixedHeight(30)
        self._send_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._send_btn.setStyleSheet(
            f"QPushButton {{ background: {_MAUVE}; color: {_BG_DARK}; border: none; "
            f"border-radius: 6px; padding: 2px 14px; font-size: 11px; font-weight: bold; }}"
            f"QPushButton:hover {{ background: {_BLUE}; }}"
            f"QPushButton:pressed {{ background: {_surface0}; }}"
        )
        self._send_btn.clicked.connect(self._on_send_or_stop)
        input_row.addWidget(self._send_btn)

        bottom_lay.addLayout(input_row)
        layout.addWidget(bottom)

    def _switch_to_stop_btn(self) -> None:
        self._send_btn.setText("⏹ 停止")
        self._send_btn.setStyleSheet(
            f"QPushButton {{ background: {_RED}; color: #fff; border: none; "
            f"border-radius: 6px; padding: 2px 14px; font-size: 11px; font-weight: bold; }}"
            f"QPushButton:hover {{ background: #e64553; }}"
        )

    def _switch_to_send_btn(self) -> None:
        self._send_btn.setText("发送")
        self._send_btn.setStyleSheet(
            f"QPushButton {{ background: {_MAUVE}; color: {_BG_DARK}; border: none; "
            f"border-radius: 6px; padding: 2px 14px; font-size: 11px; font-weight: bold; }}"
            f"QPushButton:hover {{ background: {_BLUE}; }}"
        )

    def _on_send_or_stop(self) -> None:
        if self._agent_running:
            self._stop_agent()
        else:
            self._send()

    def _stop_agent(self) -> None:
        """停止当前 agent 的 prompt（通过 AgentBackend）。"""
        if self._agent is not None:
            try:
                asyncio.ensure_future(self._agent.stop())
            except RuntimeError:
                _logger.debug("[agent] stop 异常（event loop 已关闭）", exc_info=True)
        self._agent_running = False
        self._switch_to_send_btn()

    # ═══════════════════════════════════════════════════
    # Agent 生命周期 — 每个 task 一个 AgentBackend
    # ═══════════════════════════════════════════════════

    async def _ensure_agent(self, task_uri: str) -> None:
        """通过 AgentManager 获取或创建 agent，绑定 SignalBridge。

        自动从 ~/.diy-llm/providers/ 读取第一个已配置的 provider 作为默认 LLM 后端。
        """
        from diy.core.agent_manager import get_manager

        try:
            mgr = get_manager()

            # 1. 先断开旧 bridge（确保停 agent 时信号不泄漏）
            if self._bridge is not None:
                self._disconnect_bridge()
            # self._bridge 现在是 None

            # 2. 停掉旧 task 的 agent
            if self._agent is not None and self._agent.task_uri != task_uri:
                self._agent.set_callbacks(AgentCallbacks())
                await mgr.stop(self._agent.task_uri)

            # 3. 从 task frontmatter 读取后端类型，默认 pi（兼容旧数据）
            from diy.core._state import get_task

            task_info = get_task(task_uri)
            agent_meta = (task_info or {}).get("agent", {}) or {}
            backend_type = agent_meta.get("type", "pi")

            # 4. 从 task frontmatter 读 provider/model（可选，pi 用自己的默认配置）
            provider = agent_meta.get("provider")
            model = agent_meta.get("model")

            self._bridge = SignalBridge()
            agent = await mgr.get_or_create(
                task_uri,
                backend=backend_type,
                provider=provider,
                model=model,
                callbacks=self._bridge.callbacks(),
            )
            # 4. 替换 agent 回调（get_or_create 可能返回存活的旧 agent，其回调指向已删除的旧 bridge）
            agent.set_callbacks(self._bridge.callbacks())
            self._agent = agent
            self._bridge.bind(agent)
            self._connect_bridge()
        except Exception as exc:
            _logger.error("[agent] _ensure_agent 失败 (uri=%s): %s", task_uri, exc, exc_info=True)

    def _connect_bridge(self) -> None:
        """连接 SignalBridge 的信号。"""
        if self._bridge is None:
            return
        self._bridge.delta_received.connect(self._on_acp_delta)
        self._bridge.reasoning_received.connect(self._on_acp_reasoning)
        self._bridge.tool_started.connect(self._on_acp_tool)
        self._bridge.finished.connect(self._on_acp_finished)
        self._bridge.error_occurred.connect(self._on_acp_error)

    def _disconnect_bridge(self) -> None:
        """断开 SignalBridge 的信号。"""
        if self._bridge is None:
            return
        try:
            self._bridge.delta_received.disconnect(self._on_acp_delta)
            self._bridge.reasoning_received.disconnect(self._on_acp_reasoning)
            self._bridge.tool_started.disconnect(self._on_acp_tool)
            self._bridge.finished.disconnect(self._on_acp_finished)
            self._bridge.error_occurred.disconnect(self._on_acp_error)
        except (RuntimeError, TypeError):
            pass
        self._bridge.deleteLater()
        self._bridge = None

    def _on_acp_error(self, msg: str) -> None:
        """ACP 错误日志 — 同时重置按钮状态。"""
        _logger.error("[acp] %s", msg)
        if self._agent_running:
            self._agent_running = False
            self._switch_to_send_btn()

    def _on_acp_delta(self, text: str) -> None:
        """ACP 流式文本 delta——追加到缓冲区，刷新 UI。"""
        self._stream_buffer += text
        self._refresh_streaming_widget()

    def _on_acp_reasoning(self, text: str) -> None:
        """ACP 推理过程——替换 reasoning 缓冲区，刷新 UI。"""
        self._reasoning_buffer = text
        self._refresh_streaming_widget()

    def _on_acp_tool(self, name: str, tc_id: str, args: dict) -> None:
        """ACP 工具事件——记录日志，未来可渲染 tool call 卡片。"""
        _logger.info("[acp] tool: %s id=%s args=%s", name, tc_id, args)

    def _on_acp_finished(self, stop_reason: str) -> None:
        """ACP prompt 完成——将缓冲区渲染为完整消息，重置缓冲。"""
        # 先移除流式 widget，再添加正式消息
        if hasattr(self, "_stream_widget") and self._stream_widget is not None:
            self._messages_layout.removeWidget(self._stream_widget)
            self._stream_widget.deleteLater()
            self._stream_widget = None

        full_text = self._stream_buffer.strip()
        if full_text:
            self._add_assistant_message(full_text, self._reasoning_buffer)
        self._stream_buffer = ""
        self._reasoning_buffer = ""
        self._agent_running = False
        self._switch_to_send_btn()

    def _refresh_streaming_widget(self) -> None:
        """刷新流式消息 widget（更新或创建）。

        在消息列表末尾显示一个正在流式输出的消息 widget，
        实时展示当前累积的 reasoning + 文本内容。
        后续完整消息到达后（_on_acp_finished）替换为正式消息 widget。
        """
        # 移除旧的流式 widget（如果存在）
        if hasattr(self, "_stream_widget") and self._stream_widget is not None:
            self._messages_layout.removeWidget(self._stream_widget)
            self._stream_widget.deleteLater()
            self._stream_widget = None

        # 构建显示文本
        parts = []
        if self._reasoning_buffer:
            parts.append(f"[思考] {self._reasoning_buffer}")
        if self._stream_buffer:
            parts.append(self._stream_buffer)
        display_text = "\n".join(parts) if parts else "..."

        # 创建临时流式消息 widget
        dm = DisplayMessage(
            role="assistant",
            content=_render_message_content(display_text),
            raw_content=display_text,
        )
        self._stream_widget = ChatMessageWidget(dm)
        self._messages_layout.insertWidget(
            self._messages_layout.count() - 1, self._stream_widget
        )
        self._scroll_to_bottom()

    def _add_assistant_message(self, content: str, reasoning: str = "") -> None:
        """将完整 assistant 消息添加为正式 widget。"""
        ts = datetime.now().strftime("%H:%M:%S")
        dm = DisplayMessage(
            role="assistant",
            content=_render_message_content(content),
            raw_content=content,
            timestamp=ts,
            reasoning_html=_render_message_content(reasoning) if reasoning else "",
        )
        # 缓存
        if self._task_uri:
            self._cached_msgs.setdefault(self._task_uri, []).append(dm)
        widget = ChatMessageWidget(dm)
        self._message_widgets.append(widget)
        self._messages_layout.insertWidget(self._messages_layout.count() - 1, widget)
        self._scroll_to_bottom()

    def set_compact(self, compact: bool = True) -> None:
        pass

    def _setup_timers(self) -> None:
        self._session_timer = QTimer(self)
        self._session_timer.timeout.connect(self._refresh_sessions)
        self._session_timer.start(3000)

        # 消息轮询（500ms，timeout=0 不阻塞主线程）
        self._poll_timer = QTimer(self)
        self._poll_timer.timeout.connect(self._poll_messages)
        self._poll_timer.start(500)

    # ═══════════════════════════════════════════════════
    # 滚动控制
    # ═══════════════════════════════════════════════════

    def _on_scroll(self, value: int) -> None:
        sb = self._scroll_area.verticalScrollBar()
        self._auto_scroll = value >= sb.maximum() - 30

    def _scroll_to_bottom(self) -> None:
        if self._auto_scroll:
            # 延迟到下一次事件循环，确保布局已更新、scrollbar.maximum() 正确
            QTimer.singleShot(0, self._do_scroll_to_bottom)

    def _do_scroll_to_bottom(self) -> None:
        sb = self._scroll_area.verticalScrollBar()
        sb.setValue(sb.maximum())

    # ═══════════════════════════════════════════════════
    # 消息读取与渲染（批处理，不重建）
    # ═══════════════════════════════════════════════════

    def _poll_messages(self) -> None:
        """轮询 Hermes DB，更新 _cached_msgs 并刷新 UI。"""
        if not self._task_uri or not _HERMES_DB.exists():
            return

        session_id = self._session_id_for_db or f"agent-{self._task_uri}"
        rows = _read_messages(session_id, self._last_msg_id)
        if not rows:
            return
        self._last_msg_id = max(r["id"] for r in rows)

        # 更新 _cached_msgs（tool 消息合并到最后一条 assistant）
        uri = self._task_uri
        existing = self._cached_msgs.get(uri, [])
        last = existing[-1] if existing and existing[-1].role == "assistant" else None
        new_msgs = _rows_to_display(rows, last)

        # 追加到缓存
        self._cached_msgs.setdefault(uri, []).extend(new_msgs)
        self._rendered_count += len(new_msgs)

        # 更新 UI：新 user/assistant 消息创建 widget
        for dm in new_msgs:
            widget = ChatMessageWidget(dm)
            self._message_widgets.append(widget)
            self._messages_layout.insertWidget(
                self._messages_layout.count() - 1, widget
            )

        # 只有 tool 消息更新了最后一条 assistant → 重建最后一条 widget
        if not new_msgs and last is not None:
            self._rebuild_last_widget(last)

        self._scroll_to_bottom()

    # ═══════════════════════════════════════════════════
    # Session 列表
    # ═══════════════════════════════════════════════════

    def _rebuild_list(self, sessions: list[dict]) -> None:
        self._session_list.blockSignals(True)
        self._session_list.clear()

        for s in sessions:
            icon = _session_icon(s.get("state", ""))
            sid = s.get("agent_id", s.get("id", "?"))
            item = QListWidgetItem(f"{icon} {sid}")
            item.setData(Qt.ItemDataRole.UserRole, s)
            item.setToolTip(s.get("state", ""))
            self._session_list.addItem(item)

        plus_item = QListWidgetItem("[+ 新会话]")
        plus_item.setData(Qt.ItemDataRole.UserRole, _PLUS_KEY)
        plus_item.setForeground(Qt.GlobalColor.gray)
        plus_item.setToolTip("点击后可输入新消息创建会话")
        self._session_list.addItem(plus_item)

        self._session_list.blockSignals(False)

    def _add_placeholder(self) -> None:
        if self._placeholder_row is not None:
            return
        item = QListWidgetItem("⏳ 新会话...")
        item.setData(Qt.ItemDataRole.UserRole, _PLACEHOLDER_KEY)
        item.setFlags(Qt.ItemFlag.NoItemFlags)
        self._session_list.addItem(item)
        self._placeholder_row = self._session_list.count() - 1

    def _remove_placeholder(self) -> None:
        if self._placeholder_row is not None:
            self._session_list.takeItem(self._placeholder_row)
            self._placeholder_row = None

    def _refresh_sessions(self) -> None:
        if not self._task_uri:
            return
        # 1:1 会话，无需刷新列表
        pass

    def _on_session_selected(self, row: int) -> None:
        item = self._session_list.item(row)
        if item is None:
            return
        data = item.data(Qt.ItemDataRole.UserRole)
        if data == _PLUS_KEY:
            self._input.setFocus()
            return
        if data == _PLACEHOLDER_KEY:
            return
        self._selected_idx = row

    # ═══════════════════════════════════════════════════
    # 发送 / 设置 task
    # ═══════════════════════════════════════════════════

    def set_task(self, task_uri: str) -> None:
        if task_uri == self._task_uri:
            return
        self._task_uri = task_uri
        self._message_widgets.clear()
        self._last_msg_id = 0
        self._agent_running = False
        self._rendered_count = 0
        self._load_more_btn = None
        self._switch_to_send_btn()
        self._auto_scroll = True  # 新任务 → 必定滚到底

        self._clear_messages_container()

        # 确定真实 session_id
        self._session_id_for_db = _resolve_session_id(task_uri)

        # 全量 DisplayMessage 缓存（仅读取+处理，不建 widget）
        if task_uri not in self._cached_msgs:
            # 先试真实 session_id，再试默认格式
            for sid in filter(None, [self._session_id_for_db, f"agent-{task_uri}"]):
                rows = _read_messages(sid)
                if rows:
                    rows = _trim_to_line_limit(rows)
                    self._last_msg_id = max(r["id"] for r in rows)
                    self._cached_msgs[task_uri] = _rows_to_display(rows)
                    break
            if task_uri not in self._cached_msgs:
                # 回退到 pi session 文件（PiRpcAgent 自动保存）
                pi_msgs = _load_pi_session(task_uri)
                if pi_msgs:
                    self._cached_msgs[task_uri] = pi_msgs
        # 渲染最近 PAGE_SIZE 条
        self._render_window(task_uri)
        # 立即滚动 + 下一事件循环兜底（布局完成后滚动正确）
        self._do_scroll_to_bottom()
        QTimer.singleShot(0, self._do_scroll_to_bottom)
        self._input.setFocus()

        # 异步获取 agent（SignalBridge 自动连接）
        asyncio.ensure_future(self._ensure_agent(task_uri))

    def _render_window(self, task_uri: str) -> None:
        """渲染 task 的消息窗口（惰性加载，最近 _MAX_RENDER_LINES 行）。"""
        self._message_widgets.clear()
        self._clear_messages_container()

        all_msgs = self._cached_msgs.get(task_uri, [])
        total = len(all_msgs)
        if total == 0:
            return

        # 未渲染的消息范围: [0, unrendered_end)
        unrendered_end = total - self._rendered_count
        if unrendered_end <= 0:
            return

        # 从后向前累积行数
        lines = 0
        start = unrendered_end
        for i in range(unrendered_end - 1, -1, -1):
            dm = all_msgs[i]
            n = dm.raw_content.count("\n") + 1
            n += 2  # 头尾间距
            lines += n
            if lines > _MAX_RENDER_LINES:
                break
            start = i

        window = all_msgs[start:unrendered_end]
        self._rendered_count += len(window)

        # 顶部的"加载更多"按钮
        remaining = start  # 还有多少条更早消息未加载
        if remaining > 0:
            self._load_more_btn = QPushButton(f"↑ 加载更早消息（共{remaining}条）")
            self._load_more_btn.setCursor(Qt.CursorShape.PointingHandCursor)
            self._load_more_btn.setStyleSheet(
                f"QPushButton {{ background: {_BG_Surface}; color: {_TEXT_DIM}; border: none; "
                f"border-radius: 4px; padding: 4px 12px; font-size: 11px; }}"
                f"QPushButton:hover {{ background: {_BG_Surface2}; color: {_TEXT}; }}"
            )
            self._load_more_btn.clicked.connect(self._on_load_more)
            self._messages_layout.insertWidget(
                self._messages_layout.count() - 1, self._load_more_btn
            )

        # 创建 widget
        for dm in window:
            widget = ChatMessageWidget(dm)
            self._message_widgets.append(widget)
            self._messages_layout.insertWidget(
                self._messages_layout.count() - 1, widget
            )

    def _on_load_more(self) -> None:
        """ "加载更多"按钮点击 → 渲染上一批消息。"""
        self._render_window(self._task_uri)
        self._scroll_to_bottom()

    def _rebuild_last_widget(self, dm: DisplayMessage) -> None:
        """只重建最后一条 widget（tool 内容更新后）。"""
        if not self._message_widgets:
            return
        for i in range(len(self._message_widgets) - 1, -1, -1):
            if self._message_widgets[i]._msg.role == "assistant":
                old = self._message_widgets[i]
                new_w = ChatMessageWidget(dm)
                self._messages_layout.insertWidget(
                    self._messages_layout.indexOf(old), new_w
                )
                old.deleteLater()
                self._message_widgets[i] = new_w
                return

    def _clear_messages_container(self) -> None:
        """清空消息布局，但不删除 widget（缓存复用）。"""
        while self._messages_layout.count() > 1:
            item = self._messages_layout.takeAt(0)
            if item is not None:
                w = item.widget()
                if w is not None:
                    w.setParent(None)
                    w.hide()

    def _send(self, text: str | None = None) -> None:
        if text is None:
            text = self._input.text().strip()
        if not text or not self._task_uri:
            return
        self._input.clear()

        # 添加用户消息（本地立即显示）
        ts = datetime.now().strftime("%H:%M:%S")
        dm = DisplayMessage(
            role="user",
            content=_render_message_content(text),
            raw_content=text,
            timestamp=ts,
        )
        widget = ChatMessageWidget(dm)
        self._message_widgets.append(widget)
        self._messages_layout.insertWidget(self._messages_layout.count() - 1, widget)
        self._scroll_to_bottom()

        # 缓存
        if self._task_uri:
            self._cached_msgs.setdefault(self._task_uri, []).append(dm)

        # 通过 SignalBridge + AgentBackend 异步发送（实时事件通过 Qt Signal 返回）
        if self._agent is not None:
            if not self._agent.is_alive:
                # agent 已死（如超时后 kill），触重新创建
                _logger.info("[agent] agent 已死亡，重新创建: %s", self._agent.task_uri)
                asyncio.ensure_future(self._ensure_agent(self._task_uri))
                asyncio.ensure_future(self._deferred_send(text))
                return
            try:
                asyncio.ensure_future(self._run_prompt(text))
                self._agent_running = True
                self._switch_to_stop_btn()
            except RuntimeError as exc:
                _logger.error("[agent] 发送失败（asyncio loop 未运行）: %s", exc)
            return

        # agent 尚未创建（_ensure_agent 可能还在运行或在排队）
        if self._task_uri:
            _logger.info("[agent] 队列发送: task=%s agent 尚不可用，稍后重试", self._task_uri)
            asyncio.ensure_future(self._deferred_send(text))

    async def _run_prompt(self, text: str) -> None:
        """在 event loop 上执行 agent.send()。"""
        if self._agent is None:
            return
        try:
            await self._agent.send(text)
        except Exception as exc:
            _logger.error("[agent] prompt 失败: %s", exc)

        # send 完成后 agent 进入 idle，立即切回发送按钮
        if self._agent_running:
            self._agent_running = False
            self._switch_to_send_btn()

    async def _deferred_send(self, text: str) -> None:
        """等待 agent 就绪后发送（最多等 30s）。"""
        for _ in range(30):
            if self._agent is not None:
                await self._run_prompt(text)
                return
            await asyncio.sleep(1)
        _logger.warning("[agent] 超时等待 agent 就绪，消息未发送: %s", text[:60])

    def send_text(self, text: str) -> None:
        if self._agent_running:
            self._stop_agent()
        self._input.setText(text)
        self._send()

    def _collect_message_widgets(self) -> list[ChatMessageWidget]:
        """从 _messages_layout 提取所有 ChatMessageWidget（真正的 UI 组件树）。"""
        widgets: list[ChatMessageWidget] = []
        for i in range(self._messages_layout.count()):
            item = self._messages_layout.itemAt(i)
            if item is None:
                continue
            w = item.widget()
            if isinstance(w, ChatMessageWidget):
                widgets.append(w)
        return widgets

    def ui_state(self) -> dict:
        """读取 UI 组件实时状态（从 _messages_layout 等 Qt 组件树提取）。"""
        agent_state = self._agent.state if self._agent else None
        msg_count = len(self._collect_message_widgets())
        return {
            "task_uri": self._task_uri,
            "agent_running": self._agent_running,
            "agent_state": agent_state,
            "agent_alive": self._agent.is_alive if self._agent else False,
            "messages": msg_count,
            "sessions": []
            if not self._agent
            else [
                {
                    "id": self._agent.session_id,
                    "state": self._agent.state,
                    "messages": msg_count,
                }
            ],
        }

    def ui_chat_log(self) -> str:
        """读取 UI 组件实时对话文本（从 _messages_layout 提取）。"""
        widgets = self._collect_message_widgets()
        if not widgets:
            return "(无对话)"
        lines = []
        for w in widgets:
            m = w._msg
            arrow = "←" if m.role == "user" else "→" if m.role == "assistant" else "⚙"
            txt = (m.raw_content or "")[:200]
            ts = m.timestamp or ""
            lines.append(f"[{ts}] {arrow} {txt}")
        return "\n".join(lines)
