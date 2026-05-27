import asyncio
import datetime
import diyui
import diyui.providers.panel as diypn

app = diypn.PanelApp()

app.pane.markdown("# 🚀 diyUI 异步并发与隔离压力测试")
app.pane.markdown("点击 **Launch All** 观察三路异步任务如何在 **不阻塞 UI、不互相干扰** 的情况下并发执行。")

# 1. 全局触发信号（用于一键启动三路并行）
start_all = app.signal(0)
app.widgets.button(label="🚀 Launch All Simultaneously", button_type="primary").on_click(
    lambda e: setattr(start_all, "value", start_all.value + 1)
)

# 2. 封装任务逻辑，体现“局部状态隔离”
def task_card(name, color, delay):
    # 使用独立的 Card 容器
    with app.layout.card(title=f"Task {name} ({delay}s)", width=350):
        # 每个任务独立的计数器（局部信号）
        local_run = app.signal(0)
        
        app.widgets.button(label=f"Run {name}").on_click(
            lambda e: setattr(local_run, "value", local_run.value + 1)
        )
        
        # 内部 Cell：监听全局和局部信号
        # 这里故意不加装饰器参数，体现其独立响应能力
        @app.layout.column().cell()
        async def _(node):
            # 这里的读操作会注册两个依赖
            trigger_id = start_all.value + local_run.value
            if trigger_id == 0:
                yield app.pane.markdown("  等待启动...")
                return

            yield app.pane.markdown(f"  {color} **任务 #{trigger_id} 启动**")
            
            for i in range(5):
                await asyncio.sleep(delay)
                # 核心测试点：
                # 1. yield 是否依然准确挂载到本 Card 的 Column 中（测试 ContextVar 隔离）
                # 2. await 切换后，读取到的信号值是否准确
                now = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
                yield app.pane.markdown(f"  {color} {name}: {i+1}/5 @ {now}")
                
            yield app.pane.markdown(f"  ✅ {name} 完成")

# 3. 布局：三路并行。这三路 Task 之间完全解耦。
with app.layout.row():
    task_card("A", "🔴", 0.4)
    task_card("B", "🔵", 0.7)
    task_card("C", "🟡", 1.2)

app.pane.markdown("---")
app.pane.markdown("### 验证要点")
app.pane.markdown("""
1. **并发性**：点击 Launch All，三路进度条独立跳动。
2. **隔离性**：即使 Task A 正在 await，Task B 的 yield 也绝不会出现在 A 的卡片中。
3. **状态独立**：单独点 Run A 不会重置或干扰 B 和 C。
""")

app.servable()
