"""生成三个 Factory .gen.py 文件。

用法: uv run python tools/_generate_factories.py
输出:
  src/diy/ui/providers/panel/_factories/_layout_factory_gen.py
  src/diy/ui/providers/panel/_factories/_pane_factory_gen.py
  src/diy/ui/providers/panel/_factories/_widgets_factory_gen.py

每个 .gen.py 包含完整的工厂方法实现，继承手写基类（提供 _add + __init__）。
"""
from __future__ import annotations

import inspect
import re
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "src" / "diy" / "ui" / "providers" / "panel"
FACTORIES_DIR = PKG / "_factories"

CONFIG = [
    ("_LayoutFactory", "_layout_factory_gen.py", "layout", True),
    ("_PaneFactory", "_pane_factory_gen.py", "pane", False),
    ("_WidgetsFactory", "_widgets_factory_gen.py", "widgets", False),
]

DISPLAY = {"layout": "layout", "pane": "pane", "widgets": "widgets"}
WRAPPER_MOD = {"layout": "_layout", "pane": "_pane", "widgets": "_widgets"}
BASE_CLASS = {"layout": "_LayoutFactoryBase", "pane": "_PaneFactoryBase", "widgets": "_WidgetsFactoryBase"}
MODULE_MAP = {"layout": "diy.ui.providers.panel.layout", "pane": "diy.ui.providers.panel.pane", "widgets": "diy.ui.providers.panel.widgets"}


def _to_snake(name: str) -> str:
    s = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s).lower()


def _format_type(ann: object) -> str:
    if ann is inspect.Parameter.empty:
        return "Any"
    try:
        ann = get_type_hints(lambda: ann, globalns=None, localns=None).get("ann", ann)
    except Exception:
        pass
    s = inspect.formatannotation(ann)
    s = s.replace("typing.", "").replace("NoneType", "None")
    # 只去掉包围合法 Python 标识符的引号，保留字符串字面量（如 'flex-start', 'first baseline'）
    s = re.sub(r"'([A-Za-z_][A-Za-z0-9_]*)'", r"\1", s)
    s = re.sub(r"\"([A-Za-z_][A-Za-z0-9_]*)\"", r"\1", s)
    s = s.replace("ForwardRef(", "").replace(")", "")
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > 200 or not s or s == "None":
        return "Any"
    return s


def _collect(mod_name: str) -> list[tuple[str, type]]:
    module = __import__(MODULE_MAP[mod_name], fromlist=[""])
    classes: list[tuple[str, type]] = []
    for name in sorted(dir(module)):
        if name.startswith("_"):
            continue
        if isinstance(getattr(module, name), type):
            classes.append((name, getattr(module, name)))
    return classes


def _format_default(val: object) -> str:
    """默认值 → 合法 Python 表达式"""
    if isinstance(val, type):
        module = getattr(val, "__module__", "")
        qualname = getattr(val, "__qualname__", getattr(val, "__name__", ""))
        if module and module.startswith("panel."):
            short = "pn." + module.split(".", 1)[1] + "." + qualname
            return short  # e.g., "pn.layout.base.Row" — 配合 import panel as pn
        return "..."
    s = repr(val)
    return "..." if len(s) > 60 else s


def _gen_method(cls_name: str, cls: type, wrapper_mod: str, has_children: bool, indent: str = "    ") -> str:
    """生成单个工厂方法的完整实现（签名 + body）。"""
    method_name = _to_snake(cls_name)
    sig = inspect.signature(cls.__init__)
    params = [p for p in sig.parameters.values() if p.name != "self"]

    # --- 签名 ---
    sig_lines: list[str] = []
    sig_lines.append(f"{indent}def {method_name}(self,")

    if has_children:
        sig_lines.append(f"{indent}    *children: Any,")

    param_strs: list[str] = []
    for p in params:
        if has_children and p.name == "children":
            continue
        if p.kind == inspect.Parameter.VAR_KEYWORD:
            continue  # **kwargs 由工厂方法级兜底，不在显式签名里重复
        ann_str = _format_type(p.annotation)
        if p.default is not inspect.Parameter.empty:
            param_strs.append(f"{p.name}: {ann_str} = {_format_default(p.default)}")
        else:
            param_strs.append(f"{p.name}: {ann_str}")

    for i, ps in enumerate(param_strs):
        sig_lines.append(f"{indent}    {ps}{',' if i < len(param_strs) - 1 else ','}")

    # factory 方法自己也加 **kwargs 兜底
    sig_lines.append(f"{indent}    **kwargs: Any,")
    sig_lines.append(f"{indent}) -> {wrapper_mod}.{cls_name}:")

    # --- body ---
    body: list[str] = []
    body.append(f"{indent}    return self._add({wrapper_mod}.{cls_name}(")

    if has_children:
        body.append(f"{indent}        *children,")

    # 收集所有传参关键字（包括 children 或排除 children）
    kw_names: list[str] = []
    for p in params:
        if has_children and p.name == "children":
            continue
        if p.kind == inspect.Parameter.VAR_KEYWORD:
            continue
        kw_names.append(p.name)

    for i, name in enumerate(kw_names):
        comma = "," if i < len(kw_names) - 1 else ","
        body.append(f"{indent}        {name}={name}{comma}")

    body.append(f"{indent}        **kwargs,")

    body.append(f"{indent}    ))")
    return "\n".join(sig_lines + body)


def _gen_file(cls_name: str, fname: str, mod_name: str, has_children: bool) -> str:
    classes = _collect(mod_name)
    wrapper_mod = WRAPPER_MOD[mod_name]
    display = DISPLAY[mod_name]
    base_class = BASE_CLASS[mod_name]

    # 检测是否需要 import panel
    needs_panel = False
    for _, cls in classes:
        sig = inspect.signature(cls.__init__)
        for p in sig.parameters.values():
            if p.name == "self" or p.default is inspect.Parameter.empty:
                continue
            if isinstance(p.default, type) and getattr(p.default, "__module__", "").startswith("panel."):
                needs_panel = True

    lines: list[str] = []
    lines.append(f'"""app.{display}.xxx() 工厂类 — 由 tools/_generate_factories.py 自动生成，勿手改。"""')
    lines.append("")
    lines.append("from __future__ import annotations")
    lines.append("from typing import Any")
    if needs_panel:
        lines.append("import panel as pn")
    lines.append("")
    lines.append(f"from .. import {mod_name} as {wrapper_mod}")
    lines.append(f"from ._{mod_name}_factory import {base_class}")
    lines.append("")
    lines.append("")
    lines.append(f"class {cls_name}({base_class}):")
    lines.append(f'    """app.{display}.xxx() 工厂方法（自动生成）。"""')
    lines.append("")
    for cls_name_w, cls in classes:
        lines.append(_gen_method(cls_name_w, cls, wrapper_mod, has_children))
        lines.append("")
    return "\n".join(lines) + "\n"


def generate() -> dict[str, str]:
    return {fname: _gen_file(cls_name, fname, mod_name, children)
            for cls_name, fname, mod_name, children in CONFIG}


def main() -> None:
    FACTORIES_DIR.mkdir(parents=True, exist_ok=True)
    files = generate()
    for fname, content in files.items():
        fpath = FACTORIES_DIR / fname
        existing = fpath.read_text() if fpath.exists() else ""
        if existing != content:
            fpath.write_text(content)
            print(f"✅ 写入 {fpath} ({len(content.splitlines())} 行)")
        else:
            print(f"⏭️  {fname} 无变化")


if __name__ == "__main__":
    main()
