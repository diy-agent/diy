"""Panel 组件诊断工具：适配状态 + 参数一致性。

用法:
  uv run python tools/doctor_panel.py list                  # 组件适配列表
  uv run python tools/doctor_panel.py list -g widgets       # 仅 widgets
  uv run python tools/doctor_panel.py list -g pane          # 仅 pane
  uv run python tools/doctor_panel.py list -g layout        # 仅 layout
  uv run python tools/doctor_panel.py doctor                # 参数一致性诊断
  uv run python tools/doctor_panel.py query -n Button       # 查询参数签名
"""

from __future__ import annotations

import inspect
import sys
from dataclasses import dataclass, field
from typing import Annotated, Any, get_type_hints

import cyclopts
import panel as pn
import param

from diyui.providers.panel import (
    PanelButton,
    PanelCard,
    PanelColumn,
    PanelMarkdown,
    PanelRadioButtonGroup,
    PanelRow,
    PanelTextInput,
)

# ── 已适配: diyui wrapper → Panel 原生类 ──────────────────────

_WRAPPER_MAP: dict[type, type] = {
    PanelColumn: pn.Column,
    PanelRow: pn.Row,
    PanelCard: pn.Card,
    PanelMarkdown: pn.pane.Markdown,
    PanelButton: pn.widgets.Button,
    PanelTextInput: pn.widgets.TextInput,
    PanelRadioButtonGroup: pn.widgets.RadioButtonGroup,
}

# Panel 原生类 → diyui wrapper 名（list 命令用）
_PN_TO_WRAPPER: dict[type, str] = {v: k.__name__ for k, v in _WRAPPER_MAP.items()}

# ── param 类型 → Python 类型映射 ──────────────────────────────

_PARAM_TYPE_MAP: dict[type, type] = {
    param.String: str,
    param.Integer: int,
    param.Number: float,
    param.Boolean: bool,
    param.List: list,
    param.Dict: dict,
    param.Tuple: tuple,
    param.ClassSelector: type,
    param.Selector: object,
    param.Color: str,
    param.Date: str,
    param.Range: tuple,
    param.Path: str,
    param.Event: object,
}

# ── 排除参数 ──────────────────────────────────────────────────

_COMMON_EXCLUDED: set[str] = {
    "objects",
}

_WRAPPER_EXCLUDED: dict[type, set[str]] = {
    PanelTextInput: {
        "value_input",
        "enter_pressed",
    },
    PanelButton: {
        "clicks",
    },
}

# ── list 命令用：模块收集 ─────────────────────────────────────

_MODULE_SPECS: list[tuple[Any, str]] = [
    (pn.layout, "panel.layout"),
    (pn.pane, "panel.pane"),
    (pn.widgets, "panel.widgets"),
]

_EXCLUDED_CLASSES: set[type] = {
    pn.viewable.Viewable,
    pn.layout.base.Panel,
    pn.layout.base.ListPanel,
    pn.pane.base.Pane,
    pn.widgets.base.Widget,
    pn.widgets.base.CompositeWidget,
    pn.widgets.base.Reactive,
}


# ── 数据类 ────────────────────────────────────────────────────


@dataclass
class PanelParam:
    name: str
    default: Any
    py_type: str
    param_cls: str


@dataclass
class WrapperCheck:
    wrapper_name: str
    panel_name: str
    panel_params: list[PanelParam] = field(default_factory=list)
    wrapper_params: dict[str, str] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)


# ═══════════════════════════════════════════════════════════════
# list 命令
# ═══════════════════════════════════════════════════════════════


def _collect_leaves() -> list[tuple[str, type]]:
    """从 pn.widgets/pn.layout/pn.pane 直接属性收集 Viewable 叶子类。"""
    seen: dict[type, str] = {}
    for mod, mod_path in _MODULE_SPECS:
        for name in sorted(dir(mod)):
            if name.startswith("_"):
                continue
            obj = getattr(mod, name, None)
            if not isinstance(obj, type):
                continue
            if not issubclass(obj, pn.viewable.Viewable):
                continue
            if obj in _EXCLUDED_CLASSES:
                continue
            if not getattr(obj, "__module__", "").startswith("panel."):
                continue
            full_name = f"{mod_path}.{name}"
            if obj not in seen:
                seen[obj] = full_name
    return sorted(seen.items(), key=lambda x: x[1])


def _print_list(group: str | None = None) -> None:
    entries = _collect_leaves()
    if group is not None:
        prefix = f"panel.{group}."
        entries = [(cls, name) for cls, name in entries if name.startswith(prefix)]

    adapted = sum(1 for cls, _ in entries if cls in _PN_TO_WRAPPER)
    total = len(entries)

    current_prefix: str | None = None
    for cls, full_name in entries:
        parts = full_name.rsplit(".", 1)
        prefix = parts[0] if len(parts) > 1 else full_name
        if prefix != current_prefix:
            current_prefix = prefix
            print(f"\n# {prefix}")

        wrapper = _PN_TO_WRAPPER.get(cls)
        if wrapper:
            print(f"  ✅ {full_name}  →  {wrapper}")
        else:
            print(f"  ❌ {full_name}")

    print(f"\n{'═' * 64}")
    print(f"  已适配: {adapted}/{total}  待适配: {total - adapted}")
    print(f"{'═' * 64}")


# ═══════════════════════════════════════════════════════════════
# doctor 命令（原 check_panel_params 诊断）
# ═══════════════════════════════════════════════════════════════


def _infer_param_type(p: param.Parameter) -> str:
    py_base = "Any"
    for param_cls, py_type in _PARAM_TYPE_MAP.items():
        if isinstance(p, param_cls):
            py_base = py_type.__name__
            break
    cls_ = getattr(p, "class_", None)
    if cls_ is not None:
        if isinstance(cls_, tuple):
            names = [getattr(c, "__name__", str(c)) for c in cls_ if c is not type(None)]
            py_base = " | ".join(names) if names else "Any"
        else:
            py_base = getattr(cls_, "__name__", str(cls_))
    if p.allow_None:
        return f"{py_base} | None"
    return py_base


def extract_panel_params(panel_cls: type) -> list[PanelParam]:
    result: list[PanelParam] = []
    for name in panel_cls.param:
        if name == "name":
            continue
        p = panel_cls.param[name]
        result.append(PanelParam(name=name, default=p.default, py_type=_infer_param_type(p), param_cls=type(p).__name__))
    return result


def extract_wrapper_params(wrapper_cls: type) -> dict[str, str]:
    try:
        sig = inspect.signature(wrapper_cls.__init__)
    except (ValueError, TypeError):
        return {}
    try:
        hints = get_type_hints(wrapper_cls.__init__)
    except Exception:
        hints = {}
    explicit: dict[str, str] = {}
    for name, p in sig.parameters.items():
        if name in ("self", "args", "kwargs"):
            continue
        if p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        if name in hints:
            hint = hints[name]
            origin = getattr(hint, "__origin__", None)
            if origin is not None:
                args = getattr(hint, "__args__", ())
                parts: list[str] = []
                for a in args:
                    if a is type(None):  # noqa: E721
                        parts.append("None")
                    else:
                        parts.append(getattr(a, "__name__", str(a)))
                explicit[name] = " | ".join(parts)
            else:
                explicit[name] = getattr(hint, "__name__", str(hint))
        else:
            explicit[name] = "Any"
    return explicit


def check_wrapper(wrapper_cls: type, panel_cls: type) -> WrapperCheck:
    panel_params = extract_panel_params(panel_cls)
    wrapper_params = extract_wrapper_params(wrapper_cls)
    excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(wrapper_cls, set())
    missing: list[str] = []
    for pp in panel_params:
        if pp.name in excluded:
            continue
        if pp.name not in wrapper_params:
            missing.append(pp.name)
    return WrapperCheck(wrapper_name=wrapper_cls.__name__, panel_name=panel_cls.__name__, panel_params=panel_params, wrapper_params=wrapper_params, missing=missing)


def run_checks() -> list[WrapperCheck]:
    return [check_wrapper(w, p) for w, p in _WRAPPER_MAP.items()]


def _get_wrapper_cls(name: str) -> type | None:
    for cls in _WRAPPER_MAP:
        if cls.__name__ == name:
            return cls
    return None


def _print_report(checks: list[WrapperCheck]) -> int:
    total_kwargs_params = 0
    total_strict_missing = 0
    for c in checks:
        excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(_get_wrapper_cls(c.wrapper_name), set())
        print(f"\n{'─' * 70}")
        print(f"  📦 {c.wrapper_name}  ←  panel {c.panel_name}")
        print(f"{'─' * 70}")
        if c.missing:
            print("  ⚠️  以下参数未显式定义，需强类型化:\n")
        print(f"  {'Param':<24} {'默认值':<22} {'Panel 类型':<18} 状态")
        print(f"  {'─' * 24} {'─' * 22} {'─' * 18} ─────")
        for pp in c.panel_params:
            default_str = repr(pp.default)
            if len(default_str) > 21:
                default_str = default_str[:18] + "…"
            if pp.name in excluded:
                status = "✓ 排除"
            elif pp.name in c.wrapper_params:
                status = f"✓ 已定义 :{c.wrapper_params[pp.name]}"
            else:
                status = "✗ 未定义"
                total_strict_missing += 1
            print(f"  {pp.name:<24} {default_str:<22} {pp.py_type:<18} {status}")
        panel_total = len(c.panel_params)
        excluded_count = sum(1 for pp in c.panel_params if pp.name in excluded)
        defined = sum(1 for pp in c.panel_params if pp.name in c.wrapper_params)
        undefined = panel_total - excluded_count - defined
        print(f"\n  汇总: {panel_total} Panel 参数 → {excluded_count} 排除, {defined} 已显式定义, {undefined} 未定义")
    print(f"\n{'═' * 70}")
    print(f"  总计: {total_strict_missing} 个参数未定义")
    print(f"{'═' * 70}")
    return total_strict_missing


# ═══════════════════════════════════════════════════════════════
# query 命令
# ═══════════════════════════════════════════════════════════════


def _find_panel_class(name: str) -> type | None:
    clean = name.removeprefix("pn.")
    for cls in _WRAPPER_MAP.values():
        cls_full = f"{cls.__module__}.{cls.__qualname__}"
        cls_short = cls.__qualname__
        if clean in (cls_full, cls_short):
            return cls
    candidates: dict[str, type] = {}
    for mod_name in ("", "widgets", "pane", "layout", "indicators"):
        mod = pn
        if mod_name:
            try:
                mod = getattr(pn, mod_name)
            except AttributeError:
                continue
        for attr in dir(mod):
            if attr.startswith("_"):
                continue
            obj = getattr(mod, attr)
            if not isinstance(obj, type):
                continue
            key_full = f"{obj.__module__}.{obj.__qualname__}"
            key_short = obj.__qualname__
            if mod_name:
                key_dotted = f"{mod_name}.{obj.__qualname__}"
                candidates[key_dotted] = obj
            candidates[key_short] = obj
            candidates[key_full] = obj
    return candidates.get(clean)


def _format_default(val: Any) -> str:
    if val is None:
        return "None"
    if isinstance(val, bool):
        return str(val)
    if isinstance(val, str):
        return repr(val)
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, (list, tuple, dict, set)):
        return repr(val)
    if isinstance(val, type):
        return val.__name__
    r = repr(val)
    if len(r) > 40:
        r = r[:37] + "…"
    return r


def _query_class(panel_cls: type) -> None:
    params = extract_panel_params(panel_cls)
    try:
        sig = inspect.signature(panel_cls.__init__)
        has_vargs = any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in sig.parameters.values())
    except (ValueError, TypeError):
        has_vargs = False
    cls_path = f"{panel_cls.__module__}.{panel_cls.__qualname__}"
    print(f"\n# {cls_path}")
    print(f"# 共 {len(params)} 个 param 参数\n")
    print("def __init__(")
    print("    self,")
    if has_vargs:
        print("    *children: Any,")
    for pp in params:
        print(f"    {pp.name}: {pp.py_type} = {_format_default(pp.default)},")
    print(") -> None: ...")


# ═══════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════

app = cyclopts.App(
    name="doctor_panel",
    help="Panel 组件诊断工具：适配状态 + 参数一致性。",
    version="0.2.0",
)


@app.command
def list(
    group: Annotated[
        str | None,
        cyclopts.Parameter(
            name=("--group", "-g"),
            help="仅显示指定分组: widgets / pane / layout",
        ),
    ] = None,
) -> None:
    """列出所有 Panel 组件及 diyui 适配状态。"""
    _print_list(group)


@app.command
def doctor() -> None:
    """诊断模式：对比所有 diyui wrapper 与原生 Panel 的参数一致性。"""
    checks = run_checks()
    missing = _print_report(checks)
    if missing > 0:
        print(f"\n❌ {missing} 个参数未定义")
        sys.exit(1)
    print("\n✅ 所有参数已强类型化")


@app.command
def query(
    name: Annotated[
        str,
        cyclopts.Parameter(name=("--name", "-n"), help='Panel 类名，如 "Button"、"widgets.Button"'),
    ],
) -> None:
    """查询原生 Panel 类的 __init__ 参数签名（支持模糊匹配）。"""
    cls = _find_panel_class(name)
    if cls is None:
        print(f"❌ 未找到 Panel 类: {name}")
        sys.exit(1)
    _query_class(cls)




if __name__ == "__main__":
    app()
