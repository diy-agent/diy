# diy-ui — 响应式 UI 框架

## 核心概念

- **Signal**: 可观察单值状态，读写自动触发依赖更新
- **ScopeProxy** (Phase 3a+): 自持所有 scope tree 状态，通过 `obj.diy` 挂载到任意对象
- **ScopeNode**: 薄兼容壳，全委托给 `self.diy`（Phase 3a 后）
- **Cell**: 响应式函数（同步/生成器），依赖 Signal 变化自动 rerun
- **Generator Cell**: 生成器形式的 cell，yield 组件自动挂载
- **Async Cell**: cell 中 yield awaitable，异步驱动
- **auto_mount_child**: 控制 factory（app.xxx()）是否自动挂载子组件
- **BaseApp**: 根节点，继承 ScopeNode，提供 `app.signal()` 和上下文管理

## 架构：ScopeProxy 组合模式（Phase 3a 完成）

```
任意对象 (Panel widget / ScopeNode / app)
  └── .diy → ScopeProxy 实例
               ├── 自持所有 tree/signal/cell 状态 (~310 行)
               ├── _host → 宿主对象引用
               ├── signal / init_done / panel_container (原 _DiyData slots)
               ├── _parent / _children_v / _ancestor_ids (tree)
               ├── _config_v / _lookup_mode / _lookup_scheduler (config)
               └── _execute_cell / create_signal / cell (cell/signal)
```

**关键变更**：
- `isinstance(node, ScopeNode)` → `hasattr(node, 'diy')`（鸭子类型）
- `self._add_child(child)` → `self.diy._add_child(child.diy)`
- `app._current` → 返回 `ScopeProxy`（context stack 存 ScopeProxy）
- `_ancestor_ids` 存储 `id(host)`（统一用 host id）
- `sig.owner` 是 `ScopeProxy`（`sig.owner._host` 取宿主）

## 待做

- **Mixin 化 value getter/setter**: 50 wrapper 文件的值 getter/setter 全相同模板，可抽到 `_HasValue` mixin
- **动态类消除文件**: `type('Checkbox', (_HasValue, pn.widgets.Checkbox), {...})` 替代 50 个 `_*.py`
- **Phase 3b/3c**: 删除 ScopeNode 薄壳（非紧急，零成本）

## 特有命令

```bash
./sha.sh test [args]           # pytest（跳过 browser）
./sha.sh test-headless [args]  # 含 Playwright browser 测试
./sha.sh check                 # ruff + format check + pyright + test
./sha.sh fix                   # ruff 自动修复
./sha.sh panel                 # 启动 Panel 示例
```

## Commit 前检查清单

1. `./sha.sh check`
2. 若改动涉及 browser 测试：`./sha.sh test-headless`
3. 自查 diff：`git diff --stat`，确保不夹带无关改动

## 测试基线

- 全量: 26 fail / 145 pass（26 个全是 pre-existing: Button + param coverage + panel native）
- Unit + intent: 108 passed ✅
- 关键文件: `_scope.py` (420 行), `_base_app.py` (73 行)

## Panel 参数诊断工具

```bash
./sha.sh panel list                  # 组件适配列表
./sha.sh panel doctor                # 参数一致性诊断
./sha.sh panel verify                # 参数透传运行时验证
```
