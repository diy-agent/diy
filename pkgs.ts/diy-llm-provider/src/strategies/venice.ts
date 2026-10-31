// strategies/venice.ts — venice 占位（##491，**故意什么都不做**）
//
// 事实：opencode 侧源码的 `packages/ai/src/protocols/venice-chat.ts` 里也有 `prompt_cache_retention`。
// 但我们**没在 venice 上实测过**（字段名 / 取值 / 会不会 400 都不知道）。
// ##486 定下的原则：**未验证的字段不发** —— 省下的钱不值得换一次 400。
//
// 所以这里只占位：不认领任何端点、不做任何变换（行为 == passthrough）。
// 将来实测通过了再填 `matches`（按 host）与 `transformBody`，其余一行不用改。
//
// 为什么不留空文件：注册表要能读到它（`index.ts` 里已经登记），否则「加新 provider 只需新增文件 +
// 注册一行」这条判据就没有第二个实例可对照。

import type { ProviderStrategy } from './types.js';

export const veniceStrategy: ProviderStrategy = {
    name: 'venice',
    // 端点 host 与字段都未实测 —— **先不认领**：认领了却不加东西，只会让人误以为已经支持
    matches: () => false,
};
