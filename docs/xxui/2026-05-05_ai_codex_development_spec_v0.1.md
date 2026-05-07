---
source: ai_codex
author: Codex, reviewed and corrected by chen56
generated_by: Codex
last_updated: 2026-05-05
status: current_development_spec
---

# DAO UI v0.1 Development Spec

本文是后续开发入口文档。旧文件保留为过程材料；实现、测试、计划应以本文为准。

## 0. 核心决策

DAO UI 不再尝试抽象一套统一 UI 组件设计语言。

DAO UI 只统一：

- state runtime
- ScopeNode runtime
- signal dependency tracking
- rerun cell
- scheduler policy
- debug/log/notify scope
- resource lifetime

DAO UI 不统一：

- CSS/layout 语义
- provider 组件参数
- provider 事件命名
- provider UI 设计模式
- provider 原生运行方式

原因：Panel、marimo 等框架已经有各自成熟 UI 组件和参数体系。强行统一组件层会导致参数对齐困难、CSS/layout 语义失真、实现成本过高，并且容易因为不熟悉各 provider 细节而设计出错误抽象。

因此最终方向是：

```python
class dao_ui.providers.panel.Button:
    target: pn.widgets.Button
    signal: dao_ui.Signal | None

    @property
    def value(self) -> object:
        return self.signal.value
```

也就是：组件是 provider 原生组件的薄包装，参数尽量与 provider 保持一致；DAO UI 在 wrapper 上附加自己的 ScopeNode、Signal、rerun、debug、lifetime 能力。

## 1. 包名与入口

包名固定为 `dao_ui`。

```python
import dao_ui as ui
import dao_ui.providers.panel as panel

app = ui.App(provider=panel.Provider())
```

API 规则：

- 组件方法统一小写。
- 不提供 `ui.text()` 这类模块级 UI 创建 API。
- 所有组件创建必须从 app 或当前容器所属 app 进入。
- 不暴露 `parent.context.button()`。
- `app.current` 暂不作为公开 API。

## 2. 分层模型

```text
Provider UI target
    ↑ wrapped by
Provider Component Wrapper
    ↑ is also
UIComponent
    ↑ is also
ScopeNode
```

继承/组合概念：

```text
ScopeNode
    ↑
UIComponent
    ↑
PanelButton / PanelColumn / MarimoButton / MarimoStack ...
```

`ScopeNode` 是 runtime 抽象，负责：

- ownership
- signal scope
- dependency tracking
- scheduler policy lookup
- notification policy lookup
- logger/debug boundary
- resource lifetime
- rerun capability

`UIComponent` 是 UI 抽象，负责：

- provider target 创建
- parent-child append/replace
- with context
- mount
- event bridge

具体组件只做 provider wrapper，例如：

```python
class TextInput(UIComponent):
    target: pn.widgets.TextInput
    signal: ui.Signal[str]

    @property
    def value(self) -> str:
        return self.signal.value

    @value.setter
    def value(self, value: str) -> None:
        self.signal.value = value
```

## 3. Provider 原则

Provider 负责把 DAO UI runtime 接到现有框架。

```python
app = ui.App(provider=panel.Provider())
```

Provider 必须遵守：

- 参数尽量与原 provider 一致。
- 事件命名尽量与原 provider 一致。
- 不做跨 provider 参数统一。
- 不做 CSS/layout 抽象翻译。
- 不暴露统一 HTML/CSS 设计语言。
- 可以在 adapter 内部使用 provider 的 watch/callback/event 机制。
- 用户侧不需要理解 provider 的状态机制，状态统一进入 DAO UI signal。

Panel 示例：

```python
button = app.button(name="Run", button_type="primary")
text = app.text_input(name="Name", placeholder="input name")
group = app.radio_button_group(options=["a", "b"])
```

marimo 示例：

```python
text = app.text_input(label="Name")
choice = app.radio(options=["a", "b"])
```

这两个 provider 的参数不要求完全一致。

## 4. App 与根节点

`App` 是根 ScopeNode，也是虚拟 UI 容器。

```python
app = ui.App(provider=panel.Provider())
```

约束：

- app 不必直接对应 provider 原生组件。
- app 是 current context 的初始节点。
- app 可以支持多实例，便于测试和隔离。
- provider 原生 root 由 provider 决定。
- `app.mount()` 负责把 children 挂载到 provider 运行环境。

Panel 方向：

```python
app.mount()
# 内部由 provider 将 app children 组织为 Panel root 并 servable
```

## 5. Context 与构树

with 语法只负责构建 parent-child 关系，不负责 rerun block 捕获。

```python
with app.column():
    app.markdown("# Title")
    app.button(name="Run")
```

语义：

```text
create column wrapper
append column.target to current parent target
push column as current context
create markdown and button under column
pop context
```

v0.1 暂不实现 `contextvars.ContextVar`。

原因：当前 UI API 设计为单线程同步模型。context 管理先封装在 app/runtime 内部，后续如果引入 async、多线程、跨 task UI 构建，再评估切换到 `contextvars.ContextVar`。

## 6. Signal

Signal 是 DAO UI 状态原语。

```python
count = app.signal(0)
count.value += 1
```

重要决策：

- Signal 本身是独立 runtime primitive，可以通过 `dao_ui.signal.Signal(...)` 或 `dao_ui.signal.signal(...)` 直接构造。
- UI 响应式 rerun 必须使用 `app.signal()` 创建 scope signal。
- `app.signal()` 的职责是创建 signal 并挂载到当前 ScopeNode。
- app 限定只对 scope signal 做 UI rerun。
- signal 有 owner/scope/lifetime/debug metadata。
- signal 作用域原则上是 owner node 的子树。
- 子树外访问 signal：dev 模式报错，prod 模式 warning log。
- 读取 `.value` 时，如果当前正在执行 cell，则注册依赖。
- 写入 `.value` 时，如果新旧值相等，不触发 rerun。
- v0.1 只支持单值 signal，不支持 deep reactive list/dict。

正确列表写法：

```python
items = app.signal(["a", "b"])

items.value = items.value + ["c"]
items.value = items.value[1:]
```

不保证触发：

```python
items.value.append("c")
```

## 7. 输入组件与 Signal

输入组件返回组件 wrapper，不直接返回 Signal。

```python
name = app.text_input(name="Name")

@app.column().cell()
def _(node: ui.providers.panel.Column):
    app.markdown(f"hello {name.value}")
```

wrapper 内部持有 signal：

```python
class TextInput(UIComponent):
    target: ProviderTextInput
    signal: Signal[str]

    @property
    def value(self) -> str:
        return self.signal.value
```

约束：

- `name.value` 代理到 `name.signal.value`。
- 输入组件内部 signal 与 `app.signal()` 使用同一套 dependency tracking。
- v0.1 暂不支持外部 signal 绑定：

```python
name = app.signal("")
app.text_input(value=name)  # v0.1 不支持
```

provider 事件桥接：

```text
provider user event
    -> wrapper receives native value
    -> wrapper.signal.value = native value
    -> scheduler marks dependent cells dirty
```

## 8. Cell

Cell 是 rerun 单位。普通函数不是 reactive component。

```python
@app.card(title="Display").cell()
def _(node: ui.providers.panel.Card):
    app.markdown(f"count = {count.value}")
```

最终 API：

- 使用 `@app.xxx(...).cell()`。
- 不使用 `app.anno.xxx()`。
- cell 定义时立即首次执行并挂载。
- v0.1 按对象实例管理，不需要 key/id。
- 所有 provider wrapper 都可以 `.cell()`。
- 不提供 `app.cell()` 或 `app.scope()` 这种超出 provider 范畴的虚拟组件。
- 容器组件作为 cell 时，可以继续挂载子 UI。
- 原子组件作为 cell 时，只能更新自身 wrapper 或 `target`，继续挂载子 UI 应报错。

容器组件 cell：

```python
@app.column().cell()
def _(node: ui.providers.panel.Column):
    app.markdown(f"value = {value.value}")
```

原子组件 cell：

```python
@app.button(name="Run").cell()
def _(node: ui.providers.panel.Button):
    node.disabled = disable_all.value
    node.target.disabled = disable_all.value
```

原子组件 cell 内禁止挂载子 UI：

```python
@app.button(name="Run").cell()
def _(node: ui.providers.panel.Button):
    app.markdown("child")  # error: button is not a container
```

`.cell(fn)` 和装饰器形式等价：

```python
app.markdown("").cell(lambda node: setattr(node, "value", str(count.value)))
```

多行逻辑推荐函数装饰器，不推荐 lambda tuple。

## 9. Cell 函数参数

cell 函数接收一个 `node` 参数。

`node` 就是当前被 `.cell()` 标记的 provider wrapper，也是当前 ScopeNode。装饰器默认没有返回值，因此 cell body 需要通过 `node` 引用当前组件。

```python
@app.button(name="Run").cell()
def _(node: ui.providers.panel.Button):
    node.disabled = disable_all.value
    node.target.disabled = disable_all.value
```

`node` 不是业务 props，不用于 props replay。

允许无参函数作为便捷形式，但不推荐，因为无法拿到当前 wrapper：

```python
@app.column().cell()
def _():
    app.markdown("hello")
```

禁止引入 Solara/React 风格 props replay：

```python
@component
def Panel(name: str):
    ...
```

自定义组件就是普通 Python 函数：

```python
def TodoItem(app: ui.App, item: str) -> None:
    with app.row():
        app.markdown(item)
        app.button(name="Remove")
```

## 10. Rerun 事务

Cell rerun 是同步 transaction。

```text
external event
    -> signal.value set
    -> submit dirty cell to nearest scheduler
    -> scheduler flush
    -> synchronous cell rerun
    -> provider update
```

rerun 规则：

- rerun 前清空旧依赖。
- rerun 时重新 tracking。
- 条件依赖动态更新。
- 同一个 cell 当前 flush 内去重。
- 禁止嵌套 rerun；rerun 中写 signal 只 enqueue。
- 当前 rerun 完成后 flush 队列。
- 默认设置最大 rerun 深度，例如 `MAX_RERUN_DEPTH = 100`。
- 同一 signal 触发多个 cell：纵向按树从上到下，横向按同层 children 顺序。

错误处理：

- cell rerun 应先在 staging scope 收集新组件。
- 成功后一次性替换旧 children。
- 失败时保留旧 UI。
- 默认将错误抛到控制台并通知页面。
- 错误展示位置由 scope notification policy 决定。
- cell 报错后依赖保留，便于 debug。

注意：这与“组件创建立即挂载”并不冲突。正常构树立即挂载到当前 provider parent；cell rerun 时当前 parent 是临时 staging container，成功后 provider adapter 执行 replace。

## 11. Scheduler

Scheduler 是 ScopeNode facet，不是全局单例。

```python
app = ui.App(
    provider=panel.Provider(),
    scope=ui.ScopeConfig(
        mode="prod",
        scheduler=ui.schedulers.periodic(period_ms=10),
    ),
)

with app.column(scope=ui.ScopeConfig(scheduler=ui.schedulers.immediate())):
    ...
```

v0.1 至少考虑两种策略：

- immediate scheduler：写入后同步 flush，便于测试。
- periodic/batched scheduler：类似 Flutter frame/batch 思路。
- dev mode 默认 scheduler：immediate。
- prod mode 默认 scheduler：periodic。

兼容原则：

- `signal.value` 写入本身同步完成，后续 Python 语句能读到新值。
- UI rerun 是否立即执行由最近 scheduler policy 决定。
- 测试优先使用 immediate scheduler 降低不确定性。

## 12. ScopeNode 配置树

UI 树也是 runtime 配置树。

```python
app = ui.App(
    provider=panel.Provider(),
    scope=ui.ScopeConfig(mode="prod"),
)

with app.page(scope=ui.ScopeConfig(scheduler=ui.schedulers.immediate())):
    sig_a = app.signal(1)

    with app.sidebar():
        sig_b = app.signal(2)

    with app.column(scope=ui.ScopeConfig(scheduler=ui.schedulers.periodic(period_ms=100))):
        sig_c = app.signal(3)
```

形成：

```text
App
└── Page scheduler=immediate
    ├── sig_a
    ├── Sidebar
    │   └── sig_b
    └── Column scheduler=periodic(100ms)
        └── sig_c
```

查找规则：

- `app.notify()` 查找最近 notification policy。
- signal 更新查找 signal owner scope 下最近 scheduler。
- log/print 查找最近 logger/debug policy。
- resource 销毁跟随 owner ScopeNode lifetime。

## 13. Debug / Log / Notify

Debug 是 scope 能力。

v0.1 设计时应预留：

- dev/prod mode
- cell rerun count
- cell dependency list
- signal owner
- signal propagation path
- illegal cross-scope usage warning
- print/log capture
- error notification

print/log 策略可以包括：

- 控制台输出
- 当前 cell 下方输出
- 全局 debug panel
- 页面 notification bubble

实现可先做最小策略，但数据模型要能扩展。

## 14. Provider Component Set

v0.1 不设计统一组件集，只定义 provider wrapper 的最低验证范围。

Panel provider v0.1：

- `column`
- `row`
- `card`
- `button`
- `text_input`
- `radio_button_group`
- `markdown`

marimo provider v0.1：

- `hstack`
- `vstack`
- `button`
- `text`
- `radio`
- `md` / markdown
- 参数按 marimo 原生习惯，不强行与 Panel 一致。
- marimo 只是 provider，不依赖 marimo cell 语义实现 DAO UI runtime。

## 15. Mount 与原生对象暴露

provider 原生对象不隐藏。DAO UI 是薄层，允许用户直接查看和操作 wrapper 的 `target`。

```python
button = app.button(name="Run")
button.target  # provider native object
```

注意：

- 直接操作 `target` 是高级用法。
- 如果用户绕过 DAO UI signal/runtime 修改 provider 状态，DAO UI 不保证能追踪这些变化。
- DAO UI 不干预用户直接操作原生组件。
- 当 DAO UI wrapper 能力不足时，用户可以自行扩展或直接使用原 provider 组件。
- 常规状态联动仍应通过 wrapper `.value` / `.signal` / `app.signal()` 完成。

## 16. 非目标

v0.1 不做：

- 自研 browser renderer
- 虚拟 DOM
- tree diff
- compile/AST transform
- hook system
- props replay
- 统一 CSS/layout 抽象
- 统一 provider 参数
- reactive list/dict/deep object
- 外部 signal 双向绑定到输入组件
- 分布式/cross-process signal
- async cell body

## 17. 意图级测试草案

以下测试表达需求接口。最终开发应先落测试，再写实现。未实现能力可先 `xfail` 或写注释型测试。

### 17.1 App 入口与 provider

```python
def test_create_panel_app():
    import dao_ui as ui
    import dao_ui.providers.panel as panel

    app = ui.App(provider=panel.Provider())

    assert app.provider.name == "panel"
```

### 17.2 组件参数保持 provider 风格

```python
def test_panel_button_keeps_panel_style_params():
    app = make_panel_app()

    button = app.button(name="Run", button_type="primary")

    assert button.node.parent is app
    assert button.target.name == "Run"
```

### 17.3 with 构建父子关系

```python
def test_with_context_builds_scope_tree():
    app = make_panel_app()

    with app.column() as col:
        btn = app.button(name="Run")

    assert col.parent is app
    assert btn.parent is col
    assert btn in col.children
```

### 17.4 输入组件 value 代理到 signal

```python
def test_input_value_is_signal_proxy():
    app = make_panel_app()

    name = app.text_input(name="Name", value="Alice")

    assert name.value == "Alice"
    name.value = "Bob"
    assert name.signal.value == "Bob"
```

### 17.5 signal 读取注册 cell 依赖

```python
def test_cell_tracks_signal_dependency():
    app = make_panel_app(scheduler="immediate")
    count = app.signal(0)

    @app.column().cell()
    def _(node):
        app.markdown(f"count={count.value}")

    assert count.has_observer(_)
```

### 17.5.1 cell 函数接收当前 wrapper node

```python
def test_cell_function_receives_current_wrapper_node():
    app = make_panel_app(scheduler="immediate")
    disabled = app.signal(False)
    seen = []

    @app.button(name="Run").cell()
    def _(node):
        seen.append(node)
        node.disabled = disabled.value
        node.target.disabled = disabled.value

    assert len(seen) == 1
    assert seen[0].target.name == "Run"
```

### 17.5.2 原子组件 cell 禁止挂载子 UI

```python
def test_atomic_component_cell_cannot_mount_child_ui():
    app = make_panel_app(scheduler="immediate")

    with pytest.raises(ui.NonContainerNodeError):
        @app.button(name="Run").cell()
        def _(node):
            app.markdown("child")
```

### 17.6 相等值不 rerun

```python
def test_same_value_does_not_rerun():
    app = make_panel_app(scheduler="immediate")
    count = app.signal(0)
    calls = []

    @app.column().cell()
    def _(node):
        calls.append(count.value)

    count.value = 0

    assert calls == [0]
```

### 17.7 signal 更新触发 cell rerun

```python
def test_signal_update_reruns_dependent_cell():
    app = make_panel_app(scheduler="immediate")
    count = app.signal(0)
    calls = []

    @app.column().cell()
    def _(node):
        calls.append(count.value)

    count.value = 1

    assert calls == [0, 1]
```

### 17.8 条件依赖重新收集

```python
def test_cell_dependencies_are_recollected_on_rerun():
    app = make_panel_app(scheduler="immediate")
    flag = app.signal(True)
    a = app.signal("a")
    b = app.signal("b")
    values = []

    @app.column().cell()
    def _(node):
        values.append(a.value if flag.value else b.value)

    flag.value = False
    a.value = "a2"
    b.value = "b2"

    assert values == ["a", "b", "b2"]
```

### 17.9 rerun 失败保留旧 UI

```python
def test_failed_rerun_keeps_old_children():
    app = make_panel_app(scheduler="immediate")
    value = app.signal("ok")

    cell = app.column()

    @cell.cell()
    def _():
        if value.value == "bad":
            raise RuntimeError("bad")
        app.markdown(value.value)

    old_children = list(cell.children)

    value.value = "bad"

    assert cell.children == old_children
    assert app.debug.last_error is not None
```

### 17.10 rerun 中写 signal 不嵌套执行

```python
def test_signal_write_during_rerun_is_enqueued_not_nested():
    app = make_panel_app(scheduler="immediate")
    count = app.signal(0)
    calls = []

    @app.column().cell()
    def _(node):
        calls.append(count.value)
        if count.value == 1:
            count.value = 2

    count.value = 1

    assert calls == [0, 1, 2]
```

### 17.11 signal scope 限制

```python
def test_cross_scope_signal_usage_warns_or_errors_in_dev():
    app = make_panel_app(mode="dev", scheduler="immediate")

    with app.column() as left:
        secret = app.signal("left")

    with app.column():
        @app.column().cell()
        def _(node):
            app.markdown(secret.value)

    assert app.debug.has_scope_violation()
```

### 17.12 普通函数不是 reactive component

```python
def test_custom_component_is_plain_function():
    app = make_panel_app(scheduler="immediate")
    count = app.signal(0)
    calls = []

    def Header() -> None:
        calls.append("header")
        app.markdown("header")

    Header()

    @app.column().cell()
    def _(node):
        app.markdown(str(count.value))

    count.value = 1

    assert calls == ["header"]
```

### 17.13 wrapper 公开 native target

```python
def test_wrapper_exposes_native_target_for_thin_layer_escape_hatch():
    app = make_panel_app()
    button = app.button(name="Run")

    assert button.target is not None
    assert button.target.name == "Run"
```

### 17.14 app.mount 由 provider 接管

```python
def test_mount_delegates_to_provider():
    provider = FakeProvider()
    app = ui.App(provider=provider)
    app.markdown("hello")

    app.mount()

    assert provider.mounted is True
```

## 18. 推荐开发顺序

1. 写 intent tests：入口、provider wrapper、with context、signal、cell。
2. 实现纯 runtime：ScopeNode、Signal、dependency tracking、scheduler。
3. 实现 fake provider：用于不依赖 Panel/marimo 的单元测试。
4. 实现 Panel provider wrapper。
5. 实现 cell staging rerun 与错误保留旧 UI。
6. 实现 debug/log/notify 最小策略。
7. 对比实现 marimo provider 的最小 wrapper。

## 19. 已确认补充决策

1. Signal 本身独立存在，可直接通过 `dao_ui.signal` 模块构造；UI rerun 场景必须使用 `app.signal()` 创建 scope signal。
2. v0.1 暂不实现 `contextvars.ContextVar`，因为当前 UI API 是单线程同步模型。
3. 默认 scheduler：dev mode 使用 immediate，prod mode 使用 periodic。
4. cell 函数支持 `node` 参数；`node` 是当前 provider wrapper / ScopeNode。
5. provider wrapper 不隐藏 `target`，因为 DAO UI 是 provider 原生 UI 的薄层；直接操作 `target` 不保证同步 DAO UI runtime，但框架不干预。
6. v0.1 provider 组件清单：Panel 为 `Column/Row/Card/Button/TextInput/RadioButtonGroup/Markdown`；marimo 为 `hstack/vstack/button/text/radio/md`。
7. signal 跨 scope：dev 报错，prod warning log。
