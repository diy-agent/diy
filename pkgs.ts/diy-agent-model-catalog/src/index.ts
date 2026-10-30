// @diy-agent/model-catalog — 把 `$DIY_HOME/model.yaml` + `providers.custom.yaml`（+ models.dev
// 快照）读成一份**可选的模型目录**。
//
//   import { loadCatalog, listAccounts, readAccountValue } from '@diy-agent/model-catalog';
//
//   const entries = loadCatalog('/Users/me/.diy');        // 无 key 值，accounts 只有名字
//   const names = listAccounts('/Users/me/.diy');          // [{ providerId, kind, names }]
//   const key = readAccountValue('/Users/me/.diy', 'deepseek'); // 单独一条路径；别打印
//
// ##467 写侧（配置页用；与读侧同一份文件口径）：
//   saveProvider(home, { providerId, spec, models })     // spec → providers.custom.yaml，models → model.yaml
//   saveAccount(home, { providerId, name, value })       // 返回 { chars }，**永不回 token 原值**
//   removeProvider(home, providerId)
//   readDefaultModel(home) / saveDefaultModel(home, key) // model.yaml 顶层 defaultModel
//
// 边界（##465）：
//   · 不含 key 值（目录 / 账号列表都只有名字）
//   · 不 import `@diy-agent/llm-provider`（数据与行为分离）
//   · 不读环境变量做选择，只在展开 `$VAR` 时用（可用 `options.env` 注入）

export { CatalogError } from "./errors.js";
export type { CatalogErrorCode } from "./errors.js";

export {
    listAccountStates,
    listAccounts,
    listProviders,
    loadCatalog,
    readAccountValue,
} from "./catalog.js";
export {
    readDefaultModel,
    removeProvider,
    saveAccount,
    saveDefaultModel,
    saveProvider,
} from "./write.js";
export type { AccountState, ProviderAccountStates, ProviderSummary } from "./catalog.js";
export type { ProviderModelPatch, SaveAccountInput, SaveProviderInput, SavedAccount } from "./write.js";
export type { CatalogOptions, ModelCatalogCost, ModelCatalogEntry, ProviderAccounts } from "./types.js";
