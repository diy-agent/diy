"""PanelApp — Panel 专属 diyui App。

用法：app = diypn.PanelApp()
组件方法遵循 Panel 原生子包习惯：
  app.layout.column()    # 同 pn.layout.Column()
  app.pane.markdown()    # 同 pn.pane.Markdown()
  app.widgets.button()   # 同 pn.widgets.Button()
"""

from __future__ import annotations

from typing import Any

import diyui

from . import layout as _layout
from . import pane as _pane
from . import widgets as _widgets
from ._base import UIComponent


class _LayoutFactory:
    """app.layout.xxx() 工厂，与 pn.layout 一致。"""

    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:
        self._app = app

    def _add(self, comp: UIComponent) -> UIComponent:
        self._app._add_to_current(comp)
        return comp

    def accordion(self, *children: Any, **kwargs: Any) -> _layout.Accordion:
        return self._add(_layout.Accordion(*children, **kwargs))

    def card(self, *children: Any, **kwargs: Any) -> _layout.Card:
        return self._add(_layout.Card(*children, **kwargs))

    def column(self, *children: Any, **kwargs: Any) -> _layout.Column:
        return self._add(_layout.Column(*children, **kwargs))

    def divider(self, **kwargs: Any) -> _layout.Divider:
        return self._add(_layout.Divider(**kwargs))

    def feed(self, *children: Any, **kwargs: Any) -> _layout.Feed:
        return self._add(_layout.Feed(*children, **kwargs))

    def flex_box(self, *children: Any, **kwargs: Any) -> _layout.FlexBox:
        return self._add(_layout.FlexBox(*children, **kwargs))

    def float_panel(self, *children: Any, **kwargs: Any) -> _layout.FloatPanel:
        return self._add(_layout.FloatPanel(*children, **kwargs))

    def grid_box(self, *children: Any, **kwargs: Any) -> _layout.GridBox:
        return self._add(_layout.GridBox(*children, **kwargs))

    def grid_spec(self, **kwargs: Any) -> _layout.GridSpec:
        return self._add(_layout.GridSpec(**kwargs))

    def grid_stack(self, **kwargs: Any) -> _layout.GridStack:
        return self._add(_layout.GridStack(**kwargs))

    def hspacer(self, **kwargs: Any) -> _layout.HSpacer:
        return self._add(_layout.HSpacer(**kwargs))

    def modal(self, *children: Any, **kwargs: Any) -> _layout.Modal:
        return self._add(_layout.Modal(*children, **kwargs))

    def row(self, *children: Any, **kwargs: Any) -> _layout.Row:
        return self._add(_layout.Row(*children, **kwargs))

    def spacer(self, **kwargs: Any) -> _layout.Spacer:
        return self._add(_layout.Spacer(**kwargs))

    def swipe(self, *children: Any, **kwargs: Any) -> _layout.Swipe:
        return self._add(_layout.Swipe(*children, **kwargs))

    def tabs(self, *children: Any, **kwargs: Any) -> _layout.Tabs:
        return self._add(_layout.Tabs(*children, **kwargs))

    def vspacer(self, **kwargs: Any) -> _layout.VSpacer:
        return self._add(_layout.VSpacer(**kwargs))

    def widget_box(self, *children: Any, **kwargs: Any) -> _layout.WidgetBox:
        return self._add(_layout.WidgetBox(*children, **kwargs))


class _PaneFactory:
    """app.pane.xxx() 工厂，与 pn.pane 一致。"""

    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:
        self._app = app

    def _add(self, comp: UIComponent) -> UIComponent:
        self._app._add_to_current(comp)
        return comp

    def alert(self, object: Any = None, **kwargs: Any) -> _pane.Alert:
        return self._add(_pane.Alert(object, **kwargs))

    def audio(self, object: str = "", **kwargs: Any) -> _pane.Audio:
        return self._add(_pane.Audio(object, **kwargs))

    def bokeh(self, object: Any = None, **kwargs: Any) -> _pane.Bokeh:
        return self._add(_pane.Bokeh(object, **kwargs))

    def dataframe(self, object: Any = None, **kwargs: Any) -> _pane.DataFrame:
        return self._add(_pane.DataFrame(object, **kwargs))

    def deckgl(self, object: Any = None, **kwargs: Any) -> _pane.DeckGL:
        return self._add(_pane.DeckGL(object, **kwargs))

    def echarts(self, object: Any = None, **kwargs: Any) -> _pane.ECharts:
        return self._add(_pane.ECharts(object, **kwargs))

    def holoviews(self, object: Any = None, **kwargs: Any) -> _pane.HoloViews:
        return self._add(_pane.HoloViews(object, **kwargs))

    def html(self, object: Any = None, **kwargs: Any) -> _pane.HTML:
        return self._add(_pane.HTML(object, **kwargs))

    def image(self, object: Any = None, **kwargs: Any) -> _pane.Image:
        return self._add(_pane.Image(object, **kwargs))

    def jpg(self, object: Any = None, **kwargs: Any) -> _pane.JPG:
        return self._add(_pane.JPG(object, **kwargs))

    def json(self, object: Any = None, **kwargs: Any) -> _pane.JSON:
        return self._add(_pane.JSON(object, **kwargs))

    def latex(self, object: Any = None, **kwargs: Any) -> _pane.LaTeX:
        return self._add(_pane.LaTeX(object, **kwargs))

    def markdown(self, object: Any = None, **kwargs: Any) -> _pane.Markdown:
        return self._add(_pane.Markdown(object, **kwargs))

    def matplotlib(self, object: Any = None, **kwargs: Any) -> _pane.Matplotlib:
        return self._add(_pane.Matplotlib(object, **kwargs))

    def pdf(self, object: Any = None, **kwargs: Any) -> _pane.PDF:
        return self._add(_pane.PDF(object, **kwargs))

    def png(self, object: Any = None, **kwargs: Any) -> _pane.PNG:
        return self._add(_pane.PNG(object, **kwargs))

    def plotly(self, object: Any = None, **kwargs: Any) -> _pane.Plotly:
        return self._add(_pane.Plotly(object, **kwargs))

    def str(self, object: Any = None, **kwargs: Any) -> _pane.Str:
        return self._add(_pane.Str(object, **kwargs))

    def svg(self, object: Any = None, **kwargs: Any) -> _pane.SVG:
        return self._add(_pane.SVG(object, **kwargs))

    def vega(self, object: Any = None, **kwargs: Any) -> _pane.Vega:
        return self._add(_pane.Vega(object, **kwargs))

    def video(self, object: str = "", **kwargs: Any) -> _pane.Video:
        return self._add(_pane.Video(object, **kwargs))

    def avif(self, object: str = "", **kwargs: Any) -> _pane.AVIF:
        return self._add(_pane.AVIF(object, **kwargs))

    def gif(self, object: str = "", **kwargs: Any) -> _pane.GIF:
        return self._add(_pane.GIF(object, **kwargs))

    def ico(self, object: str = "", **kwargs: Any) -> _pane.ICO:
        return self._add(_pane.ICO(object, **kwargs))

    def placeholder(self, object: Any = None, **kwargs: Any) -> _pane.Placeholder:
        return self._add(_pane.Placeholder(object, **kwargs))

    def webp(self, object: str = "", **kwargs: Any) -> _pane.WebP:
        return self._add(_pane.WebP(object, **kwargs))


class _WidgetsFactory:
    """app.widgets.xxx() 工厂，与 pn.widgets 一致。"""

    __slots__ = ("_app",)

    def __init__(self, app: PanelApp) -> None:
        self._app = app

    def _add(self, comp: UIComponent) -> UIComponent:
        self._app._add_to_current(comp)
        return comp

    def button(self, **kwargs: Any) -> _widgets.Button:
        return self._add(_widgets.Button(**kwargs))

    def button_icon(self, **kwargs: Any) -> _widgets.ButtonIcon:
        return self._add(_widgets.ButtonIcon(**kwargs))

    def check_box_group(self, **kwargs: Any) -> _widgets.CheckBoxGroup:
        return self._add(_widgets.CheckBoxGroup(**kwargs))

    def check_button_group(self, **kwargs: Any) -> _widgets.CheckButtonGroup:
        return self._add(_widgets.CheckButtonGroup(**kwargs))

    def checkbox(self, **kwargs: Any) -> _widgets.Checkbox:
        return self._add(_widgets.Checkbox(**kwargs))

    def code_editor(self, **kwargs: Any) -> _widgets.CodeEditor:
        return self._add(_widgets.CodeEditor(**kwargs))

    def color_picker(self, **kwargs: Any) -> _widgets.ColorPicker:
        return self._add(_widgets.ColorPicker(**kwargs))

    def date_picker(self, **kwargs: Any) -> _widgets.DatePicker:
        return self._add(_widgets.DatePicker(**kwargs))

    def file_download(self, **kwargs: Any) -> _widgets.FileDownload:
        return self._add(_widgets.FileDownload(**kwargs))

    def file_input(self, **kwargs: Any) -> _widgets.FileInput:
        return self._add(_widgets.FileInput(**kwargs))

    def float_input(self, **kwargs: Any) -> _widgets.FloatInput:
        return self._add(_widgets.FloatInput(**kwargs))

    def float_slider(self, **kwargs: Any) -> _widgets.FloatSlider:
        return self._add(_widgets.FloatSlider(**kwargs))

    def int_input(self, **kwargs: Any) -> _widgets.IntInput:
        return self._add(_widgets.IntInput(**kwargs))

    def int_slider(self, **kwargs: Any) -> _widgets.IntSlider:
        return self._add(_widgets.IntSlider(**kwargs))

    def literal_input(self, **kwargs: Any) -> _widgets.LiteralInput:
        return self._add(_widgets.LiteralInput(**kwargs))

    def loading_spinner(self, **kwargs: Any) -> _widgets.LoadingSpinner:
        return self._add(_widgets.LoadingSpinner(**kwargs))

    def menu_button(self, **kwargs: Any) -> _widgets.MenuButton:
        return self._add(_widgets.MenuButton(**kwargs))

    def multi_select(self, **kwargs: Any) -> _widgets.MultiSelect:
        return self._add(_widgets.MultiSelect(**kwargs))

    def password_input(self, **kwargs: Any) -> _widgets.PasswordInput:
        return self._add(_widgets.PasswordInput(**kwargs))

    def progress(self, **kwargs: Any) -> _widgets.Progress:
        return self._add(_widgets.Progress(**kwargs))

    def radio_box_group(self, **kwargs: Any) -> _widgets.RadioBoxGroup:
        return self._add(_widgets.RadioBoxGroup(**kwargs))

    def radio_button_group(self, **kwargs: Any) -> _widgets.RadioButtonGroup:
        return self._add(_widgets.RadioButtonGroup(**kwargs))

    def range_slider(self, **kwargs: Any) -> _widgets.RangeSlider:
        return self._add(_widgets.RangeSlider(**kwargs))

    def select(self, **kwargs: Any) -> _widgets.Select:
        return self._add(_widgets.Select(**kwargs))

    def static_text(self, **kwargs: Any) -> _widgets.StaticText:
        return self._add(_widgets.StaticText(**kwargs))

    def switch(self, **kwargs: Any) -> _widgets.Switch:
        return self._add(_widgets.Switch(**kwargs))

    def tabulator(self, **kwargs: Any) -> _widgets.Tabulator:
        return self._add(_widgets.Tabulator(**kwargs))

    def text_area_input(self, **kwargs: Any) -> _widgets.TextAreaInput:
        return self._add(_widgets.TextAreaInput(**kwargs))

    def text_input(self, **kwargs: Any) -> _widgets.TextInput:
        return self._add(_widgets.TextInput(**kwargs))

    def toggle(self, **kwargs: Any) -> _widgets.Toggle:
        return self._add(_widgets.Toggle(**kwargs))

    def toggle_group(self, **kwargs: Any) -> _widgets.ToggleGroup:
        return self._add(_widgets.ToggleGroup(**kwargs))

    def array_input(self, **kwargs: Any) -> _widgets.ArrayInput:
        return self._add(_widgets.ArrayInput(**kwargs))

    def autocomplete_input(self, **kwargs: Any) -> _widgets.AutocompleteInput:
        return self._add(_widgets.AutocompleteInput(**kwargs))

    def boolean_status(self, **kwargs: Any) -> _widgets.BooleanStatus:
        return self._add(_widgets.BooleanStatus(**kwargs))

    def color_map(self, **kwargs: Any) -> _widgets.ColorMap:
        return self._add(_widgets.ColorMap(**kwargs))

    def date_range_picker(self, **kwargs: Any) -> _widgets.DateRangePicker:
        return self._add(_widgets.DateRangePicker(**kwargs))

    def date_range_slider(self, **kwargs: Any) -> _widgets.DateRangeSlider:
        return self._add(_widgets.DateRangeSlider(**kwargs))

    def date_slider(self, **kwargs: Any) -> _widgets.DateSlider:
        return self._add(_widgets.DateSlider(**kwargs))

    def datetime_input(self, **kwargs: Any) -> _widgets.DatetimeInput:
        return self._add(_widgets.DatetimeInput(**kwargs))

    def datetime_picker(self, **kwargs: Any) -> _widgets.DatetimePicker:
        return self._add(_widgets.DatetimePicker(**kwargs))

    def time_picker(self, **kwargs: Any) -> _widgets.TimePicker:
        return self._add(_widgets.TimePicker(**kwargs))

    def datetime_range_picker(self, **kwargs: Any) -> _widgets.DatetimeRangePicker:
        return self._add(_widgets.DatetimeRangePicker(**kwargs))

    def datetime_range_slider(self, **kwargs: Any) -> _widgets.DatetimeRangeSlider:
        return self._add(_widgets.DatetimeRangeSlider(**kwargs))

    def datetime_slider(self, **kwargs: Any) -> _widgets.DatetimeSlider:
        return self._add(_widgets.DatetimeSlider(**kwargs))

    def dial(self, **kwargs: Any) -> _widgets.Dial:
        return self._add(_widgets.Dial(**kwargs))

    def discrete_player(self, **kwargs: Any) -> _widgets.DiscretePlayer:
        return self._add(_widgets.DiscretePlayer(**kwargs))

    def gauge(self, **kwargs: Any) -> _widgets.Gauge:
        return self._add(_widgets.Gauge(**kwargs))

    def int_range_slider(self, **kwargs: Any) -> _widgets.IntRangeSlider:
        return self._add(_widgets.IntRangeSlider(**kwargs))

    def linear_gauge(self, **kwargs: Any) -> _widgets.LinearGauge:
        return self._add(_widgets.LinearGauge(**kwargs))

    def multi_choice(self, **kwargs: Any) -> _widgets.MultiChoice:
        return self._add(_widgets.MultiChoice(**kwargs))

    def number(self, **kwargs: Any) -> _widgets.Number:
        return self._add(_widgets.Number(**kwargs))

    def number_input(self, **kwargs: Any) -> _widgets.NumberInput:
        return self._add(_widgets.NumberInput(**kwargs))

    def player(self, **kwargs: Any) -> _widgets.Player:
        return self._add(_widgets.Player(**kwargs))

    def toggle_icon(self, **kwargs: Any) -> _widgets.ToggleIcon:
        return self._add(_widgets.ToggleIcon(**kwargs))

    def tooltip_icon(self, **kwargs: Any) -> _widgets.TooltipIcon:
        return self._add(_widgets.TooltipIcon(**kwargs))

    def tqdm(self, **kwargs: Any) -> _widgets.Tqdm:
        return self._add(_widgets.Tqdm(**kwargs))

    def trend(self, **kwargs: Any) -> _widgets.Trend:
        return self._add(_widgets.Trend(**kwargs))

    def video_stream(self, **kwargs: Any) -> _widgets.VideoStream:
        return self._add(_widgets.VideoStream(**kwargs))


class PanelApp(diyui.BaseApp):
    """Panel 专属 diyui App。

    用法：app = diypn.PanelApp()
    组件方法遵循 Panel 原生子包习惯：
      app.layout.column()    # 同 pn.layout.Column()
      app.pane.markdown()    # 同 pn.pane.Markdown()
      app.widgets.button()   # 同 pn.widgets.Button()
    """

    def __init__(self, *, config: diyui.ScopeConfig | None = None) -> None:
        if config is None:
            config = diyui.ScopeConfig(scheduler=diyui.ImmediateScheduler())
        super().__init__()
        self._config = config
        self.provider = "panel"
        self.layout = _LayoutFactory(self)
        self.pane = _PaneFactory(self)
        self.widgets = _WidgetsFactory(self)

    # ── serve ─────────────────────────────────

    def servable(self) -> None:
        """将 app 根下所有顶层 UIComponent 注册为 servable。"""
        self._sync_tree_to_panel(self)
        for component in self.get_panel_roots():
            component.servable()  # type: ignore[attr-defined]

    def _find_first_real_component(self, node: diyui.ScopeNode) -> UIComponent | None:
        """DFS 找到第一个 UIComponent。"""
        if isinstance(node, UIComponent):
            return node
        for child in node._children:
            result = self._find_first_real_component(child)
            if result is not None:
                return result
        return None

    @property
    def components(self) -> list[UIComponent]:
        """获取所有 UIComponent。"""
        result: list[UIComponent] = []
        for child in self._children:
            result.extend(self._find_all_real_components(child))
        return result

    def _find_all_real_components(self, node: diyui.ScopeNode) -> list[UIComponent]:
        """DFS 找到所有 UIComponent。"""
        if isinstance(node, UIComponent):
            return [node]
        result: list[UIComponent] = []
        for child in node._children:
            result.extend(self._find_all_real_components(child))
        return result

    def get_panel_roots(self) -> list[UIComponent]:
        """获取所有 panel 根组件（app._children 中每个分支的第一个 UIComponent）。"""
        result: list[UIComponent] = []
        for child in self._children:
            component = self._find_first_real_component(child)
            if component is not None:
                result.append(component)
        return result

    def _sync_tree_to_panel(self, node: diyui.ScopeNode) -> None:
        """将 diyui 树同步到 Panel 原生 children。"""
        if isinstance(node, UIComponent) and node.diy.panel_container:
            node._on_children_replaced(node._children)
        for child in node._children:
            self._sync_tree_to_panel(child)
