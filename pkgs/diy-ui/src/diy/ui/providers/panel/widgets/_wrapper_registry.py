"""动态生成所有 widget wrapper 类。

DiyInitSub metaclass 在 type() 创建类时自动从 Panel param 描述符
生成带完整类型注解的 __init__。wrapper 文件本身无需任何显式 __init__。
"""
from __future__ import annotations

import panel as pn

from .._base import UIComponent, _HasValue

# (ClassName, PanelClass, use_HasValue, extra_attrs)
# extra_attrs: dict | None — 额外类属性（__exclude_params__ / __watch_param__ 等）
_WIDGETS: list[tuple[str, type, bool, dict | None]] = [
    # ── 有 value 的 widget（继承 _HasValue） ──
    ("ArrayInput",           pn.widgets.ArrayInput,           True,  None),
    ("AutocompleteInput",    pn.widgets.AutocompleteInput,    True,  None),
    ("BooleanStatus",        pn.widgets.BooleanStatus,        True,  None),
    ("Button",               pn.widgets.Button,               True,  {
        "__exclude_params__": {"name", "clicks", "button_type", "button_style"},
    }),
    ("CheckBoxGroup",        pn.widgets.CheckBoxGroup,        True,  None),
    ("CheckButtonGroup",     pn.widgets.CheckButtonGroup,     True,  None),
    ("Checkbox",             pn.widgets.Checkbox,             True,  None),
    ("CodeEditor",           pn.widgets.CodeEditor,           True,  None),
    ("ColorMap",             pn.widgets.ColorMap,             True,  None),
    ("ColorPicker",          pn.widgets.ColorPicker,          True,  None),
    ("DatePicker",           pn.widgets.DatePicker,           True,  None),
    ("DateRangePicker",      pn.widgets.DateRangePicker,      True,  None),
    ("DateRangeSlider",      pn.widgets.DateRangeSlider,      True,  None),
    ("DateSlider",           pn.widgets.DateSlider,           True,  None),
    ("DatetimeInput",        pn.widgets.DatetimeInput,        True,  None),
    ("DatetimePicker",       pn.widgets.DatetimePicker,       True,  None),
    ("DatetimeRangePicker",  pn.widgets.DatetimeRangePicker,  True,  None),
    ("DatetimeRangeSlider",  pn.widgets.DatetimeRangeSlider,  True,  None),
    ("DatetimeSlider",       pn.widgets.DatetimeSlider,       True,  None),
    ("Dial",                 pn.widgets.Dial,                 True,  None),
    ("DiscretePlayer",       pn.widgets.DiscretePlayer,       True,  None),
    ("FileDownload",         pn.widgets.FileDownload,         True,  None),
    ("FileInput",            pn.widgets.FileInput,            True,  None),
    ("FloatInput",           pn.widgets.FloatInput,           True,  None),
    ("FloatSlider",          pn.widgets.FloatSlider,          True,  None),
    ("Gauge",                pn.widgets.Gauge,                True,  None),
    ("IntInput",             pn.widgets.IntInput,             True,  None),
    ("IntRangeSlider",       pn.widgets.IntRangeSlider,       True,  None),
    ("IntSlider",            pn.widgets.IntSlider,            True,  None),
    ("LinearGauge",          pn.widgets.LinearGauge,          True,  None),
    ("LiteralInput",         pn.widgets.LiteralInput,         True,  None),
    ("MultiChoice",          pn.widgets.MultiChoice,          True,  None),
    ("MultiSelect",          pn.widgets.MultiSelect,          True,  None),
    ("NumberInput",          pn.widgets.FloatInput,           True,  None),  # Panel 无 NumberInput，代理到 FloatInput
    ("Number",               pn.widgets.Number,               True,  None),
    ("PasswordInput",        pn.widgets.PasswordInput,        True,  None),
    ("Player",               pn.widgets.Player,               True,  None),
    ("RadioBoxGroup",        pn.widgets.RadioBoxGroup,        True,  None),
    ("RadioButtonGroup",     pn.widgets.RadioButtonGroup,     True,  None),
    ("RangeSlider",          pn.widgets.RangeSlider,          True,  None),
    ("Select",               pn.widgets.Select,               True,  None),
    ("Switch",               pn.widgets.Switch,               True,  None),
    ("Tabulator",            pn.widgets.Tabulator,            True,  None),
    ("TextAreaInput",        pn.widgets.TextAreaInput,        True,  None),
    ("TextInput",            pn.widgets.TextInput,            True,  None),
    ("TimePicker",           pn.widgets.TimePicker,           True,  None),
    ("Toggle",               pn.widgets.Toggle,               True,  None),
    ("ToggleGroup",          pn.widgets.ToggleGroup,          True,  None),
    ("ToggleIcon",           pn.widgets.ToggleIcon,           True,  None),
    ("Tqdm",                 pn.widgets.Tqdm,                 True,  None),
    ("Trend",                pn.widgets.Trend,                True,  None),

    # ── 无 value 的 widget（不继承 _HasValue） ──
    ("ButtonIcon",           pn.widgets.ButtonIcon,           False, None),
    ("LoadingSpinner",       pn.widgets.LoadingSpinner,       False, None),
    ("MenuButton",           pn.widgets.MenuButton,           False, None),
    ("Progress",             pn.widgets.Progress,             False, None),
    ("StaticText",           pn.widgets.StaticText,           False, None),
    ("TooltipIcon",          pn.widgets.TooltipIcon,          False, None),
    ("VideoStream",          pn.widgets.VideoStream,          False, None),
]

_MODULE = __name__

# ── 动态生成所有类 ──
for _name, _panel_cls, _use_hasvalue, _extra in _WIDGETS:
    _bases = (
        (UIComponent, _HasValue, _panel_cls)
        if _use_hasvalue
        else (UIComponent, _panel_cls)
    )
    _attrs = {"__module__": _MODULE}
    if _extra:
        _attrs.update(_extra)
    _cls = type(_name, _bases, _attrs)
    globals()[_name] = _cls
