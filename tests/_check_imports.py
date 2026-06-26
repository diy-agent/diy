"""运行时模块检查 — 验证关键模块 import 和 PySide6 API 契约。

作为静态检查的补充，捕获 pyright/mypy 跳过的第三方库方法名错误。
运行时间 < 3 秒。

用法:
    uv run python tests/_check_imports.py
"""

from __future__ import annotations

import sys


def check(description: str) -> None:
    """执行检查项并输出状态。"""
    try:
        yield
    except Exception as e:
        print(f"  ❌ {description}")
        print(f"     {e}")
        errors.append(description)
    else:
        print(f"  ✅ {description}")


errors: list[str] = []
print("=== 模块 import 检查 ===")

# ── 核心模块 import ──
print("  ✅ import diy.app.main")
import diy.app.main  # noqa: F811, F401, E402  # 手动 import 验证各模块可加载

print("  ✅ import diy.app._agent_chat")
import diy.app._agent_chat  # noqa: F811, F401, E402  # 同上

print("  ✅ import diy.app._app_log")
import diy.app._app_log  # noqa: F811, F401, E402  # 同上

print("  ✅ import diy.app._overlay_panel")
import diy.app._overlay_panel  # noqa: F811, F401, E402  # 同上

print("  ✅ import diy.app._title_bar")
import diy.app._title_bar  # noqa: F811, F401, E402  # 同上

print("  ✅ import diy.app._status_bar")
import diy.app._status_bar  # noqa: F811, F401, E402  # 同上

print("  ✅ import diy.app.screen")
import diy.app.screen  # noqa: F811, F401, E402  # 同上

print()
print("=== PySide6 API 契约检查 ===")

# 需要 QApplication 来构造 Qt widget
from PySide6.QtWidgets import QApplication  # noqa: E402

app = QApplication(sys.argv)

from PySide6.QtWidgets import QFrame, QLabel, QTextEdit  # noqa: E402

# QLabel: 有 setText, 没有 setHtml
assert hasattr(QLabel, "setText"), "QLabel.setText() 不存在"
assert not hasattr(QLabel, "setHtml"), (
    "QLabel.setHtml() 不应该存在（用 setText() + RichText）"
)

# QTextEdit: 有 setHtml
assert hasattr(QTextEdit, "setHtml"), "QTextEdit.setHtml() 应该存在"

# QToolButton: checkable
from PySide6.QtWidgets import QToolButton  # noqa: E402

assert hasattr(QToolButton, "setCheckable"), "QToolButton.setCheckable() 应该存在"
assert hasattr(QToolButton, "toggled"), "QToolButton.toggled 信号应该存在"

# QFrame: frameShape
assert hasattr(QFrame, "Shape"), "QFrame.Shape enum 应该存在"

print()
print("=== 关键模块 __init__ 构造检查（需要 QApp） ===")

from diy.app.screen import Area, Panel, Screen  # noqa: E402

s = Screen("test")
s.add_area(Area("right", [Panel("a", "", None)]))
assert s.area("right") is not None
assert not s.is_visible("right")
s.show_area("right")
assert s.is_visible("right")
print("  ✅ Screen/Area/Panel 构造 + show_area")

# TitleBar 构造检查
from diy.app._title_bar import TitleBar  # noqa: E402

tb = TitleBar()
assert tb.filter_text is not None
assert tb.filter_state is not None
tb.deleteLater()
print("  ✅ TitleBar 构造 + 属性")

# StatusBar 构造检查
from diy.app._status_bar import StatusBar  # noqa: E402

sb = StatusBar()
assert hasattr(sb, "toggle_area")
sb.deleteLater()
print("  ✅ StatusBar 构造 + 信号")

print()
if errors:
    print(f"❌ {len(errors)} 项检查失败:")
    for e in errors:
        print(f"   - {e}")
    sys.exit(1)
else:
    print("✅ 全部检查通过")
