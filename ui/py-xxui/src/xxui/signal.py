"""Signal[T] — xxui 状态原语。

Signal 是独立 runtime primitive，可直接构造，不依赖 App。
UI 响应式 rerun 需用 app.signal() 创建 scope signal。
"""
from __future__ import annotations
from typing import TypeVar, Generic, Callable

T = TypeVar("T")

# 模块级依赖收集器，cell 执行时设置
_dependency_collector: Callable[[Signal[object]], None] | None = None
# 模块级当前 cell node，用于跨 scope 检查
_current_cell_node: object | None = None
# 防止嵌套 rerun 的深度计数
_rerun_depth: int = 0


class ScopeViolationError(Exception):
    """跨 scope 访问 signal 异常。"""
    pass


class Signal(Generic[T]):
    """可观察的单值状态容器。

    读写规则：
    - 读取 .value：若存在依赖收集器（cell 执行上下文），注册依赖。
    - 写入 .value：新旧值相等则跳过；否则通知观察者，触发 cell rerun。
    """

    __slots__ = ("_value", "_observers", "_owner", "_tracker", "_cell_subscribers")

    def __init__(self, value: T) -> None:
        self._value: T = value
        self._observers: list[Callable[[T], None]] = []
        self._owner: object | None = None
        self._tracker: Callable[[Signal[T]], None] | None = None
        self._cell_subscribers: set[object] = set()  # ScopeNode 实例

    # ── value ──────────────────────────────────

    @property
    def value(self) -> T:
        # 跨 scope 检查：signal 的 owner 是否在当前 cell node 的祖先树中
        cross_scope = False
        if _current_cell_node is not None and self._owner is not None:
            owner = self._owner
            if id(owner) not in _current_cell_node._ancestor_ids:  # type: ignore[attr-defined]
                cross_scope = True
                mode = _current_cell_node.get_config("mode")  # type: ignore[attr-defined]
                if mode == "dev":
                    raise ScopeViolationError(
                        f"Cross-scope signal access: cell node not in signal owner's subtree"
                    )
                # prod: warn only, skip dependency
        # 依赖收集（跨 scope 访问不注册依赖）
        if not cross_scope:
            collector = _dependency_collector
            if collector is not None:
                collector(self)  # type: ignore[arg-type]
            elif self._tracker is not None:
                self._tracker(self)
        return self._value

    @value.setter
    def value(self, new: T) -> None:
        if self._value == new:
            return
        self._value = new
        self._notify(new)
        self._trigger_cells()

    # ── owner ──────────────────────────────────

    @property
    def owner(self) -> object | None:
        return self._owner

    @owner.setter
    def owner(self, node: object | None) -> None:
        self._owner = node

    # ── observers ──────────────────────────────

    def on_change(self, callback: Callable[[T], None]) -> Callable[[], None]:
        """注册观察者。返回值是取消订阅函数，重复调用安全。"""
        self._observers.append(callback)

        def unsubscribe() -> None:
            try:
                self._observers.remove(callback)
            except ValueError:
                pass

        return unsubscribe

    # ── cell subscribers ───────────────────────

    def _subscribe_cell(self, cell_node: object) -> None:
        self._cell_subscribers.add(cell_node)

    def _unsubscribe_cell(self, cell_node: object) -> None:
        self._cell_subscribers.discard(cell_node)

    def _trigger_cells(self) -> None:
        """信号变化时，标记所有订阅 cell 为 dirty 并入队 scheduler。
        若 cell 正在执行中，只标记 dirty，等当前执行结束后 flush。
        """
        for cell_node in list(self._cell_subscribers):
            cell_node._mark_dirty()  # type: ignore[attr-defined]
            if cell_node._is_executing:  # type: ignore[attr-defined]
                continue  # 正在执行中，不入队，避免嵌套
            scheduler = cell_node.get_config("scheduler")  # type: ignore[attr-defined]
            if scheduler is not None:
                scheduler.enqueue(lambda cn=cell_node: cn._execute_cell())  # type: ignore[attr-defined]

    # ── internal ───────────────────────────────

    def _notify(self, new_value: T) -> None:
        for cb in self._observers:
            cb(new_value)
