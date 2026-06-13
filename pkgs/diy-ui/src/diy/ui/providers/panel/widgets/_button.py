"""Panel Button — 全部类型注解由 DiyMeta 自动从 Panel param 生成。"""

from __future__ import annotations

import panel as pn

from diy.ui.providers.panel._base import UIComponent
from diy.ui._signal import Signal


class Button(UIComponent, pn.widgets.Button):
    """pn.widgets.Button 的 diy.ui 包装。

    不需要手写 __init__ —
      DiyMeta 从 Panel 的 param descriptors 自动生成带有完整类型注解的构造器。
    pre_init 创建 signal（必须在 Panel.__init__ 之前），
    post_init 挂载事件桥接。
    """

    # 从构造器中排除的 Panel 旧参数
    __exclude_params__ = {"name", "clicks", "button_type", "button_style"}
    # 传给 _diy_pre_init 的参数子集
    __pre_kwargs__ = {"value"}

    # ── 模板方法 ──
    # 注意：_diy_pre_init 注解不影响构造器签名（构造器由 metaclass 生成）

    def _diy_pre_init(self, *, value: bool = False) -> None:
        """在 Panel.__init__ 前执行：创建 signal。

        value property 覆盖后访问 self._signal，所以它必须先存在。
        """
        self._signal = Signal(value)

    def _diy_post_init(self) -> None:
        """在 Panel.__init__ 后执行：挂载 click 事件桥接到 signal。"""
        self._setup_event_bridge()

    # ── 自定义属性 ──

    @property
    def value(self) -> bool:
        """代理到内部 signal，实现响应式更新。"""
        return self._signal.value

    @value.setter
    def value(self, v: bool) -> None:
        self._signal.value = v

    # ── 内部 ──

    def _setup_event_bridge(self) -> None:
        """Panel clicks → Signal emit。"""
        def _on_click(event):
            self._signal.emit()
        self.param.watch(_on_click, "clicks")
