"""dai task github — GitHub 任务操作"""

from __future__ import annotations

import sys
import subprocess
from typing import Annotated
from cyclopts import App, Parameter

from ._log import logger
from .task import (
    uri_to_pool_path, star, unstar, ensure_dirs,
    get_task_data,
)

log = logger.with_tag("task.github")

github_app = App(
    name="github",
    help="GitHub 任务操作",
)


def _parse_github_uri(uri: str) -> tuple[str, str, str] | None:
    """解析 GitHub URI 为 (owner, repo, number)
    
    支持格式:
      diy-agent/_diy/issues/42
      github.com/diy-agent/_diy/issues/42
    """
    parts = uri.replace("github.com/", "").split("/")
    if len(parts) >= 4 and parts[2] == "issues":
        owner, repo = parts[0], parts[1]
        try:
            number = int(parts[3])
            return owner, repo, number
        except ValueError:
            pass
    return None


@github_app.command(name="link")
def github_link(
    uri: Annotated[str, Parameter(help="GitHub issue URI (如 diy-agent/_diy/issues/42)")],
):
    """链接已有 issue 到池子（下载 + 自动 star）"""
    ensure_dirs()
    
    parsed = _parse_github_uri(uri)
    if not parsed:
        log.error(f"无法解析 URI: {uri}")
        sys.exit(1)
    
    owner, repo, number = parsed
    full_uri = f"github.com/{owner}/{repo}/issues/{number}"
    
    # 检查是否已在池子
    pool_path = uri_to_pool_path(full_uri)
    if pool_path.exists():
        log.info(f"已在池子中: {full_uri}")
        star(full_uri)
        return
    
    # 下载 issue
    log.info(f"下载 issue #{number}...")
    try:
        result = subprocess.run(
            ["gh", "issue", "view", str(number), "--repo", f"{owner}/{repo}",
             "--json", "title,body,state,createdAt,updatedAt"],
            capture_output=True, text=True, timeout=30,
        )
        
        if result.returncode != 0:
            log.error(f"下载失败: {result.stderr}")
            sys.exit(1)
        
        import json
        issue_data = json.loads(result.stdout)
        
        # 创建目录
        pool_path.mkdir(parents=True, exist_ok=True)
        
        # 写 frontmatter
        from datetime import datetime
        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        content = f"""---
uri: {full_uri}
title: "{issue_data.get('title', '')}"
state: {issue_data.get('state', 'OPEN').lower()}
subject: 
created: '{issue_data.get('createdAt', now)}'
updated: '{issue_data.get('updatedAt', now)}'
source:
  type: github_issue
  uri: {full_uri}
---

{issue_data.get('body', '')}
"""
        agents_md = pool_path / "AGENTS.md"
        agents_md.write_text(content, encoding="utf-8")
        
        log.success(f"已下载: {full_uri}")
        
        # 自动 star
        star(full_uri)
        
    except subprocess.TimeoutExpired:
        log.error("下载超时")
        sys.exit(1)
    except Exception as e:
        log.error(f"下载失败: {e}")
        sys.exit(1)


@github_app.command(name="sync")
def github_sync(
    uri: Annotated[str, Parameter(help="GitHub issue URI")],
):
    """刷新池子中的 issue 数据"""
    ensure_dirs()
    
    parsed = _parse_github_uri(uri)
    if not parsed:
        log.error(f"无法解析 URI: {uri}")
        sys.exit(1)
    
    owner, repo, number = parsed
    full_uri = f"github.com/{owner}/{repo}/issues/{number}"
    
    pool_path = uri_to_pool_path(full_uri)
    if not pool_path.exists():
        log.error(f"任务不在池子中: {full_uri}")
        log.info(f"请先 dai task github link {full_uri}")
        sys.exit(1)
    
    # 重新下载
    log.info(f"刷新 issue #{number}...")
    try:
        result = subprocess.run(
            ["gh", "issue", "view", str(number), "--repo", f"{owner}/{repo}",
             "--json", "title,body,state,createdAt,updatedAt"],
            capture_output=True, text=True, timeout=30,
        )
        
        if result.returncode != 0:
            log.error(f"刷新失败: {result.stderr}")
            sys.exit(1)
        
        import json
        issue_data = json.loads(result.stdout)
        
        # 更新 frontmatter
        from datetime import datetime
        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        content = f"""---
uri: {full_uri}
title: "{issue_data.get('title', '')}"
state: {issue_data.get('state', 'OPEN').lower()}
subject: 
created: '{issue_data.get('createdAt', now)}'
updated: '{issue_data.get('updatedAt', now)}'
source:
  type: github_issue
  uri: {full_uri}
---

{issue_data.get('body', '')}
"""
        agents_md = pool_path / "AGENTS.md"
        agents_md.write_text(content, encoding="utf-8")
        
        log.success(f"已刷新: {full_uri}")
        
    except Exception as e:
        log.error(f"刷新失败: {e}")
        sys.exit(1)


@github_app.command(name="promote")
def github_promote(
    task_uri: Annotated[str, Parameter(help="本地任务 URI (如 local/task/1)")],
    repo: Annotated[str, Parameter(help="目标 GitHub 仓库 (如 diy-agent/_diy)")],
):
    """将本地任务升级为 GitHub issue"""
    ensure_dirs()
    
    # 读取本地任务数据
    local_data = get_task_data(task_uri)
    if not local_data:
        log.error(f"本地任务不存在: {task_uri}")
        sys.exit(1)
    
    title = local_data.get("title", "")
    body = local_data.get("body", "")
    
    # 创建 GitHub issue
    log.info(f"创建 GitHub issue...")
    try:
        result = subprocess.run(
            ["gh", "issue", "create", "--repo", repo,
             "--title", title, "--body", body],
            capture_output=True, text=True, timeout=30,
        )
        
        if result.returncode != 0:
            log.error(f"创建失败: {result.stderr}")
            sys.exit(1)
        
        # 解析返回的 issue URL
        # 格式: https://github.com/owner/repo/issues/123
        issue_url = result.stdout.strip()
        parts = issue_url.rstrip("/").split("/")
        number = parts[-1]
        owner_repo = "/".join(parts[-3:-1])
        
        new_uri = f"github.com/{owner_repo}/issues/{number}"
        log.info(f"已创建: {new_uri}")
        
        # 移动数据目录
        import shutil
        old_path = uri_to_pool_path(task_uri)
        new_path = uri_to_pool_path(new_uri)
        new_path.parent.mkdir(parents=True, exist_ok=True)
        
        # 更新 frontmatter 中的 URI
        agents_md = old_path / "AGENTS.md"
        content = agents_md.read_text(encoding="utf-8")
        content = content.replace(f"uri: {task_uri}", f"uri: {new_uri}")
        content = content.replace(f"uri: {task_uri}", f"uri: {new_uri}", 1)
        
        # 移动目录
        shutil.move(str(old_path), str(new_path))
        
        # 写入更新后的内容
        (new_path / "AGENTS.md").write_text(content, encoding="utf-8")
        
        # 更新 star
        from .task import uri_to_star_name
        old_star = STAR_DIR / uri_to_star_name(task_uri)
        if old_star.is_symlink():
            old_star.unlink()
        
        star(new_uri)
        
        log.success(f"已升级: {task_uri} → {new_uri}")
        
    except Exception as e:
        log.error(f"升级失败: {e}")
        sys.exit(1)


# 需要导入 STAR_DIR
from .task import STAR_DIR
