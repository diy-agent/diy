#!/usr/bin/env uv run
"""Serve all .pn.py examples with metadata-driven tree navigation.

Usage:
    uv run python examples/serve_all.py          # 生产模式
    uv run python examples/serve_all.py --dev     # 开发模式（自动重载）

打开 http://localhost:5006/ 查看分类索引。
"""
import argparse
import re
from pathlib import Path

import panel as pn

EXAMPLES = Path(__file__).resolve().parent

# ── PEP 723 inline metadata 解析 ──

_SCRIPT_RE = re.compile(
    r"^# /// script$\n(?P<content>(?:^#.*$\n)*)^# ///$",
    re.MULTILINE,
)


def _parse_script_meta(path: str) -> dict:
    """从 .pn.py 文件解析 # /// script 块中的 [tool.diy] 元数据。"""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return {}

    m = _SCRIPT_RE.search(text)
    if not m:
        return {}

    # 去除行首 "# " 或 "#" 前缀，得到合法 TOML
    toml_text = re.sub(r"^# ?", "", m.group("content"), flags=re.MULTILINE)

    try:
        import tomllib
        data = tomllib.loads(toml_text)
    except Exception:
        return {}

    return data.get("tool", {}).get("diy", {})


# ── 发现 & 分组 ──

def discover() -> dict[str, list[dict]]:
    """扫描 examples/ 下所有 .pn.py，按目录分组，返回 {category: [entry, ...]}。

    每个 entry:
        slug  /catalog/demo_button
        name  demo_button
        path  绝对路径
        description  来自 [tool.diy].description
        tags         来自 [tool.diy].tags
    """
    grouped: dict[str, list[dict]] = {}
    for f in sorted(EXAMPLES.rglob("*.pn.py")):
        rel = f.relative_to(EXAMPLES)
        parts = rel.parts
        if len(parts) < 2:
            continue
        category = parts[0]
        name = parts[-1].removesuffix(".pn.py")
        slug = f"/{str(rel.parent / name)}"
        meta = _parse_script_meta(str(f))
        grouped.setdefault(category, []).append({
            "slug": slug,
            "name": name,
            "path": str(f),
            "description": meta.get("description", ""),
            "tags": meta.get("tags", []),
        })
    return grouped


# ── 索引页 ──

CAT_META: dict[str, tuple[str, str]] = {
    "apps":     ("📱", "应用"),
    "catalog":  ("🧩", "组件目录"),
    "features": ("⚡", "特性演示"),
}


def _tags_badge(tags: list[str]) -> str:
    """渲染 tags 为小标签。"""
    if not tags:
        return ""
    badges = " ".join(f"`{t}`" for t in tags)
    return f"  {badges}"


def build_index(grouped: dict[str, list[dict]]) -> pn.Column:
    """构建根索引页：按分类分组，每个条目显示描述和标签。"""
    sections: list = []

    total = sum(len(v) for v in grouped.values())
    sections.append(pn.pane.Markdown(
        f"# 🎯 diy UI 示例总览\n共 **{total}** 个示例，按分类浏览。点击链接跳转。",
        sizing_mode="stretch_width",
    ))

    for category in ["apps", "catalog", "features"]:
        items = grouped.get(category)
        if not items:
            continue
        emoji, label = CAT_META.get(category, ("📁", category))
        lines = [f"## {emoji} {label}（{len(items)}）\n"]
        for entry in items:
            link = f"- [**{entry['name']}**]({entry['slug']})"
            if entry["description"]:
                link += f"  —  {entry['description']}"
            if entry["tags"]:
                link += _tags_badge(entry["tags"])
            lines.append(link)

        sections.append(pn.pane.Markdown("\n".join(lines), sizing_mode="stretch_width"))

    sections.append(pn.layout.Divider())
    sections.append(pn.pane.Markdown(
        "*每个脚本的 `# /// script` 块携带 `[tool.diy]` 元数据，本页自动发现并渲染。*"
    ))

    return pn.Column(*sections, sizing_mode="stretch_width")


# ── 入口 ──

def main():
    parser = argparse.ArgumentParser(description="Serve all diy-ui examples")
    parser.add_argument("--dev", action="store_true", help="Enable dev/autoreload mode")
    args = parser.parse_args()

    grouped = discover()
    total = sum(len(v) for v in grouped.values())
    print(f"Found {total} examples:")
    for category, entries in grouped.items():
        print(f"  {category}/ ({len(entries)})")
        for e in entries:
            desc = f" — {e['description']}" if e["description"] else ""
            print(f"    {e['slug']}{desc}")

    # 构建 serve dict：根路径为索引页，各示例指向 .pn.py 文件
    apps: dict[str, str | pn.Column] = {"/": build_index(grouped)}
    for entries in grouped.values():
        for e in entries:
            rel_path = e["slug"].lstrip("/")
            apps[e["slug"]] = str(EXAMPLES / f"{rel_path}.pn.py")

    pn.serve(
        apps,
        port=5006,
        show=True,
        start=True,
        dev=args.dev,
        autoreload=args.dev,
    )


if __name__ == "__main__":
    main()
