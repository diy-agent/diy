"""dai task CLI 命令"""

from __future__ import annotations

import sys
from typing import Annotated, Optional
from cyclopts import App, Parameter

from ._log import logger
from .task import (
    star, unstar, is_starred, list_starred, list_pool,
    get_task_data, ensure_dirs, POOL_DIR, STAR_DIR,
    uri_to_pool_path,
)

log = logger.with_tag("task")

task_app = App(
    name="task",
    help="任务管理 — star/unstar/list/show",
)


# ══════════════════════════════════════════════════════════════
# dai task star
# ══════════════════════════════════════════════════════════════

@task_app.command(name="star")
def task_star(
    uri: Annotated[str, Parameter(help="任务 URI")],
):
    """关注任务（自动 sync + 创建 symlink）"""
    ensure_dirs()
    success = star(uri)
    if not success:
        sys.exit(1)


# ══════════════════════════════════════════════════════════════
# dai task unstar
# ══════════════════════════════════════════════════════════════

@task_app.command(name="unstar")
def task_unstar(
    uri: Annotated[str, Parameter(help="任务 URI")],
):
    """取消关注（删除 symlink，数据不动）"""
    unstar(uri)


# ══════════════════════════════════════════════════════════════
# dai task list
# ══════════════════════════════════════════════════════════════

@task_app.command(name="list")
def task_list(
    starred: Annotated[bool, Parameter(name=["--starred", "-s"], help="只列出 star 的任务")] = False,
    all: Annotated[bool, Parameter(name=["--all", "-a"], help="列出 pool 中所有任务")] = False,
):
    """列出任务"""
    ensure_dirs()
    
    if starred or (not all):
        # 默认列出 star
        uris = list_starred()
        if uris:
            from rich.console import Console
            from rich.table import Table
            from rich import box
            
            console = Console()
            table = Table(title="Starred Tasks", box=box.SIMPLE)
            table.add_column("URI", style="cyan")
            table.add_column("Title", style="green")
            table.add_column("State", style="yellow")
            
            for uri in uris:
                data = get_task_data(uri)
                if data:
                    table.add_row(
                        uri,
                        data.get("title", "")[:40],
                        data.get("state", ""),
                    )
                else:
                    table.add_row(uri, "", "")
            
            console.print(table)
            console.print(f"\n总计: {len(uris)} 个 star 任务")
        else:
            log.info("暂无 star 任务")
    
    if all:
        uris = list_pool()
        if uris:
            from rich.console import Console
            console = Console()
            console.print(f"Pool 中共 {len(uris)} 个任务")
            for uri in uris[:20]:
                console.print(f"  {uri}")
            if len(uris) > 20:
                console.print(f"  ... 还有 {len(uris) - 20} 个")


# ══════════════════════════════════════════════════════════════
# dai task show
# ══════════════════════════════════════════════════════════════

@task_app.command(name="show")
def task_show(
    uri: Annotated[str, Parameter(help="任务 URI")],
):
    """查看任务详情"""
    data = get_task_data(uri)
    if not data:
        log.error(f"任务不存在: {uri}")
        sys.exit(1)
    
    from rich.console import Console
    from rich.panel import Panel
    
    console = Console()
    
    title = data.get("title", "无标题")
    state = data.get("state", "unknown")
    subject = data.get("subject", "")
    body = data.get("body", "")
    
    content = f"[bold]{title}[/bold]\n"
    content += f"State: {state}\n"
    if subject:
        content += f"Subject: {subject}\n"
    if is_starred(uri):
        content += "Status: ⭐ starred\n"
    content += f"\n{body[:500]}"
    
    console.print(Panel(content, title=uri))
