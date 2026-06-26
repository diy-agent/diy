"""Screen / Area / Panel 抽象 — 类似 Blender 的 Screen/Area/Editor 概念。

Screen = 一组 Area 的布局配置（可切换预设）
Area   = 矩形区域容器，内含一组 Panel（tab 切换）
Panel  = 具体的视图/编辑器组件

互斥规则：
  - left ⊗ right：同时只能有一个打开
  - center：始终可见
  - bottom：独立 toggle，不参与互斥

按钮语义：
  - Area 不可见 → 显示并切到默认 Panel
  - Area 可见但其他 Panel 活跃 → 切到指定 Panel
  - Area 可见且同 Panel 活跃 → 隐藏 Area
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PySide6.QtCore import QPropertyAnimation  # type: ignore[import-untyped]
    from PySide6.QtWidgets import QTabWidget, QWidget  # type: ignore[import-untyped]


class Panel:
    """Panel — Area 内的一个视图。

    Attributes:
        id: 唯一标识（如 "task_tree", "agent_chat"）
        label: tab 标签文本
        widget: Qt widget 实例
        icon: emoji 图标（顶栏/底栏按钮用）
    """

    def __init__(self, pid: str, label: str, widget: QWidget, icon: str = ""):
        self.id = pid
        self.label = label
        self.widget = widget
        self.icon = icon


class Area:
    """Area — 屏幕上的区域容器，包含多个 Panel (tab)。

    Attributes:
        aid: 区域标识 ("left", "center", "right", "bottom")
        panels: Panel 列表
        default_index: 默认激活的 panel 索引
        exclusive_group: 互斥组名 (left/right 互斥)
        is_overlay: True = 动画滑入/推挤模式, False = 始终可见
        min_width / max_width: overlay 模式下的宽度范围
        anim_duration_ms: 滑入动画时长
    """

    def __init__(
        self,
        aid: str,
        panels: list[Panel],
        *,
        default_index: int = 0,
        exclusive_group: str | None = None,
        is_overlay: bool = False,
        min_width: int = 0,
        max_width: int = 500,
        anim_duration_ms: int = 200,
    ):
        self.aid = aid
        self.panels = panels
        self.default_index = default_index
        self.exclusive_group = exclusive_group
        self.is_overlay = is_overlay
        self.min_width = min_width
        self.max_width = max_width
        self.anim_duration_ms = anim_duration_ms

        # 运行时状态（由 Screen 管理）
        self.visible: bool = False
        self.active_panel_index: int = default_index
        self._tab_widget: QTabWidget | None = None
        self._container: QWidget | None = None
        self._animation: QPropertyAnimation | None = None

    @property
    def active_panel(self) -> Panel:
        return self.panels[self.active_panel_index]

    def panel_by_id(self, pid: str) -> Panel | None:
        for p in self.panels:
            if p.id == pid:
                return p
        return None

    def panel_index(self, pid: str) -> int | None:
        for i, p in enumerate(self.panels):
            if p.id == pid:
                return i
        return None


class Screen:
    """Screen — 布局预设，管理一组 Area 的可见性和互斥。

    用法:
        screen = Screen("默认")
        screen.add_area(Area("center", [tree_panel]))
        screen.add_area(Area("right", [detail_panel, chat_panel],
                             exclusive_group="side", is_overlay=True))
        screen.add_area(Area("bottom", [output_panel, metrics_panel]))

        # 按钮点击 → toggle area
        screen.toggle_area("right", panel_id="agent_chat")
    """

    def __init__(self, name: str):
        self.name = name
        self._areas: dict[str, Area] = {}

        # 互斥组 → 当前活跃 area id
        self._exclusive_active: dict[str, str | None] = {}

        # 回调: (area_id, visible, panel_id) → None
        self._on_toggle: list[callable] = []

    def add_area(self, area: Area) -> None:
        self._areas[area.aid] = area
        if area.exclusive_group and area.exclusive_group not in self._exclusive_active:
            self._exclusive_active[area.exclusive_group] = None

    def area(self, aid: str) -> Area | None:
        return self._areas.get(aid)

    def on_toggle(self, callback: callable) -> None:
        """注册 toggle 回调: callback(aid, visible, panel_id)。"""
        self._on_toggle.append(callback)

    def toggle_area(self, aid: str, *, panel_id: str | None = None) -> None:
        """切换 Area 可见性 / Panel。

        规则:
        1. Area 不可见 → 显示，切到指定 panel (默认 default)
        2. Area 可见 + 不同 panel → 切到指定 panel
        3. Area 可见 + 同 panel → 隐藏
        """
        area = self._areas.get(aid)
        if area is None:
            return

        target_idx = area.panel_index(panel_id) if panel_id else area.default_index

        if not area.visible:
            # 情况 1：显示
            self._show_area(aid, target_idx)
        elif area.active_panel_index != target_idx:
            # 情况 2：切 tab
            self._switch_panel(aid, target_idx)
        else:
            # 情况 3：隐藏
            self._hide_area(aid)

    def show_area(self, aid: str, *, panel_id: str | None = None) -> None:
        """显示 Area（不 toggle — 用于任务选中等场景）。

        规则:
        1. Area 不可见 → 显示
        2. Area 可见 + 不同 panel → 切 tab
        3. Area 可见 + 同 panel → 不动（不隐藏）
        """
        area = self._areas.get(aid)
        if area is None:
            return

        target_idx = area.panel_index(panel_id) if panel_id else area.default_index

        if not area.visible:
            self._show_area(aid, target_idx)
        elif area.active_panel_index != target_idx:
            self._switch_panel(aid, target_idx)
        # else: 已显示同 panel，不动

    def _show_area(self, aid: str, panel_idx: int) -> None:
        area = self._areas[aid]

        # 处理互斥组
        if area.exclusive_group:
            current = self._exclusive_active.get(area.exclusive_group)
            if current and current != aid:
                self._hide_area(current)

        area.visible = True
        area.active_panel_index = panel_idx
        self._exclusive_active[area.exclusive_group] = aid

        for cb in self._on_toggle:
            cb(aid, True, area.active_panel.id)

    def _switch_panel(self, aid: str, panel_idx: int) -> None:
        area = self._areas[aid]
        area.active_panel_index = panel_idx
        if area._tab_widget:
            area._tab_widget.setCurrentIndex(panel_idx)

        for cb in self._on_toggle:
            cb(aid, True, area.active_panel.id)

    def _hide_area(self, aid: str) -> None:
        area = self._areas[aid]
        area.visible = False

        if area.exclusive_group:
            self._exclusive_active[area.exclusive_group] = None

        for cb in self._on_toggle:
            cb(aid, False, area.active_panel.id)

    def hide_area(self, aid: str) -> None:
        """强制隐藏 Area（Esc / 点击空白处）。"""
        area = self._areas.get(aid)
        if area and area.visible:
            self._hide_area(aid)

    def state(self) -> dict:
        """返回 Screen 完整状态快照。"""
        areas_state = {}
        for aid, area in self._areas.items():
            areas_state[aid] = {
                "visible": area.visible,
                "active_panel": area.active_panel.id if area.visible else None,
                "active_panel_index": area.active_panel_index,
                "panels": [p.id for p in area.panels],
                "exclusive_group": area.exclusive_group,
                "is_overlay": area.is_overlay,
            }
        return {
            "name": self.name,
            "areas": areas_state,
            "exclusive_active": self._exclusive_active,
        }

    def is_visible(self, aid: str) -> bool:
        area = self._areas.get(aid)
        return area.visible if area else False

    def active_panel_id(self, aid: str) -> str | None:
        area = self._areas.get(aid)
        return area.active_panel.id if area and area.visible else None
