---
source: mixed
author: Codex questions + chen56 answers
generated_by: Codex
last_updated: 2026-05-05
status: source_decisions
---

问答：

一、框架命名与 API 风格

  1. 最终包名用 dao.ui、dao_ui，还是两者兼容？
A:  dao_ui
  2. 组件 API 是否统一小写：app.button()、app.card()，还是保留类名风格：app.Button()、app.Card()？
A:  统一小写
  3. ui.use(Panel()) 和 ui.App(render=PanelRender()) 二选一，最终采用哪个？
A:
import dao_ui as ui
import dao_ui.providers.panel as panel
app = ui.App(
    provider=panel.Provider(),
)
  4. 是否允许模块级快捷调用 ui.text()，还是强制所有 UI 创建都从 app.text() 进入？
A: 必须从一个容器进行，app.xxx 避免全局变量导致测试、代码难以多实例难写的问题
  5. parent.context.button() 这种写法是否保留，还是只保留 app.button() + current context？
A: parent.context.button()已删除描述，当时只是为了说明其关系，不应暴露api，只保留app.button(),后面要不要暴露context再看吧。
  二、Component / Cell API
  6. 最终 cell API 采用哪种？

  @app.anno.card(...)
  def _(): ...

  还是：

  @app.card(...).cell()
  def _(): ...
A:  @app.card(...).cell()
  7. app.anno.card() 是否仍然需要？如果保留，它和 app.card().cell() 的职责差异是什么？
A: 不要app.anno.card()
  8. 所有组件都必须支持三种形态吗？

     app.card()
     with app.card():
     @app.card().cell()
Q: 这三种形式通过继承实现一次，不需要每个组件都实现吧？

  9. 原子组件如 text/button/input 是否也允许 .cell()？
A: 目前不允许，通过一个特殊的 ui.cell()容器来做原子组件更新，可以加一个备注，后面可能实现。

  10. .cell(lambda: ...) 是否进入 v0.1？还是只支持装饰器函数，减少实现复杂度？
Q: 这个语句本身就是装饰器语法，无所谓实现不实现吧？一个可接受函数参数的cell而已? 你愿意塞函数还是lambda对api来讲没啥区别吧？即便是多行函数模拟:
.cell(lambda:(
 a(),
 b(),
 ))
这个对实现来讲都是透明的吧？
  11. cell 函数是否必须无参数？如果允许参数，rerun 时参数从哪里来？
Q: cell函数可以增加个context参数，即表示当前父容器的上下文，比如context.cell?有更好的形式吗？
  12. cell 装饰器执行时是否立即首次运行并挂载？
A: 立即执行并挂载.
  13. cell 定义在普通函数内部时，闭包捕获的变量生命周期如何说明？
Q: 啥意思？说明啥？闭包变量生命周期？
  14. cell 是否需要显式 key/id，还是 v0.1 完全按对象实例管理？
A：对象实例，暂时没有id需求
  三、上下文与组件树
  15. app.current 是公开 API 吗？
A: 只是说明情况，暂时不作为api
  16. current context 是全局变量、thread-local，还是 app 实例字段？
A: contextVar
  17. v0.1 明确单线程同步，那么是否可以先用 app 实例字段而不做 contextvar？
A: 当前单线程，和runtime一致，我看panel等的范例也并没有contextvar,只是普通变量和同步ui，只是event handler是异步，但是事件handele很可能传递参数即可？
  18. 如果嵌套多个 app，是否支持？还是禁止？
A: 支持，本来app就是为多实例准备的.但目前还没有范例用来做啥?测试可能是需要的new一个实例测试、丢弃。
  19. 一个组件是否必须有 children？原子组件如果作为 current context 时怎么处理？
A: 不必须。原子组件可以没有children，所以需要区是否有children。  
  20. with app.text(): ... 这种原子属性更新设想，v0.1 是禁止、忽略，还是允许但只作为普通容器？
A: 当前用with app.cell():... 一个特殊容器吧，先观察。
  四、Panel 后端边界
  21. v0.1 的根容器具体是 Panel 的什么对象？pn.Column、pn.Row、pn.template，还是用户传入？
A: 根对象是app，不需要直接对应provider的组件，只是虚拟组件容器即可。
  22. app.root 是否暴露底层 Panel 对象？
A: 默认是empty虚拟容器
  23. 组件包装对象是否暴露 raw / native，方便用户直接操作 Panel？
A: 不暴露，完全隐藏，统一外部api
  24. Panel 的 servable() 放在哪里调用？框架内部调用，还是用户自己调用？
A: 框架内调用, app.mount()内部循环for children servable()

  25. Panel input/select 的 value 同步采用 param.watch 还是其他机制？
A: text.value = "Bob", 理论上我们应该不使用runtime provider的观察者机制吧? panel应该可以覆盖吧?marimo因为都是只读属性,text.value=“newvalue”后内部应该重建marmio.text()

  26. Panel 容器 clear 时使用 clear()、切片删除，还是重建底层对象？
A:  panel:
    col[:] = [
        pn.pane.Markdown("# hello"),
        pn.widgets.Button(name="Run"),
    ]
    一般不要重建，会破坏原有对象identity，如果有组件不适合修改，则单独重建。
    而marimo: 貌似大部分组件没有写操作的函数，所以大多数组件只能重建.
  规则貌似还是要挨个组件对齐，而不是一次性决定。

  27. cell rerun 时是清空 cell container 的子组件，还是替换整个 cell container？
A: 同26

  28. 如果 cell container 是 Text 这种原子组件，rerun 语义是什么？
A: 暂时没有这种组件，因为用app.cell()特殊容器来应对这种场景，所以原子组件目前肯定都是重建，
   未来单独有Text这种cell，那可能要针对每个不同的组件定义,参考26

  五、Signal 语义
  29. app.input() 返回的是组件对象，还是 Signal-like 对象？
A: 组件, 可以暴露input.value并委派给内部的singal.value,singal对象暂时不暴露，待观察。
  30. 如果返回组件对象，.value 是普通值属性，还是内部代理到 Signal.value？
A: 代理  
  31. 普通 ui.signal() 和输入组件 .value 是否共享同一个依赖追踪机制？
A: 内部都是signal，没啥区别，由内部signal机制决定,input只是壳子  
  32. .value = same_value 是否触发 rerun？需要 equality check 吗？
A: 暂时值相等不rerun符合普通人直觉
  33. signal 是否支持 subscribe/unsubscribe 公开 API？
A: 不提供，因为rerun cell模型已经覆盖了类似js web的effect的作用，不需要单独提供了。
  34. cell 重新运行前，旧依赖是否清除并重新收集？
Q: rerun 前清空旧依赖
rerun 时重新 tracking

  35. 如果 cell 条件读取不同 signal，依赖集合如何更新？
动态监听器，本质是signal.value调用时进行注册观察者，依赖添加到触发的signal,当然是顺序增加，但是要保证不要重复增加,可能需要hashmap进行O(1)查询。

  36. signal 写入时同步 rerun，还是进入 scheduler 队列批量执行？
A: rerun同步执行,异步将导致后续语句无法预测signal.value

  37. 一个 signal 变化触发多个 cell 时，是否按 cell 创建顺序执行？
A: 纵向应该由树从上向下检查执行(避免本身要rerun更少量父级别节点，结果还不rerun大量深层子节点)，横向应该是同层级list顺序执行

  38. cell rerun 中再次修改 signal，允许嵌套 rerun 吗？还是排队到当前 rerun 结束后执行？
A: 应该nodescope策略化，默认策略：禁止嵌套 rerun
signal update 仅 enqueue
当前 rerun 完成后统一 flush

  六、调度器与错误处理
  39. v0.1 scheduler 是立即同步执行，还是 micro-batch？
A: 策略化，先提供立即执行简单策略和定时批处理策略，默认为定时批处理策略，类似flutter

  40. cell 执行报错时如何展示？抛出到控制台，还是挂载错误组件？
A: 策略化，目前缺省抛出控制台，并在页面notify出来

  41. cell 报错后依赖是否保留？
A: 保留，便于debug

  42. rerun 中途失败，旧 UI 是清空后显示错误，还是保留旧 UI？
A: rerun应先收集rerun cell 的新组件，成功运行后再一次性替换，所以是：成功后clear旧组件。而且notify错误应该是scope可配置的，默认显示到相应旧cell下方（类似marimo）

  43. 是否需要防止无限循环？

  @app.card().cell()
  def _():
      count.value += 1
A: 需要
值相等不触发
禁止嵌套 rerun
当前 rerun 去重（最重要）if node already dirty: skip
MAX_RERUN_DEPTH = 100
只按scope node signal rerun ，即signal的rerun范围是挂载的子树，如果用global传递到其他子树，则应warn日志+dev模式报错+prod忽略
dev模式记录传播路径便于调试：A -> B -> C -> A
未来支持策略化。


  44. 是否需要最大 rerun 深度或循环检测？
A:需要，参考43

  45. 多个 signal 连续赋值是否会重复 rerun 多次？v0.1 是否接受？
A: 不重复rerun，参考43

  七、自定义组件模型
  46. 最终是否明确规定：自定义组件就是普通函数，不是 reactive component？
A: 明确普通函数，因为rerun cell rerun时参数的保留太魔法，不考虑合并概念，保持简单

  47. 普通函数内部创建的 cell 是否被视为“子 cell”？
A: 当然，普通函数也是被上层cell调用的，自然是附属于上层cell的子cell

  48. 普通函数重复调用会创建多个 cell，这是否是预期？
A: 符合预期，cell只是具有rerun能力的node，而rerun是更新粒度的业务需求,无法阻止创建多少个。
  低质量问题，应合并在其他问题中。

  49. 是否需要销毁普通函数创建的 cell？
A: cell就是普通node，销毁与否看上层rerun时它是否还被创建。
低质量问题，应合并在其他问题中。

  50. 如果列表 cell rerun 内部创建按钮回调，旧按钮回调如何释放？
A: 回掉依赖按钮，按钮依赖node，旧按钮生命器结束，回掉函数自然被释放或设置null，按python垃圾回收最佳实践操作即可。

  八、列表与动态 UI
  51. Todo 示例里 for i, item in enumerate(items.value) 每次 rerun 清空重建，v0.1 是否接受？
A: rerun 的清空重建是业务代码决定的，框架怎么决定？业务代码已经重新for 重建了，框架没办法吧？

  52. 是否需要 keyed cell/list？还是明确 v0.1 不支持？
A: 暂时看不到需求，你看到需求了吗？ 

  53. 动态删除列表项后，旧组件和旧 watcher 是否能正确释放？
A: 能，参考scope node的signal挂载

  54. lambda idx=i 这种闭包写法是否作为推荐规范写入文档？
A: 不用，这是业务代码自己的事情，框架只接受函数参数而已,顶多列出多种范例供体会

  55. reactive list 不支持 deep mutation，那么文档是否强制要求整体替换？
A: 目前只支持单值，应备注清楚

  九、全局状态与 session
  56. 模块级 signal 在 Panel 多 session 下进程共享，这是否是默认推荐还是仅作为可选？
A: 按照目前scope node的设计思路，应该不支持独立于scope node外的signal，而应该设计一种专门跨页面的node容纳所有页面app root，因为panel会对页面py进行刷新，而目前app是页面级别的root node，无法形成真正进程级别的根节点概念。



  57. 用户私有状态是否必须放在 page factory 里创建？
A: ???
  问题质量低描述不清晰

  58. v0.1 是否要实现 app.state / scoped signal，还是只用 Python 模块变量和函数局部变量？
A. 没有app.state,只有scoped signal,局部变量模块变量只是符合python习惯的技术语法，不在本框架管控内,我们只是对signal的作用域进行tree node级别scope管控，即不允许跨子树使用范围外的signal

  59. 多页面共享 signal 的最小推荐模式是什么？
A. 没有推荐模式，只有和对应provider 适配的形式，比如panel肯定要定义一个module外的node放更全局的进程级别的signal，如果有session模型，就自行建立session级别node

  60. 是否需要区分全局 signal、session signal、component local signal 的命名规范？
A. 不区分, 本ui框架只有scope signal, signal本身是独立的，独立于ui单独使用可能有其他场景，不做介绍

  十、Notebook / marimo 方向
  61. v0.1 是否完全不实现 marimo，只保证设计不冲突？
A. 实现吧，可以对比一下panel和marimo, 0.1实现panel和marimo

  62. “先在 marimo 里融合”与“v0.1 仅 PanelRender”是否冲突？最终优先级是什么？
A. 参考61 ,marimo默认是可以嵌入panel组件的，所以即便dao_ui不开发marimo实现，理论上也可以把dao_ui 的panel挂在marimo里

  63. Panel 可以嵌入 marimo，这是否作为 v0.1 使用路径？
A. 参考61

  64. notebook 形式是否只作为未来方向，不进入第一版规格？
A. 参考61，当前只嵌入其他运行时提供器，我们暂时没有自定义notebook的需求，只是我们的设计天然比较容易变成notebook

  65. 是否要避免任何依赖 marimo cell 语义的设计？
A. 参考61，marimo只是一个provider

  十一、输出与调试
  66. cell 内 print() 是否在 v0.1 捕获？
A. 捕获，log也是scope node的能力之一，可配置，便于调试

  67. 如果捕获 print，输出挂载到哪里？cell container 末尾？独立 debug panel？
A. 参考66， 可以实现4个参考策略：打印在控制台,打印在当前cell下方(rerun清除)，打印在类似chrome/marimo develop panel的地方,比如sidebar有个展开按钮，上面显示错误数图表，点击展开为全局日志，有错误时如果没展开日志则在日志按钮附近跳一个小的错误提示泡泡。


  68. 如果不捕获 print，是否明确写入 v0.1 非目标？
A. 参考67

  69. 是否需要 dev mode 显示 cell 名称、依赖 signal、rerun 次数？
A. 需要，一开始就要考虑dev mode/prod mode，只是个在node上的状态参数，可以局部按scope开启

  70. AI coding 第一版是否需要测试这些调试能力？
A. 问题不清晰

  十二、实现范围
  71. v0.1 最小组件集到底是哪些？
A. 因为是1比1封装薄层，所以 panel: Column/Row/Card Button/TextInput/RadioButtonGroup Markdown
   marimo类似

  72. 是否需要 layout classes 透传？例如 classes="flex gap-2" 对 Panel 是否有效？
A. 按封装的框架习惯来，我们只封装同样参数的薄层

  73. Panel 本身不完全等价 CSS class 系统，classes 如何映射？
A. 不映射，只同等封装
  
  74. on_click、on_change 这类事件参数命名是否统一？
A. 按provider单独提供同provider能力/名称

  75. 输入组件支持外部 signal 绑定吗？

  name = ui.signal("")
  app.input(value=name)
A. 暂时不支持这种绑定

  76. 还是输入组件自己创建 signal？

  name = app.input("Name")
A: 是的,封装panel/marimo inputtext
  class daoui.panel.TextInput:
      target: pn.TextInput #被包装对象组件
      signal: daoui.Signal

      @property
      def value:
          return self.signal.value
  app=PanelApp()
  name:daoui.panel.TextInput = app.textInput("Name")
  name.signal

  十三、文档需要明确的取舍
  77. 最终文档是否要把 ai_chatgpt_draft.md 和 api_design_v0.2.md 合并成一份规格？
A. 这是过程文档，我怕你总结的 时候遗漏信息，所以暂时不合并，等最终成型后归档再清理

  78. 哪些内容是“必须实现”，哪些是“设计方向”，哪些是“明确不做”？
A. 综合总结吧，需求总结后直接生成测试用例代码，最终以测试用例为准。

  79. 是否需要先写 SPEC.md，再写 PLAN.md？
A. 请解释，建议。

  80. AI coding 任务是否应该拆为：

  signal core -> context/component -> panel renderer -> cell rerun -> examples/tests

A. 
  测试用例先行，测试用例代替文档需求接口定义，未实现的测试，用来表明未来的实现，现在还未实现，可以先用stub实现简单表述，避免编译问题，或甚至只有testcase的 函数内注释文本即可

  我建议下一步先回答这些最高优先级问题：

  1. 最终 API 用 app.card().cell() 还是 app.anno.card()？
  2. v0.1 是否只做 Panel，不做 marimo？
  3. input/select 返回组件对象还是 Signal 对象？
  4. scheduler 是立即同步 rerun，还是队列批处理？
  5. cell rerun 报错时清空旧 UI 还是保留旧 UI？
  6. dao.ui 和 dao_ui 最终包名选哪个？


------- 新问答

1. app.signal() 是否完全取代 ui.signal()。
A: signal本身是独立的，应该直接可以dao_ui.signal.signal()类构造器实例化,但是因为在ui中,我们的app限定只对scope signal rerun，而app.signal()是挂载创建scope signal的方法，所以这个场景必须使用。

2. v0.1 是否必须用 contextvars.ContextVar。
A: 因为目前ui设计的是单线程同步api，所以暂时不实现，再观察看，备注一下即可

3. 默认 scheduler 是 immediate 还是 periodic。
A: default:
   dev mode: immediate
   prod mode: periodic

4. cell 是否支持 ctx 参数。
A: 支持，因为装饰器默认是没有返回值的，所以需要有个引用

5. provider wrapper 是否完全隐藏 target。
A: 不隐藏，我们只是薄层

6. marimo v0.1 最小组件清单。
A:
panel: Column/Row/Card Button/TextInput/RadioButtonGroup Markdown
marimo: hstack/vstack button/text/radio md(markdown)

7. signal 跨 scope 在 dev/prod 下的具体行为。
A: signal 跨scope dev应该 报错，prod warn log
