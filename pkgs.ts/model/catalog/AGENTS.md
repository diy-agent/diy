# @diy-agent/model-catalog — 模型目录（只读配置，不含 key）

> 全仓契约见仓库根 `AGENTS.md`。需求真源是 ##465 body。

## 两条最容易破的约束

1. **目录里不许有 key 值**：`loadCatalog` / `listAccounts` 只输出账号名；取 key 只走
   `readAccountValue(home, providerId, accountName?)`，调用方负责不打印、不落日志。
2. **不 import `@diy-agent/llm-provider`**：目录是数据，provider 是行为。

## 数据流

`$DIY_HOME/model.yaml`（accounts / filter / models 覆盖）
⊕ models.dev 快照（std provider 的 spec，可选：`<home>/data/models.dev.json` → 本仓 diy-app 内置产物）
→ `ModelCatalogEntry[]`（provider×model，含 baseURL / npm / contextWindow / cost）。

`providers.custom.yaml`（自定义 provider spec）**已废弃**（2026-11-28）：模型价格唯一来源是
models.dev 的**谷价**；峰时段翻倍是模型策略（`src/strategies/models/deepseek/pricing.ts`），
不要再把峰价 / tiers 抄进配置文件。

## 取法

- `diy facts brief rule` — 全局硬约束
