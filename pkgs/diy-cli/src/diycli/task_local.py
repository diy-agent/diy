"""dai task local — 本地任务操作"""

from __future__ import annotations

import sys
import uuid
from typing import Annotated
from cyclopts import App, Parameter

from ._log import logger
from .task import (
    uri_to_pool_path, star, ensure_dirs,
    get_task_data, list_pool,
)

log = logger.with_tag("task.local")

local_app = App(
    name="local",
    help="本地任务操作",
)


@local_app.command(name="create")
def local_create(
    title: Annotated[str, Parameter(help="任务标题")],
    detail: Annotated[str, Parameter(name=["--detail", "-d"], help="任务详情")] = "",
    subject: Annotated[str, Parameter(name=["--subject", "-s"], help="Subject 路径")] = "",
):
    """创建本地任务（自动 star）"""
    ensure_dirs()
    from datetime import datetime
    
    # 生成序号（简单递增）
    local_task_dir = uri_to_pool_path("local/task")
    local_task_dir.mkdir(parents=True, exist_ok=True)
    existing = [p for p in local_task_dir.iterdir() if p.is_dir()]
    next_num = max([int(p.name) for p in existing if p.name.isdigit()] or [0]) + 1
    
    uri = f"local/task/{next_num}"
    task_dir = uri_to_pool_path(uri)
    task_dir.mkdir(parents=True, exist_ok=True)
    
    # 写 frontmatter
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    content = f"""---
uri: {uri}
title: "{title}"
state: pending
subject: {subject}
created: '{now}'
updated: '{now}'
source:
  type: local
  uri: {uri}
---

{detail}
"""
    agents_md = task_dir / "AGENTS.md"
    agents_md.write_text(content, encoding="utf-8")
    
    # 自动 star
    star(uri)
    
    log.success(f"已创建: {uri}")


@local_app.command(name="list")
def local_list():
    """列出本地任务"""
    ensure_dirs()
    
    local_dir = uri_to_pool_path("local/task")
    if not local_dir.exists():
        log.info("暂无本地任务")
        return
    
    from rich.console import Console
    from rich.table import Table
    from rich import box
    
    console = Console()
    table = Table(title="Local Tasks", box=box.SIMPLE)
    table.add_column("URI", style="cyan")
    table.add_column("Title", style="green")
    table.add_column("State", style="yellow")
    
    for item in sorted(local_dir.iterdir()):
        if item.is_dir():
            uri = f"local/task/{item.name}"
            data = get_task_data(uri)
            if data:
                table.add_row(
                    uri,
                    data.get("title", "")[:40],
                    data.get("state", ""),
                )
    
    console.print(table)
