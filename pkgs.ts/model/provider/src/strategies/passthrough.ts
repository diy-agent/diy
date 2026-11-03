// strategies/passthrough.ts — 默认策略：**什么都不加**
//
// 这是安全默认值（##486 定下的原则）：不认识的端点不补任何字段 / header。
// 注册表把它放在最后当兜底，`strategyFor` 一个都没命中时也直接返回它。

import type { ProviderStrategy } from './types.js';

export const passthroughStrategy: ProviderStrategy = {
    name: 'passthrough',
    // 兜底策略：认领一切。放在注册表末尾 ⇒ 前面的策略先匹配，永远轮不到它给已认领的端点兜底
    matches: () => true,
};
