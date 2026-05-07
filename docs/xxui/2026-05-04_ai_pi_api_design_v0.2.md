---
source: ai_pi
author: pi ai coding
generated_by: pi ai coding
last_updated: 2026-05-04
status: process_draft
---

# DAO UI API 设计文档 v0.2

> **实验阶段**：当前版本仅支持单线程、同步代码。Async 支持后续再议。

---

## 一、项目定位

```python
# DAO UI 是薄封装层，不是新框架
app = ui.App(render=PanelRender())  # 在 Panel 之上封装
app.Button("OK")                     # 立即创建 Panel Button 并挂载

# 不是这样：
# tree = build_abstract_tree()      # ❌ 不做抽象树
# render(tree)                       # ❌ 不做延迟渲染
```

**是什么：**
- 在现有框架（Panel / marimo / Qt）之上统一 UI 构造方式
- 统一 signal 状态管理、rerun runtime、组件树 DSL

**不是什么：**
- 不是新的 web framework
- 不重做 Panel / marimo / Qt
- 不实现自己的 browser renderer

---

## 二、架构总览

```
Signal Core（响应式原语）
    ↓
Dependency Tracking（依赖追踪）
    ↓
Rerun Scheduler（调度器）
    ↓
Component Tree DSL（组件树 + Context 栈）
    ↓
Backend Adapter（后端适配器）
    ↓
Panel / marimo / Qt ...
```

---

## 三、四种核心对象

```python
# Signal: 响应式状态
count = ui.signal(0)
count.value += 1  # 写入触发通知

# Component: UI 组件，创建即挂载
app.Button("OK")  # 立即挂载到 current_context

# Context: 当前父组件上下文
with app.Card():       # push Card 为 current_context
    app.Button("A")    # 挂载到 Card
# pop，current_context 恢复

# Cell: rerun 单位
@app.Card().cell()
def _():               # 函数作为 rerun block
    app.text(count.value)
```

| 概念 | 职责 |
|------|------|
| Signal | 响应式状态容器，值变化时通知观察者 |
| Component | UI 组件，创建时立即挂载到当前父容器 |
| Context | 当前父组件上下文，通过 `with` 语句管理栈 |
| Cell | rerun 单位，用 `.cell()` 标记的函数或 lambda |

---

## 四、Signal

### 4.1 基本形式

```python
count = ui.signal(0)       # int
name = ui.signal("hello")  # str
active = ui.signal(True)   # bool
data = ui.signal({"a": 1}) # object ref
```

`signal` 返回 Signal 对象，内部持有值和 observer list。

### 4.2 读写

```python
count = ui.signal(0)

# 读取 -> 自动注册观察者（如果在 cell 内）
print(count.value)  # 0

# 写入 -> 触发观察者通知
count.value = 1
count.value += 1
```

### 4.3 自动依赖追踪

```python
count = ui.signal(0)

@app.Card().cell()
def _():
    # 读取 count.value → 自动注册: 当前 cell 依赖 count
    app.text(f"count = {count.value}")
# count.value 变化时，scheduler 自动 rerun 该 cell
```

### 4.4 输入组件即 Signal

```python
# 输入组件内部封装 Signal，用户交互时自动更新
name = app.input(label="Name")       # -> Input 组件，name.value 是 Signal
choice = app.select([1, 2, 3])        # -> Select 组件
checked = app.checkbox("Enable")     # -> Checkbox 组件
level = app.slider(0, 100)           # -> Slider 组件

# 使用
@app.Card().cell()
def _():
    app.text(f"Hello, {name.value}")  # name.value 变化时自动 rerun
```

工作流程：
1. 用户在 UI 操作 → 触发 Panel 原生回调
2. 回调更新组件的 `.value` → 委派给内部 Signal
3. Signal 通知观察者 → scheduler rerun 依赖 cell

### 4.5 v0.1 范围与限制

**支持：**
- 单值 signal（int, float, str, bool, object ref）

**不支持（未来版本）：**
- deep reactive（深层对象属性响应）
- reactive list（列表元素的增删响应）
- reactive dict（字典键值响应）

```python
# ❌ v0.1 不支持：列表元素的响应式操作
items = ui.signal(["a", "b"])
items.value.append("c")   # 不会触发通知
items.value.pop(0)         # 不会触发通知

# ✅ 正确做法：整体替换
items.value = ["a", "b", "c"]  # 会触发通知
items.value = items.value[1:]  # 会触发通知
```

---

## 五、Context 栈与组件树

### 5.1 根容器

```python
import dao_ui as ui

app = ui.App(render=PanelRender())
# current_context = app（根容器）
```

### 5.2 三种组件使用方式

```python
# 1. 立即渲染（无子组件）
app.Button("OK")

# 2. 作为父容器（with 语法构树）
with app.Card(title="Title"):
    app.text("hello")
    app.Button("Save")

# 3. rerun cell: 装饰器形式
@app.Card(title="Title").cell()
def _():
    app.text(count.value)

# 3b. rerun cell: lambda 回调形式
app.Card(title="Title").cell(lambda: app.text(count.value))

# 3c. rerun cell: lambda 多语句形式（用元组）
app.Card().cell(lambda: (
    app.text("line1"),
    app.text("line2"),
    app.Button("OK"),
))
```

### 5.3 with 语句的工作机制

```python
app.Button("A")           # app.children -> [Button("A")]

with app.Box() as box:    # push: current_context = box
    app.Button("B")       # box.children -> [Button("B")]
    with app.Box() as box2:  # push: current_context = box2
        app.Button("C")   # box2.children -> [Button("C")]
    # pop: current_context = box
# pop: current_context = app
```

组件树：
```
App
├── Button("A")
└── Box
    ├── Button("B")
    └── Box
        └── Button("C")
```

### 5.4 组件创建立即挂载

```python
app.Button("OK")
# 内部等价于：
# btn = pn.widgets.Button(name="OK")  # 立即创建 Panel 组件
# current_context.append(btn)          # 立即挂载
```

**禁止：**
- 延迟 render
- 虚拟 DOM
- Terraform 式 deferred pipeline

---

## 六、Cell（rerun block）

### 6.1 核心原则

```python
# rerun 粒度 ≠ 组件粒度
# rerun 单位是 cell，不是每个组件

# 普通函数不是 cell，不会 rerun
def Header(app):
    app.text("Welcome")  # 永远只执行一次

# cell 才会 rerun
@app.Card().cell()
def _():
    app.text(count.value)  # count 变化时 rerun
```

### 6.2 Cell 定义形式

```python
# 装饰器形式（多语句推荐）
@app.Card().cell()
def _():
    app.text("line1")
    app.text(count.value)

# lambda 形式（单语句）
app.Card().cell(lambda: app.text(count.value))

# lambda 元组形式（多语句，可读性较差）
app.Card().cell(lambda: (
    app.text("line1"),
    app.text("line2"),
))
```

### 6.3 Cell Rerun 机制

```python
# 当 signal 变化触发 cell rerun 时：
def rerun_cell(cell):
    container = cell.container
    container.clear()      # 清空子组件
    push_context(container)
    try:
        cell.fn()          # 重新执行函数体
    finally:
        pop_context()
```

**不做：**
- tree diff
- incremental update
- fine-grained DOM update

### 6.4 Cell 可在任意位置定义

```python
def TodoItem(app, item_signal):
    # 普通函数，只执行一次
    with app.Card():
        app.Button("Remove", on_click=lambda: ...)
    
    # cell 定义在普通函数内部
    # 闭包自动捕获 item_signal
    @app.Text().cell()
    def _():
        app.text(f"selected: {item_signal.value}")
```

### 6.5 Cell 执行顺序

```python
s = ui.signal(0)

@app.Card().cell()  # 先定义
def card_a():
    app.text(f"A: {s.value}")

@app.Card().cell()  # 后定义
def card_b():
    app.text(f"B: {s.value}")

# s 变化时，按定义顺序：card_a -> card_b
```

---

## 七、组件 API 参考

### 7.1 基础组件

```python
# 文本
app.text("hello")
app.markdown("# Title\nContent")

# 按钮
app.Button("Click")
app.Button("Delete", on_click=lambda: delete_item())

# 输入（返回组件，内部封装 Signal）
name = app.input(label="Name")
choice = app.select(options=[1, 2, 3])
checked = app.checkbox("Enable")
level = app.slider(0, 100)

# 布局容器
with app.Box(classes="flex flex-col gap-2"):
    app.text("child1")
    app.text("child2")

with app.Card(title="Title"):
    app.text("content")
```

### 7.2 组件的三种形式

| 形式 | 语法 | 语义 |
|------|------|------|
| 立即渲染 | `app.C(args)` | 创建组件，挂载到 current_context |
| 父容器 | `with app.C(args):` | 创建组件，push 为 current_context |
| Rerun cell | `@app.C(args).cell()` 或 `.cell(fn)` | 创建组件，标记为 rerun cell |

### 7.3 自定义组件

```python
# 自定义组件 = 普通 Python 函数
# 通过闭包捕获参数
def PhonePanel(app, phone_number, verified_signal):
    with app.Card(title="Phone"):
        app.text(phone_number)
    
    @app.Badge().cell()
    def _():
        # 闭包捕获 verified_signal
        if verified_signal.value:
            app.text(f"✓ {phone_number}")
        else:
            app.text("✗ unverified")
```

---

## 八、生命周期与全局 Signal

### 8.1 Signal 作用域规则

```python
# 模块级 signal = 进程级（所有 session/tab 共享）
# state.py
app_state = ui.signal({"user": None})  # 进程内唯一，所有 tab 共享

# A tab 修改 app_state.value → B tab 立刻看到变化
# 刷新页面不会重置（Python 模块只加载一次）
```

```python
# 函数内 signal = session 级（每个 session 独立）
# app.py
def create_page():
    count = ui.signal(0)  # 每个 session 独立一份
    
    @app.Card().cell()
    def _():
        app.text(f"count: {count.value}")

# A tab 的 count 和 B tab 的 count 是不同对象
# 互不影响
```

### 8.2 后端差异

| 后端 | Session 概念 | 模块级 Signal | 函数内 Signal |
|------|-------------|--------------|--------------|
| Panel | 有（每 tab 一 session） | 进程级共享 | session 级隔离 |
| PySide6 / Qt | 无 | 进程级共享 | 调用时创建 |
| marimo | 有（notebook 状态） | 进程级共享 | cell 级 |

### 8.3 选择建议

```python
# 需要 session 隔离的状态（用户私有数据）
def create_page():
    user_input = ui.signal("")  # 函数内定义
    ...

# 需要跨 session 共享的状态（系统通知、全局配置）
# state.py
system_status = ui.signal({"online": True, "version": "1.0"})
```

### 8.4 持久化（跨进程）

```python
# Signal 本身不持久化，需要外部存储
import json
from pathlib import Path

data_file = Path("data.json")

def load_data():
    if data_file.exists():
        return json.loads(data_file.read_text())
    return {}

# 模块级 signal，启动时从文件加载
data = ui.signal(load_data())

# 用户操作后手动保存
@app.Card().cell()
def _():
    app.text(f"Data: {data.value}")
    app.Button("Save", on_click=lambda: data_file.write_text(json.dumps(data.value)))
```

---

## 九、Backend Adapter

### 9.1 切换后端

```python
app = ui.App(render=PanelRender())   # Panel
# app = ui.App(render=MarimoRender()) # marimo (未来)
# app = ui.App(render=QtRender())     # Qt (未来)
```

### 9.2 后端遵循原框架规则

DAO UI 不统一 runtime：
- Panel：仍是 persistent widget model
- marimo：仍是 notebook rerun 模型

DAO UI 统一的是：signal、rerun、context stack、component DSL。

### 9.3 组件创建立即映射

```python
app.Button("OK")
# PanelRender 内部：
# btn = pn.widgets.Button(name="OK")
# current_context.panel_obj.append(btn)
```

---

## 十、更新机制

### 10.1 策略

```python
# rerun → clear + re-execute
# 不做 tree diff，不做增量更新
```

与 Streamlit、marimo 相同策略。

### 10.2 非目标

- 不做 Virtual DOM
- 不做 diff patch
- 不做 fine-grained DOM update
- 不做编译、宏
- 不做 SolidJS 式原子属性更新（Python 无编译期 AST 能力）

---

## 十一、完整示例

### 示例 1：计数器

```python
import dao_ui as ui

app = ui.App(render=PanelRender())
count = ui.signal(0)

def add():
    count.value += 1

def sub():
    count.value -= 1

with app.Card(title="Counter"):
    app.Button("+1", on_click=add)
    app.Button("-1", on_click=sub)

@app.Card(title="Display").cell()
def _():
    app.text(f"Current count: {count.value}")
```

### 示例 2：Todo 列表

```python
import dao_ui as ui

app = ui.App(render=PanelRender())
items = ui.signal(["Buy milk", "Write code"])
new_item = ui.signal("")

def remove_item(idx):
    items.value = items.value[:idx] + items.value[idx+1:]

def add_item():
    items.value = items.value + [new_item.value]
    new_item.value = ""

def TodoList(app):
    with app.Card(title="Todo List"):
        @app.Box().cell()
        def _():
            for i, item in enumerate(items.value):
                with app.Box(classes="flex gap-2"):
                    app.text(item)
                    app.Button("✕", on_click=lambda idx=i: remove_item(idx))

        app.input(label="New item", value=new_item)
        app.Button("Add", on_click=add_item)

TodoList(app)
```

### 示例 3：带信号联动的面板

```python
import dao_ui as ui

app = ui.App(render=PanelRender())

tab_select = app.select(options=["overview", "detail", "settings"])
data = ui.signal({"sales": 100, "users": 50})

with app.Card(title="Dashboard"):
    # tab_select.value 变化会触发依赖它的 cell rerun
    pass

@app.Card().cell()
def content():
    if tab_select.value == "overview":
        app.text(f"Sales: {data.value['sales']}")
        app.text(f"Users: {data.value['users']}")
    elif tab_select.value == "detail":
        app.text("Detail view")
    else:
        app.text("Settings")
```

---

## 十二、禁止事项

| 禁止 | 原因 |
|------|------|
| Virtual DOM / tree diff | debug 困难，AI coding 难追踪 |
| Compile / AST transform | 增加复杂度，违背 Python-first |
| Hook 系统 (useEffect, useMemo) | 隐藏生命周期，mental overhead 大 |
| Props replay / component 缓存 | 魔法太多，不如闭包直观 |
| Deferred render pipeline | 创建点与错误点距离太远 |

---

## 十三、v0.1 实现范围

### 必须实现

- [ ] `ui.signal()` — Signal 类（value + observer list）
- [ ] 依赖追踪 — `.value` 读取时注册当前 cell 为观察者
- [ ] Rerun Scheduler — signal 变化时按顺序触发 cell rerun
- [ ] Context 栈 — `with` 语句 push/pop `current_context`
- [ ] `ui.App(render=...)` — 根容器 + 后端选择
- [ ] 基础组件 — Button, Text, Card, Box, Input, Select
- [ ] `.cell()` — 装饰器和回调两种形式
- [ ] `PanelRender()` — Panel 后端适配
- [ ] Cell rerun — clear + re-execute

### 不实现

- 多后端共存（同时只用一种 render）
- Reactive list / dict（v0.2+）
- Tree diff / Virtual DOM
- Notebook 模式
- 分布式 signal
- Async 支持
