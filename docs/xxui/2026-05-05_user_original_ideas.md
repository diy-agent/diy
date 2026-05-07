---
source: user
author: chen56
generated_by: none
last_updated: 2026-05-05
status: source_material
---

# 用户chen56的原始想法及回复


我想设计一套薄的封装层UI框架，想法是：
1. 实现基本组件装配系统，可以对接多种不同的后端框架，比如panel,marimo ui 等，先用这两个，
import dao.ui as ui
app = ui.use(Panel())
app.button("xxx") # 内部在页面上挂载一个button
2 对接的形式是类似nicegui/solara.dev 这样的通过with层级装配组件的方式，通过上下文父对象隐含的构造父子关系，比如执行
with app.box():
    app.button() # 这个button会调用panel.button()并insert进上层对象
3. 构成一个层级的组件树，组件树有两种节点，一是有普通父子关系的组件树：
app.button() # 当前没有层级父对象时，app就是容器，就是父对象
with app.box(classes="flex ....layout classname....") as parent:
    app.button() # 这个button会调用panel.button()并insert进上层对象parent,因为parent是当前父对象
    app.current == parent # True
    app.md("markdown")
二是有刷新rerun能力的cell，python的with语法无法获取块语句作为整体重新rerun，只能让函数作为独立rerun 块,类似@solara.component或
@render.text # [shiny.posit.co](https://shiny.posit.co/py/docs/overview.html)
def slider_val():
    return f"Slider value: {input.val()}"
不同于marimo的cell线性结构，cell是列表，我们的cell是树形组件树的，即树形组件树种有一些特殊节点是函数化的是可以rerun的。
marimo的cell关联着其显示方式，顺序向下显示，即暗示着一个固定列表layout，我们的组件树/cell只是普通组件，layout由树上响应的组件layout决定，比如css class

4. 当前使用类似marimo的组件状态管理:
  s=x.select(options=[1,2,3])
  x.md("select: {s.value}") #x选择后会响应式变化，即刷新当前cell
  组件默认是singal/reactive形式的,类似 'solara.reactive([1, 2, 3])' ,页面选项出发value的变化或手工赋值 's.value=2'都将触发此singal的观察者变化->rerun 观测这个信号变量的cell, cell自动 观测's.value'信号变量的属性获取过程注册观察者关系。

5. 子组件只是个普通函数,没有任何魔法,也不是一个rerun cell函数：
def TodoItemCard(app: ui.App,item: ui.Select[str]):
    with ui.Box("flet box"):
        ui.InputText("", value=item.value)
        ui.Button("Remove")
    # 这才是个rerun cell
    @app.anno.Box("flet box")
    def _():
        ui.Text("value:{item.value}")
    # 或者这也是rerun cell:
    app.anno.Box("flet box")(lambda: (
        ui.Text("value:"),
        ui.Text("{item.value}"),
    ) )
with app.box(classes="flex ....layout classname....") as parent:
    for item in todo_items:
       select=ui.Select(options=[*item.tags])
       TodoItemCard(app,select)

6. 因为还不了解各类web框架的细节机制，另外没有心目中理想的框架，所以希望构造一个可转换模型的框架，当前不确定是否多个框架能否共存，就暂定同时使用一种'ui.use(Panel())'

7. 查找会话历史找到所有关于我对ui设计的意见，进行总结。

备注：我希望框架的状态管理基于最基础的信号量，而这个信号量可以是一个组件select，input，也可以是一个普通值，当前类似solara.reactive,将来可能专门对list/dict/深层object做特殊的处理，现在聚焦单值即可。


---------

1.                ┌────────────┐
                │ signal core│
                └─────┬──────┘
                      │
              dependency tracking
                      │
             rerun scheduler/runtime
                      │
                component tree
                      │
       ┌──────────────┼──────────────┐
       │              │              │
   PanelRenderer  MarimoRenderer  FutureRenderer

没错,我没能力开发完整的web/gui框架,但又不满意现有框架的编写形式，所以做一个薄层，本质还是PanelRenderer要符合panel的规则，QTRender符合qt的基本规则。但是在gui构造和状态管理上符合我的设计。

2.1 没错
2.2 我的模式可以不作为notebook，但应该可以方便的抽象出某种notebook形式，因为notebook只是表现形式，而树形cell 就自然包含了这种形式的基本结构，而且marimo的静态引用通过函数名传递丢失了类型信息，并且让手工书写notebook py文件变得困难，不是我希望看到的好的方式，我理想中notebook可以类似jupyter text python模式那种,可以手工书写，方便在notebook和纯py间切换。

3.1 我认为rerun结构本质上是粒度问题，不应该自动扩展到所有组件粒度，而应该自己选择一个rerun block，受限于python with无法作为块rerun的缺点，只能用函数做rerun块
你举的例子不确切：
@app.cell
def _():
    ui.text(s.value)
没有一个叫app.cell的装饰器，我认为所有组件本身都应该可以是装饰器，而且应该用 app这种父容器进行区分而不是module名,而且可以有各类构造参数：
@app.anno.card(title="xxx",tail="xxx"....)
def _():
    ui.text(s.value)
并且应该区分普通app.card()和app.anno.card()，因为还可以直接使用：
app.card(title="xxx",tail="xxx"....)
或作为父层级：
with app.card(title="xxx",tail="xxx"....):
    ui.text(s.value)
甚至原子ui也应该可以：

with app.text(): 
  # 类似SolidJS的原子属性更新，但我认为python不做编译很难解决原子属性更新问题，所以简单化解为:all is rerun block
  ui.value=some.value
   if some.value=="some value":
      ui.classes="blue"
   # 因为要做到更细粒度的原子更新，所以可能真的需要一个app.anno.cell
   @app.anno.cell()
   def _():
       ui.disable=glabol_env.disable_all_write_access
3.2 ’‘’“with构树”只是 DSL，不是 runtime‘’‘ 
    也不是，with在python 里无法当块代码复用，所以只能是树组件dsl，如果有一天py支持了with 的块代码执行器，那with就转变为了cell，比函数形式更简单易读。
3.3 对，solara就是组件和函数绑定：
@solara.component
def MyButton(text):
    solara.Button(text)
但我认为solara的参数传递把问题复杂化了，他要把所有参数都预存起来，rerun的时候再穿进去，魔法太多了，脑子很难转过来，我认为rerun就是rerun，就应该是无参数或固定参数(比如有一个父组件引用或context？)，而子组件就只是一个普通函数调用而已。

4. 因为我在形成一个ai coding的需求说明，所以还没有代码。
4.1 和streamlit一样，rerun替换，不做tree diff，简单化。只是比他更细粒度层级结构
5.1  我不准备统一为一种完全风格的框架runtime，只是在一个框架上包装一个ui+状态管理的统一层，而具体使用，当然要符合包装的panel、marimo的形式，以便于在他们的环境里直接运行。
5.2. 同5.1
5.3 也许有一天真的可以实现自己的ui，但短期不会，太复杂了，我还有其他事情要做
6. 我强调一下，上次聊过，我不要做render这种模式，一次性构造一个大的组件树，再render为一个框架比如panel的映射树，这样和terraform的问题一样，创建组件的代码点和render距离太远，导致出问题，都不知道啥地方错了。ui.button("")内部就直接用parent.add(pn.button())
7.可以，panel可以作为first目标, 而且panel可以在merimo里用
9.2 分布式signal : 可以多聊下，我立刻要做多个页面的同一个signal，比如一个py进程的桌面web程序，有个统一的signal作为系统状态、通知器之类的，是不是用全局变量就可以？抑或是通过树进行层级传递和定义？我还没想好，因为还要符合panel的规则吧

9.3 嗯计划先在marimo里融合
9.4 对生成ai也是重点


这是我的回复，我希望能形成一个可以直接给ai coding的规格文档，有逻辑话的说明，减少信息重复，且带范例和边界条件等，足够ai进行第一次编写代码

---

重要抽象及约束:
- python强类型，尽最大努力标注类型！ 
- UI组件树不光是组件树，还是一个特性配置树，从上到下可以配置应用特性，比如在一个节点配置rerun模式为实时刷新还是定时刷新等机制
  - UI组件是变量挂载点，比如挂载signal，挂载层级配置等，比如app.notify("xxxx")同样的通知语句，在树的不同节点展示的方式有所不同！
    - 即：Scoped Reactive Runtime，即signal/scheduler/runtime/debug 作用域化
    - 所以：UI节点变进化为：Everything belongs to a ScopeNode
      - debug boundary
      - Dependency Tracking
      - notification context
      - resource lifetime
      - runtime config
      - signal scope
      - scheduler policy
      - task/effect
      - ui component
    - app.notify("xxx")的本质不是全局调用，而是：find nearest notification policy
  - signal,signal 应该挂在树上，即声明signal时应该像app.button()普通组件一样，挂在当前上下文父节点上：
    - app.signal(1) 通过类似 app.button()方式创建，形成节点关系
    - 后面就可以从子向父亲追溯查找
    - debug窗口展示当前所有树上的signal,signal的引用传播途径应该是向下传递，这样，调试某节点时只需关注其上层signal即可
    - signal的作用域即为子树，如果超过子树进行访问应该dev时报错，prod时warning
    - 总结：
      - 使signal具有生命周期(owner、scope、dependency、scheduler、debug、metadata)而不是普通变量更有意义：
  - 可按节点配置的策略化rerun scheduler
    - 场景不同rerun策略不应该是一样的，比如:
      - 高频实时图表: throttle、debounce、frame-based
      - notebook需要transactional rerun
      - AI streaming

------

### 组件树/Runtime Scope Node抽象范例:

```
import dao_ui as ui
app = ui.app(provider=xxx,scope={
    mode:"prod"
    refresh = ui.scheduler.realtime_rerun_scheduler() if app.is_dev else ui.scheduler.period_scheduler(period="10ms")
  },
)
with app.page(scope={refresh:scheduler.realtime_rerun_scheduler()}):
    sig_a = app.signal(1)
    with app.sidebar():
        sig_b = app.signal(2)
    with app.panel(classes="xxx",scope={refresh:ui.scheduler.period_scheduler(period="100ms")}):
        sig_c = app.signal(3)
```

实际形成：

```bash
# prod mode:
App
├── scheduler=period_scheduler 10ms
├── Page
    ├── scheduler=realtime_rerun_scheduler
    ├── sig_a
    ├── Sidebar
    │   └── sig_b
    └── Panel
        ├── scheduler=period_scheduler 100ms
        └── sig_c

```

--- 

rerun cell 应该是同步模型，异步任务通过resource/task/future的异步状态进行,ui线程不进行await
┌─────────────┐
│ 外部事件源   │
│ socket/io   │
│ timer/thread│
└──────┬──────┘
       │
       ▼
signal.set()
       │
       ▼
submit to nearest scheduler
       │
       ▼
同步 rerun cell
       │
       ▼
render/update ui

所有 cell 都是同步 transaction


---

### 关于scope node的层级/类型问题

最终模型：

ProcessRoot
    └── ScopeNode
            └── ScopeNode
                    └── UIComponent...


继承层次：

ScopeNode
    ↑
UIComponent
    ↑
Card/Button/Panel/Cell/Sidebar...

其中：

ScopeNode：
- runtime scope 抽象

UIComponent：
- UI/layout/render/event 抽象

Card/Button 等：
- 具体 UI 组件

至于 node 代表：
- process node
- page
- session
- iframe
- notebook cell
- widget subtree

由 provider 或用户自行定义。

runtime kernel 不理解 page/session，
只理解：
- scope
- ownership
- scheduler
- signal propagation
- lifetime

Facet 模型：

signal/scheduler/logger/rerun 等：
不是独立 node，
而是挂载到 ScopeNode 的 runtime facet。

例如：

signal
=> attach SignalFacet

scheduler
=> attach SchedulerFacet

rerun：
也不是特殊 node，
而是 ScopeNode 的 runtime capability/facet。


---
