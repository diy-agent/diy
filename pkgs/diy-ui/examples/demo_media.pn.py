"""Media 组件演示 — 音频/视频/播放器"""
import diy.ui
import diy.ui.providers.panel as diypn

app = diypn.PanelApp(config=diy.ui.ScopeConfig(mode=diy.ui.ScopeMode.DEV, scheduler=diy.ui.ImmediateScheduler()))

with app.layout.column():
    app.pane.markdown("# Media 组件")

    app.pane.markdown("## Audio")
    app.pane.audio("https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", name="Music Player")

    app.pane.markdown("## Video")
    app.pane.video("https://www.w3schools.com/html/mov_bbb.mp4", name="Sample Video")

    app.pane.markdown("## VideoStream (摄像头)")
    app.widgets.video_stream(value="", name="Camera", width=320)

    app.pane.markdown("## Player (循环播放器)")
    app.widgets.player(value=0, start=0, end=100, interval=100, name="Player")

    app.pane.markdown("## DiscretePlayer (离散选项)")
    app.widgets.discrete_player(options=["A", "B", "C", "D"], value="A", interval=500, name="Discrete")

    # Player + slider sync demo
    player = app.widgets.player(value=25, start=0, end=100, name="Demo Player")
    @app.layout.column().cell()
    def _(node: diypn.layout.Column):
        app.pane.markdown(f"> Player position: **{player.value}**")

app.servable()
