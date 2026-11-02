# @diy-agent/store-contract — 存储适配器的契约测试（##506）

**只有测试工具，没有生产代码。** 一份用例，所有实现跑同一批 —— 行为不一致由测试自动暴露，
而不是靠人肉比对两份几百行的 intent 测试。

## 怎么用

实现包在自己 `tests/` 里加一个几行的文件：

```ts
// pkgs.ts/diy-agent-session-store-jsonl/tests/contract.test.ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSessionStoreContract } from '@diy-agent/store-contract/session';
import { openJsonlSessionStore } from '../src/index.js';

defineSessionStoreContract('jsonl', async () =>
    openJsonlSessionStore({ dir: await mkdtemp(join(tmpdir(), 'diy-contract-')) }),
);
```

```ts
// pkgs.ts/diy-agent-bot/tests/store-contract.test.ts
import { defineBotStoreContract } from '@diy-agent/store-contract/bot';
import { createFileBotStore, createMemoryBotStore } from '../src/index.js';

defineBotStoreContract('fs', async () => createFileBotStore({ home: await mkdtemp(join(tmpdir(), 'diy-bot-')) }));
defineBotStoreContract('memory', () => createMemoryBotStore());
```

- `makeStore()` 每调用一次必须返回**全新的空 store**（用例之间不共享状态）
- 新增一个实现 ⇒ 加一行调用，不用重写用例

## 什么进契约，什么不进

| 进契约（接口语义）                         | 不进契约（本实现的承诺）                              |
| ------------------------------------------ | ----------------------------------------------------- |
| 空 store 的初值 / 越界不返回               | jsonl：按大小切桶、桶命名、index 重建                 |
| append 的 seq 判据（缺 seq / 断号 / 重号） | memory：`maxEntries` 上限、`clear()`                  |
| 半批不写（先全量校验再写）                 | memory：零落盘（不 import `node:*`）                  |
| readRange 的 at 闭区间与排序               | store-fs：`persona` 旧字段读兼容、`needsModel` 不落盘 |
| 删 bot 不丢会话归属                        | store-fs：坏 JSON 读成 null                           |

判据：**这条行为是「接口的语义」还是「本实现的取舍」？** 前者进契约，后者留在各包的 `intent.*.test.ts`。

## 怎么验它真的共享（##506 判据 4）

改坏任一实现（比如让 memory store 的 `readFrom` 返回倒序），**两个包的契约测试都该红**；
两边同时红才证明是同一批用例，否则只是两份长得像的测试。
