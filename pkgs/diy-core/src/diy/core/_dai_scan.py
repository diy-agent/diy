"""dai scan — 项目发现机制（issue #47）。

从当前目录向上扫描 diy.yaml 找到 workspace 根，
再在 workspace 根下递归搜索 .git 目录（maxdepth=3），
列出所有 space。

用法：
    from ._dai_scan import find_workspace_root, find_spaces
"""

from __future__ import annotations

import os


def find_workspace_root(start_dir: str, home: str | None = None) -> str | None:
    """从 start_dir 向上扫描 diy.yaml，到 home 停止。返回最高的 diy.yaml 所在目录。

    扫描策略：
    1. 从 start_dir（绝对路径）开始。
    2. 逐级向父目录检查是否存在 diy.yaml。
    3. 记录所有找到的目录，取最高（最靠近 /）的一个。
    4. 到达 home 目录后不再继续向上。
    5. 路径用 os.path.realpath 规范化。
    """
    if home is None:
        home = os.path.expanduser("~")

    start = os.path.realpath(start_dir)
    home_real = os.path.realpath(home)

    candidates: list[str] = []
    current = start

    while True:
        candidate = os.path.join(current, "diy.yaml")
        if os.path.isfile(candidate):
            candidates.append(current)

        # 到达 home 边界 — 停止
        if os.path.realpath(current) == home_real:
            break

        parent = os.path.dirname(current)
        if parent == current:
            # 已到文件系统根
            break
        current = parent

    if not candidates:
        return None

    # 返回最高的目录（路径最短 = 最靠近 /）
    candidates.sort(key=lambda p: len(p))
    return candidates[0]


def find_spaces(workspace_root: str, max_depth: int = 3) -> list[dict]:
    """在 workspace_root 下找 .git 目录（maxdepth），返回 [{path, name}]。

    用 os.walk 实现，限制递归深度 ≤ max_depth。
    返回排序后的列表（按 name 排序）。
    路径用 os.path.realpath 规范化。
    """
    root = os.path.realpath(workspace_root)
    results: list[dict] = []

    root_depth = root.rstrip(os.sep).count(os.sep)

    for dirpath, dirnames, _fnames in os.walk(root, topdown=True, followlinks=False):
        # 计算当前深度
        current_depth = dirpath.rstrip(os.sep).count(os.sep) - root_depth

        # 排除过深目录（不进入子树）
        if current_depth >= max_depth:
            dirnames.clear()
            continue

        # 检查是否有 .git 子目录
        if ".git" in dirnames:
            real_path = os.path.realpath(dirpath)
            name = os.path.basename(real_path)
            results.append({"path": real_path, "name": name})
            # 找到 .git 的目录也排除其子树（避免在同一个 repo 内继续找）
            dirnames.clear()

    # 按 name 排序
    results.sort(key=lambda d: d["name"])
    return results
