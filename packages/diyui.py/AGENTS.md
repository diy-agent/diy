# diyui.py 项目结构

## 项目定位
响应式 UI 框架薄封装层，支持 Panel 等 UI 框架的信号/作用域/Cell 响应式模型。

## 目录结构
```
diyui.py/
├── src/diyui/           # 源码
│   ├── _signal.py      # Signal[T] 可观察状态容器
│   ├── _scope.py       # ScopeNode 运行时树节点、Cell 依赖追踪
│   ├── _scheduler.py   # 调度器：ImmediateScheduler
│   ├── _debug.py       # 调试：错误捕获、rerun 计数
│   ├── _base_app.py    # BaseApp 基类，上下文栈管理
│   └── providers/      # UI 框架适配器
│       └── panel/      # Panel provider
├── tests/
│   ├── unit/           # 纯逻辑单元测试
│   ├── intent/         # 意图测试（tree snapshot + event log）
│   ├── integration/    # Provider 集成测试
│   ├── browser/        # Playwright 端到端测试
│   └── tools/          # 工具自身测试
├── examples/           # 示例
├── pyproject.toml      # 项目配置（uv + ruff）
└── sha.sh              # 开发脚本
```

## 核心概念
- **Signal**: 可观察单值状态，读写自动触发依赖更新
- **ScopeNode**: 树形作用域，管理 Signal 生命周期和 Cell
- **Cell**: 响应式函数（同步/生成器），依赖 Signal 变化自动 rerun
- **Generator Cell**: 生成器形式的 cell，yield 组件自动挂载
- **Async Cell**: cell 中 yield awaitable，异步驱动
- **auto_mount_child**: 控制 factory（app.xxx()）是否自动挂载子组件
- **BaseApp**: 根节点，提供 `app.signal()` 和上下文管理

## Commit 前检查清单
每次 commit 前必须执行：
1. `./sha.sh check` — ruff check + format check + pyright + test
2. 若改动涉及 browser 测试：`./sha.sh test-headless`
3. 自查 diff：`git diff --stat`，确保不夹带无关改动

## Panel 参数强类型化工具

`tools/doctor_panel.py` — Panel 诊断工具：适配列表 / 参数一致性 / 透传验证。
`tests/test_panel_param_coverage.py` — 参数一致性 + 透传验证 pytest 测试（5 个用例）。

```bash
./sha.sh panel list                  # 组件适配列表
./sha.sh panel list -g widgets        # 仅 widgets
./sha.sh panel doctor                 # 参数一致性诊断
./sha.sh panel verify                 # 参数透传运行时验证
./sha.sh panel query -n Button        # 查构造器签名
```

详见 `.agents/skills/panel-params/SKILL.md`。

## 常用命令
```bash
./sha.sh test [args]        # pytest（跳过 browser）
./sha.sh check              # ruff + format check + pyright + test
./sha.sh test-headless [args]  # 含 browser 测试
./sha.sh fix                # ruff 自动修复
./sha.sh panel              # 启动 Panel 示例
``` 
 
