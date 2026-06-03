# diy-ui — 响应式 UI 框架

## 核心概念

- **Signal**: 可观察单值状态，读写自动触发依赖更新
- **ScopeNode**: 树形作用域，管理 Signal 生命周期和 Cell
- **Cell**: 响应式函数（同步/生成器），依赖 Signal 变化自动 rerun
- **Generator Cell**: 生成器形式的 cell，yield 组件自动挂载
- **Async Cell**: cell 中 yield awaitable，异步驱动
- **auto_mount_child**: 控制 factory（app.xxx()）是否自动挂载子组件
- **BaseApp**: 根节点，提供 `app.signal()` 和上下文管理

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

## Panel 参数诊断工具

`tools/doctor_panel.py` — Panel 诊断工具：适配列表 / 参数一致性 / 透传验证。
`tests/test_panel_param_coverage.py` — 参数一致性 + 透传验证 pytest 测试。

```bash
./sha.sh panel list                  # 组件适配列表
./sha.sh panel list -g widgets       # 仅 widgets
./sha.sh panel doctor                # 参数一致性诊断
./sha.sh panel verify                # 参数透传运行时验证
./sha.sh panel query -n Button       # 查构造器签名
```

详见 `.agents/skills/panel-params/SKILL.md`。
