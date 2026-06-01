"""BaseApp — diyui App 基类。

各 provider App（Panel 等）继承 BaseApp。
提供 with context 管理、app.signal()、上下文栈。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ._scope import ScopeNode

if TYPE_CHECKING:
    from ._signal import Signal


from contextvars import ContextVar, Token


class BaseApp(ScopeNode):
    """App 基类，也是 ScopeNode 树的根节点。

    使用 ContextVar 管理上下文栈，确保异步安全。
    顶部是当前活跃的 ScopeNode。所有组件创建和 signal 挂载都落到 _current。
    """

    def __init__(self) -> None:
        super().__init__()
        self._context_stack_var: ContextVar[tuple[ScopeNode, ...]] = ContextVar(
            f"diyui_context_stack_{id(self)}", default=()
        )
        self._context_stack_var.set((self,))

    # ── context ────────────────────────────────

    @property
    def _current(self) -> ScopeNode:
        stack = self._context_stack_var.get()
        if not stack:
            return self
        return stack[-1]

    def _push_context(self, node: ScopeNode) -> Token[tuple[ScopeNode, ...]]:
        stack = self._context_stack_var.get()
        if not stack:
            stack = (self,)
        return self._context_stack_var.set(stack + (node,))

    def _pop_context(self, token: Token[tuple[ScopeNode, ...]] | None = None) -> None:
        if token is not None:
            self._context_stack_var.reset(token)
        else:
            stack = self._context_stack_var.get()
            if len(stack) <= 1:
                raise IndexError("不能 pop 最后一个 context（app 本身）")
            self._context_stack_var.set(stack[:-1])

    def _add_to_current(self, child: ScopeNode) -> None:
        """将 child 添加到当前 context 节点。

        若当前节点的 auto_mount_child 为 False，仅设置 _app，不挂载。
        auto_mount_child 通过 property 从当前 context 节点向上追溯。
        """
        child._app = self
        if self._current._lookup_auto_mount_child:
            self._current._add_child(child)

    # ── signal ─────────────────────────────────

    def signal[VT](self, value: VT) -> Signal[VT]:
        """创建 Signal 并挂载到当前 ScopeNode。

        委托给 _current 的 ScopeNode.signal()（通过 super 跳过自身 override）。
        """
        # self._current 可能是 self（app 本身），不能直接调 self._current.signal()
        # 因为那会再次进入 BaseApp.signal() 造成无限递归。
        # 走 super() 直接调 ScopeNode.signal()，绕开 BaseApp 的 override。
        node = self._current
        return ScopeNode.signal(node, value)
