"""ScopeNode — diyui runtime 树节点。

负责：
- 父子关系与权威 children 列表
- 配置向上追溯（自己 → 父 → 祖父 → ...）
- 祖先集合 O(1) 查询（子树访问检查）
- Signal 挂载与生命周期
- Cell 依赖追踪与 rerun（staging 原子替换）
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from ._base_app import BaseApp

C = TypeVar("C", bound="ScopeNode")

@dataclass
class ScopeConfig:
    """ScopeNode 的运行时配置。

    所有字段可选；未设置时向上追溯祖先配置。
    """

    mode: str | None = None  # "dev" | "prod"
    scheduler: object | None = None  # Scheduler 实例


class ScopeNode:
    """runtime 树节点。

    _children 是 diyui 的权威 children 列表。
    当节点也是 UI 容器时，provider adapter 负责同步到 provider 原生 children。
    """

    def __init__(self, *, config: ScopeConfig | None = None) -> None:
        self._parent: ScopeNode | None = None
        self._children: list[ScopeNode] = []
        self._config = config
        self._ancestor_ids: set[int] = {id(self)}
        self._signals: list[object] = []  # Signal 实例
        # cell
        self._cell_fn: Callable[[ScopeNode], None] | None = None
        self._dependencies: set[object] = set()  # Signal 实例
        self._is_dirty: bool = False
        self._is_executing: bool = False
        self._is_async_cell: bool = False
        # app 引用，cell 执行时用于 push/pop context
        self._app: BaseApp | None = None

    # ── tree ───────────────────────────────────

    @property
    def parent(self) -> ScopeNode | None:
        return self._parent

    def _add_child(self, child: ScopeNode) -> None:
        """添加子节点。"""
        self._children.append(child)
        child._parent = self
        child._rebuild_ancestor_ids()

    def _remove_child(self, child: ScopeNode) -> None:
        """移除子节点，清除父子关系和祖先集合。"""
        self._children.remove(child)
        child._parent = None
        child._rebuild_ancestor_ids()
        self._on_child_removed(child)

    # ── ancestor ids ───────────────────────────

    def _rebuild_ancestor_ids(self) -> None:
        """重建本节点及所有子孙的 _ancestor_ids。"""
        ids: set[int] = {id(self)}
        node = self._parent
        while node is not None:
            ids.add(id(node))
            node = node._parent
        self._ancestor_ids = ids
        for child in self._children:
            child._rebuild_ancestor_ids()

    # ── config lookup ──────────────────────────

    def get_config(self, key: str) -> Any | None:
        """向上追溯到最近有该配置的祖先。"""
        node: ScopeNode | None = self
        while node is not None:
            if node._config is not None:
                val = getattr(node._config, key, None)
                if val is not None:
                    return val
            node = node._parent
        return None

    # ── signal ─────────────────────────────────

    def signal(self, value: Any) -> Any:
        """创建 Signal 并挂载到当前 ScopeNode。

        延迟 import 避免循环依赖（_signal 模块 import _scope）。
        注意：widget 子类可能用同名属性覆盖此方法（如 Button.signal: Signal[bool]）。
        """
        from ._signal import Signal

        sig: Signal[Any] = Signal(value)
        self._mount_signal(sig)
        return sig

    def _mount_signal(self, signal: object) -> None:
        """挂载 Signal，设置 owner。"""
        signal.owner = self  # type: ignore[attr-defined]
        self._signals.append(signal)

    # ── provider sync hooks ───────────────────

    def _on_child_removed(self, child: ScopeNode) -> None:
        """子类覆写：child 移除时从 provider 删除。"""
        pass

    def _on_children_replaced(self, children: list[ScopeNode]) -> None:
        """子类覆写：children 被全量替换时同步到 provider。

        cell rerun 开始时会清空旧 children 并调用此方法。
        """
        pass

    # ── cell ───────────────────────────────────

    def cell(self: C) -> Callable[[Callable[[C], None]], C]:
        """标记此组件为 cell。返回装饰器。

        cell 函数接收当前 wrapper node 作为参数。
        定义时立即首次执行，之后依赖的 signal 变化时自动 rerun。
        """

        def decorator(fn: Callable[[C], None]) -> C:
            self._cell_fn = fn  # type: ignore[assignment]
            self._execute_cell(initial=True)
            return self

        return decorator

    def _mark_dirty(self) -> None:
        self._is_dirty = True

    def _execute_cell(self, *, initial: bool = False) -> None:
        """执行 cell 函数。

        - 执行期间保留旧依赖（支持 rerun 中写 signal 的 re-enqueue）
        - 执行后 diff 更新依赖：新增订阅，移除过时订阅
        - 清空旧 children → 执行 fn 重建 → children 即时生效
        - 失败时（非 initial）记录错误，保留空 children（旧 children 已解除关系）
        """
        from . import _signal as signal_mod

        fn = self._cell_fn
        if fn is None:
            return

        # 设置依赖收集器（不清旧依赖，执行期间保留）
        deps: set[object] = set()
        signal_mod._dependency_collector = lambda s: deps.add(s)  # type: ignore[assignment]

        # push cell node 为当前 context
        app = self._app
        if app is not None:
            app._push_context(self)  # type: ignore[attr-defined]

        # 清空旧 children
        old_children = list(self._children)
        self._children = []
        self._is_dirty = False
        self._is_executing = True
        signal_mod._current_cell_node = self
        signal_mod._rerun_depth += 1

        # 通知 provider 清空旧 children（cell rerun 开始时清理 UI）
        self._on_children_replaced([])

        from ._debug import get_debug

        debug = get_debug(self)
        debug.record_rerun()

        try:
            fn(self)  # type: ignore[arg-type]
        except Exception as exc:
            if not initial:
                debug.record_error(exc)
            else:
                raise  # 首次执行报错应传播
        finally:
            # 旧 children 解除关系
            for child in old_children:
                child._parent = None

            signal_mod._dependency_collector = None
            signal_mod._current_cell_node = None
            signal_mod._rerun_depth -= 1
            self._is_executing = False
            if app is not None:
                app._pop_context()  # type: ignore[attr-defined]
            # diff 更新依赖：新增订阅，移除过时订阅
            old_deps = self._dependencies
            for sig in old_deps - deps:
                sig._unsubscribe_cell(self)  # type: ignore[attr-defined]
            for sig in deps - old_deps:
                sig._subscribe_cell(self)  # type: ignore[attr-defined]
            self._dependencies = deps

            # auto-reset：cell 执行完成后，将标记 _reset_on_complete 的 signal 重置为默认值
            # 用于 Button 等"点击后生效一次"的组件：点击 → True → cell rerun → 恢复 False
            for sig in deps:
                if getattr(sig, "_reset_on_complete", False):
                    sig._reset_value(False)  # type: ignore[attr-defined]

        # 执行完成后若仍 dirty（rerun 中写了依赖的 signal），自动重新入队
        if self._is_dirty and self._cell_fn is not None:
            scheduler = self.get_config("scheduler")
            if scheduler is not None:
                scheduler.enqueue(self._execute_cell)
