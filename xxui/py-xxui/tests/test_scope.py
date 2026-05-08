"""ScopeNode API 契约测试。

ScopeNode 是 runtime 树节点，负责：
- 父子关系与 children 管理
- 配置向上追溯
- 祖先集合 O(1) 查询
- Signal 挂载点的生命周期
"""

from xxui.scope import ScopeConfig, ScopeNode

# ═══════════════════════════════════════════════
# 树结构
# ═══════════════════════════════════════════════


class TestScopeNodeTree:
    """ScopeNode 构成一棵树。"""

    def test_node_has_no_parent_by_default(self):
        node = ScopeNode()
        assert node.parent is None

    def test_add_child_establishes_parent_link(self):
        parent = ScopeNode()
        child = ScopeNode()
        parent._add_child(child)
        assert child.parent is parent

    def test_children_list_maintained(self):
        parent = ScopeNode()
        a = ScopeNode()
        b = ScopeNode()
        parent._add_child(a)
        parent._add_child(b)
        assert parent._children == [a, b]

    def test_nesting_three_levels(self):
        root = ScopeNode()
        mid = ScopeNode()
        leaf = ScopeNode()
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
        node = ScopeNode()
        assert id(node) in node._ancestor_ids

    def test_child_ancestor_ids_includes_parent(self):
        parent = ScopeNode()
        child = ScopeNode()
        parent._add_child(child)
        assert id(parent) in child._ancestor_ids

    def test_grandchild_ancestor_ids_includes_all_ancestors(self):
        root = ScopeNode()
        mid = ScopeNode()
        leaf = ScopeNode()
        root._add_child(mid)
        mid._add_child(leaf)
        assert id(root) in leaf._ancestor_ids
        assert id(mid) in leaf._ancestor_ids
        assert id(leaf) in leaf._ancestor_ids

    def test_sibling_not_in_ancestor_ids(self):
        root = ScopeNode()
        a = ScopeNode()
        b = ScopeNode()
        root._add_child(a)
        root._add_child(b)
        assert id(a) not in b._ancestor_ids
        assert id(b) not in a._ancestor_ids

    def test_remove_child_clears_ancestors(self):
        parent = ScopeNode()
        child = ScopeNode()
        parent._add_child(child)
        parent._remove_child(child)
        assert child.parent is None
        assert id(parent) not in child._ancestor_ids


# ═══════════════════════════════════════════════
# 配置向上追溯
# ═══════════════════════════════════════════════


class TestScopeConfigLookup:
    """get_config 向上追溯：自己 → 父 → 祖父 → 默认值。"""

    def test_returns_own_config_if_set(self):
        node = ScopeNode(config=ScopeConfig(mode="dev"))
        assert node.get_config("mode") == "dev"

    def test_falls_back_to_parent(self):
        parent = ScopeNode(config=ScopeConfig(mode="dev"))
        child = ScopeNode()
        parent._add_child(child)
        assert child.get_config("mode") == "dev"

    def test_own_config_overrides_parent(self):
        parent = ScopeNode(config=ScopeConfig(mode="dev"))
        child = ScopeNode(config=ScopeConfig(mode="prod"))
        parent._add_child(child)
        assert child.get_config("mode") == "prod"

    def test_returns_none_when_no_config_in_chain(self):
        node = ScopeNode()
        assert node.get_config("mode") is None

    def test_deep_chain_fallback(self):
        root = ScopeNode(config=ScopeConfig(mode="dev"))
        mid = ScopeNode()
        leaf = ScopeNode(config=ScopeConfig(mode="prod"))
        root._add_child(mid)
        mid._add_child(leaf)
        assert leaf.get_config("mode") == "prod"
        assert mid.get_config("mode") == "dev"

    def test_scheduler_lookup_same_rule(self):
        """scheduler 和其他配置遵循同一向上追溯规则。"""
        parent = ScopeNode(config=ScopeConfig(scheduler="immediate"))
        child = ScopeNode()
        parent._add_child(child)
        assert child.get_config("scheduler") == "immediate"


# ═══════════════════════════════════════════════
# Signal 挂载
# ═══════════════════════════════════════════════


class TestScopeNodeSignal:
    """ScopeNode 是 signal 的 owner，记录挂载的 signal。"""

    def test_mount_signal_sets_owner(self):
        from xxui.signal import Signal

        node = ScopeNode()
        sig = Signal(0)
        node._mount_signal(sig)
        assert sig.owner is node

    def test_mounted_signals_tracked(self):
        from xxui.signal import Signal

        node = ScopeNode()
        a = Signal(1)
        b = Signal(2)
        node._mount_signal(a)
        node._mount_signal(b)
        assert node._signals == [a, b]
