# pkgs/diy-llm-gui

diy-llm 的 PySide6 系统托盘管理程序。

## 结构

```
src/diy_llm_gui/
├── app.py          # QSystemTrayIcon + 菜单：模型列表、Sync、Serve 开关
└── async_utils.py  # QtAsyncio 集成：init_async / run_async / start_event_loop
```

## 入口

```bash
diy-llm-gui              # 入口点（推荐）
python -m diy_llm_gui.app  # 模块方式
```

注意：不要直接 `python src/diy_llm_gui/app.py`（relative import 会失败）。

## 依赖

- diy-llm（workspace）
- pyside6>=6.8

## 相关 Issue

- [#119](https://github.com/diy-agent/diy/issues/119) diy-llm 整体重设计
- [#120](https://github.com/diy-agent/diy/issues/120) GUI MVP
