// 契约测试（##506）：用例在 @diy-agent/store-contract/session 里，这里只声明「memory 是其中一个实现」。
// 与 jsonl 包的 contract.test.ts **跑的是同一批用例** —— 改了契约两边一起变。
// 本实现特有的行为（maxEntries 上限 / clear() / 零落盘 / 与 session 缺省实现同一函数）留在 intent.store.test.ts。
import { defineSessionStoreContract } from '@diy-agent/store-contract/session';
import { openMemorySessionStore } from '../src/index.js';

defineSessionStoreContract('memory', () => openMemorySessionStore());
