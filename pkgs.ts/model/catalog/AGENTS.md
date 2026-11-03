# @diy-agent/model-catalog — 模型目录（只读配置，不含 key）

> 全仓契约见仓库根 `AGENTS.md`。需求真源是 ##465 body。

## 两条最容易破的约束

1. **目录里不许有 key 值**：`loadCatalog` / `listAccounts` 只输出账号名；取 key 只走
   `readAccountValue(home, providerId, accountName?)`，调用方负责不打印、不落日志。
2. **不 import `@diy-agent/llm-provider`**：目录是数据，provider 是行为。

## 数据流

`$DIY_HOME/model.yaml`（accounts / filter / models 覆盖）
⊕ `providers.custom.yaml`（custom provider 的 spec）
⊕ models.dev 快照（std provider 的 spec，可选：`<home>/data/models.dev.json` → 本仓 diy-app 内置产物）
→ `ModelCatalogEntry[]`（provider×model，含 baseURL / npm / contextWindow / cost）。

## 取法

- `diy facts brief rule` — 全局硬约束
