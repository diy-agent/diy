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
    type CompactionEntryV2,
    readTurnEntries as readTurnEntriesAt,
    readBoundary as readBoundaryAt,
    appendCompactionEntry as appendCompactionEntryAt,
} from "@diy/persistence";

export { TURN_SCHEMA_CURRENT, TURN_TEXT_MAX_BYTES };
export type { OpsRef, OpsRefCheck, OpsRefReason, TurnEntry, TurnRecord, TurnRecordState, TurnTextV1, TurnDraft, TurnOp, CompactionEntry, CompactionEntryV2 };

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
/** 当前生效的压缩边界。**v2 老记录也会返回**（读侧按老语义解释：limitTokens 当保留量、headLine 当保头） */
export function readBoundary(taskUri: string): CompactionEntry | CompactionEntryV2 | null {
    return readBoundaryAt(diyHome(), taskUri);
}

/**
 * 本会话**一共写过几条压缩事件**（turns 里的 compaction entry 计数）—— ##423「压缩次数」的真源。
 * 不是 `compact.jsonl` 的条数：那份自 ##431 起是**纯审计日志**（只有手动 / mode=auto 才写），
 * 而投递切点来自这里。两个数在界面上要分开叫，别混成一个。
 */
export function countCompactions(taskUri: string): number {
    let n = 0;
    // `TurnEntry` = 轮记录 ∪ 压缩边界：判别靠 `kind` 字段（轮记录没有 kind）
    for (const e of readTurnEntriesAt(diyHome(), taskUri)) if ((e as CompactionEntry).kind === "compaction") n++;
    return n;
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
