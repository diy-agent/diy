// src/main/services/local-ops-seek.ts
// 🎯 core 侧转出：seek / 游标的实现在 `@diy/persistence`（##432 刀 1）。
//
// 为什么搬走：这一层按**字节偏移**在 ops 文件里回溯轮首 —— 它理解 ops 的行首约定，
// 属于存储知识；core 只需要「给我窗口起点」这个能力。

export {
    seekTurnStartAtOrBefore,
    seekWindowStart,
    encodeCursor,
    decodeCursor,
    isTurnStartAt,
    SEEK_CHUNK_BYTES,
} from "@diy/persistence";
