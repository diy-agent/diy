# Async Cell 设计文档

日期：2026-05-25
状态：设计中

## 进度

| Phase | 内容 | 状态 | 完成日期 | 备注 |
|-------|------|------|---------|------|
| P1 | 清理与简化（signal 下沉、去 staging） | ✅ 已完成 | 2026-05-25 | |
| P2 | ScopeConfig 强类型化 + auto_mount_child | ✅ 已完成 | 2026-05-25 | auto_mount → auto_mount_child |
| P3 | 生成器 cell 核心实现 | ✅ 已完成 | 2026-05-25 | 不含 awaitable |
| P4 | 异步 yield awaitable 支持 | ✅ 已完成 | 2026-05-25 | _drive_generator_async + enqueue_async |
| P5 | 测试重组 + tree snapshot + event log | ✅ 已完成 | 2026-05-25 | unit/intent/integration/browser/tools |
| P6 | 文档迁移 + 示例补全 | 🔄 进行中 | — | |

> 进度标记：⬜ 未开始 → 🔄 进行中 → ✅ 已完成
> 每次 Phase 完成后更新此表 + 提交时在 commit message 中引用 `ref: design/async-cell P{N}`
> 新会话读此表即可知道当前进度，无需翻 git log

## 一、目标

在现有 ScopeNode + Signal 驱动的 cell rerun 模型基础上，支持三种 cell 执行形态：

| 形态 | 用法 | 适用场景 |
|------|------|---------|
| 同步 cell（已有） | `def _(self): app.button(...)` | 即时构建、纯同步逻辑 |
| 生成器 cell（新增） | `def _(self): yield app.button(...)` | 长时间任务、step-by-step UI、线性思维 |
| 异步生成器 cell（未来） | 同上，yield awaitable | 同生成器 cell，配合数据库/网络 IO |

## 二、核心设计原则

### 2.1 核心层不关心 UI 创作风格

`diyui._scope.ScopeNode` 只提供 tree node + cell rerun 基础能力。用户通过 `app.xxx()` 还是 `yield xxx` 创建子节点，是 provider 层的事。

核心 API：
```python
node = ScopeNode()
child = ScopeNode()
node._add_child(child)          # 挂子节点

# Signal 由 ScopeNode 作为 factory 创建，创建即挂载，原子操作
sig: Signal[int] = node.signal(42)  # 返回 Signal，owner 已设置为 node

@node.cell()                    # 标记为 cell
def _(self): ...
```

设计决策：
- `signal()` 从 `BaseApp` 下沉到 `ScopeNode`，由载体（node）负责创建和挂载。消除"分离创建后忘记挂载"的状态错误。
- `BaseApp.signal()` 变为委托给 `_current`：`return self._current.signal(value)`。

### 2.2 三种创作风格通过配置共存

通过 `ScopeConfig.auto_mount` 控制 `app.button()` 等工厂函数的行为：

```python
# 默认：app.button() → 绑定到 _current（当前上下文父节点）
app = PanelApp()

# 解绑模式：app.button() → 纯工厂，不自动绑定
app = PanelApp(config=ScopeConfig(auto_mount=False))
btn = app.widgets.button("OK")  # 创建了，但还没挂到树上
some_node._add_child(btn)       # 手动挂载
```

这个开关使得 `yield app.button()` 在生成器 cell 中成为可能——factory 创建组件，generator driver 负责挂载到 cell node。

### 2.3 配置向下传递与覆盖

`ScopeConfig` 的每个字段可选（`None` = 未设置）。`get_config(key)` 向上追溯：自己 → 父 → 祖父，直到找到第一个非 `None` 的值。子节点配置优先级高于祖先。

### 2.4 去掉 staging mode

当前 staging mode 的职责是"cell rerun 期间暂存新 children，成功后再替换旧 children"。这增加了 `_execute_cell` 和 `_add_child` 的复杂度。

简化方案：
- `_execute_cell` 改为：**清空旧 children → 调 fn(self) 重建 → children 即时生效**
- 去掉 `_staging_mode`、`_staging_children`、`old_children` 回滚
- 失败时保留旧 children 的能力暂时放弃，后续视需要单独实现

对同步 cell 行为无影响。对生成器 cell 也是利好的——不需要考虑 rollback。

## 三、ScopeConfig 强类型化

```python
from enum import Enum
from typing import Protocol, Callable

class ScopeMode(Enum):
    DEV = "dev"
    PROD = "prod"

class SchedulerProtocol(Protocol):
    """Scheduler 需实现的方法。"""
    def enqueue(self, callback: Callable[[], None]) -> None: ...
    def flush(self) -> None: ...

@dataclass
class ScopeConfig:
    """ScopeNode 的运行时配置。

    所有字段可选；None 表示未设置，向上追溯祖先配置。
    子节点配置优先级高于祖先。
    """
    mode: ScopeMode | None = None
    scheduler: SchedulerProtocol | None = None
    auto_mount: bool | None = None  # app.xxx() 是否自动挂载到 _current
```

设计决策：
- `mode` 使用 `ScopeMode` 枚举替代裸字符串
- `scheduler` 使用 `SchedulerProtocol` 替代 `object`
- 暂不引入 pydantic——当前字段少（3 个），dataclass + Protocol 足够
- `None` = inherit from parent，字段级覆盖

`auto_mount` 向上追溯，默认 `True`（保持现有行为，新创建的组件自动挂到当前上下文）。

Provider 层的工厂函数在创建组件后，根据 `auto_mount` 决定是否调用 `_add_to_current`：

```python
def column(self, **kwargs) -> Column:
    col = Column(**kwargs)
    if self._app.get_config("auto_mount") is not False:
        self._app._add_to_current(col)
    return col
```

## 四、_execute_cell 重构

### 4.1 同步 cell（现状简化）

去掉 staging 逻辑：

```python
def _execute_cell(self, *, initial: bool = False) -> None:
    fn = self._cell_fn
    if fn is None:
        return

    app = self._app
    if app is not None:
        app._push_context(self)

    # 清空旧 children
    old_children = list(self._children)
    self._children = []
    self._is_dirty = False
    self._is_executing = True
    signal_mod._current_cell_node = self
    signal_mod._rerun_depth += 1

    # 通知 provider 清空
    self._on_children_replaced([])

    deps: set[object] = set()
    signal_mod._dependency_collector = lambda s: deps.add(s)

    debug = get_debug(self)
    debug.record_rerun()

    try:
        fn(self)
    except Exception as exc:
        if initial:
            raise
        debug.record_error(exc)
    finally:
        # 旧 children 解除关系
        for child in old_children:
            child._parent = None

        signal_mod._dependency_collector = None
        signal_mod._current_cell_node = None
        signal_mod._rerun_depth -= 1
        self._is_executing = False
        if app is not None:
            app._pop_context()

        # diff 更新依赖
        old_deps = self._dependencies
        for sig in old_deps - deps:
            sig._unsubscribe_cell(self)
        for sig in deps - old_deps:
            sig._subscribe_cell(self)
        self._dependencies = deps

        # auto-reset
        for sig in deps:
            if getattr(sig, "_reset_on_complete", False):
                sig._reset_value(False)

    # dirty re-enqueue
    if self._is_dirty and self._cell_fn is not None:
        scheduler = self.get_config("scheduler")
        if scheduler is not None:
            scheduler.enqueue(self._execute_cell)
```

### 4.2 生成器 cell（新增）

cell() 装饰器检测函数是否为生成器（`inspect.isgeneratorfunction(fn)`），选择不同执行路径。

生成器 cell 的 yield 语义：

| yield 值 | 类型 | 框架行为 |
|----------|------|---------|
| `UIComponent` 或 `ScopeNode` | 组件 | `self._add_child(obj)` |
| `Awaitable` | 异步操作 | `await obj`，结果 `gen.send(result)`（未来） |
| `None`（生成器结束） | — | commit children，退出 |

```python
async def _execute_cell_async(self):
    """驱动生成器 cell（async 版本，支持 yield awaitable）。"""
    gen = self._cell_fn(self)  # self 是 cell node

    app = self._app
    if app is not None:
        app._push_context(self)

    old_children = list(self._children)
    self._children = []
    self._is_dirty = False
    self._is_executing = True

    self._on_children_replaced([])

    deps: set[object] = set()

    debug = get_debug(self)
    debug.record_rerun()

    try:
        result = None
        while True:
            signal_mod._dependency_collector = lambda s: deps.add(s)
            try:
                yielded = gen.send(result)
            except StopIteration:
                break
            finally:
                signal_mod._dependency_collector = None

            if yielded is None:
                break

            if isinstance(yielded, ScopeNode):
                # 组件：挂到 cell node
                yielded._app = app
                self._add_child(yielded)
                result = None
            elif inspect.isawaitable(yielded):
                # awaitable：等待，结果传回生成器
                result = await yielded
            else:
                # 未知类型，跳过
                result = None
    except Exception as exc:
        debug.record_error(exc)
    finally:
        for child in old_children:
            child._parent = None

        self._is_executing = False
        if app is not None:
            app._pop_context()

        # diff 更新依赖
        old_deps = self._dependencies
        for sig in old_deps - deps:
            sig._unsubscribe_cell(self)
        for sig in deps - old_deps:
            sig._subscribe_cell(self)
        self._dependencies = deps

        for sig in deps:
            if getattr(sig, "_reset_on_complete", False):
                sig._reset_value(False)
```

### 4.3 Signal 挂载在异步场景

生成器 cell 执行期间 `app.signal()`（或下沉后的 `node.signal()`）创建的 signal 挂在当前 cell node。分析：

1. 生成器 cell 的 `gen = self._cell_fn(self)` 时 self 已绑定为 cell node
2. `gen.send(result)` 是同步调用，用户在 yield 点之间写的同步代码（`app.signal(42)`）通过 `_push_context(self)` 落到正确的 cell node
3. 只有 `yield awaitable` 之后的 `await` 才真正让出控制权——此时用户的 cell 代码已暂停在 yield 点，不会再创建 signal
4. 等 `await` 完成，`gen.send(result)` 回到生成器，`_current` 仍然是 cell node

加上 `_is_executing` 标志阻止了同一 cell 的重入重入。信号挂载在异步场景下无需额外机制。

### 4.4 cell() 装饰器分发

```python
def cell(self: C) -> Callable:
    def decorator(fn):
        import inspect
        if inspect.isgeneratorfunction(fn):
            self._cell_fn = fn
            self._is_async_cell = True
            # 生成器 cell：首次执行也走 async 路径
            # 需要 scheduler 支持 async enqueue
            self._execute_cell_async_initial()
        else:
            self._cell_fn = fn
            self._is_async_cell = False
            self._execute_cell(initial=True)
        return self
    return decorator
```

### 4.5 Scheduler 扩展

当前 `ImmediateScheduler.enqueue` 只接受同步 callback。需要支持 `Callable[[], Coroutine]`：

```python
class ImmediateScheduler:
    def enqueue(self, callback: Callable[[], None]) -> None:
        ...

    def enqueue_async(self, async_callback: Callable[[], Coroutine[Any, Any, None]]) -> None:
        """入队 async callback，在 IOLoop 中执行。"""
        ...
```

Panel provider 可以提供一个 `PanelScheduler`，内部用 `pn.io.curdoc().add_next_tick_callback` 调度。

## 五、_PanelContainerMixin 简化

去掉 staging 后，`_PanelContainerMixin._add_child` 不需要条件判断：

```python
def _add_child(self, child):
    super()._add_child(child)
    if isinstance(child, UIComponent):
        self.append(child)
```

`_on_child_added` 可以被移除（逻辑已合入 `_add_child`）。`_on_children_replaced` 保留，`_on_child_removed` 保留。

## 六、测试体系设计

### 6.1 目录结构

```
tests/
├── unit/                  # 纯逻辑单元测试（无 provider 依赖）
│   ├── test_signal.py
│   ├── test_scope.py
│   ├── test_scheduler.py
│   ├── test_base_app.py
│   └── test_debug.py
├── intent/                # 意图测试（替代文档，tree snapshot + event log 断言）
│   ├── test_basic_construction.py
│   ├── test_with_context_tree.py
│   ├── test_signal_rerun.py
│   ├── test_cell_staging.py
│   ├── test_button_sync_flow.py
│   └── test_async_cell.py        # 新：生成器 cell 意图
├── integration/           # Provider 集成测试（依赖 Panel）
│   └── test_panel.py
├── browser/               # Playwright 端到端测试
│   ├── test_panel_browser.py
│   └── browser_test_app.py
└── tools/                 # 工具自身测试
    └── test_panel_param_coverage.py
```

### 6.2 意图测试的断言风格

**a) Node tree 快照**

表达"某操作后的树状态"：

```python
def test_button_click_triggers_cell_rerun():
    app = PanelApp(...)
    btn = app.widgets.button(label="Submit")
    app._add_to_current(btn)

    @app.layout.column().cell()
    def _(self):
        if btn.value:
            app.pane.markdown("✅ Submitted")
        else:
            app.pane.markdown("⏳ Waiting")

    btn.param.trigger("clicks")
    scheduler = app.get_config("scheduler")
    scheduler.flush()

    assert tree(app) == """
PanelApp
├── Button "Submit" [clicks=1, signal=False]
└── Column
    └── Cell [rerun_count=2]
        └── Markdown "✅ Submitted"
"""
```

**b) 事件日志**

补充 node tree 快照，记录关键运行时事件：

```python
def test_button_click_event_log():
    app = PanelApp(...)
    btn = app.widgets.button(label="Submit")
    events = collect_events(app)

    btn.param.trigger("clicks")

    assert events == [
        "signal Button.value: False → True",
        "cell Column: rerun start (dependency: Button.value)",
        "cell Column: rerun complete",
        "signal Button.value: True → False (auto-reset)",
    ]
```

`collect_events` 通过 hook signal 的 `_notify` 和 cell 的 `_execute_cell` 入口实现。事件日志可以作为 `DebugInfo` 的一部分，在 `mode="dev"` 时自动收集。

### 6.3 tree_snapshot 工具

```python
# diyui._debug 模块

def tree_snapshot(node: ScopeNode, *, max_depth: int = 10) -> str:
    """将 ScopeNode 树渲染为可读文本，用于意图测试断言。"""
    lines = []
    _render_node(node, lines, indent=0, max_depth=max_depth, is_last=True)
    return "\n".join(lines)

def _render_node(node, lines, indent, max_depth, is_last):
    prefix = _make_prefix(indent, is_last)
    label = _node_label(node)
    lines.append(f"{prefix}{label}")
    children = node._children
    for i, child in enumerate(children):
        if indent >= max_depth:
            lines.append(f"{_make_prefix(indent + 1, False)}...")
            break
        _render_node(child, lines, indent + 1, max_depth, i == len(children) - 1)

def _node_label(node: ScopeNode) -> str:
    """生成节点标签。provider 组件可用 panel param 自定义。"""
    if hasattr(node, "_tree_label"):
        return node._tree_label()
    name = type(node).__name__
    # 显示 signal 值
    sigs = [f"{_signal_name(s)}={s.value!r}" for s in node._signals]
    if sigs:
        return f"{name} [signals: {', '.join(sigs)}]"
    return name
```

## 七、实现计划

### Phase 1：清理与简化（准备阶段）

1. `signal()` 从 `BaseApp` 下沉到 `ScopeNode`，`BaseApp.signal()` 委托给 `_current`
2. 去掉 staging mode：简化 `_execute_cell`、`_add_child`、`_PanelContainerMixin._add_child`
3. 删除 `_staging_mode`、`_staging_children` 字段
4. 删除 `_on_child_added` hook（逻辑合入 `_add_child`）
5. 确认所有现有测试通过

### Phase 2：ScopeConfig 强类型化 + auto_mount

1. `ScopeConfig`：`mode` 改为 `ScopeMode` 枚举，`scheduler` 改为 `SchedulerProtocol`
2. `ScopeConfig` 添加 `auto_mount: bool | None = None`
3. 修改 `PanelApp` 的工厂函数（`_LayoutFactory`、`_PaneFactory`、`_WidgetsFactory`），在组件创建后检查 `auto_mount`
4. 测试：`auto_mount=False` 时组件不被自动 mount；`ScopeMode.DEV` / `ScopeMode.PROD` 正确传递

### Phase 3：生成器 cell 核心实现

1. `_scope.py`：`cell()` 装饰器检测 `isgeneratorfunction`，分发到不同执行路径
2. `_scope.py`：实现 `_execute_cell_async()`（驱动生成器，处理 yield 组件）
3. `_scheduler.py`：`ImmediateScheduler` 添加 `enqueue_async()` 方法
4. `PanelApp`：默认使用支持 async 的 scheduler
5. `test_cell.py` 添加生成器 cell 测试

### Phase 4：异步 yield awaitable 支持

1. `_execute_cell_async` 中增加 `inspect.isawaitable(yielded)` 分支
2. 示例和测试

### Phase 5：测试重组 + tree snapshot + event log

1. 创建新的测试目录结构
2. 实现 `tree_snapshot` 工具
3. 实现 event log 收集（`DebugInfo` 扩展或独立模块）
4. 迁移现有测试到对应目录
5. 将 spec v0.1 第 17 节的意图测试草案落地为快照 + 事件日志断言
6. 新 intent test 写出生成器 cell 的意图测试

### Phase 6：文档迁移

1. 将 spec v0.1 的意图测试落地后，废弃过程文档，README 指向 intent tests
2. `README.md` 更新为面向用户的简洁介绍

## 八、完整变更清单（按 Phase）

### Phase 1 变更清单

涉及文件：

#### `src/diyui/_scope.py`

| 变更 | 位置 | 说明 |
|------|------|------|
| 新增 `signal()` 方法 | `ScopeNode` 类 | `def signal(self, value: T) -> Signal[T]`，创建 Signal 并调用 `_mount_signal` |
| 删除 `_staging_mode` 字段 | `__init__` L51 | 去初始化 |
| 删除 `_staging_children` 字段 | `__init__` L52 | 去初始化 |
| 简化 `_add_child` | L62-70 | 删除 staging 分支，始终 `self._children.append(child)` + `_on_child_added(child)` |
| 删除 `_remove_child` 中的 `_on_child_removed` hook | 保留 hook 但 `_remove_child` 逻辑不变 | 暂保留 |
| 删除 `_on_child_added` hook | L115-117 | provider 层不再需要此 hook |
| 保留 `_on_child_removed` | L119-121 | |
| 保留 `_on_children_replaced` | L123-127 | |
| 重写 `_execute_cell` | L149-234 | 见第四节伪代码：去掉 old_children 保存/回滚/staging commit，改为 try/finally 中解除旧 children 关系 |
| 新增 `_is_async_cell` 字段 | `__init__` | `self._is_async_cell: bool = False` |

#### `src/diyui/_base_app.py`

| 变更 | 位置 | 说明 |
|------|------|------|
| 修改 `signal()` | L47-50 | 委托给 `self._current.signal(value)`，不再直接创建 Signal 和调用 `_mount_signal` |

#### `src/diyui/providers/panel/_base.py`

| 变更 | 位置 | 说明 |
|------|------|------|
| 简化 `_PanelContainerMixin._add_child` | L39-47 | 删除 `if not self._staging_mode` 条件，改为始终 `self.append(child)` |
| 删除 `_on_child_added` | L47-49 | 逻辑已合入 `_add_child` |

#### 现有 `"dev"` / `"prod"` 字符串引用（不改，留到 Phase 2）

Phase 1 不改 `ScopeConfig.mode` 类型（仍然是 `str | None`），"dev"/"prod" 字符串比较保持不变。Phase 2 才改枚举。

#### 测试影响

Phase 1 不改变外部行为（去掉 staging 对测试透明），仅需确认现有 67 个测试全部通过。

---

### Phase 2 变更清单

涉及文件：

#### `src/diyui/_scope.py`

| 变更 | 位置 | 说明 |
|------|------|------|
| 新增 `ScopeMode` 枚举 + `SchedulerProtocol` | 文件顶部 | `from enum import Enum` |
| 修改 `ScopeConfig.mode` 类型 | `@dataclass` | `str \| None` → `ScopeMode \| None` |
| 修改 `ScopeConfig.scheduler` 类型 | `@dataclass` | `object \| None` → `SchedulerProtocol \| None` |
| 新增 `ScopeConfig.auto_mount` | `@dataclass` | `bool \| None = None` |

#### `src/diyui/_signal.py`

| 变更 | 位置 | 说明 |
|------|------|------|
| `mode == "dev"` 字符串比较 | L58 | 改为 `mode == ScopeMode.DEV`（`from ._scope import ScopeMode`） |

#### `src/diyui/_debug.py`

| 变更 | 位置 | 说明 |
|------|------|------|
| `return m if m else "prod"` | L31 | 改为 `return m if m else ScopeMode.PROD`，`mode` 属性返回类型改为 `ScopeMode` |
| `info.mode == "dev"` 断言 | test L25 | 测试中改为 `info.mode == ScopeMode.DEV` |

#### `src/diyui/providers/panel/_app.py`

| 变更 | 位置 | 说明 |
|------|------|------|
| `_LayoutFactory` 等工厂方法 | 每个 `__init__` 返回前 | 添加 `if self._app.get_config("auto_mount") is not False: self._app._add_to_current(col)` |

#### 测试和示例

需要将 `ScopeConfig(mode="dev")` 改为 `ScopeConfig(mode=ScopeMode.DEV)`：

| 文件 | 出现次数 |
|------|---------|
| `tests/test_scope.py` | 6 |
| `tests/test_debug.py` | 3 |
| `tests/test_cell.py` | 3 |
| `tests/test_panel.py` | 多 |
| `examples/panel_demo.pn.py` | 1 |
| `examples/button_sync_demo.py` | 1 |
| `examples/long_task_demo.py` | 1 |
| `tests/browser_test_app.py` | 1 |

---

### Phase 3-4 生成器 cell 核心实现

#### 用户代码示例：同步 + 生成器 cell 混合

```python
import diyui
import diyui.providers.panel as diypn
from diyui import ScopeConfig, ScopeMode

app = diypn.PanelApp(config=ScopeConfig(
    mode=ScopeMode.DEV,
    scheduler=diyui.ImmediateScheduler(),
))

@app.layout.card(title="混合演示").cell()
def _(self):
    # 同步 cell：外面是普通布局
    app.pane.markdown("# 同步部分")
    app.widgets.button(label="普通按钮")

    # 子节点：生成器 cell
    @app.layout.card(title="长时间任务").cell()
    def _(self):
        # auto_mount 为 True（默认），但 generator driver 接管挂载
        yield app.pane.markdown("🔄 步骤 1/3：开始...")
        # 这是同步 generator，不 yield awaitable
        yield app.pane.markdown("🔄 步骤 2/3：处理中...")
        yield app.pane.markdown("✅ 步骤 3/3：完成！")

app.servable()
```

#### 纯 yield 风格（auto_mount=False）

```python
app = diypn.PanelApp(config=ScopeConfig(
    mode=ScopeMode.DEV,
    scheduler=diyui.ImmediateScheduler(),
    auto_mount=False,  # app.xxx() 不自动挂载，由 generator driver 处理
))

@app.layout.card(title="纯 Yield 风格").cell()
def _(self):
    yield app.pane.markdown("开始")
    yield app.widgets.button(label="点击")
    yield app.pane.markdown("完成")
```

#### `_execute_cell_async_initial` 实现

```python
def _execute_cell_async_initial(self) -> None:
    """生成器 cell 首次执行的同步启动。

    首次执行不 await（Panel servable 阶段无 IOLoop），
    只驱动生成器收集同步 yield 的组件，遇到 awaitable 时暂停。
    session 启动后由 scheduler 继续驱动。
    """
    gen = self._cell_fn(self)
    # 首次只驱动同步 yield，遇到 awaitable 时缓存生成器状态
    # Phase 3 简化：暂不支持 yield awaitable，仅支持 yield 组件
    self._gen_instance = gen  # 缓存生成器，后续 rerun 用
    self._drive_generator(gen)

def _drive_generator(self, gen) -> None:
    """驱动生成器，处理 yield 的组件（同步版本，Phase 3）。"""
    try:
        yielded = next(gen)
        while True:
            if yielded is None:
                break
            if isinstance(yielded, ScopeNode):
                self._add_child(yielded)
            yielded = next(gen)
    except StopIteration:
        pass
```

注意：Phase 3 的生成器 cell **不支持 yield awaitable**。首次执行在 `servable()` 期间（同步），只收集 yield 的组件。rerun 时也走同步路径（`cell()` 装饰器触发同步 `_execute_cell` 还是生成器 `_drive_generator`，取决于 `_is_async_cell` 标志）。

---

### Phase 5 测试重组注意事项

1. `conftest.py` 需要放在 `tests/` 根目录（pytest 会自动发现），各子目录的测试通过 `python_files` 或默认发现规则
2. `browser/` 的 `conftest.py`（`panel_server` fixture）保持在 `tests/` 根
3. 迁移测试时，import 路径不变（`import diyui` 等），只改文件位置
4. 快照测试需要处理 `__pycache__` label 的稳定性——`_node_label` 中排除 `__pycache__` 目录或使用确定性命名

---

## 九、风险与取舍

| 风险 | 缓解 |
|------|------|
| staging 去掉后，rerun 失败旧 UI 丢失 | 优先做错误日志 + notify，后续单独实现 rollback |
| 生成器 cell 首次执行的时机 | Bokeh session 创建后异步执行首次，非阻塞 |
| 生成器 cell 和同步 cell 的依赖收集 | 生成器每次 gen.send 前后切换 collector |
| `signal()` 下沉破坏现有 API | `BaseApp.signal()` 保留为委托方法，对外接口不变 |
| `ScopeMode` 枚举破坏所有 `"dev"` 字符串引用 | Phase 2 集中修改，涉及 ~15 处，可控 |
