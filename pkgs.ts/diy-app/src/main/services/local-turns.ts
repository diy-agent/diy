// src/main/services/local-turns.ts
// 🎯 core 侧转出：turns.jsonl / ops 写入的实现全在 `@diy/persistence`（##432 刀 1）。
//
// 为什么搬走：`turns` 的 `ref` 是 **ops 行号的锚点**（`{offset,len,seq}`）—— 「一行 turns 指向
// ops 的哪一字节」是存储知识，core 不该知道。于是写 ops 与写 turns 都在包里同一处，
// core 只拿到「追加了一条 op」与「落了一条轮次记录」两个动作。

import { diyHome } from "../core/state";
import {
    TURN_SCHEMA_CURRENT,
    TURN_TEXT_MAX_BYTES,
    appendTurnRecord as appendTurnRecordAt,
    checkOpsRef as checkOpsRefAt,
    clipTurnText as clipTurnTextAt,
    readTurnRecords as readTurnRecordsAt,
    synthesizeTurnOps as synthesizeTurnOpsAt,
    type OpsRef,
    type OpsRefCheck,
    type OpsRefReason,
    type TurnDraft,
    type TurnOp,
    type TurnRecord,
    type TurnRecordState,
    type TurnTextV1,
    type TurnEntry,
    type CompactionEntry,
    readTurnEntries as readTurnEntriesAt,
    readBoundary as readBoundaryAt,
    appendCompactionEntry as appendCompactionEntryAt,
} from "@diy/persistence";

export { TURN_SCHEMA_CURRENT, TURN_TEXT_MAX_BYTES };
export type { OpsRef, OpsRefCheck, OpsRefReason, TurnEntry, TurnRecord, TurnRecordState, TurnTextV1, TurnDraft, TurnOp, CompactionEntry };

/** 旧名（v1）—— 现在就是 `TurnRecord` */
export type TurnRecordV1 = TurnRecord;

/** 截断一段正文（不切在多字节字符中间） */
export const clipTurnText = clipTurnTextAt;

/** 追加一条轮次记录（旁路；写失败只 warn） */
export function appendTurnRecord(taskUri: string, draft: TurnDraft | TurnRecord): boolean {
    return appendTurnRecordAt(diyHome(), taskUri, draft);
}

/** 追加一条压缩边界（##432 刀 2） */
export function appendCompactionEntry(taskUri: string, entry: Omit<CompactionEntry, "v" | "kind">): boolean {
    return appendCompactionEntryAt(diyHome(), taskUri, entry);
}

/** 当前生效的压缩边界（turns 里最后一条 compaction entry） */
export function readBoundary(taskUri: string): CompactionEntry | null {
    return readBoundaryAt(diyHome(), taskUri);
}

/** 读全量 turns 行（降级 / 边界路径专用） */
export function readTurnEntries(taskUri: string): TurnEntry[] {
    return readTurnEntriesAt(diyHome(), taskUri);
}

/** 读轮次记录（降级重建用） */
export function readTurnRecords(taskUri: string): TurnRecord[] {
    return readTurnRecordsAt(diyHome(), taskUri);
}

/** 校验一条记录的 ops 锚点（三种悬空） */
export function checkOpsRef(taskUri: string, ref: OpsRef | TurnRecord): OpsRefCheck {
    return checkOpsRefAt(diyHome(), taskUri, ref);
}

/** 折成只读文本历史（ops 形态） */
export const synthesizeTurnOps = synthesizeTurnOpsAt;
