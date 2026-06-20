"""dai task — 任务管理（pool + star 模型）

存储模型:
  ~/.diy/task/     ← pool（所有任务的永久存储）
  ~/.diy/star/     ← focus（symlink 视图）

命令:
  dai task star/unstar    — 关注/取消
  dai task list/show      — 列出/查看
  dai task local create   — 创建本地任务
  dai task github ...     — GitHub 操作
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

from ._log import logger

log = logger.with_tag("task")

# ══════════════════════════════════════════════════════════════
# 路径常量
# ══════════════════════════════════════════════════════════════

def _get_diy_home() -> Path:
    """获取 DIY_HOME 目录（支持环境变量覆盖）"""
    if env := os.environ.get("DIY_HOME"):
        return Path(env)
    return Path.home() / ".diy"


DIY_HOME = _get_diy_home()
POOL_DIR = DIY_HOME / "task"      # ~/.diy/task/
STAR_DIR = DIY_HOME / "star"      # ~/.diy/star/


# ══════════════════════════════════════════════════════════════
# URI ↔ 路径映射
# ══════════════════════════════════════════════════════════════

def uri_to_pool_path(uri: str) -> Path:
    """URI → pool 目录路径
    
    例:
      github.com/diy-agent/_diy/issues/42 → ~/.diy/task/github.com/diy-agent/_diy/issues/42
      local/task/1                        → ~/.diy/task/local/task/1
    """
    return POOL_DIR / uri


def pool_path_to_uri(path: Path) -> str | None:
    """pool 目录路径 → URI
    
    从 ~/.diy/task/ 开始计算相对路径
    """
    try:
        rel = path.relative_to(POOL_DIR)
        return str(rel)
    except ValueError:
        return None


def uri_to_star_name(uri: str) -> str:
    """URI → symlink 文件名（扁平化）
    
    例:
      github.com/diy-agent/_diy/issues/42 → github.com_diy-agent__diy_issues_42
      local/task/1                        → local_task_1
    """
    # 替换 / 为 _，保留 . 和 -
    return uri.replace("/", "_").replace("\\", "_")


def star_name_to_uri(star_name: str) -> str | None:
    """symlink 文件名 → URI
    
    注意：这个映射不是完全可逆的（/ 被替换为 _）
    需要从 star target 反推 URI
    """
    star_path = STAR_DIR / star_name
    if not star_path.is_symlink():
        return None
    target = os.readlink(star_path)
    # target 是相对路径，指向 pool
    target_path = (STAR_DIR / target).resolve()
    return pool_path_to_uri(target_path)


# ══════════════════════════════════════════════════════════════
# 基础操作
# ══════════════════════════════════════════════════════════════

def ensure_dirs():
    """确保 pool 和 star 目录存在"""
    POOL_DIR.mkdir(parents=True, exist_ok=True)
    STAR_DIR.mkdir(parents=True, exist_ok=True)


def is_starred(uri: str) -> bool:
    """检查任务是否已 star"""
    star_name = uri_to_star_name(uri)
    star_path = STAR_DIR / star_name
    return star_path.is_symlink()


def star(uri: str) -> bool:
    """star 一个任务
    
    如果 pool 里没有，需要先 sync（由调用方处理）
    """
    ensure_dirs()
    
    pool_path = uri_to_pool_path(uri)
    if not pool_path.exists():
        log.error(f"任务不在池子中: {uri}")
        log.info(f"请先 dai task github link {uri}")
        return False
    
    star_name = uri_to_star_name(uri)
    star_path = STAR_DIR / star_name
    
    if star_path.exists():
        log.info(f"已 star: {uri}")
        return True
    
    # 创建相对路径 symlink
    rel_path = os.path.relpath(pool_path, STAR_DIR)
    star_path.symlink_to(rel_path)
    log.success(f"已 star: {uri}")
    return True


def unstar(uri: str) -> bool:
    """unstar 一个任务（数据不动）"""
    star_name = uri_to_star_name(uri)
    star_path = STAR_DIR / star_name
    
    if not star_path.is_symlink():
        log.info(f"未 star: {uri}")
        return True
    
    star_path.unlink()
    log.success(f"已 unstar: {uri}")
    return True


def list_starred() -> list[str]:
    """列出所有 star 的任务 URI"""
    ensure_dirs()
    
    result = []
    for item in STAR_DIR.iterdir():
        if item.is_symlink():
            uri = star_name_to_uri(item.name)
            if uri:
                result.append(uri)
    return sorted(result)


def list_pool() -> list[str]:
    """列出 pool 中所有任务 URI"""
    ensure_dirs()
    
    result = []
    for item in POOL_DIR.rglob("AGENTS.md"):
        uri = pool_path_to_uri(item.parent)
        if uri:
            result.append(uri)
    return sorted(result)


def get_task_data(uri: str) -> dict | None:
    """获取任务数据（读 frontmatter）"""
    pool_path = uri_to_pool_path(uri)
    agents_md = pool_path / "AGENTS.md"
    
    if not agents_md.exists():
        return None
    
    # 简单解析 frontmatter
    content = agents_md.read_text(encoding="utf-8")
    if not content.startswith("---"):
        return {"uri": uri, "body": content}
    
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {"uri": uri, "body": content}
    
    import yaml
    frontmatter = yaml.safe_load(parts[1]) or {}
    body = parts[2].strip()
    
    return {
        "uri": uri,
        "title": frontmatter.get("title", ""),
        "state": frontmatter.get("state", "pending"),
        "subject": frontmatter.get("subject", ""),
        "source": frontmatter.get("source", {}),
        "body": body,
    }
