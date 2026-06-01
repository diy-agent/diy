"""Panel provider 契约测试。

PanelApp 是 Panel 专属的 diy.ui App。
组件是 Panel 原生组件的薄包装，参数保持 Panel 风格。
"""

import panel as pn

import diy.ui
import diy.ui.providers.panel as diypn

# ═══════════════════════════════════════════════
# 构造与入口
# ═══════════════════════════════════════════════


class TestPanelAppConstruction:
    """PanelApp 构造与 provider 标识。"""

    def test_create_panel_app(self):
        app = diypn.PanelApp()
        assert app.provider == "panel"

    def test_app_is_base_app(self):
        app = diypn.PanelApp()
        assert isinstance(app, diy.ui.BaseApp)


# ═══════════════════════════════════════════════
# 组件参数保持 Panel 风格
# ═══════════════════════════════════════════════


class TestComponentPanelStyle:
    """组件参数与 Panel 原生保持一致。"""

    def test_button_keeps_panel_params(self):
        app = diypn.PanelApp()
        btn = app.widgets.button(name="Run", button_type="primary")
        assert btn.name == "Run"
        assert btn.button_type == "primary"

    def test_text_input_keeps_panel_params(self):
        app = diypn.PanelApp()
        inp = app.widgets.text_input(name="Name", placeholder="input name")
        assert inp.name == "Name"
        assert inp.placeholder == "input name"

    def test_radio_button_group_keeps_panel_params(self):
        app = diypn.PanelApp()
        radio = app.widgets.radio_button_group(options=["a", "b", "c"])
        assert radio.options == ["a", "b", "c"]

    def test_markdown_keeps_panel_params(self):
        app = diypn.PanelApp()
        md = app.pane.markdown("# Title")
        assert "# Title" in str(md.object)


# ═══════════════════════════════════════════════
# with context 构建 Panel 树
# ═══════════════════════════════════════════════


class TestWithContextPanelTree:
    """with 语法在 Panel 容器中构建父子关系。"""

    def test_column_contains_button(self):
        app = diypn.PanelApp()
        with app.layout.column() as col:
            btn = app.widgets.button(name="Run")
        assert btn.parent is col
        assert btn in col._children

    def test_nested_panel_containers(self):
        app = diypn.PanelApp()
        with app.layout.column() as outer:
            md1 = app.pane.markdown("outer")
            with app.layout.row() as inner:
                btn = app.widgets.button(name="Go")
            md2 = app.pane.markdown("after")
        assert outer._children == [md1, inner, md2]
        assert inner._children == [btn]

    def test_card_as_container(self):
        app = diypn.PanelApp()
        with app.layout.card(title="My Card") as card:
            btn = app.widgets.button(name="OK")
        assert btn.parent is card
        assert btn in card._children
        assert card.title == "My Card"


# ═══════════════════════════════════════════════
# 输入组件 value ↔ signal
# ═══════════════════════════════════════════════


class TestInputComponentSignal:
    """输入组件的 .value 代理到 signal.value。"""

    def test_text_input_value_reads_signal(self):
        app = diypn.PanelApp()
        inp = app.widgets.text_input(name="Name", value="Alice")
        assert inp.value == "Alice"
        assert inp.signal.value == "Alice"

    def test_text_input_value_writes_signal_and_target(self):
        """通过 wrapper.value 写入时，signal 和 Panel 原生值同步更新。"""
        app = diypn.PanelApp()
        inp = app.widgets.text_input(name="Name", value="Alice")
        inp.value = "Bob"
        assert inp.signal.value == "Bob"
        assert inp.value == "Bob"
        # 验证 Panel 原生 param 值也同步（通过 descriptor __get__ 绕过 property）
        pv = inp.param["value"].__get__(inp, type(inp))
        assert pv == "Bob"

    def test_text_input_panel_native_value_sync(self):
        """通过 Panel param 模拟用户输入，signal.value 应同步。"""
        app = diypn.PanelApp()
        inp = app.widgets.text_input(name="Name", value="Alice")
        # 模拟 Panel 用户输入事件
        inp.param.update(value="Charlie")
        assert inp.signal.value == "Charlie"
        assert inp.value == "Charlie"

    def test_radio_button_group_value(self):
        app = diypn.PanelApp()
        radio = app.widgets.radio_button_group(options=["a", "b"], value="a")
        assert radio.value == "a"
        radio.value = "b"
        assert radio.signal.value == "b"
        assert radio.value == "b"
        # 验证 Panel 原生 param 值也同步
        pv = radio.param["value"].__get__(radio, type(radio))
        assert pv == "b"


# ═══════════════════════════════════════════════
# wrapper 公开 native target
# ═══════════════════════════════════════════════


class TestWrapperExposesTarget:
    """wrapper 本身就是 Panel 原生实例，无需 .target。"""

    def test_button_is_panel_instance(self):
        app = diypn.PanelApp()
        btn = app.widgets.button(name="Run")
        assert isinstance(btn, pn.widgets.Button)

    def test_markdown_is_panel_instance(self):
        app = diypn.PanelApp()
        md = app.pane.markdown("hi")
        assert isinstance(md, pn.pane.Markdown)

    def test_column_is_panel_instance(self):
        app = diypn.PanelApp()
        col = app.layout.column()
        assert isinstance(col, pn.Column)


# ═══════════════════════════════════════════════
# 组件即 Panel 原生实例（继承验证）
# ═══════════════════════════════════════════════


class TestComponentIsPanelNative:
    """diyui 组件继承 Panel 原生类，可直接当 Panel 组件使用。"""

    def test_button_is_panel_button(self):
        app = diypn.PanelApp()
        btn = app.widgets.button(name="Run")
        assert isinstance(btn, pn.widgets.Button)
        assert btn.name == "Run"  # Panel param 直接可访问

    def test_text_input_is_panel_text_input(self):
        app = diypn.PanelApp()
        inp = app.widgets.text_input(name="Name", value="Alice")
        assert isinstance(inp, pn.widgets.TextInput)

    def test_radio_button_group_is_panel_radio(self):
        app = diypn.PanelApp()
        radio = app.widgets.radio_button_group(options=["a", "b"])
        assert isinstance(radio, pn.widgets.RadioButtonGroup)

    def test_markdown_is_panel_markdown(self):
        app = diypn.PanelApp()
        md = app.pane.markdown("hi")
        assert isinstance(md, pn.pane.Markdown)

    def test_column_is_panel_column(self):
        app = diypn.PanelApp()
        col = app.layout.column()
        assert isinstance(col, pn.Column)

    def test_row_is_panel_row(self):
        app = diypn.PanelApp()
        row = app.layout.row()
        assert isinstance(row, pn.Row)

    def test_card_is_panel_card(self):
        app = diypn.PanelApp()
        card = app.layout.card(title="T")
        assert isinstance(card, pn.Card)


class TestPanelNativeApiDirectAccess:
    """无需 .target 即可直接访问 Panel 原生 API。"""

    def test_button_on_click_works_directly(self):
        app = diypn.PanelApp()
        btn = app.widgets.button(name="Run")
        calls = []
        btn.on_click(lambda e: calls.append(1))
        assert btn.clicks == 0
        # on_click 已注册，验证无异常
        assert hasattr(btn, "on_click")

    def test_button_clicks_directly(self):
        app = diypn.PanelApp()
        btn = app.widgets.button(name="Run")
        assert btn.clicks == 0

    def test_wrapper_is_panel_instance_directly(self):
        """wrapper 自身就是 Panel 原生实例，可直接当 Panel 组件使用。"""
        app = diypn.PanelApp()
        btn = app.widgets.button(name="Run")
        assert isinstance(btn, pn.widgets.Button)

    def test_text_input_param_watch_directly(self):
        app = diypn.PanelApp()
        inp = app.widgets.text_input(value="hello")
        # param.watch 直接可用（无 .target）
        assert hasattr(inp.param, "watch")


# ═══════════════════════════════════════════════
# app.signal() 在 Panel context 中
# ═══════════════════════════════════════════════


class TestPanelAppSignal:
    """app.signal() 创建 scope signal 并参与 cell rerun。"""

    def test_signal_inside_panel_container(self):
        app = diypn.PanelApp()
        with app.layout.column() as col:
            sig = app.signal(42)
        assert isinstance(sig, diy.ui.Signal)
        assert sig.owner is col

    def test_cell_with_panel_components(self):
        """cell 内使用 Panel 组件，signal 变化时 rerun。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV,
                scheduler=diy.ui.ImmediateScheduler(),
            )
        )
        count = app.signal(0)

        col = app.layout.column()

        @col.cell()
        def _(node: object):
            app.pane.markdown(str(count.value))

        assert col._children[0].object == "0"  # type: ignore[attr-defined]

        count.value = 42

        assert col._children[0].object == "42"  # type: ignore[attr-defined]


# ═══════════════════════════════════════════════
# servable
# ═══════════════════════════════════════════════


class TestPanelServable:
    """servable() 遍历所有顶层 UIComponent 并调用 .servable()。"""

    def test_servable_called_on_all_root_components(self):
        app = diypn.PanelApp()
        app.pane.markdown("# Title")
        app.widgets.button(name="Run")
        # 不应抛异常，所有组件都 servable
        app.servable()

    def test_servable_works_with_nested_containers(self):
        app = diypn.PanelApp()
        with app.layout.column():
            app.widgets.button(name="Run")
        # 不应抛异常
        app.servable()

    def test_servable_empty_app(self):
        app = diypn.PanelApp()
        # 空 app 不抛异常
        app.servable()


# ═══════════════════════════════════════════════
# 场景集成测试 — Demo 级完整链路
# ═══════════════════════════════════════════════


class TestPanelScenario:
    """Demo 页面场景：输入组件 ↔ cell ↔ 按钮事件 联动验证。

    这是最易出"signal 无效"的测试：单组件测试全过，但完整场景链路断裂。
    """

    def test_input_changes_trigger_cell_rerun(self):
        """输入组件 value 变化 → signal 更新 → 依赖 cell 自动 rerun。

        覆盖 demo 中的 name_input / multiplier_input → greeting cell 链。
        """
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        # 模拟 demo 布局：输入组件在一个列中
        with app.layout.column():
            name_input = app.widgets.text_input(name="Name", value="World")

        # cell 在兄弟列中，读取 name_input.value（跨组件依赖）
        @app.layout.column().cell()
        def _(node: object):
            app.pane.markdown(f"Hello {name_input.value}")

        # 初始渲染
        assert app._children[1]._children[0].object == "Hello World"  # type: ignore[attr-defined]

        # 模拟 Panel 用户输入 → 触发 _setup_event_bridge 中的 param.watch
        name_input.param.update(value="Alice")

        # cell 应自动 rerun
        assert app._children[1]._children[0].object == "Hello Alice"  # type: ignore[attr-defined]

    def test_cell_rerenders_multiple_signals(self):
        """多个信号变化时 cell 正确 rerun，不遗漏也不多跑。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        with app.layout.column():
            name = app.widgets.text_input(name="Name", value="A")
            mult = app.widgets.radio_button_group(
                name="Mult", options={"x1": 1, "x2": 2}, value=1
            )

        @app.layout.column().cell()
        def _(node: object):
            app.pane.markdown(f"{name.value}×{mult.value}")

        cell_col = app._children[1]
        assert cell_col._children[0].object == "A×1"  # type: ignore[attr-defined]

        # 只改 multiplier
        mult.param.update(value=2)
        assert cell_col._children[0].object == "A×2"  # type: ignore[attr-defined]

        # 改 name
        name.param.update(value="B")
        assert cell_col._children[0].object == "B×2"  # type: ignore[attr-defined]

    def test_button_click_updates_signal_and_triggers_cell(self):
        """按钮 on_click → signal.value 变更 → 依赖 cell 自动 rerun。

        覆盖 demo 中的 counter + button + cell 链。Button 的 click 回调通过
        Panel 原生机制触发，不走 diy.ui API——这是最容易断的链路。
        """
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        with app.layout.column():
            counter = app.signal(0)

            with app.layout.row():
                btn_dec = app.widgets.button(name="-1")
                btn_inc = app.widgets.button(name="+1")
                btn_dec.on_click(lambda e: setattr(counter, "value", counter.value - 1))
                btn_inc.on_click(lambda e: setattr(counter, "value", counter.value + 1))

            @app.layout.column().cell()
            def _(node: object):
                app.pane.markdown(f"Count: {counter.value}")

        # 初始：cell 已执行，counter=0
        outer_col = app._children[0]
        _row = outer_col._children[0]  # 第1个子节点：app.layout.row()
        cell_col = outer_col._children[1]  # 第2个子节点：cell 所在列
        assert cell_col._children[0].object == "Count: 0"  # type: ignore[attr-defined]

        # 模拟 Panel 按钮点击（param.trigger 触发 on_click 回调链）
        # Panel Button 通过 param.trigger('value') 或 param.trigger('clicks') 触发
        # 这里直接调 clicks param 触发 on_click watcher
        btn_inc.param.trigger("clicks")

        assert counter.value == 1
        assert cell_col._children[0].object == "Count: 1"  # type: ignore[attr-defined]

        btn_dec.param.trigger("clicks")
        assert counter.value == 0
        assert cell_col._children[0].object == "Count: 0"  # type: ignore[attr-defined]

    def test_servable_syncs_panel_native_children(self):
        """servable() 后 Panel 原生容器 children 与 diy.ui 树一致。

        这是 UI 渲染正确性的关键：diy.ui children → Panel Column[:]。
        """
        app = diypn.PanelApp()
        with app.layout.column():
            app.pane.markdown("# Title")
            app.widgets.button(name="Click Me")

        app.servable()

        # 验证 Panel 原生 children 已同步
        col = app._children[0]  # 第一个子节点就是 column
        # Panel Column 的原生 objects 属性包含实际渲染对象
        native_objects = list(col.objects)  # type: ignore[attr-defined]
        assert len(native_objects) == 2
        assert isinstance(native_objects[0], pn.pane.Markdown)
        assert isinstance(native_objects[1], pn.widgets.Button)
        assert native_objects[0].object == "# Title"  # type: ignore[attr-defined]

    def test_cell_rerun_updates_panel_native_children(self):
        """Cell rerun 后 Panel 原生 children 也得到更新（servable 同步）。

        验证完整链路：signal 变化 → cell rerun → diy.ui children 替换
        → servable() → Panel 原生 children 更新。
        """
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        count = app.signal(0)

        @app.layout.column().cell()
        def _(node: object):
            app.pane.markdown(str(count.value))

        col = app._children[0]

        # 初始
        assert col._children[0].object == "0"  # type: ignore[attr-defined]

        count.value = 99
        assert col._children[0].object == "99"  # type: ignore[attr-defined]

        # servable() 后 Panel 原生也同步
        app.servable()
        native_objects = list(col.objects)  # type: ignore[attr-defined]
        assert len(native_objects) == 1
        assert native_objects[0].object == "99"  # type: ignore[attr-defined]


# ═══════════════════════════════════════════════
# Button 同步流测试
# ═══════════════════════════════════════════════


class TestButtonSyncFlow:
    """Button 内部 Signal[bool] 同步流：点击 → True → cell rerun → 自动恢复 False。"""

    def test_button_has_internal_signal(self):
        """Button 创建时内部维护 Signal[bool]。"""
        app = diypn.PanelApp()
        btn = app.widgets.button(label="Go")
        assert isinstance(btn.signal, diy.ui.Signal)
        assert btn.signal.value is False
        assert btn.value is False
        assert btn.signal._reset_on_complete is True

    def test_button_value_is_signal_proxy(self):
        """btn.value 读取代理到 btn.signal.value。

        value.setter 在初始化后是 no-op（避免 Panel Event set-reset 干扰）。
        程序化修改应走 btn.signal.value = ...。
        """
        app = diypn.PanelApp()
        btn = app.widgets.button(label="Go")
        assert btn.value is False
        btn.signal.value = True
        assert btn.value is True
        btn.signal.value = False
        assert btn.value is False

    def test_click_sets_signal_true(self):
        """模拟点击（param.trigger clicks）→ signal.value = True。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )
        btn = app.widgets.button(label="Go")
        app._add_to_current(btn)

        assert btn.value is False
        btn.param.trigger("clicks")
        assert btn.value is True
        assert btn.signal.value is True

    def test_button_click_triggers_cell_rerun(self):
        """按钮点击 → signal=True → 依赖 cell rerun → if btn.value: 进入分支。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        btn = app.widgets.button(label="Option 1")
        app._add_to_current(btn)

        messages = []

        @btn.cell()
        def _(node: object):
            messages.append(f"cell ran, btn.value={btn.value}")
            if btn.value:
                messages.append(">> Option 1 selected!")

        # 初始：cell 执行一次，btn.value=False
        assert messages == ["cell ran, btn.value=False"]

        # 模拟点击
        btn.param.trigger("clicks")

        # cell 应 rerun：读到 True，进入 if 分支
        assert ">> Option 1 selected!" in messages
        assert "cell ran, btn.value=True" in messages

    def test_button_auto_reset_after_cell_rerun(self):
        """Cell rerun 完成后 button signal 自动恢复为 False。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        btn = app.widgets.button(label="Go")
        app._add_to_current(btn)

        @btn.cell()
        def _(node: object):
            _ = btn.value  # 只读，注册依赖

        # 点击
        btn.param.trigger("clicks")

        # cell rerun 完成后 signal 恢复 False
        assert btn.value is False
        assert btn.signal.value is False

    def test_button_no_extra_cell_rerun_on_reset(self):
        """Auto-reset 不应触发额外的 cell rerun（使用 _reset_value，不触发 cell）。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        btn = app.widgets.button(label="Go")
        app._add_to_current(btn)

        rerun_count = 0

        @btn.cell()
        def _(node: object):
            nonlocal rerun_count
            rerun_count += 1
            _ = btn.value

        # 初始执行 1 次
        assert rerun_count == 1

        # 点击 → 应只多 1 次 rerun（读到 True），reset 不触发额外 rerun
        btn.param.trigger("clicks")
        assert rerun_count == 2, f"Expected 2 reruns, got {rerun_count}"

    def test_full_click_only_reruns_once(self):
        """模拟 Panel 真实点击（param.trigger value + clicks+=1），
        只触发 1 次 cell rerun，不受 Event set-reset 干扰。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        btn = app.widgets.button(label="Go")
        app._add_to_current(btn)

        rerun_count = 0

        @btn.cell()
        def _(node: object):
            nonlocal rerun_count
            rerun_count += 1
            _ = btn.value

        assert rerun_count == 1

        # 模拟 Panel Button._process_event：value trigger + clicks += 1
        btn.param.trigger("value")
        btn.clicks += 1

        assert rerun_count == 2, f"Expected 2 reruns, got {rerun_count}"
        assert btn.value is False  # auto-reset done

    def test_value_setter_noop_after_init(self):
        """value.setter 在初始化后是 no-op，避免 Panel Event set-reset 干扰。
        程序化修改应走 btn.signal.value = ...。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )
        btn = app.widgets.button(label="Go")

        assert btn.value is False

        # init 后 value.setter 是 no-op
        btn.value = True
        assert btn.value is False  # signal 没变
        assert btn.signal.value is False

        # 只能走 signal 修改
        btn.signal.value = True
        assert btn.value is True

    def test_two_buttons_independent(self):
        """两个独立 button，各自触发各自的 cell。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(
                mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()
            )
        )

        btn1 = app.widgets.button(label="First")
        btn2 = app.widgets.button(label="Second")
        app._add_to_current(btn1)
        app._add_to_current(btn2)

        results = []

        @btn1.cell()
        def _(node: object):
            if btn1.value:
                results.append("first")

        @btn2.cell()
        def _(node: object):
            if btn2.value:
                results.append("second")

        # 点击 btn1
        btn1.param.trigger("clicks")
        assert "first" in results
        assert "second" not in results

        # 点击 btn2
        btn2.param.trigger("clicks")
        assert results == ["first", "second"]


# ═══════════════════════════════════════════════
# auto_mount 控制
# ═══════════════════════════════════════════════


class TestAutoMount:
    """auto_mount_child 控制当前容器下组件创建时是否自动挂载。"""

    def test_auto_mount_child_defaults_to_true(self):
        """默认 auto_mount_child 为 True（None → 视为 True），组件自动挂载。"""
        app = diypn.PanelApp()
        with app.layout.column() as col:
            btn = app.widgets.button(name="Ok")
        assert btn.parent is col
        assert btn in col._children

    def test_auto_mount_child_false_skips_mount(self):
        """auto_mount_child=False 的容器下，组件不自动挂载。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(scheduler=diy.ui.ImmediateScheduler())
        )
        col = app.layout.column()
        # 给 col 设 auto_mount_child=False（作为已挂载容器控制子组件行为）
        col._config = diy.ui.ScopeConfig(
            auto_mount_child=False,
            scheduler=diy.ui.ImmediateScheduler(),
        )
        with col:
            btn = app.widgets.button(name="NoAuto")
        # 不加入 _children
        assert btn not in col._children
        # parent 不设置
        assert btn.parent is None
        # _app 已设置
        assert btn._app is app

    def test_auto_mount_child_false_can_still_manually_mount(self):
        """auto_mount_child=False 时仍可手动 _add_child 挂载。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(scheduler=diy.ui.ImmediateScheduler())
        )
        col = app.layout.column()
        col._config = diy.ui.ScopeConfig(
            auto_mount_child=False,
            scheduler=diy.ui.ImmediateScheduler(),
        )
        with col:
            btn = app.widgets.button(name="Manual")
        # 手动挂载
        col._add_child(btn)
        assert btn.parent is col
        assert btn in col._children

    def test_auto_mount_child_false_panel_native_empty(self):
        """auto_mount_child=False 时 Panel 原生容器也不包含未挂载组件。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(scheduler=diy.ui.ImmediateScheduler())
        )
        col = app.layout.column()
        col._config = diy.ui.ScopeConfig(
            auto_mount_child=False,
            scheduler=diy.ui.ImmediateScheduler(),
        )
        with col:
            btn = app.widgets.button(name="Solo")
        assert list(col.objects) == []
        col._add_child(btn)
        assert list(col.objects) == [btn]

    def test_auto_mount_child_true_explicit(self):
        """auto_mount_child=True 显式设置，行为同默认。"""
        app = diypn.PanelApp(
            config=diy.ui.ScopeConfig(scheduler=diy.ui.ImmediateScheduler())
        )
        col = app.layout.column()
        col._config = diy.ui.ScopeConfig(
            auto_mount_child=True,
            scheduler=diy.ui.ImmediateScheduler(),
        )
        with col:
            btn = app.widgets.button(name="Ok")
        assert btn.parent is col
