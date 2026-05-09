# py-xxui 项目结构

## 项目定位
响应式 UI 框架薄封装层，支持 Panel 等 UI 框架的信号/作用域/Cell 响应式模型。

## 目录结构
```
py-xxui/
├── src/xxui/           # 源码
│   ├── signal.py       # Signal[T] 可观察状态容器
│   ├── scope.py        # ScopeNode 运行时树节点、Cell 依赖追踪
│   ├── scheduler.py    # 调度器：ImmediateScheduler / BatchScheduler
│   ├── debug.py        # 调试：错误捕获、rerun 计数
│   ├── base_app.py     # BaseApp 基类，上下文栈管理
│   └── providers/      # UI 框架适配器
│       └── panel.py    # Panel provider
├── tests/              # 测试（对应各模块）
├── examples/           # 示例
├── pyproject.toml      # 项目配置（uv + ruff）
└── sha.sh              # 开发脚本
```

## 核心概念
- **Signal**: 可观察单值状态，读写自动触发依赖更新
- **ScopeNode**: 树形作用域，管理 Signal 生命周期和 Cell
- **Cell**: 响应式函数，依赖 Signal 变化自动 rerun
- **BaseApp**: 根节点，提供 `app.signal()` 和上下文管理

## Commit 前检查清单
每次 commit 前必须执行：
1. `./sha.sh check` — ruff check + format check + pyright + test
2. 若改动涉及 browser 测试：`./sha.sh test-headless`
3. 自查 diff：`git diff --stat`，确保不夹带无关改动

## 常用命令
```bash
./sha.sh test [args]        # pytest（跳过 browser）
./sha.sh check              # ruff + format check + pyright + test
./sha.sh test-headless [args]  # 含 browser 测试
./sha.sh fix                # ruff 自动修复
./sha.sh panel              # 启动 Panel 示例
```