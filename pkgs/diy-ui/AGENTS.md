# diy-ui — 响应式 UI 框架

## 核心概念

- **Signal**: 可观察单值状态，读写自动触发依赖更新
- **ScopeNode**: 薄兼容壳（Phase 3a 后），全委托给 `self.diy`
- **ScopeProxy**: 自持所有 scope tree 状态，通过 `obj.diy` 挂载到任意对象
- **Cell**: 响应式函数，`@node.cell()` 装饰，依赖的 signal 变化自动 rerun
- **Generator Cell**: yield 组件自动挂载
- **BaseApp**: 根节点（继承 ScopeNode），提供 context stack 和 `app.signal()`

## 架构：Phase 3a 完成态

```
Panel widget (Button/Checkbox/...)
  ├── 继承 pn.widgets.X + UIComponent(ScopeNode)
  └── .diy → ScopeProxy(self)
               ├── _host → widget 自身
               ├── signal: Signal|None        (widget 的 Signal 实例)
               ├── init_done: bool
               ├── panel_container: bool
               ├── _parent / _children_v / _ancestor_ids[id(host)]
               ├── _config_v / _lookup_mode / _lookup_scheduler
               ├── _cell_fn_v / _dependencies / _is_dirty / _is_executing
               └── _execute_cell / create_signal / cell / on_signal_changed
```

**关键文件**：
- `src/diy/ui/_scope.py` (420 行): ScopeProxy (310 行) + ScopeNode 薄壳 (60 行)
- `src/diy/ui/_base_app.py` (73 行): BaseApp，context stack 存 ScopeProxy
- `src/diy/ui/_signal.py`: Signal 类，`_trigger_observers` 调 `obs.on_signal_changed(self)`
- `src/diy/ui/_debug.py`: DebugInfo，`get_debug(node: ScopeNode)` 缓存
- `src/diy/ui/providers/panel/_base.py`: UIComponent(ScopeNode, DiyInitSub) + `_HasValue` mixin
- `src/diy/ui/providers/panel/_factories/_widgets_factory.py`: `_add()` 安装 Signal+bridge
- `src/diy/ui/providers/panel/widgets/_wrapper_registry.py`: 57 个 widget 类动态生成
- `src/diy/ui/providers/panel/widgets/_button.py`: 唯一保留的手写 wrapper（metaclass 模式）

## Phase 2/3a 关键变更清单

### isinstance → hasattr（Phase 2）
```python
# 之前
if isinstance(node, ScopeNode): ...
if isinstance(child, UIComponent): ...
# 之后
if hasattr(node, 'diy'): ...
if hasattr(child, 'diy'): ...
```

### _add_child 调用路径
```python
# 之前: 直接调 ScopeNode
self._add_child(child)           # self = ScopeNode
# 之后: 走 diy → ScopeProxy
node.diy._add_child(child.diy)   # ScopeProxy._add_child(ScopeProxy)
```

### context stack（Phase 2）
```python
# 之前: 存 ScopeNode，_current 返回 ScopeNode
self._context_stack_var.set((self,))
# 之后: 存 ScopeProxy，_current 返回 ScopeProxy
self._context_stack_var.set((self.diy,))
# _add_to_current:
child._app = self              # 设 app 本身（非 proxy）
self._current._add_child(child) # child 是 ScopeProxy
```

### signal.owner（Phase 3a）
```python
# 之前: _mount_signal 设 sig.owner = self (ScopeNode/widget)
# 之后: sig.owner = self (ScopeProxy)
# 访问: sig.owner._host → widget
```

### _ancestor_ids（Phase 3a）
```python
# 统一用 host id (widget/ScopeNode 的 id)，不是 proxy id
# ScopeProxy.__init__: self._ancestor_ids = {id(host)}
# _rebuild_ancestor_ids: ids.add(id(node._host))
# ScopeNode._ancestor_ids: return self.diy._ancestor_ids（透传，因为存的就是 host id）
```

### on_signal_read 跨 scope 检测（Phase 3a）
```python
owner = signal.owner   # ScopeProxy
id(owner._host) not in active_cell._ancestor_ids   # host id vs host id
id(active_cell._host) not in owner._ancestor_ids
```

### cell 回调（Phase 3a）
```python
# _execute_cell 内: fn(self._host)  # 传 widget（不是 ScopeProxy）
# ScopeProxy.cell() 返回 self._host（装饰器返回宿主）
```

### Slot/property 冲突（Phase 3a）
```python
# ScopeProxy.__slots__ = ('_children_v', '_config_v', '_cell_fn_v', 'signal', ...)
# → property 暴露 _children / _config / _cell_fn
# signal 保留为 slot（widget Signal 实例），create_signal() 为方法
```

### EventLog monkey-patch（Phase 3a）
```python
# 之前: hook ScopeNode._execute_cell
# 之后: hook ScopeProxy._execute_cell
diy.ui._scope.ScopeProxy._execute_cell = _execute_cell_with_log
# _node_label 需要从 ScopeProxy._host 取 ScopeNode
```

### _signal_name 兼容 __slots__（Phase 3a）
```python
# ScopeProxy 用 __slots__，无 __dict__
# tests/helpers.py _signal_name:
try: owner_dict = owner.__dict__
except AttributeError: owner_dict = {s: getattr(owner, s) for s in type(owner).__slots__}
```

## 测试基线

```
全量: 26 fail / 145 pass（26 个全是 pre-existing）
unit (90) + intent (18): 108 passed ✅

26 pre-existing 失败:
  TestButtonSyncFlow × 9       _button.py metaclass 模式未迁移
  TestPanelParamCoverage × 2   param 排除列表未同步
  TestComponentPanelStyle × 2  name/label 参数测试（wrapper 已删 name）
  panel native × 5             Panel 内部 api 测试
  cell_panel generator × 2     generator cell Panel 适配
  test_concurrent_async × 1    async 干扰测试
  test_nested_panel × 1        Panel 容器嵌套
  test_servable × 1            servable 同步
  TestPanelAppSignal × 2       含 test_signal_inside_panel_container
  test_auto_mount × 1          auto_mount 行为
```

## 当前 branch 状态

- branch: main, ahead of origin/main by ~35 commits
- 最近改动: Step 1 (_HasValue mixin) + Step 2 (动态类消除 57 文件)
- 工作目录: clean (uncommitted)

## Wrapper 动态生成

57 个 widget 类由 `_wrapper_registry.py` 用 `type()` 动态创建。
`DiyInitSub` metaclass 在 `type()` 时自动从 Panel param 生成 `__init__`。

```python
# _wrapper_registry.py
_WIDGETS: list[tuple[str, type, bool]] = [
    ("Checkbox",    pn.widgets.Checkbox,    True),   # True = 继承 _HasValue
    ("Progress",    pn.widgets.Progress,    False),  # False = 不继承 _HasValue
    ...
]

for _name, _panel_cls, _use_hasvalue in _WIDGETS:
    _bases = (UIComponent, _HasValue, _panel_cls) if _use_hasvalue else (UIComponent, _panel_cls)
    _cls = type(_name, _bases, {"__module__": __name__})
    globals()[_name] = _cls
```

`__init__.py` 从 registry 导入后 re-export：
```python
from ._wrapper_registry import ArrayInput, ..., VideoStream
```

特点：
- 无显式 `__init__` — metaclass 自动生成
- 无 value getter/setter — `_HasValue` mixin 提供
- 无 `name` 参数、无 `init_done`、无 `_setup_event_bridge`
- `_button.py` 保留独立文件（metaclass pre_init/post_init 模式，使用 `self._signal`）

**风险：IDE 补全失效**（pyright 看不到动态类）。可接受——class 数量大且稳定，手工维护成本更高。

## 下一步

### Phase 3b/3c: 删除 ScopeNode（非紧急）
ScopeNode 已是零成本薄壳，可后续处理。

### layout/pane 同理动态化
layout (18 个) 和 pane (26 个) wrapper 也可同理用 `type()` 消除文件。
但它们的 `__enter__/__exit__` 和 `panel_container` 逻辑需要特殊处理。
