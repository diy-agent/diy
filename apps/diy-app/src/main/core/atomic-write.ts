// apps/diy-app/src/main/core/atomic-write.ts
// 实现已迁到 `@diy-agent/tools`（##514 工具层抽包）：这里只做 re-export，**别在本文件加逻辑**。
// 保留这层是因为仓里有几十处 `../core/atomic-write` 的相对 import（任务写入 / 草稿 / 实例登记…），
// 一次性全改路径只会让 diff 更大、回归面更宽；shim 与包内是**同一份模块实例**（被 vitest alias
// 与 runtime 都解析到同一文件），所以全局钩子 `setWriteErrorHook` 仍然只有一份。
export * from "@diy-agent/tools/atomic-write";
