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
import os
import sys

from PySide6.QtCore import QTimer
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QApplication,
    QMenu,
    QStyle,
    QSystemTrayIcon,
)

from diy_llm import auth as llm_auth
from diy_llm import core as llm_core

from .async_utils import init_async, run_async, start_event_loop


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
        self.setIcon(app.style().standardIcon(QStyle.SP_ComputerIcon))
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
        """单个 provider 的异步 sync。

        QtAsyncio 未实现 subprocess_exec，用 asyncio.to_thread
        在线程池跑 subprocess.run，结果回主线程后刷新菜单。
        """
        import subprocess

        def _run():
            return subprocess.run(
                [sys.executable, "-m", "diy_llm.cli", "sync", provider],
                capture_output=True, text=True,
            )

        await asyncio.to_thread(_run)
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
    """入口 — CLI 拉起 GUI 后立即返回，GUI 在后台运行。"""
    import subprocess

    # 如果已传 --daemon 标记，说明是后台进程，直接启动 GUI
    if "--daemon" in sys.argv:
        sys.argv.remove("--daemon")
        _run_gui()
        return

    # 检查是否已有实例在跑
    existing = _find_existing()
    if existing:
        print(f"diy-llm-gui 已在运行 (PID {existing})")
        # 不阻塞，让用户决定是否手动 kill
        return

    # CLI 模式：拉起后台进程后立即返回
    providers = llm_auth.list_providers_with_auth()
    print(f"diy-llm-gui v0.1.0")
    print(f"  provider:  {len(providers)} 个已配置")
    for pname in sorted(providers):
        state = llm_core.load_state(pname)
        if state:
            enabled = sum(1 for m in state.get("models", {}).values()
                          if llm_core._is_enabled(m))
            total = len(state["models"])
            print(f"    {pname}:  {enabled}/{total} 模型")
        else:
            print(f"    {pname}:  未同步")

    subprocess.Popen(
        [sys.executable, "-m", "diy_llm_gui.app", "--daemon"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _find_existing() -> int | None:
    """检查是否已有 diy-llm-gui 实例在运行。"""
    import subprocess
    try:
        result = subprocess.run(
            ["pgrep", "-f", "diy_llm_gui\\.app"],
            capture_output=True, text=True,
        )
        # 排除当前进程
        pids = [int(p) for p in result.stdout.strip().split("\n") if p]
        for pid in pids:
            if pid != os.getpid():
                return pid
    except Exception:
        pass
    return None


def _run_gui():
    """真正启动 GUI 托盘（后台进程入口）。"""
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setApplicationName("diy-llm")

    init_async(app)

    tray = DiyLlmTray(app)
    tray.show()

    start_event_loop()
    sys.exit(0)


if __name__ == "__main__":
    main()
