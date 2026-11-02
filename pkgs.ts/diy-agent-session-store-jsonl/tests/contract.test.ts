// 契约测试（##506）：用例在 @diy-agent/store-contract/session 里，这里只声明「jsonl 是其中一个实现」。
// 与 memory 包的 contract.test.ts **跑的是同一批用例** —— 改了契约两边一起变。
// 本实现特有的行为（切桶 / 桶命名 / index 重建 / 缺桶报错）留在 intent.store.test.ts。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSessionStoreContract } from '@diy-agent/store-contract/session';
import { openJsonlSessionStore } from '../src/index.js';

defineSessionStoreContract('jsonl', async () =>
    openJsonlSessionStore({ dir: await mkdtemp(join(tmpdir(), 'diy-contract-jsonl-')) }),
);
