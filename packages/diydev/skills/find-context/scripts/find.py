#!/usr/bin/env python
"""find-context/find.py — 从目标路径向上发现 AGENTS.md 和 skills

用法:
    find.py <目标文件或目录路径>

输出：按优先级排序的上下文文件列表（靠近目标文件的优先）
"""

import sys
import os
from pathlib import Path


def resolve_path(target: str) -> Path:
    p = Path(target).expanduser().resolve()
    if not p.exists():
        print(f"错误: 路径不存在: {target}", file=sys.stderr)
        sys.exit(1)
    return p


def main():
    if len(sys.argv) < 2:
        print("用法: find.py <目标文件或目录路径>", file=sys.stderr)
        sys.exit(1)

    target = resolve_path(sys.argv[1])
    home = Path.home()

    # 从目标目录向上遍历
    if target.is_file():
        current = target.parent
    else:
        current = target

    agents_files: list[Path] = []
    project_skills: list[Path] = []

    while current != current.parent and current != Path("."):
        # AGENTS.md
        agents_md = current / "AGENTS.md"
        if agents_md.is_file():
            agents_files.append(agents_md)

        # .agents/skills/ 下的 SKILL.md（排除 HOME 下的全局 skills）
        skills_dir = current / ".agents" / "skills"
        if skills_dir.is_dir() and current != home:
            for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
                if skill_md.is_file() and skill_md not in project_skills:
                    project_skills.append(skill_md)

        # 到达 HOME 后停止
        if current == home:
            break
        current = current.parent

    # 全局 skills
    global_skills_dir = home / ".agents" / "skills"
    global_skill_names: list[str] = []
    if global_skills_dir.is_dir():
        for skill_md in sorted(global_skills_dir.glob("*/SKILL.md")):
            if skill_md.is_file():
                global_skill_names.append(skill_md.parent.name)

    # 输出
    print("# 上下文加载报告")
    print(f"# 目标: {target}")
    print()

    if agents_files:
        print("## AGENTS.md（优先级由高到低，先读前 1-2 条）")
        for f in agents_files:
            print(f"- `{f}`")
        print()

    if project_skills:
        print("## 项目级 Skills（读取匹配当前任务的文件）")
        for f in project_skills:
            print(f"- `{f}`")
        print()

    if global_skill_names:
        print("## 全局 Skills（名称列表，匹配时读取 ~/.agents/skills/<name>/SKILL.md）")
        for name in global_skill_names:
            print(f"- {name}")
        print()

    if not agents_files and not project_skills:
        print("（未发现项目级 AGENTS.md 或 .agents/skills/）")

    print("# ⛔ 规则：取前 1-2 条 AGENTS.md 和最匹配的 SKILL.md，用 read 工具读取，完成后再工作")


if __name__ == "__main__":
    main()
