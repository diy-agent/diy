"""app.widgets.xxx() 工厂基类 — 提供运行时 _add 能力。

══════ 设计 A: Signal 外挂，不在 wrapper __init__ 中创建 ══════

问题：wrapper __init__ 中 Panel 父类会读取 self.value（如 Checkbox 读初始值），
      旧设计里 self.diy.signal 已在 init 中创建，触发 on_signal_read →
      deps.add(signal)，将当前执行的 cell 注册为该 widget Signal 的依赖。
      后果：用户改一下输入框 → cell 意外重跑 → state 丢失。

解决：Signal 不放在 __init__ 中，改由工厂 _add() 在挂载 widget 时统一安装。
      此时 wrapper __init__ 中 self.diy.signal 为 None，
      value getter 走 param.__get__ fallback——不经过 Signal 上下文，
      依赖追踪天然不触发。无需 no_dep_tracking 包裹。

不经过工厂直接构造的 widget 没有 Signal，不参与响应式——正确语义。

══════ 设计 B: _add 桥接 Panel param → self.diy.signal ══════

_add 做三件事：
  1. assert comp.diy.signal is None（防止重复安装）
  2. 从 param 读当前值，创建 Signal(value) → comp.diy.signal
  3. 安装 param.watch('value') → comp.diy.signal.value = event.new
     （Panel 交互 → 响应式）
  4. 挂载到当前 context node 树

value setter 只写 param.__set__，不手工写 self.diy.signal：
  widget.value = 5
    → param.__set__(5)         # Panel 保存 + 触发 watch
      → watch: self.diy.signal.value = 5  # Signal 更新 + _notify + _trigger_observers
  ✅ 单向无循环

══════ 组合效果 ══════

  用户交互 → Panel param 更新 → watch → Signal 更新 → cell rerun
  代码设值 → param.__set__     → watch → Signal 更新 → cell rerun
  Panel init → 读 value       → self.diy.signal is None → 无副作用
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from diy.ui._signal import Signal

if TYPE_CHECKING:
    from .._base import UIComponent
    from .._app import PanelApp


class _WidgetsFactoryBase:
    __slots__ = ("_app",)

    def __init__(self, app: "PanelApp") -> None:
        self._app = app

    def _add(self, comp: "UIComponent") -> "UIComponent":
        """挂载 widget 到当前 context，同时安装 Signal + param watch bridge。

        设计 A + B 交汇点：此处是 widget 生命周期中唯一创建 Signal 的位置，
        所有 diy 扩展统一写入 self.diy 命名空间。
        """
        if 'value' in comp.param:
            assert comp.diy.signal is None, (
                f"{type(comp).__name__}.diy.signal 已在 init 中设置，"
                f"但应该由 _add() 统一安装。请删除 init 中的 Signal 创建。"
            )
            comp.diy.signal = Signal(comp.value)
            comp.param.watch(
                lambda event, s=comp: s.diy.signal.__setattr__('value', event.new),
                'value',
            )
        self._app._add_to_current(comp)
        return comp
