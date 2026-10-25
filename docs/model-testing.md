# 本地 agent 测试用什么模型

> 二次披露文档：`AGENTS.md::model.*` 只留一行结论，核对流程住这里。
> 代码真源：`pkgs.ts/diy-app/src/shared/model-default.ts`（`FREE_MODEL_CANDIDATES` / `FALLBACK_MODEL` / `FREE_MODEL_CHECKED_AT`）。
> **别在文档里抄名单** —— 名单必然分叉，读真源。

## 允许清单（三档）

1. 任何 id 带 **`free` 后缀**的模型（套餐内免费，cost 全 0）—— **优先**
2. `mimo-v2.5`（opencode-go，chat 面，$0.14 / $0.28 per 1M）
3. `deepseek-v4.1-flash`

其余一律不用（太贵）。确需验证某模型特有行为：先取得用户许可，且一次只跑一条用例。

`mimo-v2.6-flash` 自 2026-10-17 起**不作缺省** —— 上游不稳，实测返回 `[model_coming_soon]`。

## free 模型核对流程（名单上架/下架频繁，用前必做）

1. 列 `https://opencode.ai/zen/go/v1/models`，筛出 `free` 后缀项
2. **各实测一条**：真发必须带 `x-opencode-session` 头，否则 400 `MissingSessionID`；测法要覆盖**流式 + 工具**，二者齐备才算可用
3. 把可用清单连同**核对日期**写回 `model-default.ts`，供其他 agent 直接复用

## 其他真源

- 价目 / 上下文上限：`https://models.dev/api.json`（`opencode-go` 的 cost / limit）
- 思考档位只有 `none/low/medium/high`（上游 400 拒绝 `minimal` / `xhigh` / `max`）
- 模型不可用（`model_coming_soon` / 404 / 401·403 / 429）→ **停工 + 通知，不换模型硬试**；实验实例页顶出 bar 的判据见 `pkgs.ts/diy-app/src/shared/model-unavailable.ts`（上游 5xx 与超时不算，那是另一类问题）
