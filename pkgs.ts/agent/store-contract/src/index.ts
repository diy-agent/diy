// @diy-agent/store-contract — 存储适配器的**契约测试**：一份用例，所有实现跑同一批（##506）
//
// 这个包**没有生产代码**，只有测试工具：`defineSessionStoreContract` / `defineBotStoreContract`。
// 每个实现包在自己的 tests/ 里调一次即可（一行），于是「同一接口的两个实现行为是否一致」
// 由测试自动暴露，不再靠人肉比对两份 intent 测试。
//
//   import { defineSessionStoreContract } from '@diy-agent/store-contract/session';
//   import { defineBotStoreContract } from '@diy-agent/store-contract/bot';
//
// 子路径分别引：session 契约不该把 @diy-agent/bot 拉进 jsonl store 的测试进程。
// 主入口只是方便一次全取（自测 / 调试用）。

export { defineSessionStoreContract } from './session.js';
export { defineBotStoreContract } from './bot.js';
