"""ScopeProxy / ScopeNode — diy.ui runtime 树节点。

Phase 3: ScopeProxy 自持所有状态和方法，ScopeNode 为薄壳兼容层。
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from ._base_app import BaseApp

from contextlib import contextmanager
from contextvars import ContextVar

from ._signal import ScopeViolationError, Signal, SignalContext

_active_cell_var: ContextVar['ScopeProxy | None'] = ContextVar("diyui_active_cell", default=None)
_deps_var: ContextVar[set[object] | None] = ContextVar("diyui_deps", default=None)


@contextmanager
def no_dep_tracking():
    """暂停响应式依赖追踪。"""
    token = _deps_var.set(None)
    try:
        yield
    finally:
        _deps_var.reset(token)


class CellRuntimeContext(SignalContext):
    def on_signal_read(self, signal: Signal[Any]) -> bool:
        active_cell = _active_cell_var.get()
        deps = _deps_var.get()
        if active_cell is None or deps is None:
            return False
        cross_scope = False
        owner = signal.owner
        if owner is not None and hasattr(owner, '_ancestor_ids'):
            if (id(owner._host) not in active_cell._ancestor_ids
                    and id(active_cell._host) not in owner._ancestor_ids):
                cross_scope = True
                if active_cell._lookup_mode == ScopeMode.DEV:
                    raise ScopeViolationError(
                        f"Cross-scope signal access: cell node {active_cell}"
                        f" not in signal owner {owner}'s subtree"
                    )
        if not cross_scope:
            deps.add(signal)
        return True


_runtime = CellRuntimeContext()
Signal._set_context(_runtime)


class ScopeMode(Enum):
    DEV = "dev"
    PROD = "prod"


class SchedulerProtocol(Protocol):
    def enqueue(self, callback: Callable[[], None]) -> None: ...
    def enqueue_async(self, async_callback: Callable[[], Coroutine[Any, Any, None]]) -> None: ...
    def flush(self) -> None: ...


@dataclass
class ScopeConfig:
    mode: ScopeMode | None = None
    scheduler: SchedulerProtocol | None = None
    auto_mount_child: bool | None = None


class _DiyData:
    """已废弃。保留兼容。"""
    __slots__ = ('signal', 'init_done', 'panel_container')
    def __init__(self):
        self.signal = None; self.init_done = False; self.panel_container = False


# ═══════════════════════════════════════════════════
# ScopeProxy — 自持所有 scope tree 状态和方法
# ═══════════════════════════════════════════════════

class ScopeProxy:
    __slots__ = (
        '_host',
        'signal', 'init_done', 'panel_container',       # _DiyData slots
        '_parent', '_children_v', '_config_v', '_ancestor_ids',  # tree
        '_signals_v', '_cell_fn_v', '_dependencies',               # signal/cell
        '_is_dirty', '_is_executing', '_is_async_cell', '_app_ref',
    )

    def __init__(self, host: object, *, config: ScopeConfig | None = None):
        self._host = host
        self.signal: Signal[Any] | None = None
        self.init_done = False
        self.panel_container = False
        self._parent: ScopeProxy | None = None
        self._children_v: list[ScopeProxy] = []
        self._config_v: ScopeConfig | None = config
        self._ancestor_ids: set[int] = {id(self)}
        self._signals_v: list[object] = []
        self._cell_fn_v: Callable[..., object] | None = None
        self._dependencies: set[object] = set()
        self._is_dirty = False
        self._is_executing = False
        self._is_async_cell = False
        self._app_ref: 'BaseApp | None' = None

    # ═══ app ═══
    @property
    def _app(self): return self._app_ref
    @_app.setter
    def _app(self, v): self._app_ref = v

    # ═══ tree ═══
    @property
    def parent(self) -> 'ScopeProxy | None': return self._parent

    @property
    def _children(self) -> 'list[ScopeProxy]': return self._children_v

    def _add_child(self, child: 'ScopeProxy'):
        self._children_v.append(child); child._parent = self; child._rebuild_ancestor_ids()

    def _remove_child(self, child: 'ScopeProxy'):
        self._children_v.remove(child); child._parent = None
        child._rebuild_ancestor_ids(); self._on_child_removed(child)

    def _rebuild_ancestor_ids(self):
        ids: set[int] = {id(self._host)}
        node = self._parent
        while node is not None: ids.add(id(node._host)); node = node._parent
        self._ancestor_ids = ids
        for c in self._children_v: c._rebuild_ancestor_ids()

    # ═══ config ═══
    @property
    def _config(self) -> ScopeConfig | None: return self._config_v
    @_config.setter
    def _config(self, v): self._config_v = v

    @property
    def _lookup_mode(self) -> ScopeMode:
        node: ScopeProxy | None = self
        while node is not None:
            if node._config_v and node._config_v.mode is not None:
                return node._config_v.mode
            node = node._parent
        return ScopeMode.PROD

    @property
    def _lookup_scheduler(self) -> SchedulerProtocol | None:
        node: ScopeProxy | None = self
        while node is not None:
            if node._config_v and node._config_v.scheduler is not None:
                return node._config_v.scheduler
            node = node._parent
        return None

    @property
    def _lookup_auto_mount_child(self) -> bool:
        node: ScopeProxy | None = self
        while node is not None:
            if node._config_v and node._config_v.auto_mount_child is not None:
                return node._config_v.auto_mount_child
            node = node._parent
        return True

    # ═══ signal ═══
    @property
    def _signals(self) -> list[object]: return self._signals_v

    def create_signal(self, value):
        from ._signal import Signal as _Sig
        sig = _Sig(value); self._mount_signal(sig); return sig

    def _mount_signal(self, sig):
        sig.owner = self; self._signals_v.append(sig)  # type: ignore[attr-defined]

    # ═══ cell ═══
    @property
    def _cell_fn(self) -> Callable[..., object] | None: return self._cell_fn_v
    @_cell_fn.setter
    def _cell_fn(self, v): self._cell_fn_v = v

    def _on_child_removed(self, child: 'ScopeProxy'): pass
    def _on_children_replaced(self, children: 'list[ScopeProxy]'): pass

    def cell(self, fn=None):
        """标记宿主为 cell。用作 @di.cell() 装饰器。"""
        import inspect
        if fn is None:
            # @di.cell() 用法
            def decorator(_fn):
                return self._cell_impl(_fn)
            return decorator
        # @di.cell 用法
        return self._cell_impl(fn)

    def _cell_impl(self, fn):
        import inspect
        self._cell_fn_v = fn
        if inspect.isgeneratorfunction(fn) or inspect.isasyncgenfunction(fn):
            self._is_async_cell = True; self._execute_cell_generator(initial=True)
        else:
            self._execute_cell(initial=True)
        return self._host

    def _mark_dirty(self): self._is_dirty = True

    def _execute_cell(self, *, initial=False):
        if self._is_executing: return
        fn = self._cell_fn_v
        if fn is None: return
        deps: set[object] = set()
        app = self._app_ref
        token_app = app._push_context(self) if app else None  # type: ignore[attr-defined]
        old = list(self._children_v)
        self._children_v = []
        self._is_dirty = False; self._is_executing = True
        tok_a = _active_cell_var.set(self)
        tok_d = _deps_var.set(deps)
        tok_s = Signal._set_context(_runtime)
        self._on_children_replaced([])
        from ._debug import get_debug
        dbg = get_debug(self._host)
        dbg.record_rerun()
        try:
            fn(self._host)
        except Exception as exc:
            if not initial: dbg.record_error(exc)
            else: raise
        finally:
            for c in old: c._parent = None
            _active_cell_var.reset(tok_a); _deps_var.reset(tok_d)
            Signal._context_var.reset(tok_s)
            self._is_executing = False
            if app: app._pop_context(token_app)  # type: ignore[attr-defined]
            self._flush_deps_and_reset(deps)
        if self._is_dirty and self._cell_fn_v and self._lookup_scheduler:
            self._lookup_scheduler.enqueue(self._execute_cell)

    def _execute_cell_generator(self, *, initial=False):
        import inspect
        fn = self._cell_fn_v
        if fn is None: return
        if inspect.isasyncgenfunction(fn):
            if self._lookup_scheduler and hasattr(self._lookup_scheduler, "enqueue_async"):
                self._lookup_scheduler.enqueue_async(lambda: self._drive_generator_async(initial=initial))
            else:
                self._drive_generator_sync(fn, initial=initial)
        else:
            self._drive_generator_sync(fn, initial=initial)

    def _drive_generator_sync(self, fn, *, initial):
        if self._is_executing: return
        import inspect as _inspect
        saved = self._config_v
        self._config_v = ScopeConfig(mode=self._lookup_mode, scheduler=self._lookup_scheduler, auto_mount_child=False)
        gen = fn(self._host); deps: set[object] = set()
        app = self._app_ref
        token_app = app._push_context(self) if app else None  # type: ignore[attr-defined]
        old = list(self._children_v); self._children_v = []
        self._is_dirty = False; self._is_executing = True
        tok_a = _active_cell_var.set(self); tok_d = _deps_var.set(deps)
        tok_s = Signal._set_context(_runtime)
        self._on_children_replaced([])
        from ._debug import get_debug
        dbg = get_debug(self._host); dbg.record_rerun()
        try:
            while True:
                try: yielded = gen.send(None)
                except StopIteration: break
                if yielded is None: break
                if hasattr(yielded, 'diy'): self._add_child(yielded.diy)
                elif _inspect.isawaitable(yielded):
                    import warnings
                    warnings.warn("Generator cell yielded awaitable in sync path.", RuntimeWarning, stacklevel=2)
        except Exception as exc:
            if not initial: dbg.record_error(exc)
            else: raise
        finally:
            if saved is not None: self._config_v = saved
            for c in old: c._parent = None
            _active_cell_var.reset(tok_a); _deps_var.reset(tok_d)
            Signal._context_var.reset(tok_s); self._is_executing = False
            if app: app._pop_context(token_app)  # type: ignore[attr-defined]
            self._flush_deps_and_reset(deps)
        if self._is_dirty and self._cell_fn_v and self._lookup_scheduler:
            self._lookup_scheduler.enqueue(self._execute_cell_generator)

    async def _drive_generator_async(self, *, initial=False):
        if self._is_executing: return
        import inspect as _inspect
        fn = self._cell_fn_v
        if fn is None: return
        saved = self._config_v
        self._config_v = ScopeConfig(mode=self._lookup_mode, scheduler=self._lookup_scheduler, auto_mount_child=False)
        gen = fn(self._host); deps: set[object] = set()
        app = self._app_ref
        token_app = app._push_context(self) if app else None  # type: ignore[attr-defined]
        old = list(self._children_v); self._children_v = []
        self._is_dirty = False; self._is_executing = True
        tok_a = _active_cell_var.set(self); tok_d = _deps_var.set(deps)
        tok_s = Signal._set_context(_runtime)
        self._on_children_replaced([])
        from ._debug import get_debug
        dbg = get_debug(self._host); dbg.record_rerun()
        is_async_gen = _inspect.isasyncgen(gen)
        try:
            result = None
            while True:
                try:
                    yielded = (await gen.asend(result)) if is_async_gen else gen.send(result)
                except (StopIteration, StopAsyncIteration): break
                if yielded is None: break
                if hasattr(yielded, 'diy'): self._add_child(yielded.diy); result = None
                elif _inspect.isawaitable(yielded): result = await yielded
                else: result = None
        except Exception as exc:
            if not initial: dbg.record_error(exc)
            else: raise
        finally:
            if saved is not None: self._config_v = saved
            for c in old: c._parent = None
            _active_cell_var.reset(tok_a); _deps_var.reset(tok_d)
            Signal._context_var.reset(tok_s); self._is_executing = False
            if app: app._pop_context(token_app)  # type: ignore[attr-defined]
            self._flush_deps_and_reset(deps)
        if self._is_dirty and self._cell_fn_v and self._lookup_scheduler:
            self._lookup_scheduler.enqueue(self._execute_cell_generator)

    def on_signal_changed(self, signal):
        self._mark_dirty()
        if self._is_executing: return
        if self._lookup_scheduler:
            if self._is_async_cell: self._lookup_scheduler.enqueue(self._execute_cell_generator)
            else: self._lookup_scheduler.enqueue(self._execute_cell)

    def _flush_deps_and_reset(self, deps):
        old_deps = self._dependencies
        for sig in old_deps - deps: sig.remove_system_observer(self)  # type: ignore[attr-defined]
        for sig in deps - old_deps: sig.add_system_observer(self)  # type: ignore[attr-defined]
        self._dependencies = deps
        for sig in deps: sig.add_system_observer(self)  # type: ignore[attr-defined]


# ═══════════════════════════════════════════════════
# ScopeNode — 薄兼容壳
# ═══════════════════════════════════════════════════

class ScopeNode:
    """薄兼容层。全委托给 self.diy (ScopeProxy)。"""

    def __init__(self, *, config: ScopeConfig | None = None):
        self.__diy = ScopeProxy(self, config=config)

    @property
    def diy(self) -> ScopeProxy: return self.__diy

    # ── 全委托 ──
    @property
    def _app(self): return self.diy._app
    @_app.setter
    def _app(self, v): self.diy._app = v

    @property
    def parent(self) -> 'ScopeNode | None':
        p = self.diy.parent; return p._host if p else None  # type: ignore[return-value]

    @property
    def _children(self) -> 'list[ScopeNode]':
        return [c._host for c in self.diy._children]  # type: ignore[return-value]

    @property
    def _config(self): return self.diy._config
    @_config.setter
    def _config(self, v): self.diy._config = v

    def _add_child(self, child: 'ScopeNode'): self.diy._add_child(child.diy)
    def _remove_child(self, child: 'ScopeNode'): self.diy._remove_child(child.diy)

    @property
    def _ancestor_ids(self) -> set[int]:
        return self.diy._ancestor_ids
    @property
    def _lookup_mode(self): return self.diy._lookup_mode
    @property
    def _lookup_scheduler(self): return self.diy._lookup_scheduler
    @property
    def _lookup_auto_mount_child(self): return self.diy._lookup_auto_mount_child
    @property
    def _signals(self): return self.diy._signals

    def signal(self, value): return self.diy.create_signal(value)
    def _mount_signal(self, sig): self.diy._mount_signal(sig)

    @property
    def _cell_fn(self): return self.diy._cell_fn
    @_cell_fn.setter
    def _cell_fn(self, v): self.diy._cell_fn = v

    def cell(self, fn=None): return self.diy.cell(fn)
    def _mark_dirty(self): self.diy._mark_dirty()
    def _execute_cell(self, *, initial=False): self.diy._execute_cell(initial=initial)
    def _execute_cell_generator(self, *, initial=False): self.diy._execute_cell_generator(initial=initial)
    def _on_child_removed(self, child): self.diy._on_child_removed(child.diy)
    def _on_children_replaced(self, children): self.diy._on_children_replaced([c.diy for c in children])
