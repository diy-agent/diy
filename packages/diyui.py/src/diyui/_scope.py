"""ScopeNode — diyui runtime 树节点。

负责：
- 父子关系与权威 children 列表
- 配置向上追溯（自己 → 父 → 祖父 → ...）
- 祖先集合 O(1) 查询（子树访问检查）
- Signal 挂载与生命周期
- Cell 依赖追踪与 rerun（staging 原子替换）
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from ._base_app import BaseApp

from ._signal import Signal, SignalContext, SignalObserver, ScopeViolationError

from contextvars import ContextVar

_active_cell_var: ContextVar[ScopeNode | None] = ContextVar("diyui_active_cell", default=None)
_deps_var: ContextVar[set[object] | None] = ContextVar("diyui_deps", default=None)


class CellRuntimeContext(SignalContext):
    def on_signal_read(self, signal: Signal[Any]) -> bool:
        active_cell = _active_cell_var.get()
        deps = _deps_var.get()

        if active_cell is None or deps is None:
            return False

        cross_scope = False
        owner = signal.owner
        if owner is not None and isinstance(owner, ScopeNode):
            if (
                id(owner) not in active_cell._ancestor_ids
                and id(active_cell) not in owner._ancestor_ids
            ):
                cross_scope = True
                if active_cell.mode == ScopeMode.DEV:
                    raise ScopeViolationError(
                        f"Cross-scope signal access: cell node {active_cell} not in signal owner {owner}'s subtree"
                    )
        if not cross_scope:
            deps.add(signal)

        return True


_runtime = CellRuntimeContext()
# Signal._context = _runtime  <-- 此处不再直接赋值 ClassVar，而是通过 Signal._set_context()
Signal._set_context(_runtime)


class ScopeMode(Enum):
    """Scope 运行模式。"""

    DEV = "dev"
    PROD = "prod"


class SchedulerProtocol(Protocol):
    """Scheduler 需实现的接口。"""

    def enqueue(self, callback: Callable[[], None]) -> None: ...
    def enqueue_async(
        self, async_callback: Callable[[], Coroutine[Any, Any, None]]
    ) -> None: ...
    def flush(self) -> None: ...


@dataclass
class ScopeConfig:
    """ScopeNode 的运行时配置。

    所有字段可选；None 表示未设置，向上追溯祖先配置。
    子节点配置优先级高于祖先。
    """

    mode: ScopeMode | None = None
    scheduler: SchedulerProtocol | None = None
    auto_mount_child: bool | None = None  # 子组件创建时是否自动挂载到本节点，默认 True


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

    @property
    def mode(self) -> ScopeMode:
        """向上追溯 mode，默认 PROD。"""
        node: ScopeNode | None = self
        while node is not None:
            if node._config is not None and node._config.mode is not None:
                return node._config.mode
            node = node._parent
        return ScopeMode.PROD

    @property
    def scheduler(self) -> SchedulerProtocol | None:
        """向上追溯 scheduler。"""
        node: ScopeNode | None = self
        while node is not None:
            if node._config is not None and node._config.scheduler is not None:
                return node._config.scheduler
            node = node._parent
        return None

    @property
    def auto_mount_child(self) -> bool:
        """向上追溯 auto_mount_child，默认 True。"""
        node: ScopeNode | None = self
        while node is not None:
            if node._config is not None and node._config.auto_mount_child is not None:
                return node._config.auto_mount_child
            node = node._parent
        return True

    # ── signal ─────────────────────────────────

    def signal[VT](self, value: VT) -> Signal[VT]:
        """创建 Signal 并挂载到当前 ScopeNode。

        延迟 import 避免循环依赖（_signal 模块 import _scope）。
        注意：widget 子类可能用同名属性覆盖此方法（如 Button.signal: Signal[bool]）。
        """
        from ._signal import Signal

        sig: Signal[VT] = Signal(value)
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

    def cell[T: ScopeNode](self: T) -> Callable[[Callable[..., object]], T]:
        """标记此组件为 cell。返回装饰器。

        cell 函数接收当前 wrapper node 作为参数。
        定义时立即首次执行，之后依赖的 signal 变化时自动 rerun。

        支持普通函数（同步 cell）和生成器函数（generator cell）。
        """
        import inspect

        def decorator(fn: Callable[..., object]) -> T:
            self._cell_fn = fn  # type: ignore[assignment]
            if inspect.isgeneratorfunction(fn) or inspect.isasyncgenfunction(fn):
                self._is_async_cell = True
                self._execute_cell_generator(initial=True)
            else:
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
        if self._is_executing:
            return

        fn = self._cell_fn
        if fn is None:
            return

        # 设置依赖收集器（不清旧依赖，执行期间保留）
        deps: set[object] = set()

        # push cell node 为当前 context
        app = self._app
        token_app = None
        if app is not None:
            token_app = app._push_context(self)  # type: ignore[attr-defined]

        # 清空旧 children
        old_children = list(self._children)
        self._children = []
        self._is_dirty = False
        self._is_executing = True
        
        token_active = _active_cell_var.set(self)
        token_deps = _deps_var.set(deps)
        token_sig_ctx = Signal._set_context(_runtime)

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

            _active_cell_var.reset(token_active)
            _deps_var.reset(token_deps)
            Signal._context_var.reset(token_sig_ctx)
            self._is_executing = False
            if app is not None:
                app._pop_context(token_app)  # type: ignore[attr-defined]
            self._flush_deps_and_reset(deps)

        # 执行完成后若仍 dirty（rerun 中写了依赖的 signal），自动重新入队
        if self._is_dirty and self._cell_fn is not None and self.scheduler is not None:
            self.scheduler.enqueue(self._execute_cell)

    def _execute_cell_generator(self, *, initial: bool = False) -> None:
        """驱动生成器 cell（同步入口，内部调度 async 驱动）。

        yield ScopeNode → 挂载为子节点。
        yield awaitable → await 后结果传回生成器。
        rerun 时重新创建生成器实例，旧 children 被清空重建。
        """
        import inspect

        fn = self._cell_fn
        if fn is None:
            return

        # 检测是否需要 async 路径：仅 async generator function 需要
        is_async = inspect.isasyncgenfunction(fn)

        if is_async:
            # 有 awaitable：走 async 路径，通过 scheduler enqueue_async 调度
            if self.scheduler is not None and hasattr(self.scheduler, "enqueue_async"):
                self.scheduler.enqueue_async(
                    lambda: self._drive_generator_async(initial=initial)
                )
            else:
                # 无 async scheduler 回退：同步驱动（遇到 awaitable 会报错）
                self._drive_generator_sync(fn, initial=initial)
        else:
            # 纯同步：直接驱动
            self._drive_generator_sync(fn, initial=initial)

    def _drive_generator_sync(
        self,
        fn: Callable[[ScopeNode], Any],
        *,
        initial: bool,
    ) -> None:
        """同步驱动生成器（无 awaitable）。"""
        if self._is_executing:
            return

        import inspect as _inspect

        # 临时设置 auto_mount_child=False，让工厂函数只创建不挂载
        saved_config = self._config
        self._config = ScopeConfig(
            mode=self.mode,
            scheduler=self.scheduler,
            auto_mount_child=False,
        )

        gen = fn(self)  # type: ignore[arg-type]
        deps: set[object] = set()

        app = self._app
        token_app = None
        if app is not None:
            token_app = app._push_context(self)  # type: ignore[attr-defined]

        old_children = list(self._children)
        self._children = []
        self._is_dirty = False
        self._is_executing = True
        
        token_active = _active_cell_var.set(self)
        token_deps = _deps_var.set(deps)
        token_sig_ctx = Signal._set_context(_runtime)

        self._on_children_replaced([])

        from ._debug import get_debug

        debug = get_debug(self)
        debug.record_rerun()

        try:
            while True:
                try:
                    yielded = gen.send(None)  # type: ignore[arg-type]
                except StopIteration:
                    break

                if yielded is None:
                    break

                if isinstance(yielded, ScopeNode):
                    self._add_child(yielded)
                elif _inspect.isawaitable(yielded):
                    import warnings

                    warnings.warn(
                        "Generator cell yielded awaitable in sync path. "
                        "Use async def for async generator cells.",
                        RuntimeWarning,
                        stacklevel=2,
                    )
        except Exception as exc:
            if not initial:
                debug.record_error(exc)
            else:
                raise
        finally:
            if saved_config is not None:
                self._config = saved_config

            for child in old_children:
                child._parent = None

            _active_cell_var.reset(token_active)
            _deps_var.reset(token_deps)
            Signal._context_var.reset(token_sig_ctx)
            self._is_executing = False
            if app is not None:
                app._pop_context(token_app)  # type: ignore[attr-defined]

            self._flush_deps_and_reset(deps)

        if self._is_dirty and self._cell_fn is not None and self.scheduler is not None:
            self.scheduler.enqueue(self._execute_cell_generator)

    async def _drive_generator_async(self, *, initial: bool = False) -> None:
        """异步驱动生成器（支持 yield awaitable 和 async def generator）。"""
        if self._is_executing:
            return

        import inspect as _inspect

        fn = self._cell_fn
        if fn is None:
            return

        # 临时设置 auto_mount_child=False
        saved_config = self._config
        self._config = ScopeConfig(
            mode=self.mode,
            scheduler=self.scheduler,
            auto_mount_child=False,
        )

        gen = fn(self)  # type: ignore[arg-type]
        deps: set[object] = set()

        app = self._app
        token_app = None
        if app is not None:
            token_app = app._push_context(self)  # type: ignore[attr-defined]

        old_children = list(self._children)
        self._children = []
        self._is_dirty = False
        self._is_executing = True
        
        token_active = _active_cell_var.set(self)
        token_deps = _deps_var.set(deps)
        token_sig_ctx = Signal._set_context(_runtime)

        self._on_children_replaced([])

        from ._debug import get_debug

        debug = get_debug(self)
        debug.record_rerun()

        is_async_gen = _inspect.isasyncgen(gen)

        try:
            result = None
            while True:
                try:
                    if is_async_gen:
                        yielded = await gen.asend(result)  # type: ignore[attr-defined]
                    else:
                        yielded = gen.send(result)  # type: ignore[arg-type]
                except StopIteration:
                    break
                except StopAsyncIteration:
                    break

                if yielded is None:
                    break

                if isinstance(yielded, ScopeNode):
                    self._add_child(yielded)
                    result = None
                elif _inspect.isawaitable(yielded):
                    result = await yielded
                else:
                    result = None
        except Exception as exc:
            if not initial:
                debug.record_error(exc)
            else:
                raise
        finally:
            if saved_config is not None:
                self._config = saved_config

            for child in old_children:
                child._parent = None

            _active_cell_var.reset(token_active)
            _deps_var.reset(token_deps)
            Signal._context_var.reset(token_sig_ctx)
            self._is_executing = False
            if app is not None:
                app._pop_context(token_app)  # type: ignore[arg-type]

            self._flush_deps_and_reset(deps)

        if self._is_dirty and self._cell_fn is not None and self.scheduler is not None:
            self.scheduler.enqueue(self._execute_cell_generator)

    def on_signal_changed(self, signal: Signal[Any]) -> None:
        self._mark_dirty()
        if self._is_executing:
            return
        if self.scheduler is not None:
            if self._is_async_cell:
                self.scheduler.enqueue(self._execute_cell_generator)
            else:
                self.scheduler.enqueue(self._execute_cell)

    def _flush_deps_and_reset(self, deps: set[object]) -> None:
        """diff 更新依赖 + auto-reset。提取为共享逻辑。"""
        old_deps = self._dependencies
        for sig in old_deps - deps:
            sig.remove_system_observer(self)  # type: ignore[attr-defined]
        for sig in deps - old_deps:
            sig.add_system_observer(self)  # type: ignore[attr-defined]
        self._dependencies = deps

        for sig in deps:
            if getattr(sig, "_reset_on_complete", False):
                sig._reset_value(False)  # type: ignore[attr-defined]
