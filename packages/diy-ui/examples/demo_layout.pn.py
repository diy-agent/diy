"""Layout 组件演示 — 18 个容器类组件"""
import diyui
import diyui.providers.panel as diypn

app = diypn.PanelApp(config=diyui.ScopeConfig(mode=diyui.ScopeMode.DEV, scheduler=diyui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Layout 组件")

    app.pane.markdown("## Accordion (直接传入子组件)")
    with app.layout.accordion() as acc:
        app.pane.markdown("Section A content")
        app.pane.markdown("Section B content")

    app.pane.markdown("## Card")
    with app.layout.card(name="Card Title"):
        app.pane.markdown("Card content body")

    app.pane.markdown("## Column")
    with app.layout.column():
        app.pane.markdown("Item 1")
        app.pane.markdown("Item 2")
        app.pane.markdown("Item 3")

    app.pane.markdown("## Divider")
    app.pane.markdown("Above the divider")
    app.layout.divider()
    app.pane.markdown("Below the divider")

    app.pane.markdown("## Feed")
    with app.layout.feed():
        app.pane.markdown("Message 1")
        app.pane.markdown("Message 2")

    app.pane.markdown("## FlexBox")
    with app.layout.flex_box():
        app.pane.markdown("Flex 1")
        app.pane.markdown("Flex 2")
        app.pane.markdown("Flex 3")

    app.pane.markdown("## FloatPanel")
    with app.layout.float_panel(name="Floating"):
        app.pane.markdown("Floating content")

    app.pane.markdown("## GridBox")
    with app.layout.grid_box(ncols=3):
        app.pane.markdown("A")
        app.pane.markdown("B")
        app.pane.markdown("C")

    app.pane.markdown("## GridSpec")
    grid = app.layout.grid_spec(ncols=3, height=150)
    with grid:
        grid[0, 0] = app.pane.markdown("(0,0)")
        grid[0, 1] = app.pane.markdown("(0,1)")
        grid[1, :] = app.pane.markdown("(1,:) full row")

    app.pane.markdown("## GridStack")
    with app.layout.grid_stack(ncols=3, height=200):
        app.pane.markdown("GS A")
        app.pane.markdown("GS B")
        app.pane.markdown("GS C")

    app.pane.markdown("## HSpacer")
    with app.layout.row():
        app.pane.markdown("Left")
        app.layout.hspacer()
        app.pane.markdown("Right")

    app.pane.markdown("## Modal")
    modal = app.layout.modal(name="Click to Open")
    with modal:
        app.pane.markdown("Modal content here")

    app.pane.markdown("## Row")
    with app.layout.row():
        app.pane.markdown("Left")
        app.pane.markdown("Center")
        app.pane.markdown("Right")

    app.pane.markdown("## Spacer")
    with app.layout.row():
        app.pane.markdown("Left")
        app.layout.spacer(width=50)
        app.pane.markdown("Right")

    app.pane.markdown("## Swipe")
    with app.layout.swipe():
        app.pane.markdown("Page 1")
        app.pane.markdown("Page 2")
        app.pane.markdown("Page 3")

    app.pane.markdown("## Tabs")
    with app.layout.tabs():
        app.pane.markdown("> Tab A content — active by default")
        app.layout.row(
            app.pane.markdown("> Tab B"),
            app.widgets.button(name="Click me"),
        )

    app.pane.markdown("## VSpacer")
    with app.layout.column(height=200):
        app.pane.markdown("Top")
        app.layout.vspacer()
        app.pane.markdown("Bottom")

    app.pane.markdown("## WidgetBox")
    with app.layout.widget_box():
        app.widgets.button(name="Button in WidgetBox")
        app.widgets.text_input(value="Input in WidgetBox")

app.servable()
