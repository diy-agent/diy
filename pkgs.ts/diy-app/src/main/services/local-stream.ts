// src/main/services/local-stream.ts
// 🎯 core 侧对「op 流」能力的**唯一转出口**（##432 刀 1）。
//
// 为什么要有这个文件：`local-agent.ts` 要按字节窗口读 op 流、签发/校验游标、广播增量 ——
// 但它不该知道这些能力背后的**存储形态**（行首约定 / 轮首前缀 / 文件路径）。
// 于是：实现在 `@diy/persistence`，广播在 `ops-feed`，core 只从这里取。

export { feed } from "./ops-feed";
export {
    decodeCursor,
    encodeCursor,
    isTurnStartAt,
    seekTurnStartAtOrBefore,
    seekWindowStart,
    SEEK_CHUNK_BYTES,
} from "@diy/persistence";
