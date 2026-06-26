"""测试 task_tree 数据层 — 纯 Python，无需 Qt。"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from diy.app.task_tree import (
    TaskNode,
    _build_hierarchy,
    _parse_md_tree,
    load_task_tree,
    merge_state_data,
    parse_agents_md_tree,
)


# ═══════════════════════════════════════════════════════
# parse_agents_md_tree
# ═══════════════════════════════════════════════════════

def test_parse_md_tree_empty():
    nodes = _parse_md_tree("")
    assert nodes == []


def test_parse_md_tree_single_task():
    md = "[#42] 测试任务 ⏳ (OPEN)"
    nodes = _parse_md_tree(md)
    assert len(nodes) == 1
    assert nodes[0].uri == "local/task/42"
    assert nodes[0].state == "active"  # OPEN → active
    assert nodes[0].title == "测试任务"


def test_parse_md_tree_hierarchy():
    md = """[#58] Epic: dev架构更新 🔄 (OPEN)
    ├── [#73] dai state ✅ done (CLOSED)
    ├── [#65] --all 层级感知 ⏳ (OPEN)
    └── [#77] vscode CLI ❌ (CANCELLED)"""

    nodes = _parse_md_tree(md)
    assert len(nodes) == 1  # 根只有一个 #58
    root = nodes[0]
    assert root.uri == "local/task/58"
    assert root.state == "active"

    assert len(root.children) == 3
    assert root.children[0].uri == "local/task/73"
    assert root.children[0].state == "done"
    assert root.children[1].uri == "local/task/65"
    assert root.children[1].state == "active"
    assert root.children[2].uri == "local/task/77"
    assert root.children[2].state == "cancelled"


def test_parse_md_tree_done():
    md = "[#73] dai state ✅ done (CLOSED)"
    nodes = _parse_md_tree(md)
    assert nodes[0].state == "done"


def test_parse_md_tree_blocked():
    md = "[#99] 被阻塞的任务 🚫 (BLOCKED)"
    nodes = _parse_md_tree(md)
    assert nodes[0].state == "blocked"


# ═══════════════════════════════════════════════════════
# parse json block
# ═══════════════════════════════════════════════════════

_JSON_BLOCK = """<!-- diy:tree:begin -->
```json
{
  "tasks": [
    {"uri": "local/task/58", "title": "Epic: dev", "state": "active", "children": [73, 65]},
    {"uri": "local/task/73", "title": "dai state", "state": "done", "parent": "local/task/58"},
    {"uri": "local/task/65", "title": "--all", "state": "pending", "parent": "local/task/58"}
  ],
  "locks": {}
}
```
<!-- diy:tree:end -->"""


def test_parse_json_block():
    nodes = parse_agents_md_tree(None)  # uses real AGENTS.md
    # 如果真实文件存在，至少能解析到东西
    agents_path = os.path.expanduser("~/git/diy/_diy-work/AGENTS.md")
    if os.path.isfile(agents_path):
        assert len(nodes) > 0

    # 用临时文件测试 json block
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write(_JSON_BLOCK)
        tmp = f.name

    try:
        nodes = parse_agents_md_tree(tmp)
        assert len(nodes) == 1
        root = nodes[0]
        assert root.uri == "local/task/58"
        assert root.state == "active"
        assert len(root.children) == 2
    finally:
        os.unlink(tmp)


# ═══════════════════════════════════════════════════════
# merge_state_data
# ═══════════════════════════════════════════════════════

def test_merge_state_data():
    nodes = [
        TaskNode(key="local/task/58", uri="local/task/58", kind="task", state="pending", title=""),
    ]
    state = {
        "tasks": {
            "local/task/58": {"title": "Epic: dev", "state": "active", "subject": "~/git/diy/_diy"},
        }
    }
    merged = merge_state_data(nodes, state)
    assert merged[0].title == "Epic: dev"
    assert merged[0].state == "active"
    assert merged[0].subject_path == "~/git/diy/_diy"


def test_merge_adds_new_tasks():
    nodes: list[TaskNode] = []
    state = {
        "tasks": {
            "local/task/58": {"title": "Epic", "state": "active", "subject": ""},
            "local/task/99": {"title": "New", "state": "pending", "subject": ""},
        }
    }
    merged = merge_state_data(nodes, state)
    assert len(merged) == 2


# ═══════════════════════════════════════════════════════
# build_hierarchy
# ═══════════════════════════════════════════════════════

def test_build_hierarchy_by_depth():
    nodes = [
        TaskNode(key="local/task/1", uri="local/task/1", depth=0),
        TaskNode(key="local/task/2", uri="local/task/2", depth=1),
        TaskNode(key="local/task/3", uri="local/task/3", depth=1),
        TaskNode(key="local/task/4", uri="local/task/4", depth=2),
    ]
    roots = _build_hierarchy(nodes)
    assert len(roots) == 1
    assert roots[0].uri == "local/task/1"
    assert len(roots[0].children) == 2
    assert roots[0].children[1].uri == "local/task/3"
    assert len(roots[0].children[1].children) == 1
    assert roots[0].children[1].children[0].uri == "local/task/4"


def test_load_task_tree():
    """集成测试: 加载真实 ~/.diy/task/ + state.yaml。"""
    nodes = load_task_tree()
    assert len(nodes) > 0
