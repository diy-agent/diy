"""任务树数据解析 — 纯 Python，无 Qt 依赖。

数据流: ~/.diy/star/ symlink → TaskNode 树
默认只显示 starred 任务。tree 加任务用 `dai task create --subject <path>`。
AGENTS.md 是渲染输出，不解析。
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

from diy.core._state import list_starred, list_tasks, load_state


@dataclass
class AgentInfo:
    agent_id: str
    state: str = "unknown"
    pid: int | None = None


@dataclass
class TaskNode:
    key: str
    label: str = ""
    kind: str = "subject"
    depth: int = 0
    uri: str = ""  # 任务 URI，如 local/task/23
    title: str = ""
    state: str = "pending"
    detail: str = ""
    body: str = ""  # markdown body（设计文档等）
    parent_uri: str | None = None  # 父任务 URI
    subject_path: str = ""
    created: str = ""  # 创建时间 ISO 8601
    updated: str = ""  # 最后更新时间 ISO 8601
    source: dict = field(default_factory=dict)
    agents: list[AgentInfo] = field(default_factory=list)
    children: list[TaskNode] = field(default_factory=list)

    @property
    def is_task(self) -> bool:
        return self.kind in ("task", "epic")

    @property
    def state_icon(self) -> str:
        icons = {
            "pending": "⏳",
            "active": "🔄",
            "open": "🔄",
            "done": "✅",
            "closed": "✅",
            "cancelled": "❌",
            "blocked": "🚫",
            "shelved": "⏸",
            "new": "🆕",
        }
        return icons.get(self.state, "⏳")


# ═══════════════════════════════════════════════════════
# 公共入口
# ═══════════════════════════════════════════════════════


def load_task_tree(
    agents_path: str | None = None, all_tasks: bool = False
) -> list[TaskNode]:
    """加载任务树 — star/ symlink 目录 + state.yaml subjects 驱动。

    默认只加载 starred 任务。all_tasks=True 加载全部任务。

    subject 字段决定任务挂载位置。parent 字段决定层级。
    """
    state_data = load_state()
    tasks_data = list_tasks() if all_tasks else list_starred()
    return _build_nodes_from_state(state_data, tasks_data)


# ═══════════════════════════════════════════════════════
# state.yaml + tasks → nodes
# ═══════════════════════════════════════════════════════


def _build_nodes_from_state(state_data: dict, tasks: dict[str, dict]) -> list[TaskNode]:
    subjects = state_data.get("subjects", {})

    # ── subject 节点：按路径层级嵌套 ──
    subject_nodes: dict[str, TaskNode] = {}
    for spath, info in sorted(subjects.items()):
        node = TaskNode(
            key=spath,
            kind="subject",
            title=info.get("description", ""),
        )
        subject_nodes[spath] = node

    # 找到每个 subject 的最邻近父 subject，计算相对显示名
    roots: list[TaskNode] = []
    for spath, node in sorted(subject_nodes.items()):
        parent = _find_parent_subject(spath, subject_nodes)
        if parent:
            parent.children.append(node)
            # 相对父 subject 的路径
            node.label = os.path.relpath(spath, parent.key)
        else:
            roots.append(node)
            node.label = spath  # 根 subject 保留全路径

    # ── task 节点 ──
    task_nodes: dict[str, TaskNode] = {}
    for uri, info in sorted(tasks.items()):
        tn = TaskNode(
            key=uri,
            kind="task",
            uri=uri,
            title=info.get("title", ""),
            detail=info.get("detail", ""),
            body=info.get("body", ""),
            state=info.get("state", "pending"),
            subject_path=info.get("subject", ""),
            parent_uri=info.get("parent"),
            created=info.get("created", ""),
            updated=info.get("updated", ""),
            source=info.get("source", {}),
        )
        task_nodes[uri] = tn

    # 第二遍：按 parent 建立层级
    for _uri, tn in task_nodes.items():
        parent_uri = tn.parent_uri
        if parent_uri and parent_uri in task_nodes:
            task_nodes[parent_uri].children.append(tn)
        elif tn.subject_path:
            # 挂在 subject 下
            parent = subject_nodes.get(tn.subject_path)
            if parent:
                parent.children.append(tn)
            else:
                roots.append(tn)
        else:
            roots.append(tn)

    return roots


def _find_parent_subject(
    spath: str, subject_nodes: dict[str, TaskNode]
) -> TaskNode | None:
    """找最邻近的父 subject。例如 ~/git/diy/_diy → ~/git。"""
    parent_path = os.path.dirname(spath)
    while parent_path and parent_path != "/" and parent_path != spath:
        if parent_path in subject_nodes:
            return subject_nodes[parent_path]
        parent_path = os.path.dirname(parent_path)
    return None


# ═══════════════════════════════════════════════════════
# 旧解析器（仅测试用 — 不用于主加载路径）
# ═══════════════════════════════════════════════════════


def _find_agents_md() -> str | None:
    local = os.path.join(os.getcwd(), "AGENTS.md")
    if os.path.isfile(local):
        return local
    p = os.path.expanduser("~/git/diy/_diy-work/AGENTS.md")
    return p if os.path.isfile(p) else None


def parse_agents_md_tree(agents_path: str | None = None) -> list[TaskNode]:
    path = agents_path or _find_agents_md()
    if not path or not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as fh:
        content = fh.read()
    nodes = _parse_json_block(content)
    if nodes:
        return nodes
    return _parse_md_tree(content)


def _parse_json_block(content: str) -> list[TaskNode] | None:
    m = re.search(
        r"<!-- diy:tree:begin -->\s*```json\s*\n(.*?)\n```\s*<!-- diy:tree:end -->",
        content,
        re.DOTALL,
    )
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    nodes: list[TaskNode] = []
    for t in data.get("tasks", []):
        uri = t.get("uri", "")
        state = t.get("state", "pending")
        nodes.append(
            TaskNode(
                key=uri,
                kind="task",
                uri=uri,
                title=t.get("title", ""),
                state=state,
                parent_uri=t.get("parent"),
                source=t.get("source", {}),
            )
        )
    return _build_hierarchy(nodes)


def _parse_md_tree(content: str) -> list[TaskNode]:
    nodes: list[TaskNode] = []
    task_re = re.compile(
        r"^(?P<prefix>[\s├└│─]*(?:├── |└── )?)\[#(?P<num>\d+)\]\s+(?P<rest>.*)"
    )
    for line in content.split("\n"):
        m = task_re.match(line)
        if not m:
            continue
        num = int(m.group("num"))
        prefix = m.group("prefix")
        rest = m.group("rest").strip()
        depth = len(prefix) // 4
        state, title = _extract_state(rest)
        uri = f"local/task/{num}"
        nodes.append(
            TaskNode(
                key=uri,
                kind="task",
                depth=depth,
                uri=uri,
                title=title,
                state=state,
            )
        )
    return _build_hierarchy(nodes)


def _extract_state(raw: str) -> tuple[str, str]:
    state_map = {
        "DONE": "done",
        "CLOSED": "done",
        "OPEN": "active",
        "ACTIVE": "active",
        "CANCELLED": "cancelled",
        "BLOCKED": "blocked",
        "SHELVED": "shelved",
        "NEW": "new",
    }
    m = re.search(r"\s*\((?P<kw>[A-Z]+)\)\s*$", raw)
    if m:
        kw = m.group("kw")
        title = raw[: m.start()].strip()
        title = re.sub(r"[\s✅❌🔄⏳🚫⏸🆕]+$", "", title).strip()
        return state_map.get(kw, "pending"), title
    m2 = re.search(
        r"\s+(?P<kw>done|active|open|closed|cancelled|blocked|shelved|pending|new)\s*$",
        raw,
        re.I,
    )
    if m2:
        kw = m2.group("kw").lower()
        state = {"open": "active", "closed": "done"}.get(kw, kw)
        title = raw[: m2.start()].strip()
        title = re.sub(r"[\s✅❌🔄⏳🚫⏸🆕]+$", "", title).strip()
        return state, title
    return "pending", raw.strip()


def _build_hierarchy(nodes: list[TaskNode]) -> list[TaskNode]:
    if not nodes:
        return []
    if any(n.depth > 0 for n in nodes):
        roots: list[TaskNode] = []
        stack: list[TaskNode] = []
        for node in nodes:
            while stack and stack[-1].depth >= node.depth:
                stack.pop()
            if stack:
                stack[-1].children.append(node)
            else:
                roots.append(node)
            stack.append(node)
        return roots
    by_parent: dict[str | None, list[TaskNode]] = {}
    for n in nodes:
        by_parent.setdefault(n.parent_uri, []).append(n)
    roots = by_parent.get(None, [])
    for n in nodes:
        n.children = by_parent.get(n.uri, [])
    return roots


def merge_state_data(
    nodes: list[TaskNode], state_data: dict | None = None
) -> list[TaskNode]:
    if state_data is None:
        state_data = load_state()
    # 优先使用传入的 tasks，没有就实时扫描
    tasks = state_data.get("tasks") or list_tasks()

    task_map: dict[str, TaskNode] = {}

    def _collect(ns):
        for n in ns:
            if n.uri:
                task_map[n.uri] = n
            _collect(n.children)

    _collect(nodes)

    for uri, info in tasks.items():
        if uri in task_map:
            node = task_map[uri]
            node.title = info.get("title", node.title)
            node.state = info.get("state", node.state)
            node.detail = info.get("detail", node.detail)
            node.body = info.get("body", node.body)
            node.subject_path = info.get("subject", "")
            node.parent_uri = info.get("parent")
        else:
            nodes.append(
                TaskNode(
                    key=uri,
                    kind="task",
                    uri=uri,
                    title=info.get("title", ""),
                    state=info.get("state", "pending"),
                    detail=info.get("detail", ""),
                    body=info.get("body", ""),
                    subject_path=info.get("subject", ""),
                    parent_uri=info.get("parent"),
                    source=info.get("source", {}),
                )
            )
    return nodes
