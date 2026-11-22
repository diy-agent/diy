---
desc: 提交前唯一检查入口
updated: 2026-11-22
---

## entry

`./sha.sh check` = 同步检查 → `tsc -b` 全仓 → oxlint → rpc 浏览器安全 → **一串护栏** → 规范索引。
护栏清单看 `sha.sh` 的 `_check_full_body()`（唯一真源，别在这里抄数字 —— 会漂）：

- 产物（源码旁不许有 .js/.d.ts）、可执行位、原子写
- `vi.mock` 禁令、异常码、包可见性、runtime 依赖闭包
- sync IO、OS 边界、renderer 边界、构建配置漂移
- 规范索引（`~/SPECS.md`）、facts 索引（`scripts/facts-index.mts`，yaml 库退役后空跑）

（见 sha.sh:_check_full_body）
