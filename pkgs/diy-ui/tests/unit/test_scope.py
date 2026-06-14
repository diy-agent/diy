"""ScopeNode API 契约测试。

ScopeNode 是 runtime 树节点，负责：
- 父子关系与 children 管理
- 配置向上追溯
- 祖先集合 O(1) 查询
- Signal 挂载点的生命周期
"""

import diy.ui

# ═══════════════════════════════════════════════
# 树结构
# ═══════════════════════════════════════════════


class TestScopeNodeTree:
    """ScopeNode 构成一棵树。"""

    def test_node_has_no_parent_by_default(self):
        node = diy.ui.ScopeNode()
        assert node.parent is None

    def test_add_child_establishes_parent_link(self):
        parent = diy.ui.ScopeNode()
        child = diy.ui.ScopeNode()
        parent._add_child(child)
        assert child.parent is parent

    def test_children_list_maintained(self):
        parent = diy.ui.ScopeNode()
        a = diy.ui.ScopeNode()
        b = diy.ui.ScopeNode()
        parent._add_child(a)
        parent._add_child(b)
        assert parent._children == [a, b]

    def test_nesting_three_levels(self):
        root = diy.ui.ScopeNode()
        mid = diy.ui.ScopeNode()
        leaf = diy.ui.ScopeNode()
        root._add_child(mid)
        mid._add_child(leaf)
        assert leaf.parent is mid
        assert mid.parent is root


# ═══════════════════════════════════════════════
# 祖先集合 O(1) 查询
# ═══════════════════════════════════════════════


class TestAncestorIds:
    """_ancestor_ids 支持 O(1) 判断节点是否在子树内。"""

    def test_ancestor_ids_includes_self(self):
        node = diy.ui.ScopeNode()
        assert id(node) in node._ancestor_ids

    def test_child_ancestor_ids_includes_parent(self):
        parent = diy.ui.ScopeNode()
        child = diy.ui.ScopeNode()
        parent._add_child(child)
        assert id(parent) in child._ancestor_ids

    def test_grandchild_ancestor_ids_includes_all_ancestors(self):
        root = diy.ui.ScopeNode()
        mid = diy.ui.ScopeNode()
        leaf = diy.ui.ScopeNode()
        root._add_child(mid)
        mid._add_child(leaf)
        assert id(root) in leaf._ancestor_ids
        assert id(mid) in leaf._ancestor_ids
        assert id(leaf) in leaf._ancestor_ids

    def test_sibling_not_in_ancestor_ids(self):
        root = diy.ui.ScopeNode()
        a = diy.ui.ScopeNode()
        b = diy.ui.ScopeNode()
        root._add_child(a)
        root._add_child(b)
        assert id(a) not in b._ancestor_ids
        assert id(b) not in a._ancestor_ids

    def test_remove_child_clears_ancestors(self):
        parent = diy.ui.ScopeNode()
        child = diy.ui.ScopeNode()
        parent._add_child(child)
        parent._remove_child(child)
        assert child.parent is None
        assert id(parent) not in child._ancestor_ids


# ═══════════════════════════════════════════════
# 配置向上追溯
# ═══════════════════════════════════════════════


class TestScopeConfigLookup:
    """mode/scheduler/auto_mount_child property 向上追溯：自己 → 父 → 祖父 → 默认值。"""

    def test_returns_own_config_if_set(self):
        node = diy.ui.ScopeNode(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV))
        assert node._lookup_mode == diy.ui.ScopeMode.DEV

    def test_falls_back_to_parent(self):
        parent = diy.ui.ScopeNode(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV))
        child = diy.ui.ScopeNode()
        parent._add_child(child)
        assert child._lookup_mode == diy.ui.ScopeMode.DEV

    def test_own_config_overrides_parent(self):
        parent = diy.ui.ScopeNode(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV))
        child = diy.ui.ScopeNode(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.PROD))
        parent._add_child(child)
        assert child._lookup_mode == diy.ui.ScopeMode.PROD

    def test_defaults_to_prod_when_no_config_in_chain(self):
        node = diy.ui.ScopeNode()
        assert node._lookup_mode == diy.ui.ScopeMode.PROD

    def test_deep_chain_fallback(self):
        root = diy.ui.ScopeNode(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV))
        mid = diy.ui.ScopeNode()
        leaf = diy.ui.ScopeNode(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.PROD))
        root._add_child(mid)
        mid._add_child(leaf)
        assert leaf._lookup_mode == diy.ui.ScopeMode.PROD
        assert mid._lookup_mode == diy.ui.ScopeMode.DEV

    def test_scheduler_lookup_same_rule(self):
        """scheduler 和其他属性遵循同一向上追溯规则。"""
        sched = diy.ui.ImmediateScheduler()
        parent = diy.ui.ScopeNode(config=diy.ui.ScopeConfig(scheduler=sched))
        child = diy.ui.ScopeNode()
        parent._add_child(child)
        assert child._lookup_scheduler is sched


# ═══════════════════════════════════════════════
# Signal 挂载
# ═══════════════════════════════════════════════


class TestScopeNodeSignal:
    """ScopeNode 是 signal 的 owner，记录挂载的 signal。"""

    def test_mount_signal_sets_owner(self):
        node = diy.ui.ScopeNode()
        sig = diy.ui.Signal(0)
        node._mount_signal(sig)
        assert sig.owner._host is node

    def test_mounted_signals_tracked(self):
        node = diy.ui.ScopeNode()
        a = diy.ui.Signal(1)
        b = diy.ui.Signal(2)
        node._mount_signal(a)
        node._mount_signal(b)
        assert node._signals == [a, b]
