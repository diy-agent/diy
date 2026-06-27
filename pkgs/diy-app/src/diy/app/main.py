"""diy 管控台 v2 — 主入口。

启动 PySide6 窗口，渲染任务树 + agent 监控。
"""

from __future__ import annotations  # noqa: I001  # __future__ 必须在文件最顶

import asyncio
import errno
import os
import sys
import time
import traceback
from pathlib import Path
import io as _io
from typing import Any

# ── QWebEngine Chromium flags 必须在 import QtWebEngineWidgets 之前设置 ──
#
# ⚠️ 警告：此 flag 设置必须放在 import QtWebEngineWidgets 之前，因为
#   import 时 WebEngine 会读取并缓存 flags，之后再设无效（os.environ 改了但
#   Chromium 内部不认识）。
#
# ⚠️ 禁止使用 --single-process！PySide6 6.8 + macOS 12 上该 flag 导致
#   V8 Proxy Resolver 初始化失败 → system_network_context_manager SIGSEGV。
#
#   改用 --disable-gpu 避免 GPU 子进程的 MachPort 冲突，同时保持 multi-process
#   模式，V8 Proxy Resolver 正常工作。
_qtwebengine_flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "")
if (
    "--single-process" not in _qtwebengine_flags
    and "--disable-gpu" not in _qtwebengine_flags
):
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = (
        _qtwebengine_flags + " --disable-gpu"
    ).strip()

from PySide6.QtCore import (  # type: ignore[import-untyped]  # noqa: E402, I001  # Qt chromium flags 设后才能 import PySide6
    QEvent,
    QFileSystemWatcher,
    QItemSelectionModel,
    QSortFilterProxyModel,
    Qt,
    QTimer,
    Signal,
    Slot,
)
from PySide6.QtGui import (  # type: ignore[import-untyped]  # noqa: E402, I001  # 同上：chromium flags 后 import
    QAction,
    QStandardItem,
    QStandardItemModel,
)

# ── QWebEngineView 安全创建守卫 ──
#
# macOS + PySide6 6.8 上，在窗口收到 NSApplicationDidBecomeActiveNotification 之前
# 创建 QWebEngineView 会导致 use-after-free SIGSEGV。所有 WebEngineView 实例必须
# 通过 _safe_create_webengine_view() 创建，该函数在 app 未 active 时抛出清晰异常。
#
# 类型标注仍需 import，故保留模块级 import 供 type checker 用，但实例化必须走守卫。
from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: E402, I001  # type: ignore[import-untyped]  # chromium flags 设后才能 import WebEngine

_webengine_ready: bool = False  # set True 后安全创建 WebEngineView


def _safe_create_webengine_view() -> QWebEngineView:
    """安全创建 QWebEngineView 实例。

    若 app 尚未收到 NSApplicationDidBecomeActiveNotification，抛出 RuntimeError。
    """
    if not _webengine_ready:
        raise RuntimeError(
            "QWebEngineView 创建过早！macOS 上窗口未 active 时创建会导致 SIGSEGV。\n"
            "参见 MainWindow._mark_webengine_ready() 和 _ensure_view() 的延迟机制。"
        )
    return QWebEngineView()


def _mark_webengine_ready() -> None:
    """标记 WebEngine 可安全创建（由 MainWindow 在收到激活事件后调用）。"""
    global _webengine_ready
    _webengine_ready = True


from diy.app._agent_chat import AgentChatPanel  # noqa: E402  # 同上
from diy.app._app_log import logger, setup_app_logger  # noqa: E402  # 同上
from diy.app._doctor import HealthIssue, run_check  # noqa: E402  # 同上
from diy.app._log_panel import LogPanel  # noqa: E402  # 同上
from diy.app._metrics import MetricsStore  # noqa: E402  # 同上
from diy.app._overlay_panel import OverlayPanel  # noqa: E402  # 同上
from diy.app._status_bar import StatusBar  # noqa: E402  # 同上
from diy.app._title_bar import TitleBar  # noqa: E402  # 同上
from diy.app.llm._page import LLMPage  # noqa: E402  # 同上
from diy.app.screen import Area, Panel, Screen  # noqa: E402  # 同上
from diy.app.task_tree import TaskNode, load_task_tree  # noqa: E402  # 同上
from diy.core._state import (  # noqa: E402  # 因 Qt chromium flags 先行设置，以下 import 均无法在文件顶
    diy_home,
)
from diy.core.agent_manager import get_manager  # noqa: E402  # 同上
from PySide6.QtWidgets import (  # type: ignore[import-untyped]  # noqa: E402  # chromium flags 设后才能 import QtWidgets
    QAbstractItemView,
    QApplication,
    QComboBox,
    QDialog,
    QDockWidget,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QStackedWidget,
    QTabWidget,
    QTextEdit,
    QToolButton,
    QTreeView,
    QVBoxLayout,
    QWidget,
)

# ═══════════════════════════════════════════════════════
# 自定义 data roles
# ═══════════════════════════════════════════════════════

ROLE_TASK_URI = Qt.ItemDataRole.UserRole + 1
ROLE_KIND = Qt.ItemDataRole.UserRole + 2
ROLE_STATE = Qt.ItemDataRole.UserRole + 3
ROLE_SUBJECT = Qt.ItemDataRole.UserRole + 4


# ═══════════════════════════════════════════════════════
# Material3 暗色主题 — 语义化颜色系统
# ═══════════════════════════════════════════════════════

import os as _os  # noqa: E402  # 放在 Qt 主题定义前，因 chromium flags 已打乱 import 顺序
import pwd as _pwd  # noqa: E402  # 同上


def _detect_sandbox() -> tuple[bool, str]:
    """检测是否在隔离模式下运行（测试/调试/多实例）。

    判定条件：
    1. $HOME ≠ 真实 HOME（临时目录模式）
    2. $DIY_HOME 已设置（项目级隔离模式）

    Returns:
        (is_sandbox, data_path) — data_path 是数据目录路径
    """
    # 检查是否设置了 DIY_HOME（非默认值）
    if _os.environ.get("DIY_HOME"):
        return True, str(diy_home())

    # 检查 HOME 是否被覆盖
    real_home = _pwd.getpwuid(_os.getuid()).pw_dir
    current_home = _os.path.expanduser("~")
    if current_home != real_home:
        return True, current_home

    return False, str(diy_home())


class Theme:
    """语义化颜色令牌 — 高对比度暗色主题"""

    # 基色
    surface = "#1e1e2e"  # 主背景
    surface_alt = "#181825"  # 侧栏/面板背景
    on_surface = "#cdd6f4"  # 主文本
    on_surface_variant = "#a6adc8"  # 次要文本
    outline = "#45475a"  # 分隔线

    # 状态色 — 高对比度版本
    pending_bg = "#e5c07b"  # 琥珀黄背景
    pending_fg = "#1e1e2e"  # 琥珀上文本（深色）
    active_bg = "#7aa2f7"  # 明亮蓝
    active_fg = "#1e1e2e"
    done_bg = "#9ece6a"  # 明亮绿
    done_fg = "#1e1e2e"
    cancelled_bg = "#565f89"  # 灰紫
    cancelled_fg = "#cdd6f4"
    blocked_bg = "#f7768e"  # 明亮红
    blocked_fg = "#1e1e2e"
    shelved_bg = "#e0af68"  # 橙
    shelved_fg = "#1e1e2e"
    new_bg = "#73daca"  # 青
    new_fg = "#1e1e2e"

    # 调试/沙箱模式 — 暖色替代蓝
    sandbox_bg = "#e5c07b"  # 琥珀色（替代 active_bg 的蓝）
    sandbox_fg = "#1e1e2e"

    @classmethod
    def state_bg(cls, state: str) -> str:
        return {
            "pending": cls.pending_bg,
            "active": cls.active_bg,
            "open": cls.active_bg,
            "done": cls.done_bg,
            "closed": cls.done_bg,
            "cancelled": cls.cancelled_bg,
            "blocked": cls.blocked_bg,
            "shelved": cls.shelved_bg,
            "new": cls.new_bg,
        }.get(state, cls.cancelled_bg)

    @classmethod
    def state_fg(cls, state: str) -> str:
        return {
            "pending": cls.pending_fg,
            "active": cls.active_fg,
            "open": cls.active_fg,
            "done": cls.done_fg,
            "closed": cls.done_fg,
            "cancelled": cls.cancelled_fg,
            "blocked": cls.blocked_fg,
            "shelved": cls.shelved_fg,
            "new": cls.new_fg,
        }.get(state, cls.on_surface)


def _icons_dir() -> Path:
    """返回 app/icons 目录路径（pkg 内打包）。"""
    return Path(__file__).resolve().parent / "icons"


def _app_stylesheet(sandbox: bool = False) -> str:
    """全局 Material3 暗色主题 QSS。

    sandbox=True 时用琥珀色替代蓝色作为强调色，区分调试/生产环境。
    """
    accent = Theme.sandbox_bg if sandbox else Theme.active_bg
    dock_bg = Theme.sandbox_bg if sandbox else Theme.surface_alt
    tab_bg = Theme.sandbox_bg if sandbox else Theme.surface
    btn_hover = Theme.sandbox_bg if sandbox else "#585b70"
    return f"""
        QMainWindow {{ background: {Theme.surface}; }}
        QDockWidget {{ background: {Theme.surface}; color: {Theme.on_surface};
                       border: 1px solid {Theme.outline}; titlebar-close-icon: none; }}
        QDockWidget::title {{ background: {dock_bg};
                              padding: 4px 8px; text-align: left; }}
        QTreeView {{ background: {Theme.surface}; color: {Theme.on_surface};
                     border: none; font-size: 13px;
                     outline: none; }}
        QTreeView::item {{ padding: 2px 4px; border-radius: 4px; }}
        QTreeView::item:selected {{ background: #45475a; color: #cdd6f4; }}
        QTreeView::item:hover {{ background: #313244; }}
        QTreeView::branch {{ background: {Theme.surface}; }}
        QTreeView::branch:has-children:closed {{ image: url({_icons_dir() / "branch-closed.png"}); }}
        QTreeView::branch:has-children:open {{ image: url({_icons_dir() / "branch-open.png"}); }}
        QTextBrowser {{ background: {Theme.surface}; color: {Theme.on_surface};
                        border: none; font-size: 14px; padding: 8px; }}
        QPlainTextEdit {{ background: {Theme.surface_alt}; color: {Theme.on_surface};
                          border: none; font-size: 12px; }}
        QLineEdit {{ background: {Theme.surface_alt}; color: {Theme.on_surface};
                     border: 1px solid {Theme.outline}; border-radius: 4px;
                     padding: 4px 8px; }}
        QLineEdit:focus {{ border: 1px solid {accent}; }}
        QPushButton {{ background: #45475a; color: {Theme.on_surface};
                       border: none; border-radius: 4px; padding: 4px 12px; }}
        QPushButton:hover {{ background: {btn_hover}; }}
        QTabWidget::pane {{ background: {Theme.surface}; border: 1px solid {Theme.outline}; }}
        QTabBar::tab {{ background: {Theme.surface_alt}; color: {Theme.on_surface_variant};
                       padding: 4px 12px; border: none; }}
        QTabBar::tab:selected {{ background: {tab_bg}; color: {Theme.on_surface};
                                 border-bottom: 2px solid {accent}; }}
        QScrollBar:vertical {{ background: {Theme.surface_alt}; width: 10px;
                               border: none; }}
        QScrollBar::handle:vertical {{ background: #45475a; border-radius: 4px;
                                       min-height: 20px; }}
        QScrollBar::handle:vertical:hover {{ background: #585b70; }}
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical
          {{ height: 0; background: none; border: none; }}
        QToolTip {{ background: {Theme.surface_alt}; color: {Theme.on_surface};
                    border: 1px solid {Theme.outline}; font-size: 12px; }}
    """


def _esc_html(text: str) -> str:
    """转义 HTML 特殊字符"""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _short_uri(uri: str) -> str:
    """URI 短显示：local/task/58 → local#58, github.com/.../58 → github#58"""
    if uri.startswith("local/"):
        num = uri.rstrip("/").rsplit("/", 1)[-1]
        return f"local#{num}"
    if "github.com" in uri:
        num = uri.rstrip("/").rsplit("/", 1)[-1]
        return f"github#{num}"
    return uri


def _state_badge(state: str) -> str:
    bg = Theme.state_bg(state)
    fg = Theme.state_fg(state)
    return f'<span class="badge" style="background:{bg};color:{fg};">{state}</span>'


def build_model(nodes: list[TaskNode]) -> QStandardItemModel:
    """从 TaskNode 树构建 QStandardItemModel。"""
    model = QStandardItemModel()
    model.setHorizontalHeaderLabels(["任务"])
    for node in nodes:
        _add_node(model, node)
    return model


def _add_node(
    parent: QStandardItemModel | QStandardItem,
    node: TaskNode,
) -> None:
    from PySide6.QtGui import QColor  # type: ignore[import-untyped]

    if node.kind == "subject":
        expanded = Path(node.key).expanduser()
        is_git = expanded.joinpath(".git").is_dir()
        icon = "📦" if is_git else "📁"
        text = f"{icon} {node.label or node.key}"
    else:
        icon = node.state_icon
        display_uri = _short_uri(node.uri or "")
        text = (
            f"{icon} {display_uri} {node.title}"
            if node.title
            else f"{icon} {display_uri}"
        )

    if node.agents:
        running = [a for a in node.agents if a.state == "running"]
        if running:
            text += f"  [🤖×{len(running)}]"

    item = QStandardItem(text)
    item.setData(node.uri, ROLE_TASK_URI)
    item.setData(node.kind, ROLE_KIND)
    item.setData(node.state, ROLE_STATE)
    item.setData(node.subject_path, ROLE_SUBJECT)

    # 树节点用列表文本色，不用 badge 色
    item.setForeground(QColor(Theme.on_surface))

    parent.appendRow(item)
    for child in node.children:
        _add_node(item, child)


# ═══════════════════════════════════════════════════════
# 边界防护 — 所有外部入口统一兜底
# ═══════════════════════════════════════════════════════


def safe_call(fn, *args, _context="", _on_error="return", **kwargs):
    """所有边界调用的防护层。

    _on_error="return" → 返回错误字符串（socket 边界）
    _on_error="silent" → 吞异常，返回 None（定时器/监控回调）
    """
    try:
        return fn(*args, **kwargs)
    except Exception:
        tb = traceback.format_exc()
        logger.error("[%s] 边界异常\n%s", _context, tb.rstrip())
        if _on_error == "return":
            return f"内部错误 (context={_context})"
        return None


def guarded(context: str):
    """装饰器：为 Qt slot / 回调加防护边界。"""
    import functools

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            return safe_call(fn, *args, _context=context, _on_error="silent", **kwargs)

        return wrapper

    return deco


# ═══════════════════════════════════════════════════════
# DetailView — HTML 元数据 + WebEngine body
# ═══════════════════════════════════════════════════════


class DetailView(QWidget):
    """详情面板：查看/编辑任务。GitHub/Jira 风格的两栏布局。"""

    task_saved = Signal(str)  # task_uri

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── 顶栏：URI + state + 按钮 ──
        self._toolbar = QWidget()
        self._toolbar.setFixedHeight(32)
        tb_lay = QHBoxLayout(self._toolbar)
        tb_lay.setContentsMargins(8, 2, 8, 2)
        tb_lay.setSpacing(6)

        self._uri_label = QLabel()
        self._uri_label.setStyleSheet(
            "color: #cdd6f4; font-size: 12px; font-weight: bold;"
        )

        self._state_label = QLabel()
        self._state_label.setStyleSheet("color: #a6adc8; font-size: 11px;")

        tb_lay.addWidget(self._uri_label)
        tb_lay.addWidget(self._state_label)
        tb_lay.addStretch()

        self._edit_btn = QPushButton("✏️ 编辑")
        self._edit_btn.setFixedHeight(24)
        self._edit_btn.setStyleSheet(
            "QPushButton { background: #45475a; color: #cdd6f4; border: none;"
            " border-radius: 4px; padding: 2px 10px; font-size: 11px; }"
            "QPushButton:hover { background: #585b70; }"
        )
        self._edit_btn.clicked.connect(self._toggle_edit)

        self._save_btn = QPushButton("💾 保存")
        self._save_btn.setFixedHeight(24)
        self._save_btn.setStyleSheet(
            "QPushButton { background: #a6e3a1; color: #1e1e2e; border: none;"
            " border-radius: 4px; padding: 2px 10px; font-size: 11px; font-weight: bold; }"
            "QPushButton:hover { background: #94e2d5; }"
        )
        self._save_btn.clicked.connect(self._save_task)
        self._save_btn.hide()

        self._cancel_btn = QPushButton("取消")
        self._cancel_btn.setFixedHeight(24)
        self._cancel_btn.setStyleSheet(
            "QPushButton { background: #45475a; color: #cdd6f4; border: none;"
            " border-radius: 4px; padding: 2px 10px; font-size: 11px; }"
            "QPushButton:hover { background: #585b70; }"
        )
        self._cancel_btn.clicked.connect(self._cancel_edit)
        self._cancel_btn.hide()

        tb_lay.addWidget(self._edit_btn)
        tb_lay.addWidget(self._save_btn)
        tb_lay.addWidget(self._cancel_btn)

        layout.addWidget(self._toolbar)

        # ── 内容区：body / edit 切换 ──
        self._stack = QStackedWidget()

        # view 页 — body 区（QWebEngineView 延迟创建，避免 macOS 启动时 Chromium
        # 初始化与 NSApplicationDidBecomeActiveNotification 冲突 → SIGSEGV）
        self.view: QWebEngineView | None = None
        self._stack.addWidget(QWidget())  # 占位，首次 setHtml 时替换

        # edit 页
        edit_page = QWidget()
        ed_lay = QVBoxLayout(edit_page)
        ed_lay.setContentsMargins(8, 8, 8, 8)
        ed_lay.setSpacing(6)

        ed_lay.addWidget(QLabel("标题"))
        self._edit_title = QLineEdit()
        self._edit_title.setStyleSheet(
            "QLineEdit { background: #313244; color: #cdd6f4; border: 1px solid #45475a;"
            " border-radius: 4px; padding: 6px 8px; font-size: 14px; }"
        )
        ed_lay.addWidget(self._edit_title)

        ed_lay.addWidget(QLabel("文档 (Markdown)"))
        self._edit_body = QPlainTextEdit()
        self._edit_body.setStyleSheet(
            "QPlainTextEdit { background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a;"
            " border-radius: 4px; padding: 6px; font-size: 13px;"
            " font-family: 'SF Mono', monospace; }"
        )
        ed_lay.addWidget(self._edit_body)

        self._stack.addWidget(edit_page)
        layout.addWidget(self._stack, 1)

        # ── 当前状态 ──
        self._current_task_uri: str | None = None
        self._current_node: TaskNode | None = None

    # ── 公开接口 ──

    def _ensure_view(self) -> None:
        """延迟创建 QWebEngineView（首次需要渲染 HTML 时）。

        macOS 上过早创建 QWebEngineView（窗口未 active 时）会导致
        NSApplicationDidBecomeActiveNotification 冲突 → SIGSEGV。
        守卫 _webengine_ready 确保最早在 window.show() 后 200ms 才创建。
        """
        if self.view is not None:
            return
        # _webengine_ready 在 window.show() 后 200ms 由定时器设为 True，
        # 在此之前创建 QWebEngineView 都会触发 macOS 上的 SIGSEGV。
        # 此全局守卫是最终安全网，不可绕过（禁止直接 QWebEngineView()）。
        if not _webengine_ready:
            QTimer.singleShot(200, self._ensure_view)
            return
        wv = _safe_create_webengine_view()
        self.view = wv
        self._stack.insertWidget(0, wv)
        self._stack.removeWidget(self._stack.widget(1))  # 移除占位符

    def show_task(self, uri: str, node: TaskNode | None, html: str) -> None:
        """进入查看模式，显示任务详情。"""
        self._ensure_view()
        if self.view is None:
            # 窗口尚未就绪（_ensure_view 延迟了），200ms 后重试。
            # 仅发生在 macOS 启动瞬间，窗口 active 后不会触发。
            QTimer.singleShot(200, lambda: self.show_task(uri, node, html))
            return
        self._current_task_uri = uri
        self._current_node = node
        self._stack.setCurrentIndex(0)
        self._edit_btn.show()
        self._save_btn.hide()
        self._cancel_btn.hide()
        self._uri_label.setText(uri)
        state = node.state if node else ""
        self._state_label.setText(state)
        self.view.setHtml(html)

    def show_placeholder(self, html: str) -> None:
        """显示占位信息（无任务选中）。"""
        self._ensure_view()
        if self.view is None:
            # 窗口尚未就绪（_ensure_view 延迟了），200ms 后重试。
            # 仅发生在 macOS 启动瞬间，窗口 active 后不会触发。
            QTimer.singleShot(200, lambda: self.show_placeholder(html))
            return
        self._current_task_uri = None
        self._current_node = None
        self._stack.setCurrentIndex(0)
        self._edit_btn.hide()
        self._save_btn.hide()
        self._cancel_btn.hide()
        self._uri_label.clear()
        self._state_label.clear()

        self.view.setHtml(html)

    # ── 编辑模式 ──

    def _toggle_edit(self) -> None:
        """切换到编辑模式。

        ⚠️ setCurrentIndex(1) 是必须的——只填字段不切页 = 用户看到还是只读视图。
        """
        if not self._current_node:
            return
        self._edit_title.setText(self._current_node.title or "")
        self._edit_body.setPlainText(self._current_node.body or "")
        self._stack.setCurrentIndex(1)
        self._edit_btn.hide()
        self._save_btn.show()
        self._cancel_btn.show()

    def _cancel_edit(self) -> None:
        """取消编辑，返回查看模式。"""
        self._stack.setCurrentIndex(0)
        self._edit_btn.show()
        self._save_btn.hide()
        self._cancel_btn.hide()

    def _save_task(self) -> None:
        """保存任务修改。"""
        uri = self._current_task_uri
        if not uri:
            return
        new_title = self._edit_title.text().strip()
        new_body = self._edit_body.toPlainText()
        try:
            from diy.core._state import update_task_field  # noqa: PLC0415

            if (
                new_title != (self._current_node.title or "")
                if self._current_node
                else True
            ):
                update_task_field(uri, title=new_title)
            if (
                new_body != (self._current_node.body or "")
                if self._current_node
                else True
            ):
                update_task_field(uri, body=new_body)
        except Exception as e:
            logger.error("保存失败: uri=%s %s", uri, e)
            self._edit_btn.hide()
            self._save_btn.show()
            self._cancel_btn.show()
            return
        self._cancel_edit()
        self.task_saved.emit(uri)


# ═══════════════════════════════════════════════════════
# 主窗口
# ═══════════════════════════════════════════════════════


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()

        # ── 沙箱检测（调试/测试/多实例模式） ──
        self._sandbox, self._sandbox_path = _detect_sandbox()
        if self._sandbox:
            self.setWindowTitle(f"🧪 diy 管控台 [测试: {self._sandbox_path}]")
        else:
            self.setWindowTitle(f"diy 管控台 [{self._sandbox_path}]")
        self.resize(1000, 650)

        self._started_at = time.time()
        self._last_reload = self._started_at

        # ── Gateway（Unix socket 入口） ──
        self._gateway = Gateway(self)
        logger.debug("[init] Gateway 创建完成")

        # ── 顶栏（过滤栏 + 区域切换按钮） ──
        self._title_bar = TitleBar(self)
        self.addToolBar(Qt.ToolBarArea.TopToolBarArea, self._title_bar)
        self._filter_text = self._title_bar.filter_text
        self._filter_state = self._title_bar.filter_state
        logger.debug("[init] TitleBar 创建完成")

        # ── Screen / Area 抽象 ──
        self._screen = Screen("默认")

        # ── 任务树（主工作区，全宽） ──
        self._tree = QTreeView()
        self._tree.setHeaderHidden(True)
        self._tree.setAnimated(True)
        self._tree.setIndentation(14)
        self._tree.setRootIsDecorated(True)
        self._tree.setExpandsOnDoubleClick(True)
        self._tree.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._on_context_menu)

        # ── 树头部栏（标题 + 刷新 + 展开按钮） ──
        tree_header = QWidget()
        tree_header_lay = QHBoxLayout(tree_header)
        tree_header_lay.setContentsMargins(8, 4, 4, 4)
        tree_header_lay.setSpacing(0)
        tree_header_label = QLabel("任务树")
        tree_header_label.setStyleSheet(
            f"color: {Theme.on_surface}; font-size: 11px; font-weight: bold;"
        )
        tree_header_lay.addWidget(tree_header_label)
        tree_header_lay.addStretch()
        self._refresh_btn = QToolButton()
        self._refresh_btn.setText("🔄")
        self._refresh_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        self._refresh_btn.setFixedSize(22, 22)
        self._refresh_btn.setToolTip("刷新任务树")
        self._refresh_btn.setStyleSheet(
            "QToolButton { background: transparent; border: none;"
            " font-size: 13px; border-radius: 4px; }"
            "QToolButton:hover { background: #45475a; }"
        )
        self._refresh_btn.clicked.connect(self._load)
        tree_header_lay.addWidget(self._refresh_btn)
        self._expand_all = True
        self._expand_btn = QToolButton()
        self._expand_btn.setText("▼")
        self._expand_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        self._expand_btn.setFixedSize(22, 22)
        self._expand_btn.setToolTip("折叠所有")
        self._expand_btn.setStyleSheet(
            "QToolButton { background: transparent; border: none;"
            " font-size: 11px; border-radius: 4px; }"
            "QToolButton:hover { background: #45475a; }"
        )
        self._expand_btn.clicked.connect(self._toggle_expand)
        tree_header_lay.addWidget(self._expand_btn)

        tree_container = QWidget()
        tree_layout = QVBoxLayout(tree_container)
        tree_layout.setContentsMargins(0, 0, 0, 0)
        tree_layout.setSpacing(0)
        tree_layout.addWidget(tree_header)
        tree_layout.addWidget(self._tree)

        # ── 详情面板（后续嵌入 Overlay） ──
        self._detail = DetailView()
        self._detail.task_saved.connect(self._on_task_saved)

        # ── Agent 对话面板（后续嵌入 Overlay tab） ──
        self._chat = AgentChatPanel(self)

        # ── Overlay 面板（右侧滑入，含详情 + Agent tab） ──
        self._overlay = OverlayPanel()
        self._overlay.set_panels(self._detail, self._chat)
        self._overlay.panel_closed.connect(self._on_overlay_closed)

        # ── 中央 Splitter（推挤布局：树 + overlay） ──
        self._splitter = QSplitter(Qt.Orientation.Horizontal)
        self._splitter.setChildrenCollapsible(False)
        self._splitter.setHandleWidth(1)
        self._splitter.setStyleSheet("QSplitter::handle { background: #45475a; }")
        self._splitter.addWidget(tree_container)
        self._splitter.addWidget(self._overlay)
        self._splitter.setStretchFactor(0, 1)
        self._splitter.setStretchFactor(1, 0)
        self._splitter.setSizes([800, 0])

        # ── LLM 管理页面 ──
        self._llm_page = LLMPage(self)

        # ── 中央 TabWidget：任务树 | LLM 管理 ──
        self._main_tabs = QTabWidget()
        self._main_tabs.setDocumentMode(True)
        self._main_tabs.setStyleSheet("""
            QTabWidget::pane {
                background: #1e1e2e; border: none;
            }
            QTabBar::tab {
                background: #181825; color: #6c7086;
                padding: 6px 16px; font-size: 12px;
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
        self._main_tabs.addTab(self._splitter, "📁 任务树")
        self._main_tabs.addTab(self._llm_page, "🤖 LLM")
        self.setCentralWidget(self._main_tabs)
        logger.debug("[init] 中央 TabWidget (任务树 + LLM) 创建完成")

        self._gateway.start()
        logger.debug("[init] Gateway 启动完成")

        # ── 底部面板（输出 / Agent 列表 / 指标） ──
        self._log_panel = LogPanel(self)

        self._agent_panel = QPlainTextEdit()
        self._agent_panel.setReadOnly(True)
        self._agent_panel.setPlaceholderText("运行中的 agent 将显示在这里")

        self._panel_tabs = QTabWidget()
        self._panel_tabs.addTab(self._log_panel, "输出")
        self._panel_tabs.addTab(self._agent_panel, "Agent")

        self._panel_dock = QDockWidget("面板", self)
        self._panel_dock.setObjectName("Panel")
        self._panel_dock.setWidget(self._panel_tabs)
        self._panel_dock.setFeatures(QDockWidget.DockWidgetFeature.DockWidgetClosable)
        self.addDockWidget(Qt.DockWidgetArea.BottomDockWidgetArea, self._panel_dock)
        self._panel_dock.hide()

        # ── Screen → Area 组装 ──
        tree_panel = Panel("task_tree", "任务树", tree_container, "📁")
        self._screen.add_area(Area("left", [tree_panel]))

        detail_panel = Panel("task_detail", "详情", self._detail, "🖥")
        chat_panel = Panel("agent_chat", "Agent", self._chat, "💬")
        self._screen.add_area(
            Area(
                "right",
                [detail_panel, chat_panel],
                exclusive_group="side",
                is_overlay=True,
                max_width=OverlayPanel.DEFAULT_WIDTH,
            )
        )

        output_panel = Panel("output_log", "输出", self._log_panel, "📋")
        agent_list_panel = Panel("agent_list", "Agent 列表", self._agent_panel, "🤖")
        self._screen.add_area(
            Area(
                "bottom",
                [output_panel, agent_list_panel],
            )
        )

        self._screen.on_toggle(self._sync_ui)
        logger.debug("[init] Screen/Area 组装完成")

        # ── 顶栏/底栏按钮 → Screen toggle ──
        self._title_bar.toggle_area.connect(
            lambda aid, pid: self._screen.toggle_area(aid, panel_id=pid)
        )
        self._status_bar = StatusBar(self)
        self.setStatusBar(self._status_bar)
        self._status_bar.toggle_area.connect(
            lambda aid, pid: self._screen.toggle_area(aid, panel_id=pid)
        )
        logger.debug("[init] 底栏 + 顶栏创建完成")

        # ── 菜单栏 ──
        self._setup_menu()

        # ── 数据 ──
        self._metrics = MetricsStore()
        # 注入 MetricsStore 到日志 → metrics handler
        from diy.app._app_log import get_metrics_handler

        mh = get_metrics_handler()
        if mh is not None:
            mh.set_store(self._metrics)
        # 指标面板（依赖 _metrics）
        from diy.app._metrics_panel import MetricsPanel

        self._metrics_panel = MetricsPanel(self._metrics)
        self._panel_tabs.addTab(self._metrics_panel, "指标")
        logger.debug("[init] MetricsPanel 创建完成")
        self._nodes: list[TaskNode] = []
        self._load()

        # ── 过滤信号（必须在 _load 之后，否则 proxy 未创建） ──
        self._filter_text.textChanged.connect(self._filter_tree)
        self._filter_state.currentTextChanged.connect(self._filter_tree)

        # ── 信号 ──
        self._tree.clicked.connect(self._on_select)
        self._tree.doubleClicked.connect(self._on_double_click)

        # ── 文件监控 ──
        self._watcher = QFileSystemWatcher(self)
        self._watcher.directoryChanged.connect(self._on_agent_dir_changed)
        self._watcher.fileChanged.connect(self._on_file_changed)
        self._setup_agent_watcher()

        # state.yaml 变化 → 自动 reload
        state_path = str(diy_home() / "state.yaml")
        self._watcher.addPath(state_path)
        # ~/.diy/task/ 目录变化（CLI 创建/删除任务）→ 自动 reload
        from diy.core._state import _data_root

        data_path = str(_data_root())
        os.makedirs(data_path, exist_ok=True)
        self._watcher.addPath(data_path)
        # 兼容：旧 d/ 目录（迁移前）
        d_path = str(diy_home() / "d")
        if os.path.isdir(d_path):
            self._watcher.addPath(d_path)
        # ~/.diy/star/ 目录变化（CLI star/unstar）→ 自动 reload
        star_path = str(diy_home() / "star")
        os.makedirs(star_path, exist_ok=True)
        self._watcher.addPath(star_path)

        # ── 定时刷新（agent 状态 5s） ──
        self._refresh_timer = QTimer(self)
        self._refresh_timer.timeout.connect(self._refresh_agents)
        self._refresh_timer.start(5000)

        # ── 健康自检（10s，启动后 30s 才开始） ──
        self._health_timer = QTimer(self)
        self._health_timer.timeout.connect(self._on_health_check)
        QTimer.singleShot(30000, lambda: self._health_timer.start(10000))

        logger.info("MainWindow 初始化完成, pid=%s", os.getpid())

        # ── macOS WebEngine 激活时序 ──
        #   窗口必须收到 NSApplicationDidBecomeActiveNotification 后才可创建
        #   QWebEngineView，否则 use-after-free SIGSEGV。我们通过监听
        #   changeEvent(ActivationChange) 事件来获知此通知已到，而非猜测时间。
        #
        #   setFocus 不能放在 event loop 首个迭代，否则 _on_select → _ensure_view
        #   会在 ActivationChange 事件到达前创建 WebEngineView。
        #   延迟到 changeEvent 标记 _webengine_ready 之后再触发。
        QTimer.singleShot(300, self._tree.setFocus)
        logger.debug("[init] __init__ 全部完成")

    def changeEvent(self, event: QEvent | None) -> None:  # noqa: N802  # 重写 Qt QMainWindow 方法，必须保持原大小写
        """监听窗口激活事件。

        首次收到 ActivationChange 且窗口 active 时，标记 WebEngine 可安全创建。
        这对应 macOS 的 NSApplicationDidBecomeActiveNotification，
        在此之前创建 QWebEngineView 会导致 use-after-free SIGSEGV。
        """
        if (
            event
            and event.type() == QEvent.Type.ActivationChange
            and self.isActiveWindow()
        ):
            _mark_webengine_ready()
        super().changeEvent(event)

    def event(self, evt: QEvent | None) -> bool:
        """处理跨线程 _InvokeEvent。"""
        if evt and isinstance(evt, _InvokeEvent):
            evt.execute()
            return True
        return super().event(evt)

    def _setup_menu(self):
        """构建菜单栏。"""
        menubar = self.menuBar()

        # ── 视图菜单 ──
        view_menu = menubar.addMenu("视图")

        toggle_output = QAction("输出", self, checkable=True)
        toggle_output.setChecked(False)
        toggle_output.setShortcut("Ctrl+`")
        toggle_output.triggered.connect(lambda v: self._toggle_panel(v, 0))
        self._panel_dock.visibilityChanged.connect(toggle_output.setChecked)
        view_menu.addAction(toggle_output)

    def _toggle_panel(self, visible: bool, tab_index: int = 0) -> None:
        # 通过 Screen 统一管理（同步到按钮状态）
        panel_id = "output_log" if tab_index == 0 else "agent_list"
        self._screen.toggle_area("bottom", panel_id=panel_id)

    def _sync_ui(self, aid: str, visible: bool, panel_id: str) -> None:
        """Screen toggle → Qt UI 同步。"""
        if aid == "right":
            if visible:
                area = self._screen.area("right")
                idx = area.active_panel_index if area else 0
                self._overlay.show_panel(idx)
            else:
                self._overlay.close_panel()
            self._title_bar.set_button_checked(aid, panel_id, visible)
        elif aid == "bottom":
            self._panel_dock.setVisible(visible)
            if visible:
                area = self._screen.area("bottom")
                idx = area.active_panel_index if area else 0
                self._panel_tabs.setCurrentIndex(idx)
                self._panel_dock.raise_()
            self._status_bar.set_button_checked(visible)
        elif aid == "left":
            # 任务树始终可见，无需 toggle
            pass

    def _on_overlay_closed(self) -> None:
        """Overlay 关闭（Esc / 点击树区）→ 同步 Screen 状态。"""
        self._screen.hide_area("right")

    @guarded("task_saved")
    def _on_task_saved(self, uri: str) -> None:
        """任务编辑保存后刷新数据并触发重渲染。"""
        self._nodes = load_task_tree()
        self._render_tree()
        # 保存后重新选中该任务 — 在 source model 中搜索
        source = self._proxy.sourceModel()
        if source is None:
            return

        def _walk(item):
            for row in range(item.rowCount()):
                child = item.child(row)
                if child.data(ROLE_TASK_URI) == uri:
                    return child
                found = _walk(child)
                if found is not None:
                    return found
            return None

        target = _walk(source.invisibleRootItem())
        if target is not None:
            idx = self._proxy.mapFromSource(target.index())
            self._tree.selectionModel().select(
                idx, QItemSelectionModel.SelectionFlag.Select
            )
            self._tree.scrollTo(idx)

    def _load(self) -> None:
        self._nodes = load_task_tree()
        self._last_reload = time.time()
        self._refresh_agents()
        self._render_tree()
        subjects = sum(1 for n in self._iter_nodes(self._nodes) if n.kind == "subject")
        tasks = sum(1 for n in self._iter_nodes(self._nodes) if n.kind == "task")
        logger.debug(
            "[main] 重载完成 — %d subject, %d task, %d root",
            subjects,
            tasks,
            len(self._nodes),
        )

    def _render_tree(self) -> None:
        source = build_model(self._nodes)
        self._proxy = TaskFilterProxy(self)
        self._proxy.setSourceModel(source)
        self._proxy.setRecursiveFilteringEnabled(True)
        self._tree.setModel(self._proxy)
        self._tree.expandAll()
        self._expand_all = True
        self._expand_btn.setText("▼")
        self._expand_btn.setToolTip("折叠所有")
        self._expand_subjects()
        # setModel() 会重建 selectionModel，重新连接信号
        self._tree.selectionModel().currentChanged.connect(self._on_select)

    def _toggle_expand(self) -> None:
        """切换全部展开/折叠。"""
        if self._expand_all:
            self._tree.collapseAll()
            self._expand_subjects()
            self._expand_all = False
            self._expand_btn.setText("▶")
            self._expand_btn.setToolTip("展开所有")
        else:
            self._tree.expandAll()
            self._expand_all = True
            self._expand_btn.setText("▼")
            self._expand_btn.setToolTip("折叠所有")

    def _expand_subjects(self) -> None:
        """展开所有 subject 节点。"""
        model = self._tree.model()
        if model is None:
            return
        for row in range(model.rowCount()):
            idx = model.index(row, 0)
            kind = model.data(idx.sibling(row, 0), ROLE_KIND)
            if kind == "subject":
                self._tree.expand(idx)

    @guarded("filter")
    def _filter_tree(self) -> None:
        """根据过滤栏筛选树节点。"""
        self._proxy.invalidateFilter()
        self._tree.expandAll()

    @guarded("timer.refresh")
    def _refresh_agents(self) -> None:
        """从 AgentManager 读取 agent 状态并挂到任务节点上。"""
        from diy.app.task_tree import AgentInfo

        states = get_manager().list()
        by_task: dict[str, Any] = {}
        for s in states:
            by_task[s.task_uri] = s

        changed = False
        for n in self._iter_nodes(self._nodes):
            uri = n.uri or ""
            state = by_task.get(uri)
            new_agents: list[AgentInfo] = []
            if state is not None:
                new_agents = [AgentInfo(agent_id=uri, state=state.state)]
            if n.agents != new_agents:
                n.agents = new_agents
                changed = True

        if changed:
            self._metrics.counter("agent.changes")
            logger.debug("[timer] agent 状态变化 → 重绘树 (%d agent)", len(states))
            self._render_tree()
        self._metrics.gauge("agent.count", len(states))
        self._metrics.counter("agent.refresh")

        # ── 刷新 Agent 面板 ──
        if states:
            from diy.core.observer import InProcessAgentObserver
            obs = getattr(self, "_agent_observer", None)
            if obs is None:
                obs = InProcessAgentObserver(get_manager())
                self._agent_observer = obs

            lines = []
            for s in states:
                icon = {"running": "🟢", "idle": "⏸️", "error": "🔴"}.get(s.state, "❓")
                line = f"{icon} {s.task_uri}\n"
                line += f"   state: {s.state}  provider: {s.provider}  model: {s.model}\n"
                if s.state == "running":
                    line += f"   events: {s.event_count}  last: {s.last_event_type}  elapsed: {s.prompt_elapsed:.0f}s\n"

                # 从 observer 读取最近事件（stderr / text_delta 等）
                buf = obs._buffers.get(s.task_uri)
                if buf:
                    recent = []
                    for ev in list(buf)[-5:]:
                        if ev.kind in ("text_delta", "tool_call", "error"):
                            text = ev.data[:80].replace("\n", " ")
                            recent.append(f"   [{ev.kind}] {text}")
                        elif ev.stream == "stderr":
                            recent.append(f"   [stderr] {ev.data[:60].replace(chr(10), ' ')}")
                    if recent:
                        line += "\n".join(recent) + "\n"

                lines.append(line)
            self._agent_panel.setPlainText("\n".join(lines))
        else:
            self._agent_panel.setPlainText("运行中的 agent 将显示在这里")

    def _iter_nodes(self, nodes: list[TaskNode]):
        for n in nodes:
            yield n
            yield from self._iter_nodes(n.children)

    # ── Agent 文件监控 ──
    def _setup_agent_watcher(self) -> None:
        agents_dir = str(diy_home() / "agents")
        os.makedirs(agents_dir, exist_ok=True)
        if agents_dir not in self._watcher.directories():
            self._watcher.addPath(agents_dir)

    @guarded("watcher.agent")
    def _on_agent_dir_changed(self, _path: str) -> None:
        # 启动 3 秒内不响应目录变化（macOS 初始化会触发一次）
        if time.time() - self._started_at < 3.0:
            return
        from diy.core._state import _data_root

        tasks_dir = str(_data_root())
        d_dir = str(diy_home() / "d")
        star_dir = str(diy_home() / "star")
        if _path == tasks_dir or _path.startswith(tasks_dir + "/"):
            logger.info("[watcher] ~/.diy/task/ 目录变化 → 全量重载")
            self._load()
        elif d_dir and (_path == d_dir or _path.startswith(d_dir + "/")):
            logger.info("[watcher] ~/.diy/d/ 目录变化（兼容）→ 全量重载")
            self._load()
        elif _path == star_dir or _path.startswith(star_dir + "/"):
            logger.info("[watcher] ~/.diy/star/ 目录变化 → 全量重载")
            self._load()
        else:
            logger.info("[watcher] agents/ 目录变化 → 刷新 agent 状态")
            self._refresh_agents()

    @guarded("watcher.file")
    def _on_file_changed(self, path: str) -> None:
        if path.endswith("state.yaml"):
            logger.info("[watcher] state.yaml 变化 → 全量重载")
            # macOS: yaml 写入可能换 inode，重新 watch
            self._watcher.removePath(path)
            self._watcher.addPath(path)
            self._load()
        else:
            logger.debug("[watcher] 其他文件变化 → 刷新 agent 状态")
            self._refresh_agents()

    # ── 健康自检 ──
    @guarded("health")
    def _on_health_check(self) -> None:
        sock_dev = getattr(self._gateway, "_sock_dev", None)
        sock_ino = getattr(self._gateway, "_sock_ino", None)
        critical = [
            i for i in run_check(sock_dev, sock_ino) if i.severity == "critical"
        ]
        self._metrics.gauge("health.critical", len(critical))
        self._metrics.counter("health.checks")
        if critical:
            self._metrics.counter("health.crashes")
            logger.warning("[health] 发现 %d 个严重问题, 退出", len(critical))
            # ... 退出逻辑不变
            for iss in critical:
                logger.warning(
                    "[health]   [%s] %s — %s", iss.code, iss.message, iss.detail[:200]
                )
            self._health_timer.stop()
            # 直接退出，不留错误面板
            QApplication.instance().quit()
            return

    def _enter_lockdown(self, issues: list[HealthIssue]) -> None:
        """严重故障 → 锁定界面并显示告示。"""
        # 隐藏所有 dock（副作用：无法交互）
        for dock in self.findChildren(QDockWidget):
            dock.hide()

        self.menuBar().setEnabled(False)

        html = """<style>
          body { background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, sans-serif;
                 display: flex; justify-content: center; align-items: center;
                 height: 100vh; margin: 0; }
          .card { max-width: 600px; padding: 40px; text-align: center; }
          .icon-warn { font-size: 48px; margin-bottom: 12px; }
          h1 { color: #f7768e; font-size: 20px; margin-bottom: 16px; }
          .issue { background: #313244; border-radius: 8px; padding: 12px 16px;
                   margin: 8px 0; text-align: left; font-size: 13px; line-height: 1.6; }
          .issue code { background: #45475a; color: #f5c2e7; padding: 1px 4px; border-radius: 3px; }
          .issue .msg { font-weight: bold; color: #f7768e; }
          .hint { margin-top: 20px; font-size: 13px; color: #a6adc8; }
        </style>
        <div class="card">
          <div class="icon-warn">⚠️</div>
          <h1>严重故障 — 应用已锁定</h1>
        """
        for iss in issues:
            html += (
                f'<div class="issue">'
                f'<div class="msg">[{iss.code}] {iss.message}</div>'
                f"<div>{self._esc_html(iss.detail)}</div>"
                f"</div>"
            )
        html += (
            '<div class="hint">建议：关闭本窗口 → kill 残留进程 → 重新启动</div></div>'
        )
        self._detail.show_placeholder(html)
        self.setWindowTitle("⚠️ 应用故障")

    # ── 右键菜单 ──
    @guarded("ctxmenu")
    def _on_context_menu(self, pos):
        from PySide6.QtWidgets import QMenu  # type: ignore[import-untyped]

        index = self._tree.indexAt(pos)
        if not index.isValid():
            return

        kind = index.data(ROLE_KIND)
        task_uri = index.data(ROLE_TASK_URI)
        subject_path = index.data(ROLE_SUBJECT)
        state = index.data(ROLE_STATE)

        menu = QMenu(self)

        # 所有节点都可以创建子任务
        new_act = menu.addAction("✨ 新建任务")
        if kind == "task":
            new_act.triggered.connect(
                lambda checked, t=task_uri: self._open_create_task(parent_uri=t)
            )
        elif kind == "subject":
            subj = index.data(ROLE_SUBJECT) or next(
                (
                    k
                    for k, v in _subjects_from_state().items()
                    if k == subject_path or k == index.data(Qt.ItemDataRole.DisplayRole)
                ),
                None,
            )
            new_act.triggered.connect(
                lambda checked, s=subj or subject_path: self._open_create_task(
                    subject=s
                )
            )
        else:
            new_act.triggered.connect(lambda: self._open_create_task())

        menu.addSeparator()

        if kind == "task" and task_uri:
            menu.addAction(f"{task_uri} — {state}").setEnabled(False)
            menu.addSeparator()

            state_menu = menu.addMenu("更改状态")
            for s, label in [
                ("pending", "⏳ Pending"),
                ("active", "🔄 Active"),
                ("done", "✅ Done"),
                ("blocked", "🚫 Blocked"),
                ("cancelled", "❌ Cancelled"),
            ]:
                if s != state:
                    act = state_menu.addAction(label)
                    act.triggered.connect(
                        lambda checked, t=task_uri, ns=s: self._set_state(t, ns)
                    )

            menu.addSeparator()

            spawn_act = menu.addAction("🤖 启动 agent")
            spawn_act.triggered.connect(
                lambda checked, t=task_uri: self._spawn_agent(t)
            )

            steer_act = menu.addAction("💬 /steer 通信")
            steer_act.triggered.connect(lambda checked, t=task_uri: self._open_steer(t))

            del_act = menu.addAction("⭐ 取消关注 / unstar")
            del_act.triggered.connect(lambda checked, t=task_uri: self._unstar_task(t))

        menu.addSeparator()
        refresh_act = menu.addAction("🔄 刷新")
        refresh_act.triggered.connect(self._load)

        menu.exec(self._tree.viewport().mapToGlobal(pos))

    # ── 操作 ──
    @guarded("action.state")
    def _set_state(self, uri: str, new_state: str) -> None:
        import subprocess

        subprocess.run(
            ["dai", "task", "edit", uri, "--state", new_state],
            capture_output=True,
        )
        self._load()

    @guarded("action.unstar")
    def _unstar_task(self, uri: str) -> None:
        """取消关注（unstar）任务 — 删除 symlink，数据不动。"""
        from diy.core._state import get_task, unstar_task

        task = get_task(uri)
        if not task:
            return
        unstar_task(uri)
        self._load()

    @guarded("action.spawn")
    def _spawn_agent(self, uri: str) -> None:
        """启动 agent for 一个 task。"""
        # 通过 Gateway 发送 diy agent spawn 命令
        from diy.core._state import get_task

        task = get_task(uri)
        if not task:
            return
        title = task.get("title", uri)
        prompt = f"请完成以下任务：{title}"
        self._chat.send_text(prompt)

    @guarded("action.create")
    def _open_create_task(
        self, parent_uri: str | None = None, subject: str | None = None
    ) -> None:
        """打开创建任务对话框。"""
        dlg = _CreateTaskDialog(self, parent_uri=parent_uri, initial_subject=subject)
        if dlg.exec():
            self._load()

    @guarded("action.steer")
    def _open_steer(self, uri: str) -> None:
        self._chat.set_task(uri)

    # ── 选中 / 双击 ──
    @guarded("tree.select")
    def _on_select(self, index=None, _deselected=None):
        # index 来自 clicked(QModelIndex) 或 currentChanged(QModelIndex, QModelIndex)
        if index is None or not index.isValid():
            indexes = self._tree.selectionModel().selectedIndexes()
            if not indexes:
                return
            index = indexes[0]

        kind = index.data(ROLE_KIND)
        task_uri = index.data(ROLE_TASK_URI)
        state = index.data(ROLE_STATE)

        if kind == "subject":
            display = index.data(Qt.ItemDataRole.DisplayRole) or ""
            html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body {{ background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, sans-serif; padding: 12px; }}
  .header {{ font-size: 14px; font-weight: bold; color: #cdd6f4; }}
  .title {{ font-size: 18px; font-weight: bold; color: #fff; margin-top: 8px; }}
</style></head><body>
<div class="header">📁 Subject</div>
<div class="title">{_esc_html(display)}</div>
</body></html>"""
            self._detail.show_placeholder(html)
            return

        if kind != "task" or not task_uri:
            self._detail.show_placeholder("""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { background: #1e1e2e; color: #a6adc8; font-family: -apple-system, sans-serif; font-size: 14px; padding: 20px; }
</style></head><body>
<div>选择任务查看详情</div>
</body></html>""")
            return

        node = self._find_node(task_uri)

        # —— 拼 HTML ——
        parts: list[str] = []

        # URI + state badge
        state_badge = _state_badge(state)
        parts.append(f"""<div class="header">{task_uri} {state_badge}</div>""")

        # Title
        if node and node.title:
            parts.append(f"""<div class="title">{_esc_html(node.title)}</div>""")

        # Detail
        if node and node.detail:
            detail_html = _esc_html(node.detail).replace("\n", "<br>")
            parts.append(f"""<div class="detail">{detail_html}</div>""")

        # Body（markdown 文档）— 渲染后嵌入同一 HTML
        full_body_html: str | None = None
        if node and node.body:
            from markdown_it import MarkdownIt

            md = MarkdownIt("gfm-like", {"breaks": True, "html": True})
            md.disable("linkify")  # 不依赖 linkify-it-py
            rendered = md.render(node.body)
            full_body_html = f"""<hr><div class="section-title">📄 文档</div><div class="md-body">{rendered}</div>"""

        # Metadata row
        meta: list[str] = []
        if node and node.subject_path:
            meta.append(
                f"""<span class="tag">📂 {_esc_html(node.subject_path)}</span>"""
            )
        if node and node.parent_uri:
            meta.append(f"""<span class="tag">⬆ 父任务 {node.parent_uri}</span>""")
        if node and node.created:
            meta.append(f"""<span class="tag">🕐 创建 {node.created}</span>""")
        if node and node.updated:
            meta.append(f"""<span class="tag">🔄 更新 {node.updated}</span>""")
        if meta:
            parts.append(f"""<div class="meta">{" ".join(meta)}</div>""")

        # Divider
        parts.append("<hr>")

        # Agent section
        if node and node.agents:
            parts.append("""<div class="section-title">🤖 Agent</div>""")
            for a in node.agents:
                icons = {"running": "🟢", "done": "✅", "blocked": "🔴"}
                icon = icons.get(a.state, "⏳")
                parts.append(
                    f"""<div class="agent">{icon} <code>{_esc_html(a.agent_id)}</code> — {a.state}</div>"""
                )
        else:
            parts.append("""<div class="hint">无运行中的 agent</div>""")

        # —— 合成完整 HTML ——
        header_html = "".join(parts)
        if full_body_html:
            header_html += full_body_html

        html_doc = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body {{ background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, sans-serif; font-size: 14px; padding: 12px; line-height: 1.7; }}
  .card {{ font-family: -apple-system, "Segoe UI", sans-serif; padding: 12px; }}
  .placeholder {{ font-family: -apple-system, "Segoe UI", sans-serif; color: #a6adc8; font-size: 14px; padding: 20px; }}
  .header {{ font-size: 14px; font-weight: bold; color: #cdd6f4; margin-bottom: 8px; }}
  .title {{ font-size: 18px; font-weight: bold; color: #ffffff; margin-bottom: 10px; }}
  .detail {{ font-size: 13px; color: #bac2de; line-height: 1.6; margin: 8px 0 12px 0; white-space: pre-wrap; }}
  .meta {{ margin: 8px 0 4px 0; }}
  .tag {{ display: inline-block; background: #45475a; color: #cdd6f4; font-size: 12px; padding: 2px 8px; border-radius: 4px; margin-right: 6px; }}
  .section-title {{ font-size: 13px; font-weight: bold; color: #a6adc8; margin: 4px 0; }}
  .agent {{ font-size: 12px; color: #bac2de; margin: 2px 0; }}
  .agent code {{ background: #1e1e2e; color: #f5c2e7; padding: 1px 4px; border-radius: 3px; }}
  .hint {{ font-size: 12px; color: #585b70; margin-top: 4px; }}
  .badge {{ display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 10px; border-radius: 10px; color: #1e1e2e; }}
  hr {{ border: none; border-top: 1px solid #45475a; margin: 12px 0; }}
  .md-body {{ font-size: 13px; color: #bac2de; line-height: 1.7; }}
  .md-body h1 {{ color: #fff; font-size: 20px; border-bottom: 1px solid #45475a; padding-bottom: 4px; }}
  .md-body h2 {{ color: #cdd6f4; font-size: 17px; }} .md-body h3 {{ color: #a6adc8; font-size: 15px; }}
  .md-body table {{ border-collapse: collapse; margin: 12px 0; width: 100%; }}
  .md-body th {{ background: #313244; color: #cdd6f4; padding: 8px 12px; text-align: left; font-weight: 600; border: 1px solid #45475a; }}
  .md-body td {{ padding: 6px 12px; border: 1px solid #313244; }}
  .md-body tr:nth-child(even) {{ background: #181825; }}
  .md-body code {{ background: #1e1e2e; color: #f5c2e7; padding: 1px 5px; border-radius: 3px; }}
  .md-body pre {{ background: #181825; padding: 10px 14px; border-radius: 6px; overflow-x: auto; }}
  .md-body blockquote {{ border-left: 3px solid #45475a; padding-left: 12px; color: #a6adc8; }}
  .md-body a {{ color: #89b4fa; }}
  .md-body strong {{ color: #cdd6f4; }} .md-body em {{ color: #a6e3a1; }}
</style></head><body>{header_html}<script>
  document.addEventListener('click', function(e) {{
    var t = e.target; while (t && t.tagName !== 'A') t = t.parentElement;
    if (t && t.href && t.getAttribute('target') === '_blank') {{
      e.preventDefault(); window.location.href = t.href;
    }}
  }});
</script></body></html>"""

        self._detail.show_task(task_uri, node, html_doc)
        self._chat.set_task(task_uri)
        # 选中任务 → 展示右侧面板（不 toggle）
        self._screen.show_area("right", panel_id="task_detail")

    @guarded("tree.double")
    def _on_double_click(self, index):
        task_uri = index.data(ROLE_TASK_URI)
        if task_uri:
            self._open_steer(task_uri)

    def _find_node(self, uri: str) -> TaskNode | None:
        def _search(nodes: list[TaskNode]) -> TaskNode | None:
            for n in nodes:
                if n.uri == uri:
                    return n
                r = _search(n.children)
                if r:
                    return r
            return None

        return _search(self._nodes)

    # ── 通知弹窗 ──

    @Slot(str)
    def show_notification(self, message: str) -> None:
        """在窗口右上角弹出通知，3 秒自动消失。点击关闭按钮可手动关闭。"""
        from PySide6.QtCore import QPropertyAnimation  # type: ignore[import-untyped]
        from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QWidget  # type: ignore[import-untyped]

        container = QWidget(self)
        container.setStyleSheet("""
            QWidget {
                background: #1e1e2e; color: #cdd6f4;
                border: 1px solid #45475a; border-radius: 8px;
            }
            QLabel {
                background: transparent; color: #cdd6f4;
                border: none; font-size: 13px;
            }
            QPushButton {
                background: transparent; color: #a6adc8;
                border: none; font-size: 15px; padding: 0 4px;
            }
            QPushButton:hover { color: #f38ba8; }
        """)
        container.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.ToolTip)
        container.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)

        layout = QHBoxLayout(container)
        layout.setContentsMargins(12, 8, 4, 8)
        layout.setSpacing(8)

        label = QLabel(message[:120], container)
        layout.addWidget(label)

        close_btn = QPushButton("×", container)
        close_btn.setFixedSize(24, 24)
        close_btn.clicked.connect(container.deleteLater)
        layout.addWidget(close_btn)

        container.adjustSize()

        # 定位：窗口右上角
        geom = self.geometry()
        container.move(geom.right() - container.width() - 20, geom.top() + 40)
        container.show()

        # 3 秒后淡出
        anim = QPropertyAnimation(container, b"windowOpacity")
        anim.setDuration(800)
        anim.setStartValue(1.0)
        anim.setEndValue(0.0)
        anim.finished.connect(container.deleteLater)
        QTimer.singleShot(3000, anim.start)

    # ── Gateway 序列化 ──

    def format_tree(self, all_tasks: bool = False) -> str:
        """遍历 QStandardItemModel，直接读 DisplayRole — 和 UI 完全一致。

        all_tasks=True 时加载全部任务（CLI diy tree 使用）。
        """
        if all_tasks:
            from diy.app.task_tree import load_task_tree

            nodes = load_task_tree(all_tasks=True)
            return self._render_nodes_text(nodes)
        proxy = self._tree.model()
        if proxy is None:
            return "(空)"
        # proxy 是 TaskFilterProxy（QSortFilterProxyModel），需取 sourceModel
        source = proxy.sourceModel() if hasattr(proxy, "sourceModel") else proxy
        lines: list[str] = []
        self._dump_model_rows(source, None, lines, 0)
        return "\n".join(lines) if lines else "(空)"

    @staticmethod
    def _render_nodes_text(nodes: list) -> str:
        """将 TaskNode 树渲染为缩进文本。"""
        lines: list[str] = []

        def _walk(ns, depth=0):
            for n in ns:
                prefix = "  " * depth
                icon = n.state_icon if n.is_task else "📁"
                label = n.title or n.label or n.uri
                if n.is_task:
                    lines.append(f"{prefix}{icon} [{n.state}] {label}  ({n.uri})")
                else:
                    lines.append(f"{prefix}{icon} {label}")
                _walk(n.children, depth + 1)

        _walk(nodes)
        return "\n".join(lines) if lines else "(空)"

    def format_status(self) -> str:
        """app 运行状态快照（类似 Docker healthcheck）。"""
        now = time.time()
        geom = self.geometry()

        def _count(nodes):
            s = t = 0
            for n in nodes:
                if n.kind == "subject":
                    s += 1
                else:
                    t += 1
                cs, ct = _count(n.children)
                s += cs
                t += ct
            return s, t

        subjects, tasks = _count(self._nodes)
        model = self._tree.model()
        model_rows = model.rowCount() if model else 0

        state_path = str(diy_home() / "state.yaml")
        state_exists = os.path.isfile(state_path)

        return "\n".join(
            [
                f"pid:       {os.getpid()}",
                f"uptime:    {now - self._started_at:.0f}s",
                f"reload:    {now - self._last_reload:.0f}s ago",
                f"window:    {geom.width()}×{geom.height()} @ ({geom.x()},{geom.y()}) "
                f"{'hidden' if self.isHidden() else 'visible'}"
                f"{' minimized' if self.isMinimized() else ''}",
                f"tree:      {subjects} subjects + {tasks} tasks = {subjects + tasks} nodes "
                f"(model rows: {model_rows})",
                f"state:     {state_path} {'✅' if state_exists else '❌ missing'}",
                f"socket:    {self._gateway._path} {'✅' if self._gateway._server else '❌'}",
                f"watchers:  {len(self._watcher.files()) + len(self._watcher.directories())} paths",
                f"timers:    refresh={self._refresh_timer.interval()}ms",
                f"qt:        {'running' if QApplication.instance() else 'stopped'}",
                f"focus:     {type(self.focusWidget()).__name__ if self.focusWidget() else 'none'}",
                f"sandbox:   {'⚡ ' + self._sandbox_path if self._sandbox else 'no'}",
                f"docks:     tree=✓ "
                f"overlay={'✓' if self._overlay.is_visible() else '✗'} "
                f"panel={'✓' if hasattr(self, '_panel_dock') and self._panel_dock.isVisible() else '✗'}",
            ]
        )

    def format_screen(self) -> str:
        """Screen / Area / Overlay 状态快照（供 diy ui screen 查询）。"""
        lines = [f"screen: {self._screen.name}"]
        for aid in ["left", "right", "bottom"]:
            area = self._screen.area(aid)
            if area is None:
                continue
            vis = "✓" if area.visible else "✗"
            panels = ", ".join(
                f"{'👉' if i == area.active_panel_index else ' '}{p.id}"
                for i, p in enumerate(area.panels)
            )
            exclusive = (
                f" [互斥组:{area.exclusive_group}]" if area.exclusive_group else ""
            )
            lines.append(f"  {aid}: {vis} panels=[{panels}]{exclusive}")

        # overlay 细节
        ov = self._overlay.state()
        lines.append(
            f"overlay: width={ov['width']} max={ov['max_width']} "
            f"anim={'是' if ov['animating'] else '否'} "
            f"show_count={ov['show_count']} tab={ov['tab_index']}"
        )

        # 按钮状态
        btn_state = []
        for btn in self._title_bar.findChildren(QToolButton):
            if isinstance(btn, QToolButton) and btn.isCheckable():
                btn_state.append(f"{btn.text()}{'✓' if btn.isChecked() else '✗'}")
        if btn_state:
            lines.append(f"buttons: {' '.join(btn_state)}")

        return "\n".join(lines)

    def format_log(
        self,
        n: int = 50,
        level: str | None = None,
        category: str | None = None,
        pretty: bool = True,
    ) -> str:
        """读取 ~/.diy/app.log，返回最近 n 条日志。

        pretty=True → 人类可读文本（含级别/分类/消息，与 LogPanel 一致）
        pretty=False → 原始 JSONL（精确对比）
        """
        log_path = diy_home() / "app.log"
        if not log_path.exists():
            return "[日志文件不存在]"
        try:
            import json
            from collections import deque  # noqa: E402  # 函数内 import，避免模块级导入

            buf = deque()
            with open(log_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    # 级别过滤
                    if level and entry.get("l") != level.upper():
                        continue
                    # 分类过滤
                    if category and entry.get("c") != category:
                        continue

                    buf.append(entry)
                    if len(buf) > n:
                        buf.popleft()

            if pretty:
                lines = []
                for e in buf:
                    cat = e.get("c", "")
                    lvl = e.get("l", "")
                    msg = e.get("m", "")
                    t = e.get("t", "")[11:19]  # HH:MM:SS
                    cat_str = f"[{cat}] " if cat else ""
                    lines.append(f"{t} {lvl:5s} {cat_str}{msg}")
                result = "\n".join(lines)
                # 统计
                counts: dict[str, int] = {}
                for e in buf:
                    l = e.get("l", "")  # noqa: E741  # l 是 log level 缩写，非数字 1
                    counts[l] = counts.get(l, 0) + 1
                summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
                return f"--- 最近 {len(buf)} 条 ({summary}) ---\n{result}"
            else:
                # 原始 JSONL
                return "\n".join(json.dumps(e, ensure_ascii=False) for e in buf)
        except Exception as exc:
            return f"[读取日志失败] {exc}"

    def format_logpanel(self) -> str:
        """读取 LogPanel 当前显示的文本（直接读 widget），用于对比 UI 与文件。"""
        if not hasattr(self, "_log_panel") or not self._log_panel:
            return "[LogPanel 未初始化]"
        try:
            text = self._log_panel._text.toPlainText()
            if not text:
                return "[LogPanel 为空]"
            lines = text.split("\n")
            # 只返回最后 50 行
            recent = lines[-50:] if len(lines) > 50 else lines
            stats = f"--- LogPanel 共 {len(lines)} 行，显示最近 {len(recent)} 行 ---"
            return stats + "\n" + "\n".join(recent)
        except Exception as exc:
            return f"[读取 LogPanel 失败] {exc}"

    @staticmethod
    def _dump_model_rows(
        model, parent: QStandardItem | None, lines: list[str], depth: int
    ) -> None:
        """递归遍历 model 的行，读 DisplayRole 拼缩进。"""
        prefix = "  " * depth
        item = model.invisibleRootItem() if parent is None else parent
        for row in range(item.rowCount()):
            child = item.child(row)
            text = child.data(Qt.ItemDataRole.DisplayRole) or ""
            lines.append(f"{prefix}{text}")
            MainWindow._dump_model_rows(model, child, lines, depth + 1)

    def format_node(self, uri: str) -> str:
        """序列化指定任务节点详情（含 agent 状态）。"""
        node = self._find_node(uri)
        if node is None:
            return f"未找到任务 {uri}"
        lines = [
            f"{node.uri} {node.title}",
            f"  kind:    {node.kind}",
            f"  state:   {node.state} {node.state_icon}",
            f"  subject: {node.subject_path or '(无)'}",
            f"  parent:  {node.parent_uri if node.parent_uri else '(无)'}",
            f"  depth:   {node.depth}",
            f"  children: {len(node.children)}",
        ]
        if node.created:
            lines.append(f"  created: {node.created}")
        if node.updated:
            lines.append(f"  updated: {node.updated}")
        if node.detail:
            lines.append(f"  detail:  {node.detail}")
        if node.body:
            # 探针输出 body 第一行 + ... 提示
            body_preview = node.body.split("\n")[0]
            lines.append(
                f"  body:    {body_preview}{' ...' if len(node.body.splitlines()) > 1 else ''}"
            )
        if node.children:
            lines.append("  child_list:")
            for c in node.children:
                lines.append(f"    {c.uri} {c.title} [{c.state}]")
        if node.agents:
            lines.append("  agents:")
            for a in node.agents:
                icon = {"running": "🤖", "done": "✅", "blocked": "🚫"}.get(
                    a.state, "⏳"
                )
                lines.append(f"    {icon} {a.agent_id} (pid={a.pid}, state={a.state})")
        return "\n".join(lines)

    def format_agents(self) -> str:
        """序列化当前 agent 列表。"""
        lines: list[str] = []
        for n in self._iter_nodes(self._nodes):
            for a in n.agents:
                lines.append(f"{n.uri} {a.agent_id} pid={a.pid} state={a.state}")
        if lines:
            return "\n".join(lines)
        # 兜底：从 AgentManager 读
        states = get_manager().list()
        if states:
            lines = []
            for s in states:
                lines.append(f"{s.task_uri} state={s.state}")
            return "\n".join(lines)
        return "(无 agent)"

    def _format_llm_status(self) -> str:
        """LLM 页面状态快照 — provider 列表 + proxy 统计。"""
        lines: list[str] = []
        lines.append("=== LLM Provider ===")

        models_dir = Path.home() / ".diy" / "models"
        if models_dir.is_dir():
            for f in sorted(models_dir.glob("*.json")):
                try:
                    import json as _json

                    state = _json.loads(f.read_text())
                    name = f.stem
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
                    lines.append(f"  {name:30s} {source:30s} {api_base}")
                    lines.append(f"  {'':30s} {enabled}/{len(models)} models enabled")
                except Exception:
                    lines.append(f"  {f.stem:30s} (read error)")
        else:
            lines.append("  (无 provider)")

        # Proxy 统计
        lines.append("")
        lines.append("=== Proxy 监控 ===")
        from diy.app.llm._monitor import SHIM_LOG_DIR as _SLD

        log_dir = _SLD
        lines.append(f"  日志目录: {log_dir}")
        try:
            log_files = sorted(Path(log_dir).glob("shim-*.jsonl"))
            if log_files:
                total_entries = 0
                for lf in log_files:
                    try:
                        total_entries += sum(1 for _ in lf.open())
                    except Exception:
                        logger.debug("[llm] 读取日志文件失败: %s", lf.name, exc_info=True)
                lines.append(
                    f"  日志文件: {len(log_files)} 个，共 {total_entries} 条记录"
                )
                lines.append(f"  最新: {log_files[-1].name}")
            else:
                lines.append("  (无日志)")
        except Exception:
            lines.append("  (无法读取日志目录)")

        lines.append("")
        active_tab = (
            self._main_tabs.currentIndex() if hasattr(self, "_main_tabs") else 0
        )  # noqa: SIM108
        tab_name = ["任务树", "LLM 管理"][active_tab]
        lines.append(f"  当前标签: {tab_name}")
        return "\n".join(lines)

    def _trigger_llm_sync(self) -> str:
        """触发 diy llm sync all（含 proxy 变体）。"""
        import subprocess as _sp

        try:
            result = _sp.run(
                ["uv", "run", "diy", "llm", "sync", "all", "--proxy"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode == 0:
                return result.stdout or "同步成功"
            return f"同步失败:\n{result.stderr}"
        except Exception as e:
            return f"同步异常: {e}"

    def closeEvent(self, event):  # noqa: N802  # 重写 Qt 事件方法，保持原大小写
        self._gateway.stop()
        super().closeEvent(event)


# ═══════════════════════════════════════════════════════
# Gateway — Unix socket 入口
# ═══════════════════════════════════════════════════════

import fcntl  # noqa: E402  # Gateway 节内 import（类引用在末尾）
import socket  # noqa: E402  # 同上
import socketserver  # noqa: E402  # 同上
import threading  # noqa: E402  # 同上
from collections.abc import Callable  # noqa: E402  # Gateway 节内 import
from typing import TypeVar  # noqa: E402  # 同上

from cyclopts import App as CycloptsApp  # noqa: E402  # 同上
from cyclopts.exceptions import UnknownCommandError  # noqa: E402  # 同上
from PySide6.QtCore import (  # type: ignore[import-untyped]  # noqa: E402  # Gateway 节内 import
    Q_ARG,
    QMetaObject,
    QObject,  # type: ignore[import-untyped]
)
from PySide6.QtCore import Qt as QtCore  # noqa: E402  # 同上

T = TypeVar("T")


class _InvokeEvent(QEvent):
    """跨线程调用 QEvent — 用 threading.Event 可靠信令。"""

    _EVENT_TYPE = QEvent.Type(QEvent.registerEventType())

    def __init__(self, fn: Callable[[], T], ret: list[T], done: threading.Event):
        super().__init__(self._EVENT_TYPE)
        self.fn = fn
        self.ret = ret
        self.done = done

    def execute(self) -> None:
        try:
            self.ret.append(self.fn())
        except Exception as e:
            self.ret.append(e)
        self.done.set()

    @classmethod
    def create(
        cls, fn: Callable[[], T], ret: list[T], done: threading.Event
    ) -> _InvokeEvent:
        return cls(fn, ret, done)


class MainThread:
    """安全地在 Qt 主线程执行操作，调用者不关心线程跳转。

    用法:
        mt = MainThread(window)
        tree = mt.invoke(window.format_tree)    # 返回 str
        node = mt.invoke(lambda: window.format_node(42))  # 带参数
    """

    def __init__(self, window: QObject):
        self._window = window

    def invoke(self, fn: Callable[[], T], timeout: float = 20.0) -> T:
        """阻塞等待 fn 在 Qt 主线程执行完毕，返回结果。

        用 QApplication.postEvent + threading.Event 的跨线程方案，
        timeout 超时后抛出 TimeoutError。
        """
        import threading

        ret: list[T] = []
        done = threading.Event()
        evt = _InvokeEvent.create(fn, ret, done)
        QApplication.instance().postEvent(self._window, evt)
        if not done.wait(timeout=timeout):
            raise TimeoutError(f"UI 操作超时（{timeout}s）")
        if isinstance(ret[0], Exception):
            raise ret[0]
        return ret[0]


class GatewayCLI:
    """Socket 协议层 — 用 cyclopts 解析命令，输出为纯文本。

    协议前缀:
      diy <cmd>   — v1 协议

    ⚠️ 双注册：这里注册的命令必须同步在 _dai_cli.py 注册。
    加命令→两处都加。移动命令→搜 grep -rn '"diy <旧>"' src/。
    """

    def __init__(self, window: MainWindow):
        self._window = window
        self._main = MainThread(window)
        self._app = CycloptsApp(name="gateway")

        # ── diy 子应用（协议 v1） ──
        diy = CycloptsApp(name="diy", help="diy protocol v1")

        @diy.command
        def doctor():
            """分层健康自检 — app 状态 / socket 健康 / 多实例 / state.yaml"""
            from diy.app._doctor import format_report, run_check

            gw = self._window._gateway
            sock_dev = getattr(gw, "_sock_dev", None)
            sock_ino = getattr(gw, "_sock_ino", None)
            return format_report(run_check(sock_dev, sock_ino))

        # ── ui ── 聊天面板交互 ──
        ui_app = CycloptsApp(name="ui", help="UI 视图操纵")

        @ui_app.command(name="tree")
        def ui_tree():
            """完整任务树（和 GUI 一致）。

            范例: diy ui tree
            """
            return self._main.invoke(self._window.format_tree)

        @ui_app.command(name="status")
        def ui_status():
            """健康检查（pid/dock 可见性/焦点/窗口/定时器）。

            范例: diy ui status
            输出: pid, uptime, window, overlay=✗, panel=✗, focus: QTreeView
            """
            return self._main.invoke(self._window.format_status)

        @ui_app.command(name="screen")
        def ui_screen():
            """Screen / Area / Overlay 状态快照。

            范例: diy ui screen
            输出: screen 名称 + 各 area 可见性/活跃 panel + overlay 动画状态
            """
            return self._main.invoke(self._window.format_screen)

        @ui_app.command(name="toggle")
        def ui_toggle(
            area: str,
            /,
            *,
            panel: str | None = None,
        ):
            """切换区域可见性。等价于点击底栏/顶栏按钮。

            Args:
                area: 区域名（left / right / bottom）
                panel: 面板 ID（不填则切到 default，同 panel 则隐藏）

            范例:
                diy ui toggle bottom panel=agent_list  # 显示 Agent 列表
                diy ui toggle bottom                   # 隐藏/切换底部
            """
            from diy.app.screen import Screen  # noqa: PLC0415

            def _do():
                screen: Screen | None = getattr(self._window, "_screen", None)
                if screen is None:
                    return "错误: Screen 未初始化"
                screen.toggle_area(area, panel_id=panel)
                return f"OK: {area}" + (f" panel={panel}" if panel else "")

            return self._main.invoke(_do)

        @ui_app.command(name="agents")
        def ui_agents():
            """agent 列表"""
            return self._main.invoke(self._window.format_agents)

        @ui_app.command(name="log")
        def ui_log(
            *,
            lines: int = 50,
            level: str | None = None,
            category: str | None = None,
            pretty: bool = True,
        ):
            """读取 ~/.diy/app.log，用于对比 UI LogPanel 与实际日志。

            Args:
                lines: 返回行数（默认 50）
                level: 过滤级别（ERROR / WARNING / INFO / DEBUG）
                category: 过滤分类前缀（watcher / timer / health / async 等）
                pretty: True=人类可读文本 False=原始 JSONL
            """
            return self._main.invoke(
                lambda: self._window.format_log(
                    n=lines,
                    level=level,
                    category=category,
                    pretty=pretty,
                )
            )

        @ui_app.command(name="logpanel")
        def ui_logpanel():
            """直接读取 LogPanel widget 当前显示的内容，与日志文件对比。

            用于验证文件/stderr/LogPanel 三路输出是否一致。
            """
            return self._main.invoke(self._window.format_logpanel)

        @ui_app.command(name="reload")
        def ui_reload():
            """热重载 state.yaml"""
            logger.info("[gateway] diy ui reload 收到 → 全量重载")
            self._main.invoke(self._window._load)
            return "OK"

        @ui_app.command(name="node")
        def ui_node(
            uri: str,
            /,
        ):
            """<uri> 任务节点详情。

            范例: diy ui node local/task/1
            """
            return self._main.invoke(lambda: self._window.format_node(uri))

        # ── task（查看/详情/编辑） ──
        ui_task_app = CycloptsApp(name="task", help="查看/编辑任务")

        @ui_task_app.command(name="detail")
        def ui_task_detail(
            uri: str,
            /,
            *,
            backend: str | None = None,
        ):
            """<uri> 查看任务详情并切入对话模式。

            三合一: 详情展示 + 切聊天面板 + 设 _current_task_uri。
            后续 edit input 无需再传 URI。
            --backend pi|hermes  选择 agent 后端（不填则使用 task frontmatter 或默认 pi）

            范例: diy ui task detail local/task/1
                  diy ui task detail local/task/1 --backend hermes
            """

            def _do():
                panel = (
                    self._window._chat
                    if hasattr(self._window, "_chat") and self._window._chat
                    else None
                )
                if panel is None:
                    return "error: UI 尚未初始化"
                panel.set_task(uri, backend=backend)
                from markdown_it import MarkdownIt as _md

                node = self._window._find_node(uri)
                if not node:
                    return f"错误: 任务 {uri} 不存在"
                _md_parser = _md("gfm-like", {"breaks": True, "html": True})
                _md_parser.disable("linkify")
                parts = [
                    f'<div class="header">{uri} ' + _state_badge(node.state) + "</div>"
                ]
                if node.title:
                    parts.append(f'<div class="title">{_esc_html(node.title)}</div>')
                if node.detail:
                    parts.append(
                        f'<div class="detail">{_esc_html(node.detail).replace(chr(10), "<br>")}</div>'
                    )
                body_html = ""
                if node.body:
                    rendered = _md_parser.render(node.body)
                    body_html = f'<hr><div class="section-title">📄 文档</div><div class="md-body">{rendered}</div>'
                meta_parts = []
                if node.subject_path:
                    meta_parts.append(
                        f'<span class="tag">📂 {_esc_html(node.subject_path)}</span>'
                    )
                if node.parent_uri:
                    meta_parts.append(
                        f'<span class="tag">⬆ 父任务 {node.parent_uri}</span>'
                    )
                if meta_parts:
                    parts.append(f'<div class="meta">{" ".join(meta_parts)}</div>')
                parts.append("<hr>")
                parts.append(
                    '<div class="hint">无运行中的 agent</div>'
                    if not node.agents
                    else '<div class="section-title">🤖 Agent</div>'
                    + "".join(
                        f'<div class="agent">{"🟢" if a.state == "running" else "✅" if a.state == "done" else "🔴"} <code>{_esc_html(a.agent_id)}</code> — {a.state}</div>'
                        for a in node.agents
                    )
                )
                header_html = "".join(parts)
                if body_html:
                    header_html += body_html
                html_doc = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body {{ background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, sans-serif; font-size: 14px; padding: 12px; line-height: 1.7; }}
  .card {{ font-family: -apple-system, "Segoe UI", sans-serif; padding: 12px; }}
  .placeholder {{ font-family: -apple-system, "Segoe UI", sans-serif; color: #a6adc8; font-size: 14px; padding: 20px; }}
  .header {{ font-size: 14px; font-weight: bold; color: #cdd6f4; margin-bottom: 8px; }}
  .title {{ font-size: 18px; font-weight: bold; color: #ffffff; margin-bottom: 10px; }}
  .detail {{ font-size: 13px; color: #bac2de; line-height: 1.6; margin: 8px 0 12px 0; white-space: pre-wrap; }}
  .meta {{ margin: 8px 0 4px 0; }}
  .tag {{ display: inline-block; background: #45475a; color: #cdd6f4; font-size: 12px; padding: 2px 8px; border-radius: 4px; margin-right: 6px; }}
  .section-title {{ font-size: 13px; font-weight: bold; color: #a6adc8; margin: 4px 0; }}
  .agent {{ font-size: 12px; color: #bac2de; margin: 2px 0; }}
  .agent code {{ background: #1e1e2e; color: #f5c2e7; padding: 1px 4px; border-radius: 3px; }}
  .hint {{ font-size: 12px; color: #585b70; margin-top: 4px; }}
  .badge {{ display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 10px; border-radius: 10px; color: #1e1e2e; }}
  hr {{ border: none; border-top: 1px solid #45475a; margin: 12px 0; }}
  .md-body {{ font-size: 13px; color: #bac2de; line-height: 1.7; }}
  .md-body h1 {{ color: #fff; font-size: 20px; border-bottom: 1px solid #45475a; padding-bottom: 4px; }}
  .md-body h2 {{ color: #cdd6f4; font-size: 17px; }} .md-body h3 {{ color: #a6adc8; font-size: 15px; }}
  .md-body table {{ border-collapse: collapse; margin: 12px 0; width: 100%; }}
  .md-body th {{ background: #313244; color: #cdd6f4; padding: 8px 12px; text-align: left; font-weight: 600; border: 1px solid #45475a; }}
  .md-body td {{ padding: 6px 12px; border: 1px solid #313244; }}
  .md-body tr:nth-child(even) {{ background: #181825; }}
  .md-body code {{ background: #1e1e2e; color: #f5c2e7; padding: 1px 5px; border-radius: 3px; }}
  .md-body pre {{ background: #181825; padding: 10px 14px; border-radius: 6px; overflow-x: auto; }}
  .md-body blockquote {{ border-left: 3px solid #45475a; padding-left: 12px; color: #a6adc8; }}
  .md-body a {{ color: #89b4fa; }}
  .md-body strong {{ color: #cdd6f4; }} .md-body em {{ color: #a6e3a1; }}
</style></head><body>{header_html}<script>
  document.addEventListener('click', function(e) {{
    var t = e.target; while (t && t.tagName !== 'A') t = t.parentElement;
    if (t && t.href && t.getAttribute('target') === '_blank') {{
      e.preventDefault(); window.location.href = t.href;
    }}
  }});
</script></body></html>"""
                # show_task 内部调用 _ensure_view，若窗口未 active 会自动延迟重试。
                # 参见 DetailView._ensure_view / show_task 的 macOS 安全检测。
                self._window._detail.show_task(uri, node, html_doc)
                self._window._screen.show_area("right", panel_id="task_detail")
                return f"OK: 已选中 {uri}"

            return self._main.invoke(_do)

        edit_app = CycloptsApp(name="edit", help="编辑模式")

        @edit_app.command(name="input")
        def ui_edit_input(
            *,
            title: str | None = None,
            body: str | None = None,
            body_file: str | None = None,
        ):
            """为当前已选中的任务设置编辑字段并切换到编辑模式。
            先用 `diy ui task detail <uri>` 选中任务。
            支持 --title / --body / --body-file。"""

            def _set_fields():
                detail = self._window._detail
                uri = detail._current_task_uri
                if not uri:
                    return (
                        "错误: 没有选中的任务。先用 `dai ui task detail <uri>` 选中。"
                    )
                node = self._window._find_node(uri)
                if node is None:
                    return f"错误: 任务 {uri} 不存在"

                body_text = body
                if body_file is not None and body is None:
                    try:
                        from pathlib import Path

                        body_text = Path(body_file).read_text(encoding="utf-8")
                    except OSError as exc:
                        return f"错误: 无法读取 body 文件: {exc}"

                detail._current_node = node
                detail._edit_title.setText(
                    title if title is not None else (node.title or "")
                )
                detail._edit_body.setPlainText(
                    body_text if body_text is not None else (node.body or "")
                )
                detail._stack.setCurrentIndex(1)
                detail._edit_btn.hide()
                detail._save_btn.show()
                detail._cancel_btn.show()
                return f"编辑模式已激活: {uri}"

            return self._main.invoke(_set_fields)

        @edit_app.command(name="submit")
        def ui_edit_submit():
            """保存当前编辑并回到查看模式。"""

            def _do_save():
                detail = self._window._detail
                uri = detail._current_task_uri
                if not uri:
                    return "错误: 没有正在编辑的任务"
                detail._save_task()
                return f"已保存: {uri}"

            return self._main.invoke(_do_save)

        ui_task_app.command(edit_app)
        ui_app.command(ui_task_app)

        chat_app = CycloptsApp(name="chat", help="AgentChatPanel 交互")

        @chat_app.command
        def state() -> str:
            """当前面板状态（task_uri, mode, sessions）。

            范例: diy ui chat state
            """
            import yaml as _yaml

            panel = (
                self._window._chat
                if hasattr(self._window, "_chat") and self._window._chat
                else None
            )
            if panel is None:
                return "error: UI 尚未初始化"
            panel_state = self._main.invoke(panel.ui_state)
            import io as _io

            buf = _io.StringIO()
            _yaml.dump(
                panel_state,
                buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return buf.getvalue()

        @chat_app.command
        def sessions() -> str:
            """当前 task 的 session 列表。"""
            import io as _io

            import yaml as _yaml

            panel = (
                self._window._chat
                if hasattr(self._window, "_chat") and self._window._chat
                else None
            )
            if panel is None:
                return "error: UI 尚未初始化"
            panel_state = self._main.invoke(panel.ui_state)
            sessions_list = panel_state.get("sessions", [])
            if not sessions_list:
                return "sessions: []"
            buf = _io.StringIO()
            _yaml.dump(
                {"sessions": sessions_list, "count": len(sessions_list)},
                buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return buf.getvalue()

        @chat_app.command
        def read(
            *,
            task: str | None = None,
        ):
            """读取当前对话文本。

            范例: diy ui chat read
            流程: send → wait → read
            """
            panel = (
                self._window._chat
                if hasattr(self._window, "_chat") and self._window._chat
                else None
            )
            if panel is None:
                return "error: UI 尚未初始化"
            text = self._main.invoke(panel.ui_chat_log)
            return text or "(无对话)"

        @chat_app.command
        def wait(
            *,
            task: str | None = None,
            timeout: int = 60,
        ):
            """等待 agent 回复完成（轮询）。

            范例: diy ui chat wait --timeout 120
            """
            import time as _time

            panel = (
                self._window._chat
                if hasattr(self._window, "_chat") and self._window._chat
                else None
            )
            if panel is None:
                return "error: UI 尚未初始化"
            out = getattr(self, "_stream_out", None)
            deadline = _time.time() + timeout
            last_text = ""
            while _time.time() < deadline:
                cur = self._main.invoke(panel.ui_chat_log) or ""
                if cur != last_text:
                    delta = cur[len(last_text) :]
                    last_text = cur
                    if out:
                        out.write(delta)
                        out.flush()
                    else:
                        return delta  # 非流式模式，只返回增量
                # 检查 session 是否已完成
                state = self._main.invoke(panel.ui_state)
                sessions = state.get("sessions", [])
                all_done = all(s.get("state") in ("done", "failed") for s in sessions)
                if sessions and all_done:
                    if out:
                        out.write("\n[done]\n")
                        out.flush()
                    return
                _time.sleep(2)
            return f"[timeout] agent 未在 {timeout}s 内完成"

        @chat_app.command
        def status():
            """当前 chat panel 状态（task / agent / session / running）。"""
            panel = (
                self._window._chat
                if hasattr(self._window, "_chat") and self._window._chat
                else None
            )
            if panel is None:
                return "error: UI \u5c1a\u672a\u521d\u59cb\u5316"
            s = panel.ui_state()
            import io as _io

            import yaml as _yaml

            buf = _io.StringIO()
            _yaml.dump(
                s, buf, allow_unicode=True, default_flow_style=False, sort_keys=False
            )
            return buf.getvalue()

        @chat_app.command
        def send(
            text: str,
            /,
            *,
            task: str | None = None,
        ):
            """向当前 task 发送消息。

            范例: diy ui chat send "帮我分析这个项目"
            流程: diy ui task detail <uri> → send → wait → read
            """
            panel = (
                self._window._chat
                if hasattr(self._window, "_chat") and self._window._chat
                else None
            )
            if panel is None:
                return "error: UI 尚未初始化"
            if task:
                self._main.invoke(lambda: panel.set_task(task))
            self._main.invoke(lambda: panel.send_text(text))
            return "OK: 已发送"

        ui_app.command(chat_app)
        diy.command(ui_app)

        # ═══════════════════════════════════════════
        # AI 子命令：task / subject / scan / profile / agent
        # 从 _dai_cli 导入逻辑函数，注册为 cyclopts 子 App
        # ═══════════════════════════════════════════

        # ── scan ──
        @diy.command
        def scan(
            *,
            path: str | None = None,
            json_output: bool = False,
        ):
            """扫描 workspace 与 spaces"""
            import os as _os

            from diy.core._dai_scan import find_spaces, find_workspace_root

            start = _os.path.realpath(path) if path else _os.path.realpath(_os.getcwd())
            ws = find_workspace_root(start)
            if ws is None:
                return "错误: 未找到 diy.yaml"
            spaces = find_spaces(ws)
            import json as _json

            import yaml as _yaml

            result = {"workspace": ws, "spaces": spaces}
            if json_output:
                return _json.dumps(result, indent=2, ensure_ascii=False)
            import io as _io

            _buf = _io.StringIO()
            _yaml.dump(
                result,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        # ── ai profile ──
        profile_app = CycloptsApp(
            name="profile", help="查询 state.yaml 中的 profile 预设"
        )

        @profile_app.command(name="list")
        def profile_list(
            *,
            json_output: bool = False,
        ):
            """列出所有 profile"""
            import json as _json

            from diy.core._state import load_state

            profiles = load_state().get("profiles", {})
            if json_output:
                return _json.dumps(profiles, indent=2, ensure_ascii=False)
            import io as _io

            import yaml as _yaml

            _buf = _io.StringIO()
            _yaml.dump(
                profiles,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        @profile_app.command
        def profile_show(
            name: str,
            /,
            *,
            json_output: bool = False,
        ):
            """查看单个 profile"""
            import json as _json

            import yaml as _yaml
            from diy.core._state import load_state

            profiles = load_state().get("profiles", {})
            if name not in profiles:
                return f"错误: profile {name} 不存在"
            if json_output:
                return _json.dumps(profiles[name], indent=2, ensure_ascii=False)
            import io as _io

            _buf = _io.StringIO()
            _yaml.dump(
                profiles[name],
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        diy.command(profile_app)

        # ── subject ──
        subject_app = CycloptsApp(name="subject", help="Subject 树管理")

        # _norm 从 diydev._state 导入（统一一处，避免模块级 HOME 缓存问题）

        # _norm 和 _subject_is_git 从 diydev._state 导入（统一一处）

        @subject_app.command(name="add")
        def subject_add(
            path: str,
            /,
            *,
            desc: str | None = None,
            json_output: bool = False,
        ):
            """注册 subject。自动检测是否为 git 仓库。

            范例: diy subject add ~/git/diy/_diy
            范例: diy subject add ~/git/diy/_diy --desc "dev 工具项目"
            注意: 路径必须是 git 仓库目录。
            """
            from diy.core.middleware import gateway_call
            from diy.core.subject import add_subject

            return gateway_call(add_subject, path, desc=desc)

        @subject_app.command(name="list")
        def subject_list(
            *,
            json_output: bool = False,
        ):
            """列出所有已注册的 subject。

            范例: diy subject list
            """
            import io as _io
            import json as _json

            import yaml as _yaml
            from diy.core._state import _subject_is_git, load_state

            data = load_state()
            subjects = data.get("subjects", {})
            enriched = {
                p: {**entry, "is_git": _subject_is_git(p)}
                for p, entry in subjects.items()
            }
            if json_output:
                return _json.dumps(enriched, indent=2, ensure_ascii=False)
            _buf = _io.StringIO()
            _yaml.dump(
                enriched,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        @subject_app.command(name="remove")
        def subject_remove(
            path: str,
            /,
            *,
            json_output: bool = False,
        ):
            """删除 subject"""
            from diy.core.middleware import gateway_call
            from diy.core.subject import remove_subject

            return gateway_call(remove_subject, path)

        @subject_app.command(name="show")
        def subject_show(
            path: str,
            /,
            *,
            json_output: bool = False,
        ):
            """查看单个 subject（含实时 is_git 检测）"""
            from diy.core.middleware import gateway_call
            from diy.core.subject import show_subject

            return gateway_call(show_subject, path)

        @subject_app.command(name="tree")
        def subject_tree(
            *,
            json_output: bool = False,
        ):
            """树状展示 subject（按路径层级嵌套）。

            范例: diy subject tree
            """
            import io as _io
            import json as _json

            import yaml as _yaml
            from diy.cli._dai_cli import _build_subject_tree
            from diy.core._state import _subject_is_git, load_state

            data = load_state()
            subjects = data.get("subjects", {})
            enriched = {
                p: {**entry, "is_git": _subject_is_git(p)}
                for p, entry in subjects.items()
            }
            tree = _build_subject_tree(enriched)
            if json_output:
                return _json.dumps(tree, indent=2, ensure_ascii=False)
            _buf = _io.StringIO()
            _yaml.dump(
                tree,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        @subject_app.command(name="scan")
        def subject_scan(
            root: str,
            /,
            *,
            json_output: bool = False,
        ):
            """扫描文件系统，发现 git 仓库作为 subject"""
            import io as _io
            import json as _json
            import os as _os

            import yaml as _yaml
            from diy.core._state import _norm, load_state, save_state

            root_path = _os.path.abspath(_os.path.expanduser(root))
            if not _os.path.isdir(root_path):
                return f"错误: 目录不存在 {root}"
            found: dict[str, dict] = {}
            for dirpath, dirs, _ in _os.walk(root_path):
                if _os.path.isdir(_os.path.join(dirpath, ".git")) or _os.path.isfile(
                    _os.path.join(dirpath, ".git")
                ):
                    found[_norm(dirpath)] = {}
                    dirs.clear()
            data = load_state()
            subjects = data.setdefault("subjects", {})
            subjects.update(found)
            save_state(data)
            result = {"status": "success", "data": {"found": len(found)}}
            if json_output:
                return _json.dumps(result, indent=2, ensure_ascii=False)
            _buf = _io.StringIO()
            _yaml.dump(
                result,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        diy.command(subject_app)

        # ── task ──
        task_app = CycloptsApp(name="task", help="任务管理")

        @task_app.command(name="star")
        def task_star(
            uri: str,
            /,
            *,
            json_output: bool = False,
        ):
            """star 任务（创建 symlink）"""
            import io as _io
            import json as _json

            import yaml as _yaml
            from diy.core._state import get_task, star_task

            task = get_task(uri)
            if task is None:
                return f"错误: 任务 {uri} 不存在"
            star_task(uri)
            result = {"status": "success", "data": {"uri": uri, "starred": True}}
            if json_output:
                return _json.dumps(result, indent=2, ensure_ascii=False)
            _buf = _io.StringIO()
            _yaml.dump(
                result,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        @task_app.command(name="unstar")
        def task_unstar(
            uri: str,
            /,
            *,
            json_output: bool = False,
        ):
            """unstar 任务（删除 symlink）"""
            import io as _io
            import json as _json

            import yaml as _yaml
            from diy.core._state import get_task, unstar_task

            task = get_task(uri)
            if task is None:
                return f"错误: 任务 {uri} 不存在"
            unstar_task(uri)
            result = {"status": "success", "data": {"uri": uri, "starred": False}}
            if json_output:
                return _json.dumps(result, indent=2, ensure_ascii=False)
            _buf = _io.StringIO()
            _yaml.dump(
                result,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        @task_app.command(name="list")
        def task_list(
            *,
            json_output: bool = False,
            all: bool = False,
        ):
            """列出任务。默认只显示 starred，--all 显示全部。"""
            import io as _io
            import json as _json

            import yaml as _yaml
            from diy.core._state import is_starred, list_starred, list_tasks

            tasks = dict(list_tasks() if all else list_starred())
            if not all:
                for k in tasks:
                    tasks[k]["starred"] = is_starred(k)
            if json_output:
                return _json.dumps({"tasks": tasks}, indent=2, ensure_ascii=False)
            _buf = _io.StringIO()
            _yaml.dump(
                {"tasks": tasks},
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        @task_app.command(name="show")
        def task_show(
            uri: str,
            /,
            *,
            json_output: bool = False,
        ):
            """查看单个任务详情。

            范例: diy task show local/task/1
            """
            import json as _json

            import yaml as _yaml
            from diy.core._state import get_task

            task = get_task(uri)
            if task is None:
                return f"错误: 任务 {uri} 不存在"
            body = task.pop("body", "") if not json_output else task.get("body", "")
            if json_output:
                return _json.dumps(task, indent=2, ensure_ascii=False)
            import io as _io

            _buf = _io.StringIO()
            _yaml.dump(
                task,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            result = _buf.getvalue()
            if body:
                result += "\n" + body
            return result

        @task_app.command(name="create")
        def task_create(
            title: str,
            subject: str,
            /,
            *,
            parent: str | None = None,
            detail: str | None = None,
            body_file: str | None = None,
            source_type: str = "local",
            source_uri: str | None = None,
            json_output: bool = False,
        ):
            """创建本地任务，自动 star。

            输出格式: status: success / data: {title, state, uri, ...}
            范例: diy task create "标题" ~/git/diy/_diy
            范例: diy task create "子任务" ~/git/diy/_diy --parent local/task/1
            注意: subject 必须已通过 diy subject add 注册。
            """
            from diy.core.middleware import gateway_call
            from diy.core.task import create_task

            return gateway_call(
                create_task,
                title,
                subject,
                parent=parent,
                detail=detail,
                body_file=body_file,
                source_type=source_type,
                source_uri=source_uri,
            )

        @task_app.command(name="edit")
        def task_edit(
            uri: str,
            /,
            *,
            title: str | None = None,
            state: str | None = None,
            subject: str | None = None,
            parent: str | None = None,
            detail: str | None = None,
            body_file: str | None = None,
            json_output: bool = False,
        ):
            """编辑任务元数据。返回编辑后的完整字段。

            范例: diy task edit local/task/1 --title "新标题" --state active
            注意: 不传的参数保持不变。
            """
            import json as _json

            import yaml as _yaml
            from diy.core._state import _norm, get_task, update_task_field

            if get_task(uri) is None:
                return f"错误: 任务 {uri} 不存在"
            fields: dict = {}
            if title is not None:
                fields["title"] = title
            if state is not None:
                fields["state"] = state
            if subject is not None:
                fields["subject"] = _norm(subject)
            if parent is not None:
                if get_task(parent) is None:
                    return f"错误: parent {parent} 不存在"
                fields["parent"] = parent
            if detail is not None:
                fields["detail"] = detail
            if body_file is not None:
                try:
                    from pathlib import Path

                    fields["body"] = Path(body_file).read_text(encoding="utf-8")
                except OSError as exc:
                    return f"错误: 无法读取 body 文件: {exc}"
            task = update_task_field(uri, **fields)
            result = {"status": "success", "data": task}
            if json_output:
                return _json.dumps(result, indent=2, ensure_ascii=False)
            import io as _io

            _buf = _io.StringIO()
            _yaml.dump(
                result,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        @task_app.command(name="delete")
        def task_delete(
            uri: str,
            /,
            *,
            json_output: bool = False,
        ):
            """删除本地任务"""
            import json as _json

            from diy.core._state import delete_task, get_task

            task = get_task(uri)
            if task is None:
                return f"错误: 任务 {uri} 不存在"
            src = task.get("source", {})
            if src.get("type") != "local":
                return f"错误: {uri} 是外部任务，请用 unlink"
            delete_task(uri)
            result = {"status": "success"}
            if json_output:
                return _json.dumps(result, indent=2, ensure_ascii=False)
            return "已删除"

        @task_app.command(name="link")
        def task_link(
            title: str,
            subject: str,
            source_uri: str,
            /,
            *,
            parent: str | None = None,
            detail: str | None = None,
            json_output: bool = False,
        ):
            """链接外部任务（GitHub issue / PR 等）。不修改远端，仅建立本地引用。"""
            import io as _io
            import json as _json

            import yaml as _yaml
            from diy.core._state import (
                _norm,
                create_task,
                get_task,
                load_state,
                star_task,
            )

            if not source_uri:
                return "错误: --source-uri 必填"
            if "github.com" in source_uri:
                source_type = "github_pr" if "/pull/" in source_uri else "github_issue"
            else:
                source_type = "external"
            subject_n = _norm(subject)
            data = load_state()
            if subject_n not in data.get("subjects", {}):
                return f"错误: subject {subject_n} 未注册"
            if parent is not None and get_task(parent) is None:
                return f"错误: parent {parent} 不存在"
            try:
                uri = create_task(
                    title=title,
                    subject=subject_n,
                    parent=parent,
                    detail=detail,
                    source_type=source_type,
                    source_uri=source_uri,
                )
                star_task(uri)
            except ValueError as exc:
                return f"错误: {exc}"
            task = get_task(uri) or {}
            result = {"status": "success", "data": task}
            if json_output:
                return _json.dumps(result, indent=2, ensure_ascii=False)
            _buf = _io.StringIO()
            _yaml.dump(
                result,
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        @task_app.command(name="unlink")
        def task_unlink(
            uri: str,
            /,
            *,
            json_output: bool = False,
        ):
            """解绑外部任务引用。不删除远端 issue，仅移除本地记录。"""
            import json as _json

            from diy.core._state import delete_task, get_task

            task = get_task(uri)
            if task is None:
                return f"错误: 任务 {uri} 不存在"
            src = task.get("source", {})
            if src.get("type") == "local":
                return f"错误: {uri} 是本地任务，请用 delete"
            delete_task(uri)
            result = {"status": "success"}
            if json_output:
                return _json.dumps(result, indent=2, ensure_ascii=False)
            return "已解绑"

        @task_app.command(name="sync")
        def task_sync(
            *,
            uri: str | None = None,
            all: bool = False,
            json_output: bool = False,
        ):
            """同步外部任务内容到本地（目前支持：GitHub issue）。"""
            import io as _io
            import json as _json
            import re as _re
            import subprocess

            import yaml as _yaml
            from diy.core._state import get_task, list_tasks, update_task_field

            if not uri and not all:
                return "错误: 请指定任务 URI 或使用 --all 同步全部"

            _GH_STATE_MAP = {"OPEN": "active", "CLOSED": "done", "MERGED": "done"}

            def _gh_parse(source_uri: str):
                m = _re.match(r"github\.com/([^/]+)/([^/]+)/issues/(\d+)", source_uri)
                if not m:
                    return None
                return m.group(1), m.group(2), m.group(3)

            def _sync_one(t_uri: str, t_data: dict) -> dict | str:
                src = t_data.get("source", {})
                source_uri = src.get("uri", t_uri)
                parsed = _gh_parse(source_uri)
                if not parsed:
                    return f"无法解析 GitHub URI: {source_uri}"
                owner, repo, number = parsed
                try:
                    r = subprocess.run(
                        [
                            "gh",
                            "issue",
                            "view",
                            number,
                            "--repo",
                            f"{owner}/{repo}",
                            "--json",
                            "title,body,state,updatedAt",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=15,
                    )
                except FileNotFoundError:
                    return "gh CLI 未安装"
                except subprocess.TimeoutExpired:
                    return f"请求 {owner}/{repo}#{number} 超时"
                if r.returncode != 0:
                    err = r.stderr.strip()
                    if "not found" in err.lower():
                        try:
                            from diy.core._state import unstar_task

                            unstar_task(t_uri)
                            return "GitHub issue 已不存在，已取消关注（unstar）"
                        except FileNotFoundError:
                            return "GitHub issue 已不存在（已移除）"
                    return f"gh 调用失败: {err}"
                try:
                    data = _json.loads(r.stdout)
                except _json.JSONDecodeError:
                    return f"gh 返回非 JSON: {r.stdout[:200]}"
                title = data.get("title", t_data.get("title", ""))
                body = data.get("body", "") or ""
                gh_state = _GH_STATE_MAP.get(data.get("state", ""), "active")
                return update_task_field(t_uri, title=title, state=gh_state, body=body)

            if all:
                tasks = list_tasks()
                results: dict[str, dict | str] = {}
                total = 0
                for t_uri, t_data in sorted(tasks.items()):
                    src = t_data.get("source", {})
                    src_type = src.get("type", "")
                    if src_type not in ("github_issue",):
                        continue
                    total += 1
                    results[t_uri] = _sync_one(t_uri, t_data)
                ok = sum(1 for v in results.values() if isinstance(v, dict))
                fail = sum(1 for v in results.values() if isinstance(v, str))
                if json_output:
                    return _json.dumps(
                        {
                            "synced": ok,
                            "failed": fail,
                            "results": results,
                            "total": total,
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                return f"同步完成: {ok} 更新, {fail} 失败, 共 {total} 个外部任务"
            # 单个同步
            task = get_task(uri)
            if task is None:
                return f"错误: 任务 {uri} 不存在"
            src = task.get("source", {})
            src_type = src.get("type", "")
            if src_type != "github_issue":
                return f"错误: {uri} 的类型 {src_type} 暂不支持同步"
            result = _sync_one(uri, task)
            if isinstance(result, str):
                return f"错误: {result}"
            if json_output:
                return _json.dumps(
                    {"status": "success", "data": result}, indent=2, ensure_ascii=False
                )
            _buf = _io.StringIO()
            _yaml.dump(
                {"status": "success", "data": result},
                _buf,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
            return _buf.getvalue()

        diy.command(task_app)

        # ── agent ──
        agent_app = CycloptsApp(name="agent", help="子 agent 管理 — 文本协议")

        import socket as _sock

        _AGENT_SOCKET = str(diy_home() / "agentd.sock")

        def _agent_send_text(cmd_line: str, retries: int = 10) -> str:
            """向 agentd socket 发送一行文本命令，返回全部响应文本。"""
            for attempt in range(retries):
                try:
                    s = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
                    s.settimeout(10)
                    s.connect(_AGENT_SOCKET)
                    s.sendall((cmd_line + "\n").encode("utf-8"))
                    s.shutdown(_sock.SHUT_WR)
                    buf: list[bytes] = []
                    while True:
                        data = s.recv(4096)
                        if not data:
                            break
                        buf.append(data)
                    s.close()
                    return b"".join(buf).decode("utf-8")
                except FileNotFoundError:
                    if attempt < retries - 1:
                        import time as _time

                        _time.sleep(0.5)
                        continue
                    raise
                except OSError:
                    if attempt < retries - 1:
                        import time as _time

                        _time.sleep(0.5)
                        continue
                    raise
            return ""

        def _check_agent_ok(resp: str) -> str | None:
            """检查响应首行是否为 OK，返回状态描述或错误信息。"""
            first = resp.split("\n")[0].strip()
            if first.startswith("ERROR"):
                return first[6:].strip()
            if first.startswith("OK"):
                return first[3:].strip()
            return None

        @agent_app.command(name="spawn")
        def agent_spawn(
            task_uri: str,
            message: str,
            /,
            *,
            model: str | None = None,
            toolsets: str | None = None,
            reasoning_budget: int | None = None,
        ):
            """为一个 task 创建并启动 agent"""
            parts = ["spawn", f"--task={task_uri}", f"--message={message}"]
            if model:
                parts.append(f"--model={model}")
            if toolsets:
                parts.append(f"--toolsets={toolsets}")
            if reasoning_budget is not None:
                parts.append(f"--reasoning={reasoning_budget}")
            cmd = " ".join(parts)
            resp = _agent_send_text(cmd)
            err = _check_agent_ok(resp)
            if err is not None:
                return f"agent {task_uri}: {err}"
            return f"agent {task_uri}: 已启动"

        @agent_app.command(name="send")
        def agent_send(
            task_uri: str,
            message: str,
            /,
        ):
            """向 agent 发送消息"""
            cmd = f"send --task={task_uri} --message={message}"
            resp = _agent_send_text(cmd)
            err = _check_agent_ok(resp)
            if err is not None:
                return f"agent {task_uri}: {err}"
            return f"agent {task_uri}: 消息已发送"

        @agent_app.command(name="kill")
        def agent_kill(
            task_uri: str,
            /,
        ):
            """终止 agent"""
            cmd = f"kill --task={task_uri}"
            resp = _agent_send_text(cmd)
            err = _check_agent_ok(resp)
            if err is not None:
                return f"agent {task_uri}: {err}"
            return f"agent {task_uri}: 已终止"

        @agent_app.command(name="list")
        def agent_list():
            """列出所有活跃 agent"""
            resp = _agent_send_text("list")
            if resp.startswith("(") or not resp.strip():
                return "(无活跃 agent)"
            return resp

        @agent_app.command(name="health")
        def agent_health(
            task_uri: str | None = None,
            /,
        ):
            """检查 agent 子进程健康状态。

            检查进程存活、状态、运行时长。无参数时检查所有 agent。

            范例: diy agent health
                  diy agent health local/task/1
            """
            import os as _os
            import time as _time

            mgr = get_manager()
            agents = [mgr.get(task_uri)] if task_uri else mgr.list()

            if not agents:
                return "(无 agent)"

            lines = []
            for a in agents:
                uri = a.task_uri if hasattr(a, "task_uri") else ""
                proc = getattr(a, "_proc", None)
                pid = proc.pid if proc else 0
                alive = proc.returncode is None if proc else False

                # 进程存在性检查
                proc_exists = False
                if pid:
                    try:
                        _os.kill(pid, 0)
                        proc_exists = True
                    except ProcessLookupError:
                        proc_exists = False
                    except PermissionError:
                        proc_exists = True

                state = a.state if hasattr(a, "state") else "?"
                lines.append(
                    f"{'🟢' if proc_exists else '🔴'} {uri:<30} "
                    f"state={state:<8} pid={pid or '?'}"
                )
                if proc_exists and not alive:
                    lines[-1] += " (僵尸)"
                elif not proc_exists and alive:
                    lines[-1] += " (失联)"

            return "\n".join(lines)

        @agent_app.command(name="show")
        def agent_show(
            task_uri: str,
            /,
        ):
            """查看 agent 状态和输出"""
            cmd = f"show --task={task_uri}"
            resp = _agent_send_text(cmd)
            if resp.startswith("ERROR"):
                return resp
            return resp

        @agent_app.command(name="monitor")
        def agent_monitor(
            task_uri: str | None = None,
            /,
            *,
            json: bool = False,
        ):
            """agent 实时监控。

            范例: diy agent monitor
                  diy agent monitor local/task/1
            """
            mgr = get_manager()
            import json as _json
            import time as _time

            def _snap(uri):
                agent = mgr.get(uri)
                if agent is None:
                    return None
                s = agent.state_snapshot()
                now = _time.time()
                proc = getattr(agent, "_proc", None)
                alive = proc.returncode is None if proc else False
                pid = proc.pid if proc else 0
                return {
                    "task_uri": s.task_uri,
                    "session_id": s.session_id,
                    "state": s.state,
                    "provider": s.provider,
                    "model": s.model,
                    "messages": s.message_count,
                    "events": s.event_count,
                    "last_event": s.last_event_type,
                    "elapsed": f"{s.prompt_elapsed:.0f}s" if s.state == "running" else "",
                    "pid": pid,
                    "alive": alive,
                }

            def _do():
                if task_uri:
                    snap = _snap(task_uri)
                    if snap is None:
                        return f"agent {task_uri} 不活跃"
                    if json:
                        return _json.dumps(snap, ensure_ascii=False)
                    lines = [
                        f"{'='*50}",
                        f"  {snap['task_uri']}",
                        f"{'='*50}",
                        f"  state:    {snap['state']}",
                        f"  provider: {snap['provider']}",
                        f"  model:    {snap['model']}",
                        f"  messages: {snap['messages']}",
                    ]
                    if snap["state"] == "running":
                        lines.append(f"  events:   {snap['events']} (last: {snap['last_event']})")
                        lines.append(f"  elapsed:  {snap['elapsed']}")
                    if snap["pid"]:
                        lines.append(f"  pid:      {snap['pid']} (alive={snap['alive']})")
                    return "\n".join(lines)
                else:
                    states = mgr.list()
                    if json:
                        data = [_snap(s.task_uri) for s in states]
                        return _json.dumps({"agents": data}, ensure_ascii=False)
                    if not states:
                        return "(无 agent)"
                    lines = [
                        f"{'URI':<30} {'STATE':<10} {'PROVIDER':<15} {'MODEL':<20} {'EVENTS':<8} {'PID':<8}",
                        "-" * 100,
                    ]
                    for s in states:
                        snap = _snap(s.task_uri)
                        icon = {"running": "🟢", "idle": "⏸️", "error": "🔴"}.get(snap["state"], "❓")
                        ev = str(snap["events"]) if snap["events"] else ""
                        pid = str(snap["pid"]) if snap["pid"] else ""
                        lines.append(
                            f"{snap['task_uri']:<30} {icon} {snap['state']:<8} "
                            f"{snap['provider']:<15} {snap['model']:<20} {ev:<8} {pid:<8}"
                        )
                    return "\n".join(lines)

            return self._main.invoke(_do)

        @agent_app.command(name="stream")
        def agent_stream(
            task_uri: str | None = None,
            /,
            *,
            timeout: int = 120,
            json: bool = False,
        ):
            """agent 事件流（流式输出）。

            范例: diy agent stream local/task/1
                  diy agent stream local/task/1 --timeout 60
                  diy agent stream local/task/1 --json
            """
            import json as _json
            import time as _time
            from diy.core.observer import InProcessAgentObserver

            mgr = get_manager()
            obs = InProcessAgentObserver(mgr)
            out = getattr(self, "_stream_out", None)

            if not out:
                return "error: 非流式模式，不支持 stream"

            def _do():
                if task_uri:
                    agent = mgr.get(task_uri)
                    if agent is None:
                        out.write(f"error: agent {task_uri} 不活跃\n")
                        out.flush()
                        return

                    # 注入 observer
                    if hasattr(agent, "_observer"):
                        agent._observer = obs

                    deadline = _time.time() + timeout
                    seen = 0
                    while _time.time() < deadline:
                        # 检查 agent 是否还在运行
                        if agent.is_alive is False:
                            out.write("[done] agent 已停止\n")
                            out.flush()
                            return

                        # 从 observer buffer 读取新事件
                        buf = obs._buffers.get(task_uri)
                        if buf:
                            while len(buf) > seen:
                                ev = buf[seen]
                                if json:
                                    out.write(_json.dumps(ev.to_dict(), ensure_ascii=False) + "\n")
                                else:
                                    out.write(ev.format() + "\n")
                                out.flush()
                                seen += 1

                        _time.sleep(0.3)

                    out.write(f"[timeout] {timeout}s 到期\n")
                    out.flush()
                else:
                    # 列出所有 agent 的状态（一次性输出）
                    states = mgr.list()
                    if not states:
                        out.write("(无 agent)\n")
                        out.flush()
                        return
                    if json:
                        data = []
                        for s in states:
                            snap = s.state_snapshot()
                            data.append({
                                "task_uri": snap.task_uri,
                                "state": snap.state,
                                "provider": snap.provider,
                                "model": snap.model,
                            })
                        out.write(_json.dumps({"agents": data}, ensure_ascii=False) + "\n")
                    else:
                        for s in states:
                            snap = s.state_snapshot()
                            icon = {"running": "🟢", "idle": "⏸️", "error": "🔴"}.get(snap.state, "❓")
                            out.write(
                                f"{icon} {snap.task_uri:<30} {snap.state:<10} "
                                f"{snap.provider:<15} {snap.model}\n"
                            )
                    out.flush()

            self._main.invoke(_do)

        diy.command(agent_app)

        # ── notify / title / metrics / shutdown（UI 操纵） ──
        @ui_app.command(name="notify")
        def ui_notify(*message: str):
            """<消息...> 弹通知 — 窗口右上角弹出"""
            text = " ".join(message)
            QMetaObject.invokeMethod(
                self._window,
                "show_notification",
                QtCore.ConnectionType.QueuedConnection,
                Q_ARG(str, text),
            )
            return "OK"

        @ui_app.command(name="title")
        def ui_title(*text: str):
            """<文本...> 改窗口标题"""
            title_text = " ".join(text)
            if not title_text:
                return "错误: 缺少参数，用法: diy ui title <文本...>"
            QMetaObject.invokeMethod(
                self._window,
                "setWindowTitle",
                QtCore.ConnectionType.QueuedConnection,
                Q_ARG(str, title_text),
            )
            return f"标题已改为: {title_text}"

        @ui_app.command(name="metrics")
        def ui_metrics():
            """返回当前指标快照（YAML）。"""
            import yaml  # type: ignore[import-untyped]  # noqa: PLC0415

            raw = yaml.dump(
                self._window._metrics.snapshot(),
                default_flow_style=False,
                sort_keys=False,
                allow_unicode=True,
            )
            import re  # noqa: PLC0415

            return re.sub(r"\x1b\[\d+(;\d+)*m", "", raw)

        @ui_app.command(name="llm")
        def ui_llm(*, refresh: bool = False):
            """LLM 管理页面状态快照 — provider 列表 + proxy 统计。

            范例: dai ui llm
                   dai ui llm --refresh
            """
            return self._main.invoke(self._window._format_llm_status)

        @ui_app.command(name="llm-sync")
        def ui_llm_sync():
            """触发 LLM provider 同步（diy llm sync all）。

            范例: dai ui llm-sync
            """
            return self._main.invoke(self._window._trigger_llm_sync)

        @ui_app.command(name="shutdown")
        def ui_shutdown():
            """关闭管控台。app 退出后下次 diy 命令会自动启动。

            不尝试优雅退出——QtWebEngine 线程不配合清理，Python finalization
            会卡死导致 flock 永不到达、新实例无法启动。
            直接 os._exit(0)，内核同步释放文件锁和 socket。
            agent 子进程的 stdin/stdout pipe 会因父进程退出而断裂，
            下次 I/O 时自动退出，无需逐个清理。
            """
            import logging as _lg

            for h in _lg.getLogger("diy.app").handlers:
                h.flush()
            os._exit(0)

        # ── 注册 diy 组 ──
        self._app.command(diy)

        @self._app.default
        def unknown(*tokens: str):
            return f"未知命令: {' '.join(tokens)!r}  试试 --help"

    def dispatch(self, line: str, out: _io.TextIOWrapper) -> None:
        """流式输出 — 直接写 out，不缓冲。"""
        import io
        import shlex

        from rich.console import Console

        tokens = shlex.split(line) if line else ["--help"]
        console = Console(file=out, width=80)

        # 保存 stream_out 供流式命令（如 wait）使用
        self._stream_out = out

        # cyclopts 错误写入 stderr，重定向到 out
        old_stderr = sys.stderr
        err_buf = io.StringIO()
        sys.stderr = err_buf
        _logged = False  # 兜底标记：是否已通过 except Exception 记录到 app.log
        _exit_code = None  # SystemExit 退出码（None=未退出，0=--help，2=错误）
        try:
            self._app(tokens, console=console, exit_on_error=True)
        except SystemExit as e:
            _exit_code = e.code
        except UnknownCommandError:
            _exit_code = 2
        except Exception as exc:
            _logged = True
            msg = f"dispatch 异常: {exc}"
            logger.error("%s\n%s", msg, traceback.format_exc())
            out.write(f"\n内部错误: {exc}\n")
            self._notify_error(msg)
        finally:
            sys.stderr = old_stderr
            self._stream_out = None

        err_text = err_buf.getvalue()
        if err_text:
            out.write(err_text)
            # 兜底：cyclopts 写了错误到 stderr 但未被 except Exception 捕获
            # 如 SystemExit(2) / UnknownCommandError 的上下文，所有通道统一推送
            if not _logged and _exit_code:
                msg = f"[dispatch] 命令异常 (exit={_exit_code}): {err_text.strip()}"
                logger.warning("%s", msg)
                self._notify_error(msg)
        out.flush()

    def _notify_error(self, message: str) -> None:
        """跨线程在 UI 右上角弹出错误通知。"""
        from PySide6.QtCore import Q_ARG, QMetaObject  # noqa: PLC0415
        from PySide6.QtCore import Qt as QtCore  # noqa: PLC0415

        QMetaObject.invokeMethod(
            self._window,
            "show_notification",
            QtCore.ConnectionType.QueuedConnection,
            Q_ARG(str, message),
        )


# ═══════════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════════


def _subjects_from_state() -> dict:
    """从 state.yaml 读取 subject 列表。"""
    from diy.core._state import load_state

    return load_state().get("subjects", {})


# ═══════════════════════════════════════════════════════
# 创建任务对话框
# ═══════════════════════════════════════════════════════


class _CreateTaskDialog(QDialog):
    """创建任务弹窗 — 用 FormMixin 模式处理错误。"""

    def __init__(
        self,
        parent=None,
        parent_uri: str | None = None,
        initial_subject: str | None = None,
    ):
        super().__init__(parent)
        self.setWindowTitle("✨ 新建任务")
        self.resize(480, 400)

        self._parent_uri = parent_uri
        self._result_uri: str | None = None

        layout = QVBoxLayout(self)
        layout.setSpacing(12)

        # 标题
        layout.addWidget(QLabel("标题"))
        self._title = QLineEdit()
        self._title.setPlaceholderText("任务标题...")
        layout.addWidget(self._title)
        self._title_error = QLabel()
        self._title_error.setStyleSheet("color: #f38ba8; font-size: 11px;")
        self._title_error.hide()
        layout.addWidget(self._title_error)

        # Subject 选择
        layout.addWidget(QLabel("Subject"))
        self._subject = QComboBox()
        subjects = _subjects_from_state()
        self._subject.addItem("(无)", "")
        for s in sorted(subjects.keys()):
            self._subject.addItem(s, s)
        if initial_subject and initial_subject in subjects:
            self._subject.setCurrentText(initial_subject)
        layout.addWidget(self._subject)
        self._subject_error = QLabel()
        self._subject_error.setStyleSheet("color: #f38ba8; font-size: 11px;")
        self._subject_error.hide()
        layout.addWidget(self._subject_error)

        # 父任务（只读显示）
        if parent_uri:
            from diy.core._state import get_task

            pt = get_task(parent_uri)
            pt_label = pt.get("title", parent_uri) if pt else parent_uri
            info = QLabel(f"父任务: {parent_uri} — {pt_label}")
            info.setStyleSheet("color: #a6adc8; font-size: 12px;")
            info.setWordWrap(True)
            layout.addWidget(info)

        # 详情
        layout.addWidget(QLabel("详情（可选）"))
        self._detail = QTextEdit()
        self._detail.setPlaceholderText("任务描述...")
        self._detail.setMaximumHeight(120)
        layout.addWidget(self._detail)

        layout.addStretch()

        # 按钮
        btn_row = QHBoxLayout()
        cancel_btn = QPushButton("取消")
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)
        btn_row.addStretch()
        create_btn = QPushButton("创建")
        create_btn.setDefault(True)
        create_btn.clicked.connect(self._on_create)
        btn_row.addWidget(create_btn)
        layout.addLayout(btn_row)

        # 暗色样式
        self.setStyleSheet("""
            QDialog {
                background: #1e1e2e; color: #cdd6f4;
                font-size: 13px;
            }
            QLabel {
                color: #a6adc8; font-size: 12px;
            }
            QLineEdit, QTextEdit, QComboBox {
                background: #313244; color: #cdd6f4;
                border: 1px solid #45475a; border-radius: 4px;
                padding: 6px 8px; font-size: 13px;
            }
            QLineEdit:focus, QTextEdit:focus, QComboBox:focus {
                border: 1px solid #7aa2f7;
            }
            QComboBox::drop-down {
                border: none; width: 20px;
            }
            QComboBox QAbstractItemView {
                background: #313244; color: #cdd6f4;
                selection-background-color: #45475a;
            }
            QPushButton {
                background: #45475a; color: #cdd6f4;
                border: none; border-radius: 4px;
                padding: 6px 16px;
            }
            QPushButton:hover {
                background: #585b70;
            }
            QPushButton[pressed=true] {
                background: #7aa2f7;
            }
        """)

    def _show_field_error(self, field: str, msg: str) -> None:
        """显示字段级错误。"""
        label = getattr(self, f"_{field}_error", None)
        if label:
            label.setText(f"⚠ {msg}")
            label.show()

    def _clear_errors(self) -> None:
        for name in ("title", "subject"):
            label = getattr(self, f"_{name}_error", None)
            if label:
                label.hide()

    def _on_create(self) -> None:
        from diy.core.task import create_task
        from diy.core.validator import ValidationError

        self._clear_errors()
        try:
            uri = create_task(
                title=self._title.text().strip(),
                subject=self._subject.currentData() or "",
                parent=self._parent_uri,
                detail=self._detail.toPlainText().strip() or None,
            )
            self._result_uri = uri
            self.accept()
        except ValidationError as e:
            for err in e.errors:
                self._show_field_error(err.field, err.msg)


class Gateway(QObject):
    """Unix domain socket server — diy 协议入口。

    协议: 纯文本，cyclopts 解析。
    命令前缀 diy = 协议 v1。
    """

    def __init__(self, window: MainWindow, socket_path: str | None = None):
        super().__init__(window)
        self._window = window
        if socket_path:
            self._path = os.path.expanduser(socket_path)
        else:
            self._path = str(diy_home() / "app.sock")
        self._server: socketserver.UnixStreamServer | None = None
        self._thread: threading.Thread | None = None
        self._cli = GatewayCLI(window)
        # 单实例保护资源
        self._lock_fd: int | None = None
        self._sock_dev: int | None = None
        self._sock_ino: int | None = None

    def _fd_cloexec(self, fd: int) -> None:
        """设置 FD_CLOEXEC，防止 fork 后子进程继承"""
        flags = fcntl.fcntl(fd, fcntl.F_GETFD)
        fcntl.fcntl(fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)

    def _release_lock(self) -> None:
        """释放 flock+关闭锁文件（幂等）。"""
        if self._lock_fd is not None:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
                os.close(self._lock_fd)
            except OSError:
                pass
            self._lock_fd = None

    def start(self) -> None:
        lock_path = os.path.join(os.path.dirname(self._path), "app.lock")
        os.makedirs(os.path.dirname(lock_path), exist_ok=True)

        # 1) 打开锁文件 + CLOEXEC
        self._lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        self._fd_cloexec(self._lock_fd)

        # 2) 非阻塞 flock — 串行化启动，消除 TOCTOU
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self._lock_fd)
            self._lock_fd = None
            raise ConnectionError("已有管控台进程在启动中") from None
        except OSError:
            os.close(self._lock_fd)
            self._lock_fd = None
            raise ConnectionError("无法获取 app.lock") from None

        try:
            # 3) probe 探活：区分活跃实例 vs 僵尸文件（仍在锁内）
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._fd_cloexec(probe.fileno())
            try:
                probe.settimeout(0.5)
                probe.connect(self._path)
                probe.close()
                raise ConnectionError(f"已有运行中的管控台实例 (socket: {self._path})")
            except OSError as e:
                probe.close()
                # 关键：只有 ECONNREFUSED/ENOENT 才判定为僵尸，其他错误（权限等）不删文件
                if e.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                    raise
                # 僵尸文件，安全删除
                try:
                    os.unlink(self._path)
                except FileNotFoundError:
                    logger.debug("[gateway] socket 已不存在（僵尸清理）")

            # 4) 绑定 + 监听
            self._server = socketserver.UnixStreamServer(
                self._path, _make_handler(self)
            )
            self._thread = threading.Thread(
                target=self._server.serve_forever, daemon=True
            )
            self._thread.start()

            # 记下 socket 文件身份
            try:
                st = os.stat(self._path)
                self._sock_dev = st.st_dev
                self._sock_ino = st.st_ino
            except OSError:
                pass

            logger.info(
                "Gateway socket ready → %s  pid=%d",
                self._path,
                os.getpid(),
            )
        except Exception:
            # 启动失败：锁随进程退出由内核释放，不需要手动清
            self._release_lock()
            raise

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
        try:
            os.unlink(self._path)
        except OSError:
            logger.debug("[gateway] socket 清理异常", exc_info=True)
        # 注意：不释放 flock！锁由进程退出时内核自动清理。
        # 如果在这里释放，_app_restart 可能趁旧进程还在退出时抢到锁。
        # 只有进程死透，锁才释放。这是单实例的最后一道防线。


def _make_handler(gateway: Gateway):
    import io as _io

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            data = self.rfile.readline()
            if not data:
                return
            cmd = data.decode("utf-8").strip()
            # wfile 是 binary，包成 text mode 给 rich
            text_out = _io.TextIOWrapper(
                self.wfile, encoding="utf-8", write_through=True
            )
            try:
                gateway._cli.dispatch(cmd, text_out)
            except Exception:
                import traceback

                text_out.write(f"\n内部错误: {traceback.format_exc()}")
                text_out.flush()

    return Handler


# ═══════════════════════════════════════════════════════
# AgentInfo (简化 dataclass，避免循环导入)
# ═══════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════
# 任务树过滤器
# ═══════════════════════════════════════════════════════


class TaskFilterProxy(QSortFilterProxyModel):
    """按文本 + 状态过滤任务树。"""

    def __init__(self, window: MainWindow):
        super().__init__(window)
        self._window = window
        self.setRecursiveFilteringEnabled(True)

    def filterAcceptsRow(self, source_row: int, source_parent) -> bool:  # noqa: N802  # 重写 QSortFilterProxyModel 方法
        model = self.sourceModel()
        if model is None:
            return True
        index = model.index(source_row, 0, source_parent)
        if not index.isValid():
            return True

        text = self._window._filter_text.text().strip().lower()
        state_filter = self._window._filter_state.currentText()

        display = (index.data(Qt.ItemDataRole.DisplayRole) or "").lower()
        uri = index.data(ROLE_TASK_URI) or ""
        item_state = index.data(ROLE_STATE) or ""

        # 文本匹配
        text_ok = not text or text in display or text in uri.lower()

        # 状态匹配
        state_ok = state_filter == "所有状态" or item_state == state_filter

        return text_ok and state_ok


class AgentInfo:
    def __init__(self, agent_id: str, state: str = "unknown", pid: int | None = None):
        self.agent_id = agent_id
        self.state = state
        self.pid = pid

    def __eq__(self, other):
        if not isinstance(other, AgentInfo):
            return False
        return self.agent_id == other.agent_id and self.state == other.state


# ═══════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════


def main():
    import signal
    import socket
    import subprocess

    # ── 日志系统必须先初始化 ──
    setup_app_logger()
    logger.info("=" * 50)
    logger.info("diy 管控台启动")

    # ── 加载 ~/.diy/.env（LLM provider API keys） ──
    _dotenv = diy_home() / ".env"
    if _dotenv.is_file():
        for _line in _dotenv.read_text().splitlines():
            _line = _line.strip()
            if not _line or _line.startswith("#") or "=" not in _line:
                continue
            _key, _sep, _val = _line.partition("=")
            _key = _key.strip()
            _val = _val.strip().strip("\"'")
            if _key and _val and _key not in os.environ:
                os.environ[_key] = _val

    # ── Qt 应用必须在 QtAsyncio event loop 之前创建 ──
    sandbox, sandbox_path = _detect_sandbox()

    # QWebEngine Chromium flags 已在模块级（import QtWebEngineWidgets 之前）设置
    # 用户可通过环境变量覆盖：
    #   QTWEBENGINE_CHROMIUM_FLAGS="--single-process" uv run python -m diy.app.main

    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setStyleSheet(_app_stylesheet(sandbox))

    # ── QtAsyncio: Qt event loop 驱动 asyncio（Python 3.15+ 策略系统废弃，届时需改用 asyncio.run + loop factory） ──
    from PySide6.QtAsyncio import QAsyncioEventLoopPolicy  # noqa: PLC0415

    if sys.platform == "win32":
        # Windows: ProactorEventLoop（Python 3.8+ 默认）的 subprocess pipe 与 QtAsyncio 可能冲突
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    else:
        asyncio.set_event_loop_policy(QAsyncioEventLoopPolicy())
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    # ── 全局异步异常安全网 ──
    def _safe_asyncio_handler(context):
        """QtAsyncio call_exception_handler 只传 context (非标准 asyncio 的 (loop, context))。"""
        try:
            exc = context.get("exception")
            _msg = context.get("message", "")
            # Qt C++ 对象已销毁 — 非致命，日志即可
            if isinstance(exc, RuntimeError) and "already deleted" in str(exc):
                logger.warning("[qt-lifecycle] 访问已删除 QObject: %s", exc)
                return
            # 其他 async Task 异常 — 记录不崩溃
            if exc:
                logger.error(
                    "[async] 未处理的 Task 异常: %s\n%s",
                    exc,
                    "".join(__import__("traceback").format_tb(exc.__traceback__)),
                )
                return
            # 非 exception 上下文（如 cancelled）— 交给默认处理器
            _orig = loop.get_exception_handler()
            if _orig and _orig is not _safe_asyncio_handler:
                _orig(loop, context)
        except Exception as handler_err:
            logger.error("[async] 异常安全网自身崩溃: %s", handler_err, exc_info=True)

    loop.set_exception_handler(_safe_asyncio_handler)

    # ── 全局 Python 异常安全网（兜住 Qt slot 等边界） ──
    _orig_excepthook = sys.excepthook

    def _safe_excepthook(typ, val, tb):
        if isinstance(val, RuntimeError) and "already deleted" in str(val):
            logger.warning("[qt-lifecycle] sys.excepthook: %s", val)
            return
        # Qt 关闭阶段的大量 harmless 异常，直接跳过
        if isinstance(val, RuntimeError) and "Internal C++ object" in str(val):
            logger.debug("[qt-lifecycle] sys.excepthook (无害): %s", val)
            return
        # 统一日志：所有未捕获异常同时走 logging 和 stderr
        logger.error(
            "[qt-lifecycle] 未捕获异常: %s: %s\n%s",
            typ.__name__,
            val,
            "".join(__import__("traceback").format_tb(tb)).rstrip(),
        )
        _orig_excepthook(typ, val, tb)

    sys.excepthook = _safe_excepthook

    # ── 线程异常安全网（Python 3.14 不走 sys.excepthook）──
    import threading as _threading

    _threading.excepthook = _safe_excepthook

    # ── 连接 agentd（已有则复用，没有则启动） ──
    hermes_python = os.path.expanduser("~/.hermes/hermes-agent/venv/bin/python3")
    _agentd_proc = None
    agentd_sock = str(diy_home() / "agentd.sock")

    # 先试试能不能连上已存在的 agentd
    _agentd_alive = False
    if os.path.exists(agentd_sock):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(0.5)
            s.connect(agentd_sock)
            s.close()
            _agentd_alive = True
            logger.info("agentd 已在运行，复用")
        except OSError:
            pass  # socket 残留，需要启动新的

    if not _agentd_alive and os.path.exists(hermes_python):
        srcdir = os.path.dirname(os.path.abspath(__file__))  # diydev/app/
        src_parent = os.path.dirname(os.path.dirname(srcdir))  # src/<zipper>
        env = os.environ.copy()
        env["PYTHONPATH"] = src_parent
        _agentd_proc = subprocess.Popen(
            [hermes_python, "-m", "diy.core._agent_daemon"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        logger.info("agentd 已启动 (pid=%s)", _agentd_proc.pid)
    elif not _agentd_alive:
        logger.warning("找不到 Hermes Python，agentd 未启动")

    # ── ACP Client 不再在启动时创建 —— AgentChatPanel 负责为每个 task 懒启动 ──
    # （参见 _agent_chat.py _ensure_acp_for_task / _lazy_start_acp）

    # Ctrl+C 两次退出（调试模式下 Qt event loop 会吞 SIGINT）
    signal.signal(signal.SIGINT, signal.SIG_DFL)

    try:
        window = MainWindow()
    except ConnectionError as e:
        logger.error("[exit] 单实例检测失败 — %s", e)
        return

    window.show()
    logger.debug("[main] window.show() 完成")

    # Qt event loop = asyncio event loop（QAsyncioEventLoop.run_forever 内部调用 app.exec()）
    loop.run_forever()
    logger.debug("[main] event loop 退出")

    # ── 退出时清理 ──
    if _agentd_proc and _agentd_proc.poll() is None:
        try:
            _agentd_proc.terminate()
            _agentd_proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _agentd_proc.kill()
        logger.info("agentd 已停止")

    # ACP 异步关闭（同步等不到了，子进程随主进程退出）
    logger.info("diy 管控台退出")

    # 强制退出，绕过 Python 的 wait_for_thread_shutdown
    # QtWebEngine 线程不配合退出，Python 会在 finalization 时卡死
    # 导致 app.lock 的 flock 永不释放，新实例无法启动
    logger.info("[exit] event loop 结束，os._exit(0) 强制退出")
    # os._exit 不 flush logging handler，显式 flush
    for h in logger.handlers:
        h.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
