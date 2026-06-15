"""动态生成所有 widget wrapper 类。

DiyInitSub metaclass 在 type() 创建类时自动从 Panel param 描述符
生成带完整类型注解的 __init__。wrapper 文件本身无需任何显式 __init__。
"""
from __future__ import annotations

import panel as pn

from .._base import UIComponent, _HasValue

# (ClassName, PanelClass, use_HasValue)
_WIDGETS: list[tuple[str, type, bool]] = [
    # ── 有 value 的 widget（继承 _HasValue） ──
    ("ArrayInput",           pn.widgets.ArrayInput,           True),
    ("AutocompleteInput",    pn.widgets.AutocompleteInput,    True),
    ("BooleanStatus",        pn.widgets.BooleanStatus,        True),
    ("CheckBoxGroup",        pn.widgets.CheckBoxGroup,        True),
    ("CheckButtonGroup",     pn.widgets.CheckButtonGroup,     True),
    ("Checkbox",             pn.widgets.Checkbox,             True),
    ("CodeEditor",           pn.widgets.CodeEditor,           True),
    ("ColorMap",             pn.widgets.ColorMap,             True),
    ("ColorPicker",          pn.widgets.ColorPicker,          True),
    ("DatePicker",           pn.widgets.DatePicker,           True),
    ("DateRangePicker",      pn.widgets.DateRangePicker,      True),
    ("DateRangeSlider",      pn.widgets.DateRangeSlider,      True),
    ("DateSlider",           pn.widgets.DateSlider,           True),
    ("DatetimeInput",        pn.widgets.DatetimeInput,        True),
    ("DatetimePicker",       pn.widgets.DatetimePicker,       True),
    ("DatetimeRangePicker",  pn.widgets.DatetimeRangePicker,  True),
    ("DatetimeRangeSlider",  pn.widgets.DatetimeRangeSlider,  True),
    ("DatetimeSlider",       pn.widgets.DatetimeSlider,       True),
    ("Dial",                 pn.widgets.Dial,                 True),
    ("DiscretePlayer",       pn.widgets.DiscretePlayer,       True),
    ("FileDownload",         pn.widgets.FileDownload,         True),
    ("FileInput",            pn.widgets.FileInput,            True),
    ("FloatInput",           pn.widgets.FloatInput,           True),
    ("FloatSlider",          pn.widgets.FloatSlider,          True),
    ("Gauge",                pn.widgets.Gauge,                True),
    ("IntInput",             pn.widgets.IntInput,             True),
    ("IntRangeSlider",       pn.widgets.IntRangeSlider,       True),
    ("IntSlider",            pn.widgets.IntSlider,            True),
    ("LinearGauge",          pn.widgets.LinearGauge,          True),
    ("LiteralInput",         pn.widgets.LiteralInput,         True),
    ("MultiChoice",          pn.widgets.MultiChoice,          True),
    ("MultiSelect",          pn.widgets.MultiSelect,          True),
    ("NumberInput",          pn.widgets.FloatInput,           True),  # Panel 无 NumberInput，代理到 FloatInput
    ("Number",               pn.widgets.Number,               True),
    ("PasswordInput",        pn.widgets.PasswordInput,        True),
    ("Player",               pn.widgets.Player,               True),
    ("RadioBoxGroup",        pn.widgets.RadioBoxGroup,        True),
    ("RadioButtonGroup",     pn.widgets.RadioButtonGroup,     True),
    ("RangeSlider",          pn.widgets.RangeSlider,          True),
    ("Select",               pn.widgets.Select,               True),
    ("Switch",               pn.widgets.Switch,               True),
    ("Tabulator",            pn.widgets.Tabulator,            True),
    ("TextAreaInput",        pn.widgets.TextAreaInput,        True),
    ("TextInput",            pn.widgets.TextInput,            True),
    ("TimePicker",           pn.widgets.TimePicker,           True),
    ("Toggle",               pn.widgets.Toggle,               True),
    ("ToggleGroup",          pn.widgets.ToggleGroup,          True),
    ("ToggleIcon",           pn.widgets.ToggleIcon,           True),
    ("Tqdm",                 pn.widgets.Tqdm,                 True),
    ("Trend",                pn.widgets.Trend,                True),

    # ── 无 value 的 widget（不继承 _HasValue） ──
    ("ButtonIcon",           pn.widgets.ButtonIcon,           False),
    ("LoadingSpinner",       pn.widgets.LoadingSpinner,       False),
    ("MenuButton",           pn.widgets.MenuButton,           False),
    ("Progress",             pn.widgets.Progress,             False),
    ("StaticText",           pn.widgets.StaticText,           False),
    ("TooltipIcon",          pn.widgets.TooltipIcon,          False),
    ("VideoStream",          pn.widgets.VideoStream,          False),
]

_MODULE = __name__

# ── 动态生成所有类 ──
for _name, _panel_cls, _use_hasvalue in _WIDGETS:
    _bases = (
        (UIComponent, _HasValue, _panel_cls)
        if _use_hasvalue
        else (UIComponent, _panel_cls)
    )
    _cls = type(_name, _bases, {"__module__": _MODULE})
    globals()[_name] = _cls
