# Async Cell 实现总结

日期：2026-05-26
状态：已结案（P1-P6 全部完成）

## 实现时间线

| Phase | 内容 | 变更规模 | 关键提交 |
|-------|------|---------|---------|
| P1 | 清理与简化（signal 下沉、去 staging） | _scope.py -57/+49 | `8a10cc5` |
| P2 | ScopeConfig 强类型化 + auto_mount_child | _scope.py +28, 测试 +109 | `faa6a8c` |
| P3 | 生成器 cell 核心实现 | _scope.py +108, 测试 +206 | `a879c81` |
| P4 | 异步 yield awaitable 支持 | _scope.py +174, _scheduler.py +18, 测试 +93 | `175698c` |
| P5 | 测试重组 + tree snapshot + event log | 测试目录 5 层分离, helpers.py +162 | `5be6833` |
| P5+ | 意图测试增强 + EventLog 升级 | intent/ 重写, helpers.py 重构 | 本次 |
| P6 | 示例补全 | async_cell_demo.py + generator_cell_demo.py | `9d4bb4b` |

总变更：`_scope.py` ~380 行新增，测试 ~1200 行新增，170 tests 全绿。

## 核心架构决策回顾

### 1. 核心层与 Provider 层分离

```
diyui._scope.ScopeNode         ← 核心树节点，signal + cell rerun
diyui._base_app.BaseApp        ← 根节点，_context_stack
diyui.providers.panel.PanelApp ← Panel 语法糖，工厂函数
```

核心层不关心 UI 创作风格。`app.button()` 还是 `yield app.button()`，由 provider 层决定。

### 2. 三种 cell 形态

| 形态 | 函数类型 | 执行路径 | 用法 |
|------|---------|---------|------|
| 同步 cell | `def` | `_execute_cell` | 即时构建，纯同步 |
| 生成器 cell | `def` + `yield` | `_execute_cell_generator` → `_drive_generator_sync` | 长任务，step-by-step UI |
| 异步生成器 cell | `async def` + `yield` | `_execute_cell_generator` → `_drive_generator_async` | 配合数据库/网络 IO |

### 3. 不用 ContextVar

生成器 cell 的 `self` 就是 cell node。`fn(self)` 创建生成器时天然绑定，`_push_context(self)` 在整个驱动生命周期有效，不存在并发 current 漂移。没有引入隐式上下文。

### 4. Staging 模式已移除

`_execute_cell` 简化为：清空旧 children → 执行 fn 重建 → children 即时生效。`_add_child` 和 `_PanelContainerMixin._add_child` 不再有条件分支。

### 5. 测试作为文档

测试目录分为 5 层：`unit/`、`intent/`、`integration/`、`browser/`、`tools/`。

意图测试使用 tree snapshot + event log 双重断言——每个人都直接从测试代码理解系统行为，不需要读 md 文档。

## 经验教训

### 做得好的

1. **Phase 分步推进**，每个 Phase 独立可验证。新会话只需读进度表就知道当前状态。
2. **commit 粒度**，每个 Phase 一个 commit，message 引用 `ref: design/async-cell P{N}`
3. **_flush_deps_and_reset** 提取为共享方法，消除 `_execute_cell`、`_drive_generator_sync`、`_drive_generator_async` 中的重复逻辑
4. **auto_mount_child** 语义名比 `auto_mount` 更精确，表达的是"子组件自动挂载"
5. **BaseApp.signal() 委托** 走 `ScopeNode.signal(node, value)` 而非 `self._current.signal()`，避免无限递归——设计巧妙

### 可以改进的

1. **_upgrade_to_async 升级路径** 增加了复杂度。`_drive_generator_sync` 遇到 awaitable → 保存生成器状态 → `_upgrade_to_async` → `enqueue_async(resume)`。半路升级维护成本高。后续可简化为直接要求用户用 `async def` + `yield` 走 `_drive_generator_async`。
2. **EventLog 的 monkey-patch** 只 hook 了 `_execute_cell`，无法捕获 `_execute_cell` 内部 catch 的错误。需要 hook `DebugInfo.record_error` 才能完整记录。
3. **FakeApp 定义重复** 出现在 `test_cell.py`、`test_basic_construction.py`、`test_signal_rerun.py` 中。应统一到 `helpers.py`。
4. **`_has_awaitable_in_generator` 死代码** 在本次审查中被删除。AI 可能在重构时遗忘清理，值得注意。

### 后续方向

- **简化升级路径**：Phase 4 生成器 cell 直接要求 async def，去掉 `_upgrade_to_async`
- **FakeApp 统一**：移到 `tests/helpers.py`，各测试文件 import
- **EventLog 错误捕获**：hook `DebugInfo.record_error`
- **ContextVar 不再考虑**：确认不会引入
