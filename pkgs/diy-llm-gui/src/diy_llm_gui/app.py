"""diy-llm GUI — PySide6 系统托盘管理程序。

基于 QtAsyncio（PySide6 6.8+ 内置），asyncio 与 Qt 事件循环统一调度。
协程在主线程运行，await 后可直接操作 widget，无需 Signal 中转。

托盘菜单：
  - 模型列表（✓/✗/⚠ 状态）
  - Sync 按钮（异步，不阻塞 UI）
  - Serve 开/关 switch

基于 QtAsyncio（PySide6 6.8+ 内置），asyncio 与 Qt 事件循环统一调度。
"""

from __future__ import annotations

import asyncio
import sys

from PySide6.QtCore import QTimer
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QApplication,
    QMenu,
    QSystemTrayIcon,
)

from diy_llm import auth as llm_auth
from diy_llm import core as llm_core

from diy_llm_gui.async_utils import init_async, run_async, start_event_loop


def _enabled_label(model_id: str, model: dict) -> str:
    """模型状态标签：✓ / ✗ / ⚠。"""
    is_enabled = model.get("editable", {}).get("enabled", model.get("enabled", True))
    status = model.get("status", "ok")
    error_code = (model.get("error") or {}).get("code", "")

    if status != "ok" and error_code == "MODEL_DEPRECATED":
        return f"⚠ {model_id}"
    if is_enabled:
        return f"✓ {model_id}"
    return f"✗ {model_id}"


# ═══════════════════════════════════════════════════════════════════════
# 托盘应用
# ═══════════════════════════════════════════════════════════════════════

class DiyLlmTray(QSystemTrayIcon):
    """diy-llm 系统托盘。"""

    def __init__(self, app: QApplication):
        super().__init__()
        self._app = app
        self._serve_process = None

        # 图标（无图标文件时用系统默认）
        self.setIcon(app.style().standardIcon(app.style().SP_ComputerIcon))
        self.setToolTip("diy-llm")

        # 菜单
        self._menu = QMenu()
        self._build_menu()
        self.setContextMenu(self._menu)

        # 定时刷新
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._build_menu)
        self._timer.start(30_000)  # 30s

    def _build_menu(self):
        """重建托盘菜单。"""
        self._menu.clear()

        # ── 模型列表 ──
        providers_with_auth = llm_auth.list_providers_with_auth()
        if not providers_with_auth:
            no_auth = QAction("(无已配置的 provider)", self._menu)
            no_auth.setEnabled(False)
            self._menu.addAction(no_auth)
        else:
            for pname in sorted(providers_with_auth):
                # provider 标题
                section = QAction(f"── {pname} ──", self._menu)
                section.setEnabled(False)
                self._menu.addAction(section)

                state = llm_core.load_state(pname)
                if not state or not state.get("models"):
                    empty = QAction("  (无模型，请 Sync)", self._menu)
                    empty.setEnabled(False)
                    self._menu.addAction(empty)
                else:
                    for mid, mdata in state.get("models", {}).items():
                        label = _enabled_label(mid, mdata)
                        action = QAction(f"  {label}", self._menu)
                        action.setEnabled(False)
                        self._menu.addAction(action)

        self._menu.addSeparator()

        # ── Sync 按钮 ──
        sync_action = QAction("🔄 Sync", self._menu)
        sync_action.triggered.connect(self._on_sync)
        self._menu.addAction(sync_action)

        self._menu.addSeparator()

        # ── Serve 开关 ──
        if self._serve_process and self._serve_process.poll() is None:
            serve_text = "◼  Stop Serve"
        else:
            serve_text = "▶  Start Serve"
        serve_action = QAction(serve_text, self._menu)
        serve_action.triggered.connect(self._on_toggle_serve)
        self._menu.addAction(serve_action)

        self._menu.addSeparator()

        # ── 退出 ──
        quit_action = QAction("Quit", self._menu)
        quit_action.triggered.connect(self._on_quit)
        self._menu.addAction(quit_action)

    # ── 回调 ──

    def _on_sync(self):
        """异步 sync，不阻塞 UI 菜单。"""
        providers = llm_auth.list_providers_with_auth()
        for pname in sorted(providers):
            run_async(self._sync_one(pname))

    async def _sync_one(self, provider: str):
        """单个 provider 的异步 sync — 用子进程避免阻塞。"""
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "diy_llm.cli", "sync", provider,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        # sync 完成后刷新菜单
        self._build_menu()

    def _on_toggle_serve(self):
        if self._serve_process and self._serve_process.poll() is None:
            self._serve_process.terminate()
            self._serve_process = None
        else:
            import subprocess

            self._serve_process = subprocess.Popen(
                [sys.executable, "-m", "diy_llm.cli", "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        # 刷新开关文本
        self._build_menu()

    def _on_quit(self):
        if self._serve_process:
            self._serve_process.terminate()
            self._serve_process = None
        self._app.quit()


# ═══════════════════════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════════════════════

def main():
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    # PySide6 6.8+ 内置 QtAsyncio — 必须在 QApplication 创建后调用
    init_async(app)

    tray = DiyLlmTray(app)
    tray.show()

    # start_event_loop() 替代 app.exec()
    # asyncio 和 Qt 事件循环在此统一调度
    start_event_loop()
    sys.exit(0)


if __name__ == "__main__":
    main()
