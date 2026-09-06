#!/usr/bin/env python3
"""把老 Python 栈的 local 任务迁移到新 TS 栈布局（一次性脚本）。

老布局（pkgs/diy-core/src/diy/core/_state.py）：
  ~/.diy/task/local/<name>/AGENTS.md          ← 命名任务
  ~/.diy/task/local/task/<n>/AGENTS.md        ← 数字任务
  frontmatter: title/state/subject/source{type,uri}/parent/agent/detail/closed/...

新布局（pkgs.ts/diy-app/src/main/core/{state,task,project}.ts）：
  $DIY_HOME/projects/<pid>/tasks/<tid>/AGENTS.md
  URI = projects/<pid>/tasks/<tid>（pid/tid 必须纯数字，否则 listTasks 扫不到）
  frontmatter: title/state/parent/detail/created/updated/source_type/source_uri
  project 由 URI 路径推导，不再读 subject；star 为 star/<uri with __> 单层 symlink

规则（确定性，可重跑）：
  - 只扫 <source>/task/local/**，github 等其它 scope 不动
  - 按老 subject 分组建 project（subject 排序 → pid 1..N），meta.yaml 只写 {id,path,created}
    （不写目标仓库 diy.yaml 名片，避免脏用户仓库）
  - 数字 tid 原号保留（同 project 内无冲突）；命名任务按旧名排序分 max+1…
  - parent 按 old→new 映射表重写；跨项目 / 指向 local 之外 / 父不存在 → 丢弃并记录
  - source.{type,uri} 展平为 source_type/source_uri；agent/closed/被丢的 parent 折进 body 附录
  - 老 star 中属于 local 且目标存在的，按新命名重建；dangling 跳过并记录

用法：
  python3 scripts/migrate-local-tasks.py [--source ~/.diy] [--target ./build/home] [--apply] [--force]
  默认 dry-run（只打印报告不写盘）；--apply 才写；目标 projects/ 非空时需 --force（清空重建）。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml


def parse_agents_md(path: Path) -> tuple[dict, str]:
    """解析老 AGENTS.md → (frontmatter dict, body)。格式错误抛 ValueError。"""
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"{path} 缺少 frontmatter 起始 ---")
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        raise ValueError(f"{path} 缺少 frontmatter 结束 ---")
    fm = yaml.safe_load("\n".join(lines[1:end])) or {}
    body = "\n".join(lines[end + 1 :]).strip()
    return fm, body


def main() -> int:
    ap = argparse.ArgumentParser(description="迁移老 local 任务到新 TS 布局")
    ap.add_argument("--source", default="~/.diy", help="老数据根（默认 ~/.diy）")
    ap.add_argument("--target", default="./build/home", help="新数据根（默认 ./build/home）")
    ap.add_argument("--apply", action="store_true", help="不加则 dry-run，只打印报告")
    ap.add_argument("--force", action="store_true", help="目标 projects/ 非空时清空重建")
    args = ap.parse_args()

    src_root = Path(os.path.expanduser(args.source))
    src_local = src_root / "task" / "local"
    # 目标必须绝对路径：star symlink 存相对路径会断（相对 link 所在目录解析）
    tgt_root = Path(args.target).absolute()
    if not src_local.exists():
        print(f"源目录不存在: {src_local}", file=sys.stderr)
        return 1

    # ── 1. 扫描老 local 任务 ──
    files = sorted(src_local.rglob("AGENTS.md"))
    tasks: dict[str, tuple[dict, str]] = {}  # old_uri → (fm, body)
    for f in files:
        old_uri = f"local/{f.parent.relative_to(src_local)}"
        try:
            tasks[old_uri] = parse_agents_md(f)
        except ValueError as e:
            print(f"跳过（格式错）: {e}", file=sys.stderr)
    print(f"扫描到老 local 任务 {len(tasks)} 条")

    # ── 2. 按 subject 分组 → project ──
    by_subject: dict[str, list[str]] = {}
    no_subject: list[str] = []
    for uri, (fm, _) in tasks.items():
        subj = fm.get("subject")
        if not subj:
            no_subject.append(uri)
            continue
        by_subject.setdefault(str(subj), []).append(uri)
    if no_subject:
        print(f"跳过（无 subject，无法分组）: {no_subject}", file=sys.stderr)
        for uri in no_subject:
            del tasks[uri]

    subjects = sorted(by_subject)
    proj_of_subject = {s: str(i + 1) for i, s in enumerate(subjects)}

    # ── 3. 分配新 tid ──
    # 数字叶原号保留；命名叶按旧名排序分 max(数字)+1…（同 project 内老数字唯一，故无冲突）
    new_uri: dict[str, str] = {}  # old → new
    for subj in subjects:
        pid = proj_of_subject[subj]
        uris = by_subject[subj]
        numeric = sorted(
            (u for u in uris if u.split("/")[-1].isdigit()), key=lambda u: int(u.split("/")[-1])
        )
        named = sorted(u for u in uris if not u.split("/")[-1].isdigit())
        for u in numeric:
            new_uri[u] = f"projects/{pid}/tasks/{u.split('/')[-1]}"
        nxt = max([int(u.split("/")[-1]) for u in numeric] or [0]) + 1
        for u in named:
            new_uri[u] = f"projects/{pid}/tasks/{nxt}"
            nxt += 1

    # ── 4. 老 star 清点（只收 local 且目标存在的）──
    star_root = src_root / "star"
    starred_old: set[str] = set()
    dangling: list[str] = []
    if star_root.exists():
        # 嵌套式 star/local/task/<n>
        for d in sorted((star_root / "local").rglob("*")) if (star_root / "local").exists() else []:
            if d.is_symlink():
                try:
                    rel = d.relative_to(star_root)
                    uri = str(rel)
                except ValueError:
                    continue
                tgt = Path(os.readlink(d))
                if not tgt.exists():
                    dangling.append(uri)
                    continue
                if uri in tasks:
                    starred_old.add(uri)
        # 扁平式 local__<name>
        for d in sorted(star_root.iterdir()):
            if d.is_symlink() and d.name.startswith("local__"):
                uri = "local/" + d.name[len("local__") :]
                tgt = Path(os.readlink(d))
                if not tgt.exists():
                    dangling.append(uri)
                    continue
                if uri in tasks:
                    starred_old.add(uri)

    # ── 5. 组装新文件内容 ──
    now = datetime.now(timezone.utc).isoformat()
    new_files: dict[str, str] = {}  # new_uri → AGENTS.md 全文
    dropped_parents: list[tuple[str, str, str]] = []  # (old, parent_old, 原因)
    appendix_count = 0
    for old, new in new_uri.items():
        fm, body = tasks[old]
        pid = new.split("/")[1]
        notes: list[str] = []

        # parent 重写：必须同 project 且存在
        new_parent = None
        p = fm.get("parent")
        if p:
            p = str(p)
            if p in new_uri and new_uri[p].split("/")[1] == pid:
                new_parent = new_uri[p]
            else:
                reason = "父不在本次迁移内" if p not in new_uri else "跨项目（新系统要求同项目父子）"
                dropped_parents.append((old, p, reason))
                notes.append(f"- 原 parent `{p}` 已丢弃（{reason}）")

        # source 展平
        src = fm.get("source")
        stype = suri = None
        if isinstance(src, dict):
            stype = src.get("type")
            suri = src.get("uri")

        # agent / closed 无处可放 → 附录
        if fm.get("agent") is not None:
            notes.append(f"- agent: `{fm.get('agent')}`（新 schema 无此字段，会话不迁移）")
        if fm.get("closed") is not None:
            notes.append(f"- closed: `{fm.get('closed')}`（新 schema 无此字段）")

        front: dict = {"title": fm.get("title", ""), "state": fm.get("state", "pending")}
        if new_parent:
            front["parent"] = new_parent
        if fm.get("detail") is not None:
            front["detail"] = fm.get("detail")
        if fm.get("created") is not None:
            front["created"] = fm.get("created")
        if fm.get("updated") is not None:
            front["updated"] = fm.get("updated")
        if stype is not None:
            front["source_type"] = stype
        if suri is not None:
            front["source_uri"] = suri

        if notes:
            appendix_count += 1
            body = (
                (body + "\n\n" if body else "")
                + "> 迁移附注（老 frontmatter 字段，新 schema 无对应，已折叠至此）\n"
                + "\n".join(f"> {n}" for n in notes)
                + "\n"
            )
        dump = yaml.safe_dump(front, allow_unicode=True, sort_keys=False).strip()
        new_files[new] = f"---\n{dump}\n---\n{body.strip() + chr(10) if body.strip() else ''}"

    # ── 6. 报告 ──
    print("\n== project 映射（subject → pid） ==")
    for s in subjects:
        pid = proj_of_subject[s]
        n = len(by_subject[s])
        print(f"  projects/{pid} ← {s}（{n} 条）")
    print("\n== 任务映射（old → new） ==")
    for old in sorted(new_uri):
        star = " ★" if old in starred_old else ""
        print(f"  {old} → {new_uri[old]}{star}")
    print(f"\n== 丢弃的 parent（{len(dropped_parents)}） ==")
    for old, p, r in dropped_parents:
        print(f"  {old} 的 parent {p}：{r}")
    if dangling:
        print(f"\n== dangling 老 star（跳过，{len(dangling)}） ==")
        for d in dangling:
            print(f"  {d}")
    print(f"\n带迁移附录的任务：{appendix_count} 条；将重建新 star：{len(starred_old)} 个")

    if not args.apply:
        print("\n[dry-run] 未写盘。确认无误后加 --apply 执行。")
        return 0

    # ── 7. 写盘 ──
    # 只动本次迁移管理的路径：projects/<pid>（冲突的 pid）、star/projects__* 链接。
    # 从不整目录删除——老 star（github 等）和其它数据原样保留。
    proj_root = tgt_root / "projects"
    star_new_root = tgt_root / "star"
    conflicts = [pid for pid in set(proj_of_subject.values()) if (proj_root / pid).exists()]
    if conflicts and not args.force:
        print(f"目标已存在 project 目录 {conflicts}，加 --force 只覆盖这些 pid", file=sys.stderr)
        return 2

    for s in subjects:
        pid = proj_of_subject[s]
        meta = {"id": pid, "path": s, "label": s, "created": now}
        d = proj_root / pid
        if d.exists():
            # --force 已确认：只删冲突的 pid 目录（ backed up by caller ）
            shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True, exist_ok=True)
        (d / "meta.yaml").write_text(
            yaml.safe_dump(meta, allow_unicode=True, sort_keys=False), encoding="utf-8"
        )
    for new, content in new_files.items():
        d = tgt_root / new
        d.mkdir(parents=True, exist_ok=True)
        (d / "AGENTS.md").write_text(content, encoding="utf-8")
    star_new_root.mkdir(parents=True, exist_ok=True)
    for old in sorted(starred_old):
        new = new_uri[old]
        link = star_new_root / new.replace("/", "__")
        if link.is_symlink() or link.exists():
            if not args.force:
                print(f"star 链接已存在且未加 --force，跳过: {link}", file=sys.stderr)
                continue
            link.unlink()
        link.symlink_to((tgt_root / new).absolute())

    print(
        f"\n[apply] 已写入：{len(new_files)} 个任务 + {len(subjects)} 个 project → {tgt_root}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
