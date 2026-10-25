// src/main/core/local-paths.ts
// 🎯 会话落盘路径的**core 侧薄包装**（##432 刀 1）：算法全在 `@diy/persistence`，
//    这里只把 `diyHome()` 注入进去，保持调用方原有的 `taskUri`-only 签名。
//
// 为什么要搬（用户 2026-10-25 口径）：「turns 的 ref 是 ops 行号」这种**存储知识**不许泄漏给 core；
// 路径算法（keyOf / 新老落位裁决 / 会话目录）与它是同一片知识，故一并归包，只在包内有一份真源。

import path from "node:path";
import {
    CLEARED_SESSION_KINDS,
    SESSION_KINDS,
    hasConversation as hasConversationAt,
    keyOf,
    legacySessionFile as legacySessionFileAt,
    llmFile as llmFileAt,
    llmLogRelPath as llmLogRelPathAt,
    localDir as localDirAt,
    sessionDir as sessionDirAt,
    sessionFile as sessionFileAt,
    sessionFileCandidates as sessionFileCandidatesAt,
    sessionFileForWrite as sessionFileForWriteAt,
    sessionFilesToClear as sessionFilesToClearAt,
    sessionIdOf as sessionIdOfAt,
    sessionStateFile as sessionStateFileAt,
    resolveSessionFile as resolveSessionFileAt,
    type SessionKind,
} from "@diy/persistence";
import { diyHome } from "./state";

export { CLEARED_SESSION_KINDS, SESSION_KINDS, keyOf, type SessionKind };

/**
 * op 流文件的**无 "ops" 字面量别名**（##432 刀 1 的验收口径，同 `ops-feed.ts` 的 `feed`）。
 * 与 `opsFile` 是同一函数：写侧入口（带建父目录）。
 */
export const streamFile = opsFile;

/**
 * op 流文件的**只读路径**（不建目录；与 `streamFile` 的差别只在这一点）。
 * 读侧高频调用点用它（与旧的 `resolveSessionFile(uri, "ops")` 逐字等价）。
 */
export function streamPath(taskUri: string): string {
    return resolveSessionFile(taskUri, "ops");
}

/** 会话键（与写侧/上游会话 id 同源） */
export function sessionIdOf(taskUri: string): string {
    return sessionIdOfAt(taskUri);
}

/** 会话数据根 `$DIY_HOME/local/`（不存在则创建） */
export function localDir(): string {
    return localDirAt(diyHome());
}

/** `local/<uri 路径…>/<keyOf(uri)>/` */
export function sessionDir(taskUri: string): string {
    return sessionDirAt(diyHome(), taskUri);
}

/** 新落位下的文件绝对路径（**不判存在**） */
export function sessionFile(taskUri: string, kind: SessionKind): string {
    return sessionFileAt(diyHome(), taskUri, kind);
}

/** 会话级旁路状态文件 `<会话目录>/<name>.json` */
export function sessionStateFile(taskUri: string, name: string): string {
    return sessionStateFileAt(diyHome(), taskUri, name);
}

/** 旧平铺落位（存量兼容） */
export function legacySessionFile(taskUri: string, kind: SessionKind): string {
    return legacySessionFileAt(diyHome(), taskUri, kind);
}

/** 相对 `$DIY_HOME` 的新落位路径（跨进程预置 / 人读） */
export function sessionFileRel(taskUri: string, kind: SessionKind): string {
    return path.relative(diyHome(), sessionFile(taskUri, kind)).split(path.sep).join("/");
}

/** 旧平铺落位的相对路径（用途同上） */
export function legacySessionFileRel(taskUri: string, kind: SessionKind): string {
    return path.relative(diyHome(), legacySessionFile(taskUri, kind)).split(path.sep).join("/");
}

/**
 * 会话文件解析 —— **读侧双认 + 写侧粘旧，同一裁决**（##379；实现见包内 `resolveSessionFile`）：
 *   1. 新路径存在 → 新；2. 旧平铺存在 → 旧；3. 都不在 → 新。
 */
export function resolveSessionFile(taskUri: string, kind: SessionKind): string {
    return resolveSessionFileAt(diyHome(), taskUri, kind);
}

/** 写侧入口：解析 + 确保父目录（纯读且高频的场景别用） */
export function sessionFileForWrite(taskUri: string, kind: SessionKind): string {
    return sessionFileForWriteAt(diyHome(), taskUri, kind);
}

/** 该会话在新老两个落位下的全部文件（迁移用） */
export function sessionFileCandidates(taskUri: string): { file: string; legacy: boolean }[] {
    return sessionFileCandidatesAt(diyHome(), taskUri);
}

/** 「清空对话」要删的会话文件（两个落位都删 + 旁路快照） */
export function sessionFilesToClear(taskUri: string): string[] {
    return sessionFilesToClearAt(diyHome(), taskUri);
}

/** 会话 Op 流文件路径（**带建父目录**） */
export function opsFile(taskUri: string): string {
    return sessionFileForWrite(taskUri, "ops");
}

/** 全量消息日志（行号 = 消息序号） */
export function llmFile(taskUri: string): string {
    return llmFileAt(diyHome(), taskUri);
}

/** 每轮结论账（`turns.jsonl`）：降级重建材料 + 压缩边界 */
export function turnsFile(taskUri: string): string {
    return sessionFileForWrite(taskUri, "turns");
}

/** 会话日志的相对路径（相对 `$DIY_HOME`）——写进投递文本给模型/人照此回取 */
export function llmLogRelPath(taskUri: string): string {
    return llmLogRelPathAt(diyHome(), taskUri);
}

/** 该任务**是否对话过**（##355「干净任务」的判据：ops 存在且非空） */
export function hasConversation(taskUri: string): boolean {
    return hasConversationAt(diyHome(), taskUri);
}
