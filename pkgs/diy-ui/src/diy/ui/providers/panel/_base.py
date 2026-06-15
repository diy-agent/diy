"""Panel provider 基础类 — UIComponent 和容器 Mixin。"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

import diy.ui
from diy.ui.providers.panel._meta import DiyInitSub

if TYPE_CHECKING:
    from diy.ui._signal import Signal

C = TypeVar("C", bound="UIComponent")


class UIComponent(diy.ui.ScopeNode, DiyInitSub):
    """provider 原生组件的薄包装。

    diy.ui 组件直接继承 Panel 原生类，self 就是 provider 原生对象。
    diy 命名空间存放 diy 扩展属性（signal/init_done/panel_container）。

    DiyInitSub 使子类自动从 Panel param 提取类型生成 __init__。
    """

    def __init__(self, *, config: diy.ui.ScopeConfig | None = None) -> None:
        super().__init__(config=config)
        self.diy.panel_container = False

    @property
    def signal(self) -> Signal[Any]:
        """返回组件绑定的 Signal 实例。

        仅 value widget 有此属性。layout 容器应使用 app.signal(value) 创建 scope signal。
        """
        sig = self.diy.signal
        if sig is not None:
            return sig  # type: ignore[return-value]
        raise AttributeError(
            f"{type(self).__name__} 没有绑定的 signal。"
            "layout 容器请使用 app.signal(value) 创建 scope signal。"
        )


class _PanelContainerMixin:
    """Panel 容器组件共用的 children 同步逻辑。

    在新继承模型下，self 就是 Panel 容器（pn.Column/Row/Card），
    self.append(child) / self[:] = [...] 直接操作 Panel 原生 children。
    """

    def _add_child(self, child: diy.ui.ScopeNode) -> None:
        """添加子节点，同时同步到 Panel 原生容器。"""
        super(UIComponent, self)._add_child(child)  # type: ignore[arg-type]
        if hasattr(child, "diy"):
            self.append(child)  # type: ignore[attr-defined]

    def _on_child_removed(self, child: diy.ui.ScopeNode) -> None:
        """从 Panel 原生容器中移除 child。"""
        if hasattr(child, "diy") and child in list(self):  # type: ignore[attr-defined]
            self.remove(child)  # type: ignore[attr-defined]

    def _on_children_replaced(self, children: list[diy.ui.ScopeNode]) -> None:
        """全量替换 Panel 原生 children。"""
        self[:] = [c for c in children if hasattr(c, "diy")]  # type: ignore[index]


class _HasValue:
    """Mixin：value getter/setter，优先 Signal，None 时 fallback Panel param。

    所有有 value 的 widget wrapper 继承此类，替代重复的 value property 定义。
    50 个 wrapper 共用此 mixin，减少 ~700 行重复代码。

    用法:
        class Checkbox(UIComponent, _HasValue, pn.widgets.Checkbox):
            def __init__(self, *, value=False, ...):
                ...
    """

    @property
    def value(self) -> Any:
        """value getter：优先 self.diy.signal，None 时 fallback Panel param。"""
        sig = self.diy.signal  # type: ignore[attr-defined]
        return sig.value if sig is not None else self.param['value'].__get__(self)  # type: ignore[attr-defined]

    @value.setter
    def value(self, v: Any) -> None:
        """value setter：只设 param，watch 自动推 Signal。不手工写 Signal。"""
        self.param['value'].__set__(self, v)  # type: ignore[attr-defined]
