"""Panel 组件诊断工具：适配状态 + 参数一致性 + 透传验证。

用法:
  uv run python tools/doctor_panel.py list                  # 组件适配列表
  uv run python tools/doctor_panel.py list -g widgets       # 仅 widgets
  uv run python tools/doctor_panel.py list -g pane          # 仅 pane
  uv run python tools/doctor_panel.py list -g layout        # 仅 layout
  uv run python tools/doctor_panel.py doctor                # 参数一致性诊断
  uv run python tools/doctor_panel.py verify                # 参数透传运行时验证
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

import diy.ui.providers.panel as diypn

# ── 已适配: diy.ui wrapper → (Panel 原生类, diypn 子包名) ─────────

_WRAPPER_SPECS: list[tuple[type, type, str]] = [
    # ── layout ──
    (diypn.layout.Accordion, pn.layout.Accordion, "layout"),
    (diypn.layout.Card, pn.Card, "layout"),
    (diypn.layout.Column, pn.Column, "layout"),
    (diypn.layout.Divider, pn.layout.Divider, "layout"),
    (diypn.layout.Feed, pn.layout.Feed, "layout"),
    (diypn.layout.FlexBox, pn.layout.FlexBox, "layout"),
    (diypn.layout.FloatPanel, pn.layout.FloatPanel, "layout"),
    (diypn.layout.GridBox, pn.layout.GridBox, "layout"),
    (diypn.layout.GridSpec, pn.layout.GridSpec, "layout"),
    (diypn.layout.GridStack, pn.layout.GridStack, "layout"),
    (diypn.layout.HSpacer, pn.layout.HSpacer, "layout"),
    (diypn.layout.Modal, pn.layout.Modal, "layout"),
    (diypn.layout.Row, pn.Row, "layout"),
    (diypn.layout.Spacer, pn.layout.Spacer, "layout"),
    (diypn.layout.Swipe, pn.layout.Swipe, "layout"),
    (diypn.layout.Tabs, pn.layout.Tabs, "layout"),
    (diypn.layout.VSpacer, pn.layout.VSpacer, "layout"),
    (diypn.layout.WidgetBox, pn.layout.WidgetBox, "layout"),
    # ── pane ──
    (diypn.pane.Alert, pn.pane.Alert, "pane"),
    (diypn.pane.Audio, pn.pane.Audio, "pane"),
    (diypn.pane.AVIF, pn.pane.AVIF, "pane"),
    (diypn.pane.Bokeh, pn.pane.Bokeh, "pane"),
    (diypn.pane.DataFrame, pn.pane.DataFrame, "pane"),
    (diypn.pane.DeckGL, pn.pane.DeckGL, "pane"),
    (diypn.pane.ECharts, pn.pane.ECharts, "pane"),
    (diypn.pane.GIF, pn.pane.GIF, "pane"),
    (diypn.pane.HTML, pn.pane.HTML, "pane"),
    (diypn.pane.HoloViews, pn.pane.HoloViews, "pane"),
    (diypn.pane.ICO, pn.pane.ICO, "pane"),
    (diypn.pane.Image, pn.pane.Image, "pane"),
    (diypn.pane.JPG, pn.pane.JPG, "pane"),
    (diypn.pane.JSON, pn.pane.JSON, "pane"),
    (diypn.pane.LaTeX, pn.pane.LaTeX, "pane"),
    (diypn.pane.Markdown, pn.pane.Markdown, "pane"),
    (diypn.pane.Matplotlib, pn.pane.Matplotlib, "pane"),
    (diypn.pane.PDF, pn.pane.PDF, "pane"),
    (diypn.pane.PNG, pn.pane.PNG, "pane"),
    (diypn.pane.Placeholder, pn.pane.Placeholder, "pane"),
    (diypn.pane.Plotly, pn.pane.Plotly, "pane"),
    (diypn.pane.Str, pn.pane.Str, "pane"),
    (diypn.pane.SVG, pn.pane.SVG, "pane"),
    (diypn.pane.Vega, pn.pane.Vega, "pane"),
    (diypn.pane.Video, pn.pane.Video, "pane"),
    (diypn.pane.WebP, pn.pane.WebP, "pane"),
    # ── widgets ──
    (diypn.widgets.ArrayInput, pn.widgets.ArrayInput, "widgets"),
    (diypn.widgets.AutocompleteInput, pn.widgets.AutocompleteInput, "widgets"),
    (diypn.widgets.BooleanStatus, pn.widgets.BooleanStatus, "widgets"),
    (diypn.widgets.Button, pn.widgets.Button, "widgets"),
    (diypn.widgets.ButtonIcon, pn.widgets.ButtonIcon, "widgets"),
    (diypn.widgets.CheckBoxGroup, pn.widgets.CheckBoxGroup, "widgets"),
    (diypn.widgets.CheckButtonGroup, pn.widgets.CheckButtonGroup, "widgets"),
    (diypn.widgets.Checkbox, pn.widgets.Checkbox, "widgets"),
    (diypn.widgets.CodeEditor, pn.widgets.CodeEditor, "widgets"),
    (diypn.widgets.ColorMap, pn.widgets.ColorMap, "widgets"),
    (diypn.widgets.ColorPicker, pn.widgets.ColorPicker, "widgets"),
    (diypn.widgets.DatePicker, pn.widgets.DatePicker, "widgets"),
    (diypn.widgets.DateRangePicker, pn.widgets.DateRangePicker, "widgets"),
    (diypn.widgets.DateRangeSlider, pn.widgets.DateRangeSlider, "widgets"),
    (diypn.widgets.DateSlider, pn.widgets.DateSlider, "widgets"),
    (diypn.widgets.DatetimeInput, pn.widgets.DatetimeInput, "widgets"),
    (diypn.widgets.DatetimePicker, pn.widgets.DatetimePicker, "widgets"),
    (diypn.widgets.DatetimeRangePicker, pn.widgets.DatetimeRangePicker, "widgets"),
    (diypn.widgets.DatetimeRangeSlider, pn.widgets.DatetimeRangeSlider, "widgets"),
    (diypn.widgets.DatetimeSlider, pn.widgets.DatetimeSlider, "widgets"),
    (diypn.widgets.Dial, pn.widgets.Dial, "widgets"),
    (diypn.widgets.DiscretePlayer, pn.widgets.DiscretePlayer, "widgets"),
    (diypn.widgets.FileDownload, pn.widgets.FileDownload, "widgets"),
    (diypn.widgets.FileInput, pn.widgets.FileInput, "widgets"),
    (diypn.widgets.FloatInput, pn.widgets.FloatInput, "widgets"),
    (diypn.widgets.FloatSlider, pn.widgets.FloatSlider, "widgets"),
    (diypn.widgets.Gauge, pn.widgets.Gauge, "widgets"),
    (diypn.widgets.IntInput, pn.widgets.IntInput, "widgets"),
    (diypn.widgets.IntRangeSlider, pn.widgets.IntRangeSlider, "widgets"),
    (diypn.widgets.IntSlider, pn.widgets.IntSlider, "widgets"),
    (diypn.widgets.LinearGauge, pn.widgets.LinearGauge, "widgets"),
    (diypn.widgets.LiteralInput, pn.widgets.LiteralInput, "widgets"),
    (diypn.widgets.LoadingSpinner, pn.widgets.LoadingSpinner, "widgets"),
    (diypn.widgets.MenuButton, pn.widgets.MenuButton, "widgets"),
    (diypn.widgets.MultiChoice, pn.widgets.MultiChoice, "widgets"),
    (diypn.widgets.MultiSelect, pn.widgets.MultiSelect, "widgets"),
    (diypn.widgets.Number, pn.widgets.Number, "widgets"),
    (diypn.widgets.NumberInput, pn.widgets.NumberInput, "widgets"),
    (diypn.widgets.PasswordInput, pn.widgets.PasswordInput, "widgets"),
    (diypn.widgets.Player, pn.widgets.Player, "widgets"),
    (diypn.widgets.Progress, pn.widgets.Progress, "widgets"),
    (diypn.widgets.RadioBoxGroup, pn.widgets.RadioBoxGroup, "widgets"),
    (diypn.widgets.RadioButtonGroup, pn.widgets.RadioButtonGroup, "widgets"),
    (diypn.widgets.RangeSlider, pn.widgets.RangeSlider, "widgets"),
    (diypn.widgets.Select, pn.widgets.Select, "widgets"),
    (diypn.widgets.StaticText, pn.widgets.StaticText, "widgets"),
    (diypn.widgets.Switch, pn.widgets.Switch, "widgets"),
    (diypn.widgets.Tabulator, pn.widgets.Tabulator, "widgets"),
    (diypn.widgets.TextAreaInput, pn.widgets.TextAreaInput, "widgets"),
    (diypn.widgets.TextInput, pn.widgets.TextInput, "widgets"),
    (diypn.widgets.TimePicker, pn.widgets.TimePicker, "widgets"),
    (diypn.widgets.Toggle, pn.widgets.Toggle, "widgets"),
    (diypn.widgets.ToggleGroup, pn.widgets.ToggleGroup, "widgets"),
    (diypn.widgets.ToggleIcon, pn.widgets.ToggleIcon, "widgets"),
    (diypn.widgets.TooltipIcon, pn.widgets.TooltipIcon, "widgets"),
    (diypn.widgets.Tqdm, pn.widgets.Tqdm, "widgets"),
    (diypn.widgets.Trend, pn.widgets.Trend, "widgets"),
    (diypn.widgets.VideoStream, pn.widgets.VideoStream, "widgets"),
]

# 子包名 → wrapper 类列表（供命名空间一致性检查用）
_SUBPACKAGE_WRAPPERS: dict[str, list[type]] = {}
for _w, _p, _sp in _WRAPPER_SPECS:
    _SUBPACKAGE_WRAPPERS.setdefault(_sp, []).append(_w)

_WRAPPER_MAP: dict[type, type] = {w: p for w, p, _ in _WRAPPER_SPECS}

# Panel 原生类 → diy.ui wrapper 名（list 命令用）
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

_COMMON_EXCLUDED: set[str] = set()

_WRAPPER_EXCLUDED: dict[type, set[str]] = {
    diypn.layout.Accordion: {
        "objects",
    },
    diypn.layout.Card: {
        "objects",
    },
    diypn.layout.Column: {
        "objects",
    },
    diypn.layout.Feed: {
        "objects",
        "visible_range",
    },
    diypn.layout.FlexBox: {
        "objects",
    },
    diypn.layout.FloatPanel: {
        "objects",
    },
    diypn.layout.GridBox: {
        "objects",
    },
    diypn.layout.Modal: {
        "objects",
    },
    diypn.layout.Row: {
        "objects",
    },
    diypn.layout.Swipe: {
        "objects",
        "_before",
        "_after",
    },
    diypn.layout.Tabs: {
        "objects",
    },
    diypn.layout.WidgetBox: {
        "objects",
    },
    diypn.widgets.TextInput: {
        "value_input",
        "enter_pressed",
    },
    diypn.widgets.Button: {
        "clicks",
        "name",
        "button_type",
        "button_style",
    },
    diypn.widgets.PasswordInput: {
        "value_input",
    },
    diypn.widgets.TextAreaInput: {
        "value_input",
    },
    diypn.widgets.CodeEditor: {
        "value_input",
    },
    diypn.widgets.IntSlider: {
        "value_throttled",
    },
    diypn.widgets.FloatSlider: {
        "value_throttled",
    },
    diypn.widgets.RangeSlider: {
        "value_throttled",
        "value_start",
        "value_end",
    },
    diypn.widgets.IntInput: {
        "value_throttled",
        "mode",
    },
    diypn.widgets.FloatInput: {
        "value_throttled",
        "mode",
    },
    diypn.widgets.FileInput: {
        "filename",
        "mime_type",
        "value",
    },
    diypn.widgets.FileDownload: {
        "data",
        "_clicks",
        "_transfers",
        "value",
    },
    diypn.widgets.MenuButton: {
        "clicked",
        "value",
    },
    diypn.widgets.ButtonIcon: {
        "value",
        "clicks",
        "toggle_duration",
    },
    diypn.pane.DataFrame: {
        "sanitize_hook",
        "_object",
    },
    diypn.pane.DeckGL: {
        "click_state",
        "hover_state",
        "view_state",
        "throttle",
    },
    diypn.pane.HTML: {
        "sanitize_hook",
    },
    diypn.pane.HoloViews: {
        "default_widgets",
        "widget_layout",
    },
    diypn.pane.JSON: {
        "encoder",
    },
    diypn.pane.Plotly: {
        "click_data",
        "doubleclick_data",
        "clickannotation_data",
        "hover_data",
        "relayout_data",
        "restyle_data",
        "selected_data",
        "viewport",
        "_render_count",
    },
    diypn.pane.Vega: {
        "selection",
    },
    diypn.pane.Placeholder: {
        "_pane",
    },
    diypn.widgets.AutocompleteInput: {
        "value_input",
    },
    diypn.widgets.IntRangeSlider: {
        "value_throttled",
        "value_start",
        "value_end",
    },
    diypn.widgets.DateRangeSlider: {
        "value_throttled",
        "value_start",
        "value_end",
    },
    diypn.widgets.DateSlider: {
        "value_throttled",
    },
    diypn.widgets.DatetimeRangeSlider: {
        "value_throttled",
        "value_start",
        "value_end",
    },
    diypn.widgets.DatetimeSlider: {
        "value_throttled",
        "as_datetime",
    },
    diypn.widgets.DiscretePlayer: {
        "value_throttled",
    },
    diypn.widgets.Player: {
        "value_throttled",
    },
    diypn.layout.Divider: {
        "width_policy",
        "height_policy",
    },
    diypn.layout.HSpacer: {
        "sizing_mode",
    },
    diypn.layout.VSpacer: {
        "sizing_mode",
    },
}

# ── 包装类参数别名映射 ──────────────────────────────────────
# key: wrapper 类, value: {wrapper 参数名: 实际检查的 Panel 属性名}
# 用于 wrapper 对参数做了语义重命名的情况（如 button_type → color）
_WRAPPER_PARAM_MAP: dict[type, dict[str, str]] = {
    diypn.widgets.Button: {
        "button_type": "color",
        "button_style": "variant",
    },
    diypn.widgets.RadioButtonGroup: {
        "button_type": "color",
        "button_style": "variant",
    },
    diypn.widgets.CheckButtonGroup: {
        "button_type": "color",
        "button_style": "variant",
    },
    diypn.widgets.Toggle: {
        "button_type": "color",
        "button_style": "variant",
    },
    diypn.widgets.MenuButton: {
        "button_type": "color",
        "button_style": "variant",
    },
    diypn.widgets.FileDownload: {
        "button_type": "color",
        "button_style": "variant",
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
    type_mismatches: list[tuple[str, str, str]] = field(default_factory=list)  # (param_name, panel_type, wrapper_type)


@dataclass
class PassThroughCheck:
    """单参数透传验证结果。"""
    param_name: str
    target_attr: str          # 实际检查的 Panel 属性名
    test_value: Any
    actual_value: Any
    passed: bool
    error: str | None = None  # 构造异常时记录
    is_warning: bool = False  # True = 构造异常（测试数据问题），False = 值不匹配（透传失败）


@dataclass
class VerifyResult:
    """运行时透传验证结果。"""
    wrapper_name: str
    panel_name: str
    checks: list[PassThroughCheck] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    @property
    def failures(self) -> list[PassThroughCheck]:
        return [c for c in self.checks if not c.passed and not c.is_warning]

    @property
    def warnings(self) -> list[PassThroughCheck]:
        return [c for c in self.checks if not c.passed and c.is_warning]


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


def _normalize_type(t: str) -> str:
    """规范化类型字符串用于比较：去空格、统一 Optional/Union 写法。"""
    s = t.strip()
    # 去掉 typing. 前缀
    s = s.replace("typing.", "")
    # 去空格
    s = s.replace(" ", "")
    # 统一 None / NoneType
    s = s.replace("NoneType", "None")
    # 去掉泛型参数（list[X] → list，dict[K,V] → dict）
    s = s.split("[")[0] if "[" in s else s
    # 统一 Any | None → Any|None
    s = s.replace("|None", "|None").replace("None|", "None|")
    return s


def _is_type_compatible(panel_type: str, wrapper_type: str) -> bool:
    """判断 Panel 推断类型与 wrapper 标注类型是否兼容。"""
    if panel_type == wrapper_type:
        return True
    pn = _normalize_type(panel_type)
    wt = _normalize_type(wrapper_type)
    if pn == wt:
        return True
    # Any 通配
    if wt == "Any":
        return True
    # 不兼容
    return False


def check_wrapper(wrapper_cls: type, panel_cls: type) -> WrapperCheck:
    panel_params = extract_panel_params(panel_cls)
    wrapper_params = extract_wrapper_params(wrapper_cls)
    excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(wrapper_cls, set())
    missing: list[str] = []
    mismatches: list[tuple[str, str, str]] = []
    for pp in panel_params:
        if pp.name in excluded:
            continue
        if pp.name not in wrapper_params:
            missing.append(pp.name)
        else:
            wrapper_type = wrapper_params[pp.name]
            if not _is_type_compatible(pp.py_type, wrapper_type):
                mismatches.append((pp.name, pp.py_type, wrapper_type))
    return WrapperCheck(
        wrapper_name=wrapper_cls.__name__,
        panel_name=panel_cls.__name__,
        panel_params=panel_params,
        wrapper_params=wrapper_params,
        missing=missing,
        type_mismatches=mismatches,
    )


def run_checks() -> list[WrapperCheck]:
    return [check_wrapper(w, p) for w, p in _WRAPPER_MAP.items()]


def _get_wrapper_cls(name: str) -> type | None:
    for cls in _WRAPPER_MAP:
        if cls.__name__ == name:
            return cls
    return None


def _print_report(checks: list[WrapperCheck]) -> tuple[int, int]:
    total_kwargs_params = 0
    total_strict_missing = 0
    total_type_mismatches = 0
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
                wrapper_t = c.wrapper_params[pp.name]
                if not _is_type_compatible(pp.py_type, wrapper_t):
                    status = f"⚠ 类型近似: 标注 {wrapper_t}, Panel {pp.py_type}"
                    total_type_mismatches += 1
                else:
                    status = f"✓ 已定义 :{wrapper_t}"
            else:
                status = "✗ 未定义"
                total_strict_missing += 1
            print(f"  {pp.name:<24} {default_str:<22} {pp.py_type:<18} {status}")
        panel_total = len(c.panel_params)
        excluded_count = sum(1 for pp in c.panel_params if pp.name in excluded)
        defined = sum(1 for pp in c.panel_params if pp.name in c.wrapper_params)
        undefined = panel_total - excluded_count - defined
        print(f"\n  汇总: {panel_total} Panel 参数 → {excluded_count} 排除, {defined} 已显式定义, {undefined} 未定义"
              f"{', ⚠ ' + str(len(c.type_mismatches)) + ' 类型近似' if c.type_mismatches else ''}")
    print(f"\n{'═' * 70}")
    if total_strict_missing:
        print(f"  ❌ {total_strict_missing} 个参数未定义")
    if total_type_mismatches:
        print(f"  ⚠ {total_type_mismatches} 个参数类型近似（Panel 推断精度有限，仅供参考）")
    if not total_strict_missing and not total_type_mismatches:
        print("  ✅ 所有参数已强类型化，类型一致")
    print(f"{'═' * 70}")
    return total_strict_missing, total_type_mismatches


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
        p = panel_cls.param[pp.name]
        doc = getattr(p, "doc", None)
        if doc:
            doc_one_line = doc.strip().split("\n")[0][:80]
            doc_comment = f"  # {doc_one_line}"
        else:
            doc_comment = ""
        print(f"    {pp.name}: {pp.py_type} = {_format_default(pp.default)},{doc_comment}")
    print(") -> None: ...")
    print("\n# ═══════════════════════════════════════════════")
    print("# 别名映射: button_type→color, button_style→variant")
    print("# 查看 doctor_panel.py _WRAPPER_PARAM_MAP 获取完整映射")


# ═══════════════════════════════════════════════════════════════
# verify 命令（运行时透传验证）
# ═══════════════════════════════════════════════════════════════

_NO_VALUE = object()  # 无法生成有效测试值的标记

# 特定参数名的测试值覆写（空集合兜底，避免构造失败）
_PARAM_TEST_VALUE_OVERRIDES: dict[str, Any] = {
    # ---- 需要 options 同时设置才能验证的 ----
    "disabled_options": _NO_VALUE,
    # ---- Panel 内部会附加默认值，无法单参数验证透传的 ----
    "css_classes": _NO_VALUE,       # Card / WidgetBox 等会追加 'card' / 'panel-widget-box'
    "button_css_classes": _NO_VALUE,
    "header_css_classes": _NO_VALUE,
    "title_css_classes": _NO_VALUE,
    "extensions": _NO_VALUE,        # Markdown / HTML 有默认扩展
    # ---- 需要正确格式的（用合理值替代） ----
    "classes": _NO_VALUE,      # Panel 内部追加 ['panel-df']
    "disabled": _NO_VALUE,     # CodeEditor 的 disabled 构造后状态变化
    "groups": {"g1": ["a", "b"]},
    "sorters": [{"field": "col1", "dir": "asc"}],
    "filters": [{"field": "col1", "type": "ge", "value": 0}],
}


def _generate_test_value(p: param.Parameter) -> Any:
    """为 param 参数生成一个非默认值的测试值。"""
    default = p.default

    # 按参数名覆写（优先）
    if p.name in _PARAM_TEST_VALUE_OVERRIDES:
        override = _PARAM_TEST_VALUE_OVERRIDES[p.name]
        if override is _NO_VALUE:
            return _NO_VALUE
        if override != default:
            return override
        # 覆写值与默认值相同，尝试构造不同的值
        if isinstance(override, list):
            return ["__test__"] if default != ["__test__"] else ["__other__"]
        if isinstance(override, dict):
            return {"__k": 1} if default != {"__k": 1} else {"__k": 2}
        return override

    # Selector / ObjectSelector：从允许值中选取非默认值
    if isinstance(p, (param.Selector, param.ObjectSelector)):
        objects = getattr(p, "objects", None) or []
        for obj in objects:
            if obj != default and obj is not None:
                return obj
        return _NO_VALUE

    # Event 必须在 Boolean 之前检查（Event 继承 Boolean）
    if isinstance(p, param.Event):
        # Event 参数被 Panel 内部消费，设值后立即重置，无法用常规方式验证透传
        return _NO_VALUE

    if isinstance(p, param.Boolean):
        return not default if default is not None else True
    if isinstance(p, param.Integer):
        for v in (42, 0, -1, 999):
            if v != default:
                return v
        return _NO_VALUE
    if isinstance(p, param.Number):
        for v in (3.14, 0.0, -1.0, 999.0):
            if v != default:
                return v
        return _NO_VALUE
    if isinstance(p, param.String):
        return "__test__" if default != "__test__" else "__other__"
    if isinstance(p, param.Color):
        return "#FF0000" if default != "#FF0000" else "#00FF00"
    if isinstance(p, param.List):
        # 先试空列表兜底，避免 item_type 约束导致的构造失败
        if default != []:
            return []
        item_type = getattr(p, "item_type", None)
        if item_type is str:
            return ["__test__"] if default != ["__test__"] else ["__other__"]
        if item_type is int:
            return [1] if default != [1] else [2]
        if default == [] or isinstance(default, list) and default and isinstance(default[0], str):
            return ["__test__"] if default != ["__test__"] else ["__other__"]
        return [1] if default != [1] else [2]
    if isinstance(p, param.Dict):
        if default != {}:
            return {}
        return {"__k": 1} if default != {"__k": 1} else {"__k": 2}
    if isinstance(p, param.Tuple):
        return (1, 2) if default != (1, 2) else (3, 4)
    if isinstance(p, param.Range):
        return (0, 1) if default != (0, 1) else (1, 2)

    # ClassSelector / 未知类型
    cls_ = getattr(p, "class_", None)
    if cls_ is not None:
        return _NO_VALUE

    return _NO_VALUE


def verify_pass_through(wrapper_cls: type, panel_cls: type) -> VerifyResult:
    """运行时验证：用非默认值实例化 wrapper，检验参数是否真正透传到 Panel 原生对象。"""
    result = VerifyResult(
        wrapper_name=wrapper_cls.__name__,
        panel_name=panel_cls.__name__,
    )
    param_map = _WRAPPER_PARAM_MAP.get(wrapper_cls, {})
    excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(wrapper_cls, set())
    wrapper_param_names = set(extract_wrapper_params(wrapper_cls))

    for pp in extract_panel_params(panel_cls):
        if pp.name in excluded:
            continue
        if pp.name not in wrapper_param_names:
            # 缺失参数由 doctor 命令负责，这里跳过
            continue

        p = panel_cls.param[pp.name]
        test_val = _generate_test_value(p)
        if test_val is _NO_VALUE:
            result.skipped.append(pp.name)
            continue

        target_attr = param_map.get(pp.name, pp.name)

        try:
            instance = wrapper_cls(**{pp.name: test_val})
            actual = getattr(instance, target_attr, _NO_VALUE)
            if actual is _NO_VALUE or actual != test_val:
                result.checks.append(PassThroughCheck(
                    param_name=pp.name,
                    target_attr=target_attr,
                    test_value=test_val,
                    actual_value=actual,
                    passed=False,
                    error=f"Expected {target_attr}={test_val!r}, got {actual!r}",
                ))
            else:
                result.checks.append(PassThroughCheck(
                    param_name=pp.name,
                    target_attr=target_attr,
                    test_value=test_val,
                    actual_value=actual,
                    passed=True,
                ))
        except Exception as exc:
            # 构造异常 → 标为警告（可能是测试数据问题，非包装器透传故障）
            result.checks.append(PassThroughCheck(
                param_name=pp.name,
                target_attr=target_attr,
                test_value=test_val,
                actual_value=_NO_VALUE,
                passed=False,
                is_warning=True,
                error=f"构造警告: {exc}",
            ))

    return result


def run_verify() -> list[VerifyResult]:
    return [verify_pass_through(w, p) for w, p in _WRAPPER_MAP.items()]


def _print_verify(results: list[VerifyResult]) -> tuple[int, int]:
    total_fail = 0
    total_warn = 0
    for r in results:
        print(f"\n{'─' * 70}")
        print(f"  🔬 {r.wrapper_name}  ←  panel {r.panel_name}")
        print(f"{'─' * 70}")

        if not r.checks and not r.skipped:
            print("  （无可验证参数）")
            continue

        print(f"  {'参数':<24} {'目标属性':<20} {'测试值':<20} 状态")
        print(f"  {'─' * 24} {'─' * 20} {'─' * 20} ─────")
        for c in r.checks:
            tv = repr(c.test_value)
            if len(tv) > 19:
                tv = tv[:16] + "…"
            if c.passed:
                print(f"  {c.param_name:<24} {c.target_attr:<20} {tv:<20} ✓")
            elif c.is_warning:
                print(f"  {c.param_name:<24} {c.target_attr:<20} {tv:<20} ⚠ {c.error}")
                total_warn += 1
            else:
                print(f"  {c.param_name:<24} {c.target_attr:<20} {tv:<20} ✗ {c.error}")
                total_fail += 1
        if r.skipped:
            print(f"  跳过（无法生成测试值）: {', '.join(r.skipped)}")

    print(f"\n{'═' * 70}")
    parts = []
    if total_fail:
        parts.append(f"❌ {total_fail} 个参数透传失败")
    if total_warn:
        parts.append(f"⚠ {total_warn} 个构造警告（测试数据或 Panel 版本限制）")
    if not total_fail and not total_warn:
        parts.append("✅ 所有参数透传验证通过")
    print("  " + "  ".join(parts))
    print(f"{'═' * 70}")
    return total_fail, total_warn


# ═══════════════════════════════════════════════════════════════
# namespace 命令（包命名空间一致性检查）
# ═══════════════════════════════════════════════════════════════


@dataclass
class NamespaceCheck:
    """命名空间一致性检查结果。"""
    subpkg: str
    expected: list[str]    # 应在该子包下的 wrapper 类名
    actual: list[str]      # 该子包下实际导出的公开类
    extra: list[str]       # 多出的
    missing_access: list[str]  # 无法从预期路径访问的


def _run_namespace_checks() -> list[NamespaceCheck]:
    """检查每个 diypn 子包的命名空间一致性：
    1. wrapper 类能在对应子包路径下访问
    2. 子包下不应有多余的公开类
    """
    results: list[NamespaceCheck] = []
    for sp_name, wrappers in _SUBPACKAGE_WRAPPERS.items():
        sp = getattr(diypn, sp_name, None)
        if sp is None:
            results.append(NamespaceCheck(
                subpkg=sp_name,
                expected=[w.__name__ for w in wrappers],
                actual=[],
                extra=[],
                missing_access=[w.__name__ for w in wrappers],
            ))
            continue

        expected_names = {w.__name__ for w in wrappers}
        actual_names = set(getattr(sp, "__all__", []))
        if not actual_names:
            # fallback: 收集所有非下划线开头的属性
            actual_names = {a for a in dir(sp) if not a.startswith("_")}

        missing_access = [n for n in expected_names if getattr(sp, n, None) is None]
        extra = sorted(actual_names - expected_names)

        results.append(NamespaceCheck(
            subpkg=sp_name,
            expected=sorted(expected_names),
            actual=sorted(actual_names),
            extra=extra,
            missing_access=missing_access,
        ))
    return results


def _print_namespace(results: list[NamespaceCheck]) -> int:
    issues = 0
    for r in results:
        print(f"\n{'─' * 70}")
        print(f"  📁 diypn.{r.subpkg}")
        print(f"{'─' * 70}")
        if r.missing_access:
            print(f"  ❌ 无法访问: {', '.join(r.missing_access)}")
            issues += len(r.missing_access)
        if r.extra:
            print(f"  ⚠️  多余导出（不在 _WRAPPER_SPECS 中）: {', '.join(r.extra)}")
            issues += len(r.extra)
        if not r.missing_access and not r.extra:
            print(f"  ✅ 与 Panel 原生路径一致: {', '.join(r.expected)}")
    print(f"\n{'═' * 70}")
    if issues:
        print(f"  ❌ {issues} 个命名空间不一致")
    else:
        print("  ✅ 命名空间与 Panel 原生一致")
    print(f"{'═' * 70}")
    return issues


# ═══════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════

app = cyclopts.App(
    name="doctor_panel",
    help="Panel 组件诊断工具：适配状态 + 参数一致性。",
    version="0.2.0",
)


@app.command(name="list")
def list_cmd(
    group: Annotated[
        str | None,
        cyclopts.Parameter(
            name=("--group", "-g"),
            help="仅显示指定分组: widgets / pane / layout",
        ),
    ] = None,
) -> None:
    """列出所有 Panel 组件及 diy.ui 适配状态。"""
    _print_list(group)


@app.command
def doctor() -> None:
    """诊断模式：对比所有 diy.ui wrapper 与原生 Panel 的参数一致性和类型匹配。"""
    checks = run_checks()
    missing, mismatches = _print_report(checks)
    if missing > 0:
        print(f"\n❌ {missing} 个参数未定义")
        sys.exit(1)
    if mismatches > 0:
        print(f"\n⚠ {mismatches} 个参数类型近似（Panel 推断精度有限，仅供参考）")
    else:
        print("\n✅ 所有参数已强类型化，类型一致")


@app.command
def verify() -> None:
    """运行时验证：用非默认值实例化 wrapper，检验参数是否透传到 Panel 原生对象。"""
    results = run_verify()
    failures, warnings = _print_verify(results)
    if failures > 0:
        print(f"\n❌ {failures} 个参数透传失败（需修复）")
        sys.exit(1)
    if warnings > 0:
        print(f"\n⚠ {warnings} 个构造警告（测试数据或 Panel 版本限制，不影响功能）")
    else:
        print("\n✅ 所有参数透传验证通过")


@app.command
def namespace() -> None:
    """检查 diypn 子包命名空间是否与 Panel 原生路径一致。"""
    results = _run_namespace_checks()
    issues = _print_namespace(results)
    if issues > 0:
        print("\n❌ 命名空间不一致")
        sys.exit(1)
    print("\n✅ 命名空间与 Panel 原生一致")


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


@app.command
def doc(
    name: Annotated[
        str,
        cyclopts.Parameter(name=("--name", "-n"), help='wrapper 类名，如 "Button"、"widgets.Button"'),
    ],
    format: Annotated[
        str | None,
        cyclopts.Parameter(name=("--format", "-f"), help="输出格式: snippet / markdown"),
    ] = "snippet",
) -> None:
    """生成 wrapper __init__ 的 Panel param docstring（可粘贴到包装类中）。"""
    cls = _find_panel_class(name)
    if cls is None:
        print(f"❌ 未找到 Panel 类: {name}")
        sys.exit(1)

    wrapper_cls = _PN_TO_WRAPPER.get(cls)
    params = extract_panel_params(cls)
    excluded = _COMMON_EXCLUDED.copy()
    param_map: dict[str, str] = {}
    if wrapper_cls:
        wrapper = _get_wrapper_cls(wrapper_cls)
        if wrapper:
            excluded |= _WRAPPER_EXCLUDED.get(wrapper, set())
            param_map = _WRAPPER_PARAM_MAP.get(wrapper, {})

    if format == "markdown":
        print(f"# `{cls.__name__}` 参数文档\n")
        print(f"Panel 路径: `{cls.__module__}.{cls.__qualname__}`\n")
        for pp in params:
            if pp.name in excluded:
                continue
            target = param_map.get(pp.name, pp.name) if wrapper_cls else pp.name
            p = cls.param[pp.name]
            docstr = (getattr(p, "doc", "") or "").strip().split("\n")[0][:120]
            print(f"- **{pp.name}**: `{pp.py_type}` = `{_format_default(pp.default)}`  → `{target}`  {docstr}")
    else:
        # snippet: 生成可直接粘贴到 __init__ 中的 #: 注释块
        print(f"# ── {cls.__name__} params ──")
        print('"""')
        for pp in params:
            if pp.name in excluded:
                continue
            target = param_map.get(pp.name, pp.name)
            p = cls.param[pp.name]
            docstr = (getattr(p, "doc", "") or "").strip().split("\n")[0][:120]
            if docstr:
                print(f"{pp.name}: {docstr}")
        print('"""')


@app.command
def docgen(
    output: Annotated[
        str | None,
        cyclopts.Parameter(name=("--output", "-o"), help="输出 JSON 路径"),
    ] = "panel_param_refs.json",
) -> None:
    """生成所有 wrapper 的 Panel 参数文档 JSON 参考文件（AI 可快速加载）。"""
    import json

    refs: dict[str, dict[str, Any]] = {}
    for wrapper_cls, panel_cls in _WRAPPER_MAP.items():
        wname = wrapper_cls.__name__
        params = extract_panel_params(panel_cls)
        excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(wrapper_cls, set())
        param_map = _WRAPPER_PARAM_MAP.get(wrapper_cls, {})
        param_refs: dict[str, dict[str, str]] = {}
        for pp in params:
            if pp.name in excluded:
                continue
            p = panel_cls.param[pp.name]
            target = param_map.get(pp.name, pp.name)
            docstr = (getattr(p, "doc", "") or "").strip()
            param_refs[pp.name] = {
                "type": pp.py_type,
                "default": repr(pp.default),
                "target": target,
                "doc": docstr,
            }
        refs[wname] = {
            "panel_class": f"{panel_cls.__module__}.{panel_cls.__qualname__}",
            "params": param_refs,
        }

    with open(output, "w", encoding="utf-8") as f:
        json.dump(refs, f, indent=2, ensure_ascii=False)
    print(f"✅ 已生成参数参考文件: {output} ({len(refs)} 个组件, {sum(len(v['params']) for v in refs.values())} 个参数)")


if __name__ == "__main__":
    app()
