---
source: ai_chatgpt
author: ChatGPT
generated_by: ChatGPT
last_updated: 2026-05-04
status: process_draft
---

# XX UI Framework 初步规格（AI Coding Draft v0.1）

## 项目目标

XX UI 是一个：

> “Python-first、signal/reactive 驱动、树形组件 DSL、多后端适配”的薄封装 UI 框架。

它：

* 不是新的 web framework
* 不重做 Panel / Qt / marimo
* 不实现自己的浏览器 renderer
* 不做 Virtual DOM
* 不做 compile-time framework

而是：

# 在现有框架之上建立统一的：

* UI 构造方式
* signal/reactive 状态管理
* rerun runtime
* 组件树 DSL

---

# 一、核心设计目标

## 1. 薄封装（Thin Layer）

XX UI 只是：

```text id="whosyx"
XX UI
    ↓
Panel / marimo / Qt
```

不是：

```text id="8npzbu"
XX UI Runtime
    ↓
HTML Renderer
```

组件创建应当立即映射到底层框架对象：

```python id="mx3l34"
ui.button("OK")
```

内部立即：

```python id="gjjlwm"
pn.widgets.Button(...)
parent.append(button)
```

而不是：

```text id="z0p0ub"
先构造抽象树
最后统一 render
```

禁止：

* 虚拟 DOM
* 大型 render pipeline
* Terraform 式 deferred render

原因：

* debug 困难
* 创建点与错误点距离太远
* AI coding 难追踪
* 用户 mental model 不直观

---

# 二、核心架构

整体结构：

```text id="jlwmc0"
Signal Core
    ↓
Dependency Tracking
    ↓
Rerun Scheduler
    ↓
Component Tree DSL
    ↓
Backend Adapter
    ↓
Panel / marimo / Qt
```

---

# 三、核心概念

XX UI 中有四种核心对象：

| 概念        | 作用          |
| --------- | ----------- |
| Signal    | reactive 状态 |
| Component | UI组件        |
| Context   | 当前父组件上下文    |
| Cell      | rerun 单位    |

---

# 四、Signal 系统

## 目标

Signal 是整个系统的核心 reactive primitive。

类似：

* SolidJS signal
* Vue ref
* Solara reactive

但更简单。

---

## 基本形式

```python id="nvtvq0"
count = ui.signal(0)

count.value += 1
```

---

## Signal 自动依赖追踪

在 rerun cell 内：

```python id="9i0rxg"
@app.anno.card()
def _():
    ui.text(count.value)
```

读取：

```python id="0w6ivn"
count.value
```

自动注册：

```text id="g9jjlwm"
当前 cell 依赖 count
```

当：

```python id="bmr7j8"
count.value = 2
```

时：

```text id="5hyv6m"
scheduler rerun 对应 cell
```

---

## 初期范围

v0.1 仅支持：

```text id="b7wfrf"
单值 signal
```

例如：

* int
* float
* str
* bool
* object ref

不处理：

* deep reactive
* proxy object
* reactive list
* reactive dict

未来可扩展。

---

# 五、Cell（rerun block）

## 核心思想

# rerun 粒度 ≠ 组件粒度

XX UI 不采用：

```python id="phhsp4"
@component
def Button():
```

作为 rerun 单位。

普通函数：

```python id="jzyvot"
def TodoItem():
```

只是普通 Python 函数。

---

## Cell 才是 rerun 单位

由于 Python 不支持：

```python id="v9f63x"
with block:
```

整体 rerun。

因此：

# rerun block 必须使用函数。

但：

* 不强调 component function
* 不强调 props system
* 不强调 hooks

---

## Cell API

所有组件都可以作为：

* 普通组件
* context parent
* cell decorator

例如：

---

普通组件：

```python id="utg0xq"
app.card(title="Title")
```

---

父容器：

```python id="b1b3xe"
with app.card(title="Title"):
    app.text("hello")
```

---

rerun cell：

```python id="b7rn8w"
@app.anno.card(title="Status")
def _():
    app.text(count.value)
```

---

# 六、with 构树系统

## 目标

使用：

```python id="pmkl4m"
with app.box():
```

形成组件树。

类似：

* NiceGUI
* Solara
* Flutter
* HTML DOM nesting

---

## 本质

with 只是：

# parent context stack

例如：

```python id="m0xfx7"
push_parent(box)
...
pop_parent()
```

---

## 当前限制

Python 的 with：

无法：

* 捕获 block AST
* rerun block body
* 延迟执行 block

因此：

# with 只能作为组件树 DSL

不能作为 reactive rerun block。

---

## 未来可能

如果未来 Python 支持：

```text id="e3rj0k"
block closure
```

则：

```python id="r87rmu"
with app.card():
```

理论上可以直接变为 rerun cell。

但当前不实现。

---

# 七、组件树

## 组件树作用

组件树仅用于：

```text id="t7igj9"
layout
parent-child relationship
```

不承担：

```text id="r2v9yu"
reactive execution graph
```

---

## Reactive Graph 与 Component Tree 分离

例如：

```python id="9z1hxh"
with app.sidebar():
    status_panel()

with app.main():
    editor_panel()
```

layout tree：

```text id="om0f06"
sidebar
main
```

而 reactive graph：

```text id="jlwm4r"
status_panel -> signalA
editor_panel -> signalB
```

二者独立。

---

# 八、更新机制

## v0.1 方案

# 不做 tree diff

采用：

```text id="9m14xr"
rerun → replace subtree
```

类似：

* Streamlit
* marimo
* notebook cell output

原因：

* 实现简单
* mental model 简单
* AI coding 简单
* debug 容易

---

## 非目标

不实现：

* Virtual DOM
* diff patch
* fine-grained DOM update

---

## 关于“原子更新”

例如：

```python id="l0s8lc"
with app.text():
    ui.value = signal.value
```

理论上：

```text id="e3d7ur"
只更新 text.value
```

比 rerun 更细。

但：

Python 无 compile/runtime AST 能力时：

实现困难。

因此：

# v0.1 所有 reactive 更新统一为 rerun cell

未来再考虑更细粒度优化。

---

# 九、状态管理设计

## 状态来源

Signal 可以来自：

* 普通 signal
* 输入组件
* select
* checkbox
* slider

例如：

```python id="o6jlwm"
s = app.select([1,2,3])

s.value
```

本质也是 signal。

---

# 十、Backend Adapter

## 目标

XX UI 不统一 runtime。

而是：

# 在不同 backend 上包装统一 DSL。

例如：

```python id="i89p8s"
app = ui.use(PanelRenderer())
```

---

## backend 必须遵循原框架规则

例如：

Panel：

* 仍然是 persistent widget model

marimo：

* 仍然符合 notebook rerun 模型

XX UI 不强行统一它们。

---

## XX UI 负责统一：

* signal
* rerun
* context stack
* component DSL

---

# 十一、禁止事项

XX UI 不做：

---

## 1. Virtual DOM

禁止：

```text id="a5l1if"
build tree
diff
patch
```

---

## 2. Compile System

禁止：

* JSX compile
* AST transform
* magic transpiler

---

## 3. Hook System

禁止：

```python id="59kvsj"
useEffect()
useMemo()
```

---

## 4. Complex Props Replay

不采用：

```python id="ryjlwm"
@component(props...)
```

自动缓存参数 rerender。

原因：

* 魔法太多
* mental overhead 大
* AI coding 难理解

---

# 十二、Notebook 设计方向

XX UI：

# 不是 notebook framework

但：

# 可以自然映射 notebook。

---

## XX notebook 特点

希望 notebook：

* 可手写
* 可作为普通 py 文件
* notebook/app 可切换
* 不依赖函数名静态引用

不同于：

marimo：

```python id="vjlwmc"
def __():
```

函数名静态依赖模式。

---

## 理想 notebook 形式

更接近：

* Jupyter text notebook
* 普通 Python 文件

而不是：

```text id="smmgca"
强 notebook DSL
```

---

# 十三、全局 Signal / 分布式 Signal

## 当前需求

多个页面共享：

* 系统状态
* 通知器
* 登录状态
* 全局事件

例如：

```python id="xjlwm0"
global_state = ui.signal(...)
```

---

## v0.1 推荐方案

直接使用：

# module global signal

例如：

```python id="jlwm2s"
# state.py
app_state = ui.signal(...)
```

其他页面：

```python id="jlwm9m"
from state import app_state
```

即可。

---

## 原因

signal 本身已经：

* 可观察
* 可订阅
* reactive

因此：

# 不需要复杂 store。

---

## 后续可扩展

未来可能支持：

* scoped signal
* app context signal
* distributed signal
* websocket synchronized signal
* cross-process signal

但 v0.1 不实现。

---

# 十四、AI Coding 友好性（重要）

XX UI 的一个核心目标：

# 降低 AI coding 理解难度。

因此：

---

## 优先：

* 显式结构
* 少魔法
* 少隐藏生命周期
* 少 compile
* 少 implicit rerender

---

## 避免：

* hooks
* memo
* component replay
* AST magic
* hidden closure replay

---

# 十五、v0.1 实现范围（严格）

仅实现：

---

## Runtime

* Signal
* Dependency tracking
* Scheduler
* Cell rerun

---

## DSL

* with parent tree
* component decorator
* component creation

---

## Backend

仅：

```text id="3ajm2z"
PanelRenderer
```

---

## 更新方式

仅：

```text id="lnjlwm"
rerun replace subtree
```

---

# 十六、典型示例

## 示例1：基本组件树

```python id="jlwm0p"
app = ui.use(PanelRenderer())

with app.card(title="Todo"):
    app.text("hello")
    app.button("Add")
```

---

## 示例2：Reactive Cell

```python id="rjlwmx"
count = ui.signal(0)

@app.anno.card(title="Counter")
def _():
    app.text(f"count={count.value}")
```

---

## 示例3：输入组件 Signal

```python id="jjlwm8"
name = app.input("name")

@app.anno.card()
def _():
    app.text(name.value)
```

---

## 示例4：普通函数组件

```python id="tjlwm5"
def TodoItem(app, item):

    with app.card():
        app.text(item.value)

        app.button("Remove")

    @app.anno.text()
    def _():
        app.text(f"selected={item.value}")
```

普通函数：

* 不缓存
* 不 rerender
* 不 component lifecycle

只是普通 Python 函数。

---

# 十七、未来方向（非 v0.1）

未来可能：

* Qt renderer
* web renderer
* terminal renderer
* notebook renderer
* reactive list
* keyed rerun
* subtree preservation
* distributed signal
* async signal
* websocket sync
* AI layout generation
* AST optimization

但当前不实现。
