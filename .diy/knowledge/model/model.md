---
desc: 本地 agent 测试用什么模型
updated: 2026-10-21
---

## allowed

测试只准三类：**带 `free` 后缀**（优先）· `mimo-v2.5` · `deepseek-v4.1-flash`；其余太贵不用。确需验某模型特有行为：先取得用户许可，一次一条用例

## default

缺省先挑 free 可用项，都不可用退 `mimo-v2.5`；`mimo-v2.6-flash` 自 2026-10-17 起**不作缺省**（上游 `[model_coming_soon]`）

## free

free 模型上架/下架频繁，用前必须列 `https://opencode.ai/zen/go/v1/models` 筛 `free` + 各实测一条（**流式 + 工具**齐备才算可用）→ 写回真源并标核对日期

## reasoning

档位只有 `none/low/medium/high`（上游 400 拒绝 `minimal`/`xhigh`/`max`）

## truth

价目真源 `https://models.dev/api.json`（`opencode-go` 的 cost/limit）
