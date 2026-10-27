// src/index.ts
// @diy/persistence —— 本地 agent 的会话持久化边界（##432 刀 1）
//
// core（diy-app）只依赖这里导出的**窄接口**：
//   · 路径：`keyOf` / `sessionIdOf` / `sessionFilesToClear` / `llmLogRelPath`（core 的 local-paths 转出）
//   · 历史读：`resolveReplay` / `readOps` / `loadDegradedHistory`
//   · 写：`createOpsAppender`（写 ops）/ `appendTurnRecord` / `appendCompactionEntry`
//   · 边界：`readBoundary`（压缩边界 = 一次事件，不是每步的重新决策）
//
// 存储格式（ops 行、turns 行、turns.ref 的字节锚点）只在这里被理解 —— core 不知道
// 「turns 的一行指向 ops 的哪一行」，因此 ops 格式将来可以独立演进。

export { keyOf, sessionIdOf } from "./keys";
export {
    SESSION_KINDS,
    CLEARED_SESSION_KINDS,
    type SessionKind,
    localDir,
    sessionDir,
    sessionFile,
    sessionStateFile,
    legacySessionFile,
    resolveSessionFile,
    sessionFileForWrite,
    sessionFileCandidates,
    sessionFilesToClear,
    opsFile,
    turnsFile,
    compactFile,
    llmFile,
    llmLogRelPath,
    hasConversation,
} from "./paths";
export {
    fileSize,
    countFileLines,
    readOpsRange,
    readOpsFrom,
    findTurnOffset,
    isTurnStartAt,
} from "./ops-io";
export { seekTurnStartAtOrBefore, seekWindowStart, encodeCursor, decodeCursor, SEEK_CHUNK_BYTES } from "./seek";
export { writeLlmOffsets, readLlmOffsets, llmOffsetOf, maxLineBytesOf } from "./llm-offsets";
export {
    TURN_TEXT_MAX_BYTES,
    TURN_SCHEMA_CURRENT,
    type OpsRef,
    type OpsRefCheck,
    type OpsRefReason,
    type TurnEntry,
    type TurnRecord,
    type TurnRecordState,
    type TurnTextV1,
    type TurnDraft,
    type CompactionEntry,
    type CompactionEntryV2,
    type OpsAppender,
    type TurnOp,
    clipTurnText,
    appendTurnRecord,
    appendCompactionEntry,
    readTurnEntries,
    readTurnRecords,
    readBoundary,
    createOpsAppender,
    checkOpsRef,
    synthesizeTurnOps,
} from "./turns";
export {
    type ReplayInfo,
    type DegradedCause,
    type DegradedHistory,
    resolveReplay,
    loadDegradedHistory,
    readOps,
    readOpsWindow,
} from "./history";
