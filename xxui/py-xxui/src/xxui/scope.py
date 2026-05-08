"""ScopeNode — xxui runtime 树节点。

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
from typing import Any, TypeVar

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

    _children 是 xxui 的权威 children 列表。
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
        self._staging_mode: bool = False
        self._staging_children: list[ScopeNode] = []
        # app 引用，cell 执行时用于 push/pop context
        self._app: object | None = None  # BaseApp 实例

    # ── tree ───────────────────────────────────

    @property
    def parent(self) -> ScopeNode | None:
        return self._parent

    def _add_child(self, child: ScopeNode) -> None:
        """添加子节点。staging 模式下进入 _staging_children。"""
        if self._staging_mode:
            self._staging_children.append(child)
        else:
            self._children.append(child)
        child._parent = self
        child._rebuild_ancestor_ids()

    def _remove_child(self, child: ScopeNode) -> None:
        """移除子节点，清除父子关系和祖先集合。"""
        self._children.remove(child)
        child._parent = None
        child._rebuild_ancestor_ids()

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

    def _mount_signal(self, signal: object) -> None:
        """挂载 Signal，设置 owner。"""
        signal.owner = self  # type: ignore[attr-defined]
        self._signals.append(signal)

    def _on_children_replaced(self, children: list[ScopeNode]) -> None:
        """children 被 cell staging 替换后调用。子类（UIComponent）覆写以同步 provider。"""
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
        - staging 模式收集新 children，成功后原子替换，失败保留旧 UI
        - cell 执行期间 self 作为当前 context
        """
        from xxui import signal as signal_mod

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

        # staging：保存旧 children，启用 staging mode
        old_children = list(self._children)
        self._staging_mode = True
        self._staging_children = []
        self._is_dirty = False
        self._is_executing = True
        signal_mod._current_cell_node = self
        signal_mod._rerun_depth += 1

        from xxui.debug import get_debug

        debug = get_debug(self)
        debug.record_rerun()

        try:
            fn(self)  # type: ignore[arg-type]
        except Exception as exc:
            if not initial:
                # rerun 失败：恢复旧 children，记录错误
                debug.record_error(exc)
                self._children = old_children
                for child in self._staging_children:
                    child._parent = None
                self._on_children_replaced(self._children)
            else:
                raise  # 首次执行报错应传播
        else:
            # 成功：旧 children 解除关系，staging children 转为正式
            for child in old_children:
                child._parent = None
            self._children = self._staging_children
            self._on_children_replaced(self._children)
        finally:
            signal_mod._dependency_collector = None
            signal_mod._current_cell_node = None
            signal_mod._rerun_depth -= 1
            self._staging_mode = False
            self._staging_children = []
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

        # 执行完成后若仍 dirty（rerun 中写了依赖的 signal），自动重新入队
        if self._is_dirty and self._cell_fn is not None:
            scheduler = self.get_config("scheduler")
            if scheduler is not None:
                scheduler.enqueue(self._execute_cell)
