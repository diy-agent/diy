// @diy-agent/model-catalog — 把 `$DIY_HOME/model.yaml` + `providers.custom.yaml`（+ models.dev
// 快照）读成一份**可选的模型目录**。
//
//   import { loadCatalog, listAccounts, readAccountValue } from '@diy-agent/model-catalog';
//
//   const entries = loadCatalog('/Users/me/.diy');        // 无 key 值，accounts 只有名字
//   const names = listAccounts('/Users/me/.diy');          // [{ providerId, kind, names }]
//   const key = readAccountValue('/Users/me/.diy', 'deepseek'); // 单独一条路径；别打印
//
// 边界（##465）：
//   · 不含 key 值（目录 / 账号列表都只有名字）
//   · 不 import `@diy-agent/llm-provider`（数据与行为分离）
//   · 不读环境变量做选择，只在展开 `$VAR` 时用（可用 `options.env` 注入）

export { CatalogError } from "./errors.js";
export type { CatalogErrorCode } from "./errors.js";

export { loadCatalog, listAccounts, readAccountValue } from "./catalog.js";
export type { CatalogOptions, ModelCatalogCost, ModelCatalogEntry, ProviderAccounts } from "./types.js";
