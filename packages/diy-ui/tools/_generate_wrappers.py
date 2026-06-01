"""批量生成 panel wrapper 文件。"""
from __future__ import annotations

from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "src" / "diyui" / "providers" / "panel"
PANE_DIR = PKG / "pane"
WIDGET_DIR = PKG / "widgets"

PANE_COMMON_PARAMS = """        name: str = "",
        align: Any = "start",
        aspect_ratio: Any | None = None,
        css_classes: list[Any] | None = None,
        design: Any = None,
        height: int | None = None,
        min_width: int | None = None,
        min_height: int | None = None,
        max_width: int | None = None,
        max_height: int | None = None,
        margin: Any | None = (5, 10),
        styles: dict[str, Any] | None = None,
        stylesheets: list[Any] | None = None,
        tags: list[Any] | None = None,
        width: int | None = None,
        width_policy: Any = "auto",
        height_policy: Any = "auto",
        sizing_mode: Any = None,
        visible: bool = True,
        loading: bool = False,
        default_layout: Any = pn.Row,"""

PANE_COMMON_INIT = """            name=name,
            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes or [],
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles or {},
            stylesheets=stylesheets or [],
            tags=tags or [],
            width=width,
            width_policy=width_policy,
            height_policy=height_policy,
            sizing_mode=sizing_mode,
            visible=visible,
            loading=loading,
            default_layout=default_layout,"""

WIDGET_COMMON = """        label: str = "",
        name: str = "",
        align: Any = "start",
        aspect_ratio: Any | None = None,
        css_classes: list[Any] | None = None,
        design: Any = None,
        height: int | None = None,
        min_width: int | None = None,
        min_height: int | None = None,
        max_width: int | None = None,
        max_height: int | None = None,
        margin: Any | None = (5, 10),
        styles: dict[str, Any] | None = None,
        stylesheets: list[Any] | None = None,
        tags: list[Any] | None = None,
        width: int | None = 300,
        width_policy: Any = "auto",
        height_policy: Any = "auto",
        sizing_mode: Any = None,
        visible: bool = True,
        loading: bool = False,
        disabled: bool = False,"""

WIDGET_COMMON_INIT = """            align=align,
            aspect_ratio=aspect_ratio,
            css_classes=css_classes or [],
            design=design,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
            margin=margin,
            styles=styles or {},
            stylesheets=stylesheets or [],
            tags=tags or [],
            width=width,
            width_policy=width_policy,
            height_policy=height_policy,
            sizing_mode=sizing_mode,
            visible=visible,
            loading=loading,
            disabled=disabled,"""


def image_pane(name: str) -> str:
    return f'''"""Panel {name} — pn.pane.{name} 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import panel as pn

from .._base import UIComponent


class {name}(UIComponent, pn.pane.{name}):

    def __init__(
        self,
        object: Any | None = None,
        *,
{PANE_COMMON_PARAMS}
        enable_streaming: bool = False,
        embed: bool = False,
        alt_text: str | None = None,
        caption: str | None = None,
        fixed_aspect: bool = True,
        link_url: str | None = None,
        target: str = "_blank",
    ) -> None:
        UIComponent.__init__(self)
        pn.pane.{name}.__init__(
            self,
            object,
{PANE_COMMON_INIT}
            enable_streaming=enable_streaming,
            embed=embed,
            alt_text=alt_text,
            caption=caption,
            fixed_aspect=fixed_aspect,
            link_url=link_url,
            target=target,
        )
'''


def simple_pane(name: str, panel_ref: str,
                extra_params: str = "", extra_init: str = "") -> str:
    extra_params_str = f"\n{extra_params}" if extra_params else ""
    extra_init_str = f"\n{extra_init}" if extra_init else ""
    return f'''"""Panel {name} — {panel_ref} 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import panel as pn

from .._base import UIComponent


class {name}(UIComponent, {panel_ref}):

    def __init__(
        self,
        object: Any | None = None,
        *,
{PANE_COMMON_PARAMS}{extra_params_str}
    ) -> None:
        UIComponent.__init__(self)
        {panel_ref}.__init__(
            self,
            object,
{PANE_COMMON_INIT}{extra_init_str}
        )
'''


def value_widget(name: str, panel_ref: str, value_type: str, value_default: str,
                 extra_params: str = "", extra_init: str = "",
                 extra_new: str = "",
                 value_param: str = "value") -> str:
    extra_params_str = f"\n{extra_params}" if extra_params else ""
    extra_init_str = f"\n{extra_init}" if extra_init else ""
    extra_new_str = f"\n{extra_new}\n" if extra_new else ""
    return f'''"""Panel {name} — {panel_ref} 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import diyui
import panel as pn

from .._base import UIComponent


class {name}(UIComponent, {panel_ref}):
{extra_new_str}
    def __init__(
        self,
        *,
{WIDGET_COMMON}
        {value_param}: {value_type} = {value_default},{extra_params_str}
    ) -> None:
        UIComponent.__init__(self)
        self.diy.signal: diyui.Signal[{value_type}] = diyui.Signal[{value_type}]({value_param})
        _label = label or name
        self.diy.init_done: bool = False
        {panel_ref}.__init__(
            self,
            label=_label,
            {value_param}={value_param},
{WIDGET_COMMON_INIT}{extra_init_str}
        )
        self.diy.init_done = True
        self._setup_event_bridge()

    @property
    def {value_param}(self) -> {value_type}:
        return self.diy.signal.value

    @{value_param}.setter
    def {value_param}(self, v: {value_type}) -> None:
        self.diy.signal.value = v
        if self.diy.init_done:
            self.param["{value_param}"].__set__(self, v)

    def _setup_event_bridge(self) -> None:
        def on_change(event: Any) -> None:
            self.diy.signal.value = event.new

        self.param.watch(on_change, "{value_param}")
'''


def display_widget(name: str, panel_ref: str,
                   extra_params: str = "", extra_init: str = "") -> str:
    extra_params_str = f"\n{extra_params}" if extra_params else ""
    extra_init_str = f"\n{extra_init}" if extra_init else ""
    return f'''"""Panel {name} — {panel_ref} 的 diyui 包装。"""

from __future__ import annotations

from typing import Any

import panel as pn

from .._base import UIComponent


class {name}(UIComponent, {panel_ref}):

    def __init__(
        self,
        *,
{WIDGET_COMMON}{extra_params_str}
    ) -> None:
        UIComponent.__init__(self)
        _label = label or name
        {panel_ref}.__init__(
            self,
            label=_label,
{WIDGET_COMMON_INIT}{extra_init_str}
        )
'''


# ═══════════════════════════════════════════════════════════════
#  Generate all files
# ═══════════════════════════════════════════════════════════════

# ── Image panes ───────────────────────────────────────────────

for name in ["AVIF", "GIF", "ICO", "WebP"]:
    (PANE_DIR / f"_{name.lower()}.py").write_text(image_pane(name))
    print(f"  ✏️  pane/_{name.lower()}.py")

# ── Placeholder ───────────────────────────────────────────────

(WIDGET_DIR.parent / "pane" / "_placeholder.py").write_text(
    simple_pane("Placeholder", "pn.pane.Placeholder",
                extra_params="""        inplace: bool = False,\n""",
                extra_init="""            inplace=inplace,"""))
print("  ✏️  pane/_placeholder.py")

# ── Simple value widgets (value + Signal) ────────────────────

# BooleanStatus: bool value
(WIDGET_DIR / "_boolean_status.py").write_text(
    value_widget("BooleanStatus", "pn.widgets.BooleanStatus", "bool", "False",
                 extra_params="""        color: str = "dark",
        throttle: int = 500,""",
                 extra_init="""            color=color,
            throttle=throttle,"""))
print("  ✏️  widgets/_boolean_status.py")

# Gauge: float value + ECharts gauge display
(WIDGET_DIR / "_gauge.py").write_text(
    value_widget("Gauge", "pn.widgets.Gauge", "float", "0.0",
                 extra_params="""        bounds: tuple[float, float] = (0, 100),
        colors: list[tuple[float, str]] | None = None,
        format: str = "{value}%",
        annulus_width: float = 10,
        num_splits: int = 10,
        show_labels: bool = True,
        show_ticks: bool = True,
        start_angle: float = -135,
        end_angle: float = 135,
        title_size: int = 18,
        tooltip_format: str = "{b} : {c}%",
        custom_opts: dict[str, Any] | None = None,""",
                 extra_init="""            bounds=bounds,
            colors=colors,
            format=format,
            annulus_width=annulus_width,
            num_splits=num_splits,
            show_labels=show_labels,
            show_ticks=show_ticks,
            start_angle=start_angle,
            end_angle=end_angle,
            title_size=title_size,
            tooltip_format=tooltip_format,
            custom_opts=custom_opts,"""))
print("  ✏️  widgets/_gauge.py")

# LinearGauge
(WIDGET_DIR / "_linear_gauge.py").write_text(
    value_widget("LinearGauge", "pn.widgets.LinearGauge", "float", "0.0",
                 extra_params="""        bounds: tuple[float, float] = (0, 100),
        colors: list[tuple[float, str]] | None = None,
        format: str = "{value}%",
        default_color: str = "#eeeeee",
        nan_format: str = "-",
        needle_color: str = "black",
        show_boundaries: bool = True,
        horizontal: bool = True,
        tick_size: int = 10,
        title_size: str | None = None,
        unfilled_color: str = "whitesmoke",
        value_size: int | None = None,""",
                 extra_init="""            bounds=bounds,
            colors=colors,
            format=format,
            default_color=default_color,
            nan_format=nan_format,
            needle_color=needle_color,
            show_boundaries=show_boundaries,
            horizontal=horizontal,
            tick_size=tick_size,
            title_size=title_size,
            unfilled_color=unfilled_color,
            value_size=value_size,"""))
print("  ✏️  widgets/_linear_gauge.py")

# Dial
(WIDGET_DIR / "_dial.py").write_text(
    value_widget("Dial", "pn.widgets.Dial", "float", "0.0",
                 extra_params="""        bounds: tuple[float, float] = (0, 100),
        colors: list[tuple[float, str]] | None = None,
        format: str = "{value}%",
        annulus_width: float = 10,
        start_angle: float = -135,
        end_angle: float = 135,
        background: str | None = None,
        default_color: str = "#eeeeee",
        label_color: str = "black",
        nan_format: str = "-",
        needle_color: str = "black",
        needle_width: float = 4.0,
        tick_size: int = 10,
        title_size: int | None = None,
        unfilled_color: str = "whitesmoke",
        value_size: int | None = None,""",
                 extra_init="""            bounds=bounds,
            colors=colors,
            format=format,
            annulus_width=annulus_width,
            start_angle=start_angle,
            end_angle=end_angle,
            background=background,
            default_color=default_color,
            label_color=label_color,
            nan_format=nan_format,
            needle_color=needle_color,
            needle_width=needle_width,
            tick_size=tick_size,
            title_size=title_size,
            unfilled_color=unfilled_color,
            value_size=value_size,"""))
print("  ✏️  widgets/_dial.py")

# Number: numeric value indicator
(WIDGET_DIR / "_number_widget.py").write_text(
    value_widget("Number", "pn.widgets.Number", "float", "0.0",
                 extra_params="""        default_color: str = "gray",
        font_size: str = "18pt",
        format: str = "{value}",
        nan_format: str = "-",
        colors: list[str] | None = None,
        title_size: str = "18pt",""",
                 extra_init="""            default_color=default_color,
            font_size=font_size,
            format=format,
            nan_format=nan_format,
            colors=colors,
            title_size=title_size,"""))
print("  ✏️  widgets/_number_widget.py")

# Trend: series data indicator
(WIDGET_DIR / "_trend.py").write_text(
    value_widget("Trend", "pn.widgets.Trend", "dict", "None",
                 extra_params="""        plot_x: str = "x",
        plot_y: str = "y",
        selection: list = [],
        data: Any | None = None,
        layout: str = "column",
        plot_color: str = "#428bca",
        plot_type: str = "bar",
        pos_color: str = "#5cb85c",
        neg_color: str = "#d9534f",
        value_change: Any = "auto",\n""",
                 extra_init="""            plot_x=plot_x,
            plot_y=plot_y,
            selection=selection,
            data=data,
            layout=layout,
            plot_color=plot_color,
            plot_type=plot_type,
            pos_color=pos_color,
            neg_color=neg_color,
            value_change=value_change,"""))
print("  ✏️  widgets/_trend.py")

# Tqdm: progress bar
(WIDGET_DIR / "_tqdm.py").write_text(
    value_widget("Tqdm", "pn.widgets.Tqdm", "int", "0",
                 extra_params="""        layout: Any | None = None,
        lock: Any | None = None,
        max: int = 100,
        progress: Any | None = None,
        text: str = "",
        text_pane: Any | None = None,
        write_to_console: bool = False,""",
                 extra_init="""            layout=layout,
            lock=lock,
            max=max,
            progress=progress,
            text=text,
            text_pane=text_pane,
            write_to_console=write_to_console,"""))
print("  ✏️  widgets/_tqdm.py")

# TooltipIcon: display-only (string value)
(WIDGET_DIR / "_tooltip_icon.py").write_text(
    display_widget("TooltipIcon", "pn.widgets.TooltipIcon",
                   extra_params="""        value: str = "",\n""",
                   extra_init="""            value=value,"""))
print("  ✏️  widgets/_tooltip_icon.py")

# ── Select widgets ────────────────────────────────────────────

# AutocompleteInput
(WIDGET_DIR / "_autocomplete_input.py").write_text(
    value_widget("AutocompleteInput", "pn.widgets.AutocompleteInput", "str", '""',
                 extra_params="""        options: list[Any] | dict[str, Any] | None = None,
        placeholder: str = "",
        case_sensitive: bool = True,
        restrict: bool = True,
        min_characters: int = 0,
        search_strategy: str = "includes",
        description: str | None = None,""",
                 extra_init="""            options=options or [],
            placeholder=placeholder,
            case_sensitive=case_sensitive,
            restrict=restrict,
            min_characters=min_characters,
            search_strategy=search_strategy,
            description=description,"""))
print("  ✏️  widgets/_autocomplete_input.py")

# MultiChoice
(WIDGET_DIR / "_multi_choice.py").write_text(
    value_widget("MultiChoice", "pn.widgets.MultiChoice", "list[Any]", "[]",
                 extra_params="""        options: list[Any] | dict[str, Any] | None = None,
        placeholder: str = "",
        max_items: int | None = None,
        description: str | None = None,
        delete_button: bool = True,
        option_limit: int | None = None,
        search_option_limit: int | None = None,
        solid: bool = True,""",
                 extra_init="""            options=options or [],
            placeholder=placeholder,
            max_items=max_items,
            description=description,
            delete_button=delete_button,
            option_limit=option_limit,
            search_option_limit=search_option_limit,
            solid=solid,"""))
print("  ✏️  widgets/_multi_choice.py")

# ColorMap
(WIDGET_DIR / "_color_map.py").write_text(
    value_widget("ColorMap", "pn.widgets.ColorMap", "str", '"viridis"',
                 extra_params="""        options: dict[str, str] | None = None,
        ncols: int = 4,
        swatch_height: int = 20,
        swatch_width: int = 100,
        value_name: str | None = None,""",
                 extra_init="""            options=options or {},
            ncols=ncols,
            swatch_height=swatch_height,
            swatch_width=swatch_width,
            value_name=value_name,"""))
print("  ✏️  widgets/_color_map.py")

# ── Input widgets ─────────────────────────────────────────────

# NumberInput (pn.NumberInput 是工厂类，不能直接继承；用 FloatInput 做基类)
(WIDGET_DIR / "_number_input.py").write_text(
    value_widget("NumberInput", "pn.widgets.FloatInput", "float", "0.0",
                 extra_params="""        placeholder: str = "0",
        format: str = "0,0.000",
        start: float | None = None,
        end: float | None = None,
        step: float = 1.0,
        mode: str = "float",
        page_step_multiplier: int = 10,
        wheel_wait: int = 100,
        description: str | None = None,""",
                 extra_init="""            placeholder=placeholder,
            format=format,
            start=start,
            end=end,
            step=step,
            mode=mode,
            page_step_multiplier=page_step_multiplier,
            wheel_wait=wheel_wait,
            description=description,"""))
print("  ✏️  widgets/_number_input.py")

# ArrayInput
(WIDGET_DIR / "_array_input.py").write_text(
    value_widget("ArrayInput", "pn.widgets.ArrayInput", "list[Any]", "[]",
                 extra_params="""        placeholder: str = "[]",
        max_array_size: int = 10000,
        description: str | None = None,
        serializer: str = "ast",
        type: type | tuple[type, ...] | None = None,""",
                 extra_init="""            placeholder=placeholder,
            max_array_size=max_array_size,
            description=description,
            serializer=serializer,
            type=type,"""))
print("  ✏️  widgets/_array_input.py")

# Player
(WIDGET_DIR / "_player.py").write_text(
    value_widget("Player", "pn.widgets.Player", "int", "0",
                 extra_params="""        start: int = 0,
        end: int = 10,
        step: int = 1,
        interval: int = 500,
        loop_policy: str = "once",
        direction: int = 0,
        preview_duration: int = 1500,
        show_loop_controls: bool = True,
        show_value: bool = False,
        value_align: str = "start",
        scale_buttons: int = 1,
        visible_buttons: list = ["slower", "first", "previous", "play", "next", "last", "faster"],
        visible_loop_options: list = ["once", "loop", "reflect"],\n""",
                 extra_init="""            start=start,
            end=end,
            step=step,
            interval=interval,
            loop_policy=loop_policy,
            direction=direction,
            preview_duration=preview_duration,
            show_loop_controls=show_loop_controls,
            show_value=show_value,
            value_align=value_align,
            scale_buttons=scale_buttons,
            visible_buttons=visible_buttons,
            visible_loop_options=visible_loop_options,"""))
print("  ✏️  widgets/_player.py")

# DiscretePlayer
(WIDGET_DIR / "_discrete_player.py").write_text(
    value_widget("DiscretePlayer", "pn.widgets.DiscretePlayer", "Any", "None",
                 extra_params="""        options: list[Any] | dict[str, Any] | None = None,
        interval: int = 500,
        loop_policy: str = "once",
        direction: int = 0,
        step: int = 1,
        preview_duration: int = 1500,
        show_loop_controls: bool = True,
        show_value: bool = True,
        value_align: str = "start",
        scale_buttons: int = 1,
        visible_buttons: list = ["slower", "first", "previous", "play", "next", "last", "faster"],
        visible_loop_options: list = ["once", "loop", "reflect"],\n""",
                 extra_init="""            options=options or [],
            interval=interval,
            loop_policy=loop_policy,
            direction=direction,
            step=step,
            preview_duration=preview_duration,
            show_loop_controls=show_loop_controls,
            show_value=show_value,
            value_align=value_align,
            scale_buttons=scale_buttons,
            visible_buttons=visible_buttons,
            visible_loop_options=visible_loop_options,"""))
print("  ✏️  widgets/_discrete_player.py")

# ── Icon / Misc widgets ───────────────────────────────────────

# ToggleIcon
(WIDGET_DIR / "_toggle_icon.py").write_text(
    value_widget("ToggleIcon", "pn.widgets.ToggleIcon", "bool", "False",
                 extra_params="""        icon: str = "heart",
        size: str = "1.2em",
        active_icon: str = "",
        description: str | None = None,
        description_delay: int = 500,""",
                 extra_init="""            icon=icon,
            size=size,
            active_icon=active_icon,
            description=description,
            description_delay=description_delay,"""))
print("  ✏️  widgets/_toggle_icon.py")

# VideoStream - display only
(WIDGET_DIR / "_video_stream.py").write_text(
    display_widget("VideoStream", "pn.widgets.VideoStream",
                   extra_params="""        format: str = "jpeg",
        paused: bool = False,
        timeout: int | None = None,
        value: Any | None = None,""",
                   extra_init="""            format=format,
            paused=paused,
            timeout=timeout,
            value=value,"""))
print("  ✏️  widgets/_video_stream.py")

# ── Slider variants ───────────────────────────────────────────

# IntRangeSlider
(WIDGET_DIR / "_int_range_slider.py").write_text(
    value_widget("IntRangeSlider", "pn.widgets.IntRangeSlider", "tuple[int, int]", "(0, 1)",
                 extra_params="""        start: int = 0,
        end: int = 10,
        step: int = 1,
        bar_color: str = "#6baed6",
        direction: str = "ltr",
        format: str | None = None,
        orientation: str = "horizontal",
        show_value: bool = True,
        tooltips: bool = True,""",
                 extra_init="""            start=start,
            end=end,
            step=step,
            bar_color=bar_color,
            direction=direction,
            format=format,
            orientation=orientation,
            show_value=show_value,
            tooltips=tooltips,"""))
print("  ✏️  widgets/_int_range_slider.py")

# DateRangeSlider
(WIDGET_DIR / "_date_range_slider.py").write_text(
    value_widget("DateRangeSlider", "pn.widgets.DateRangeSlider", "Any", "None",
                 extra_params="""        start: Any | None = None,
        end: Any | None = None,
        step: int = 1,
        bar_color: str = "#6baed6",
        orientation: str = "horizontal",
        show_value: bool = True,
        tooltips: bool = True,
        direction: str = "ltr",
        format: str | None = None,""",
                 extra_init="""            start=start,
            end=end,
            step=step,
            bar_color=bar_color,
            orientation=orientation,
            show_value=show_value,
            tooltips=tooltips,
            direction=direction,
            format=format,"""))
print("  ✏️  widgets/_date_range_slider.py")

# DateSlider
(WIDGET_DIR / "_date_slider.py").write_text(
    value_widget("DateSlider", "pn.widgets.DateSlider", "Any", "None",
                 extra_params="""        start: Any | None = None,
        end: Any | None = None,
        step: int = 1,
        bar_color: str = "#6baed6",
        orientation: str = "horizontal",
        show_value: bool = True,
        tooltips: bool = True,
        direction: str = "ltr",
        as_datetime: bool = False,
        format: str | None = None,""",
                 extra_init="""            start=start,
            end=end,
            step=step,
            bar_color=bar_color,
            orientation=orientation,
            show_value=show_value,
            tooltips=tooltips,
            direction=direction,
            as_datetime=as_datetime,
            format=format,"""))
print("  ✏️  widgets/_date_slider.py")

# DatetimeRangeSlider
(WIDGET_DIR / "_datetime_range_slider.py").write_text(
    value_widget("DatetimeRangeSlider", "pn.widgets.DatetimeRangeSlider", "Any", "None",
                 extra_params="""        start: Any | None = None,
        end: Any | None = None,
        step: int = 1,
        bar_color: str = "#6baed6",
        orientation: str = "horizontal",
        show_value: bool = True,
        tooltips: bool = True,
        direction: str = "ltr",
        format: str | None = None,""",
                 extra_init="""            start=start,
            end=end,
            step=step,
            bar_color=bar_color,
            orientation=orientation,
            show_value=show_value,
            tooltips=tooltips,
            direction=direction,
            format=format,"""))
print("  ✏️  widgets/_datetime_range_slider.py")

# DatetimeSlider (as_datetime is read-only, excluded)
(WIDGET_DIR / "_datetime_slider.py").write_text(
    value_widget("DatetimeSlider", "pn.widgets.DatetimeSlider", "Any", "None",
                 extra_params="""        start: Any | None = None,
        end: Any | None = None,
        step: int = 1,
        bar_color: str = "#6baed6",
        orientation: str = "horizontal",
        show_value: bool = True,
        tooltips: bool = True,
        direction: str = "ltr",
        format: str | None = None,""",
                 extra_init="""            start=start,
            end=end,
            step=step,
            bar_color=bar_color,
            orientation=orientation,
            show_value=show_value,
            tooltips=tooltips,
            direction=direction,
            format=format,"""))
print("  ✏️  widgets/_datetime_slider.py")

# ── Date/Time widgets ─────────────────────────────────────────

# DateRangePicker
(WIDGET_DIR / "_date_range_picker.py").write_text(
    value_widget("DateRangePicker", "pn.widgets.DateRangePicker", "Any", "None",
                 extra_params="""        start: Any | None = None,
        end: Any | None = None,
        description: str | None = None,
        disabled_dates: list | None = None,
        enabled_dates: list | None = None,""",
                 extra_init="""            start=start,
            end=end,
            description=description,
            disabled_dates=disabled_dates,
            enabled_dates=enabled_dates,"""))
print("  ✏️  widgets/_date_range_picker.py")

# DatetimePicker
(WIDGET_DIR / "_datetime_picker.py").write_text(
    value_widget("DatetimePicker", "pn.widgets.DatetimePicker", "Any", "None",
                 extra_params="""        start: Any | None = None,
        end: Any | None = None,
        enable_seconds: bool = False,
        enable_time: bool = True,
        military_time: bool = False,
        description: str | None = None,
        allow_input: bool = False,
        disabled_dates: list | None = None,
        enabled_dates: list | None = None,
        as_numpy_datetime64: bool | None = None,
        mode: str = "single",""",
                 extra_init="""            start=start,
            end=end,
            enable_seconds=enable_seconds,
            enable_time=enable_time,
            military_time=military_time,
            description=description,
            allow_input=allow_input,
            disabled_dates=disabled_dates,
            enabled_dates=enabled_dates,
            as_numpy_datetime64=as_numpy_datetime64,
            mode=mode,"""))
print("  ✏️  widgets/_datetime_picker.py")

# DatetimeInput
(WIDGET_DIR / "_datetime_input.py").write_text(
    value_widget("DatetimeInput", "pn.widgets.DatetimeInput", "Any", "None",
                 extra_params="""        placeholder: str = "",
        description: str | None = None,
        format: str = "yyyy-MM-dd HH:mm:ss",
        serializer: str = "ast",
        type: type | tuple[type, ...] | None = None,
        start: Any | None = None,
        end: Any | None = None,\n""",
                 extra_init="""            placeholder=placeholder,
            description=description,
            format=format,
            serializer=serializer,
            type=type,
            start=start,
            end=end,"""))
print("  ✏️  widgets/_datetime_input.py")

# DatetimeRangePicker
(WIDGET_DIR / "_datetime_range_picker.py").write_text(
    value_widget("DatetimeRangePicker", "pn.widgets.DatetimeRangePicker", "Any", "None",
                 extra_params="""        start: Any | None = None,
        end: Any | None = None,
        enable_seconds: bool = False,
        enable_time: bool = True,
        military_time: bool = False,
        description: str | None = None,
        allow_input: bool = False,
        disabled_dates: list | None = None,
        enabled_dates: list | None = None,
        as_numpy_datetime64: bool | None = None,
        mode: str = "range",""",
                 extra_init="""            start=start,
            end=end,
            enable_seconds=enable_seconds,
            enable_time=enable_time,
            military_time=military_time,
            description=description,
            allow_input=allow_input,
            disabled_dates=disabled_dates,
            enabled_dates=enabled_dates,
            as_numpy_datetime64=as_numpy_datetime64,
            mode=mode,"""))
print("  ✏️  widgets/_datetime_range_picker.py")

# TimePicker
(WIDGET_DIR / "_time_picker.py").write_text(
    value_widget("TimePicker", "pn.widgets.TimePicker", "Any", "None",
                 extra_params="""        start: Any | None = None,
        end: Any | None = None,
        format: str = "HH:mm",
        seconds: bool = False,
        hour_increment: int = 1,
        minute_increment: int = 1,
        second_increment: int = 1,
        clock: str = "12h",""",
                 extra_init="""            start=start,
            end=end,
            format=format,
            seconds=seconds,
            hour_increment=hour_increment,
            minute_increment=minute_increment,
            second_increment=second_increment,
            clock=clock,"""))
print("  ✏️  widgets/_time_picker.py")

print("\n✅ All wrapper files generated!")
