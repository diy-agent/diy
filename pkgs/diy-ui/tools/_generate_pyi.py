"""生成 _app.pyi type stub — 从 wrapper 类提取三个 Factory 的显式签名。

用法: uv run python tools/_generate_pyi.py
"""
from __future__ import annotations

import inspect
import re
from pathlib import Path
from typing import get_type_hints

import diy.ui.providers.panel.layout as diy_layout
import diy.ui.providers.panel.pane as diy_pane
import diy.ui.providers.panel.widgets as diy_widgets

PKG = Path(__file__).resolve().parent.parent / "src" / "diy" / "ui" / "providers" / "panel"
PYI_PATH = PKG / "_app.pyi"

MOD_ALIAS_META = {"_layout": "layout", "_pane": "pane", "_widgets": "widgets"}


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
    for ch in ("'", '"'):
        s = s.replace(ch, "")
    s = s.replace("ForwardRef(", "").replace(")", "")
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > 200 or not s or s == "None":
        return "Any"
    return s


def _format_default(val: object) -> str:
    """将默认值格式化为合法 Python 表达式（在 .pyi 中）。"""
    if isinstance(val, type):
        module = getattr(val, "__module__", "")
        qualname = getattr(val, "__qualname__", val.__name__)
        # 优先查找是否已在 diypn 子包中
        for alias, mod in (("_layout", diy_layout), ("_pane", diy_pane), ("_widgets", diy_widgets)):
            for attr_name in dir(mod):
                if getattr(mod, attr_name) is val:
                    return f"{alias}.{attr_name}"
        # panel 内部类在 .pyi 中无法引用 → 用 ...
        if module.startswith("panel."):
            return "..."
        name = f"{module}.{qualname}" if module and module != "builtins" else qualname
        return "..." if len(name) > 60 else name
    s = repr(val)
    return "..." if len(s) > 60 else s


def _collect(dir_module: object) -> list[tuple[str, type]]:
    classes: list[tuple[str, type]] = []
    for name in sorted(dir(dir_module)):
        if name.startswith("_"):
            continue
        cls = getattr(dir_module, name)
        if isinstance(cls, type):
            classes.append((name, cls))
    return classes


def _build_method_lines(
    cls_name: str,
    cls: type,
    indent: str = "    ",
    mod_alias: str = "_widgets",
    has_children: bool = False,
) -> list[str]:
    method_name = _to_snake(cls_name)
    sig = inspect.signature(cls.__init__)
    params = [p for p in sig.parameters.values() if p.name != "self"]

    lines: list[str] = []
    lines.append(f"{indent}def {method_name}(self,")
    if has_children:
        lines.append(f"{indent}    *children: Any,")

    param_strs: list[str] = []
    for p in params:
        if has_children and p.name == "children":
            continue
        ann_str = _format_type(p.annotation)
        if p.default is not inspect.Parameter.empty:
            param_strs.append(f"{p.name}: {ann_str} = {_format_default(p.default)}")
        else:
            param_strs.append(f"{p.name}: {ann_str}")

    for i, ps in enumerate(param_strs):
        lines.append(f"{indent}    {ps}{',' if i < len(param_strs) - 1 else ','}")
    lines.append(f"{indent}) -> {mod_alias}.{cls_name}:")
    lines.append(f"{indent}    ...")
    lines.append("")
    return lines


def _generate_factory(
    factory_name: str,
    dir_module: object,
    mod_alias: str,
    *,
    has_children: bool = False,
) -> list[str]:
    display_alias = MOD_ALIAS_META.get(mod_alias, mod_alias)
    classes = _collect(dir_module)
    lines: list[str] = []
    lines.append(f"class {factory_name}:")
    lines.append(f'    """app.{display_alias}.xxx() 工厂方法类型桩。"""')
    lines.append("")
    lines.append("    def __init__(self, app: Any) -> None: ...")
    lines.append("")
    for cls_name, cls in classes:
        lines.extend(_build_method_lines(cls_name, cls, mod_alias=mod_alias, has_children=has_children))
    return lines


def generate() -> str:
    # 检测是否需要 import pandas
    needs_pd = False
    for mod in (diy_layout, diy_pane, diy_widgets):
        for _, cls in _collect(mod):
            for p in inspect.signature(cls.__init__).parameters.values():
                if p.name != "self" and "pd.DataFrame" in _format_type(p.annotation):
                    needs_pd = True

    lines: list[str] = []
    lines.append('"""Type stubs for _app.py — 由 tools/_generate_pyi.py 自动生成。"""')
    lines.append("")
    lines.append("from __future__ import annotations")
    lines.append("from typing import Any")
    if needs_pd:
        lines.append("import pandas as pd")
    lines.append("")
    lines.append("from . import layout as _layout")
    lines.append("from . import pane as _pane")
    lines.append("from . import widgets as _widgets")
    lines.append("")
    lines.append("")
    lines.append("# ── _LayoutFactory ─────────────────────────────────")
    lines.extend(_generate_factory("_LayoutFactory", diy_layout, "_layout", has_children=True))
    lines.append("")
    lines.append("# ── _PaneFactory ───────────────────────────────────")
    lines.extend(_generate_factory("_PaneFactory", diy_pane, "_pane"))
    lines.append("")
    lines.append("# ── _WidgetsFactory ────────────────────────────────")
    lines.extend(_generate_factory("_WidgetsFactory", diy_widgets, "_widgets"))
    lines.append("")
    lines.append("")
    lines.append("# ── PanelApp ───────────────────────────────────────")
    lines.append("import diy.ui")
    lines.append("")
    lines.append("class PanelApp(diy.ui.BaseApp):")
    lines.append('    """Panel 专属 diy.ui App。"""')
    lines.append("")
    lines.append("    layout: _LayoutFactory")
    lines.append("    pane: _PaneFactory")
    lines.append("    widgets: _WidgetsFactory")
    lines.append("    provider: str")
    lines.append("")
    lines.append("    def __init__(self, *, config: Any = ...) -> None: ...")
    lines.append("    def servable(self) -> None: ...")
    lines.append("    def get_panel_roots(self) -> list[Any]: ...")
    lines.append("    def signal(self, value: Any) -> Any: ...")
    return "\n".join(lines) + "\n"


def main() -> None:
    new_content = generate()
    existing = PYI_PATH.read_text() if PYI_PATH.exists() else ""

    # 收集目标：源码目录 + 所有 site-packages 下的同名目录
    targets = {PYI_PATH}

    # 当前 venv
    import sysconfig
    for key in ("purelib", "platlib"):
        sp = sysconfig.get_paths().get(key, "")
        if sp:
            pkg_dir = Path(sp) / "diy" / "ui" / "providers" / "panel"
            if pkg_dir.exists():
                targets.add(pkg_dir / "_app.pyi")

    # 扫描 monorepo 下所有 venv 的 site-packages
    monorepo_root = Path(__file__).resolve().parent.parent.parent.parent.parent  # ~/git/diy/
    for sp_dir in monorepo_root.glob("*/venv/lib/python*/site-packages/diy/ui/providers/panel"):
        targets.add(sp_dir / "_app.pyi")
    for sp_dir in monorepo_root.glob("*/.venv/lib/python*/site-packages/diy/ui/providers/panel"):
        targets.add(sp_dir / "_app.pyi")

    changed_any = False
    for t in targets:
        t.parent.mkdir(parents=True, exist_ok=True)
        if t.read_text() if t.exists() else "" != new_content:
            t.write_text(new_content)
            changed_any = True
            print(f"✅ 写入 {t}")

    if changed_any:
        line_count = len(new_content.splitlines())
        total_wrappers = 0
        total_params = 0
        for mod in (diy_layout, diy_pane, diy_widgets):
            classes = _collect(mod)
            total_wrappers += len(classes)
            for _, cls in classes:
                total_params += sum(1 for p in inspect.signature(cls.__init__).parameters.values() if p.name != "self")
        print(f"   {total_wrappers} 个 wrapper 类, {total_params} 个显式参数")
    else:
        print("⏭️ 无变化，跳过")


if __name__ == "__main__":
    main()
