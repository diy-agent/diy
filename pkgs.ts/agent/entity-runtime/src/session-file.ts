// session-file.ts —— 会话快照的**正文**（entries）落在库外。
//
// 为什么要搬出去（2026-11-28）：`session_state.entries` 是一整坨 JSON，一个 bot 每次保存快照
// 都是「整 blob 重写」，而且历史回放 / 备份 / VACUUM 都要碰它。真库实测 46 行 9.7 MB，
// 最大一份 808 KB —— 相对 `entity_items` 不算大，但它是**每步都在写**的那张表。
//
// 库里只留「元数据」（turn / collapsed / usage / log_seq / updated_at），正文按
// `<数据根>/sessions/<roomId>__<botId>.json` 落盘。两条判据（不要发明第三条）：
//   · 表里 `entries` 非空   ⇒ 老数据 / 写盘失败的回退，直接用它；
//   · 表里 `entries` 是空串 ⇒ 正文在文件里，读文件。
//
// 写盘失败**不假装成功**：调用方退回把正文写进表（db.ts 的 saveSession），宁可库大一点也不能丢上下文。

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { TranscriptEntry } from './compaction';

/** 文件名里只留 `[A-Za-z0-9_.-]`（房间 id / bot id 里的 `:` `\u0000` 之类一律归一） */
function safeName(value: string): string {
    return value.replace(/[^\w.-]+/g, '_');
}

/** 正文路径：`<数据根>/sessions/<roomId>__<botId>.json` */
export function sessionFilePath(dataRoot: string, roomId: string, botId: string): string {
    return join(dataRoot, 'sessions', `${safeName(roomId)}__${safeName(botId)}.json`);
}

/**
 * 原子写：先写 `.tmp` 再 rename。
 * 读侧（重启回放）永远看到完整的一份 —— 绝不能读到写了一半的 JSON。
 */
export function writeSessionEntries(file: string, entries: readonly TranscriptEntry[]): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(entries), 'utf8');
        renameSync(tmp, file);
    } catch (error) {
        // 半成品 tmp 留着只会占地方，清掉再抛给调用方去回退
        try {
            unlinkSync(tmp);
        } catch {
            /* 本来就没写出来 */
        }
        throw error;
    }
}

/** 读正文；不存在 / 坏 JSON ⇒ undefined（调用方当作「没有快照」，走全量回放） */
export function readSessionEntries(file: string): TranscriptEntry[] | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? (parsed as TranscriptEntry[]) : undefined;
    } catch {
        return undefined;
    }
}
