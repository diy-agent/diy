// src/paths.ts
// 🎯 会话落盘的**路径算法**（唯一真源；home 由调用方注入 —— 包不认识 `diyHome()`）。
//
// 落位（##379）：一个会话一个目录
//   `<home>/local/projects/4/tasks/266-07a945e1d52d/ops.jsonl | llm.jsonl | turns.jsonl | …`
//   · 目录名 = `keyOf(uri)`（唯一性算法见 keys.ts）；
//   · 父路径 = uri 的路径部分；文件名 = `<kind>.jsonl`。
//   旧落位（平铺 `<home>/local/<key>.<kind>.jsonl`）读侧双认、写侧粘旧（见 `resolveSessionFile`）。
//
// 本模块只做路径计算与目录创建，不含任何会话逻辑。

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { keyOf } from "./keys.js";

/** 会话子文件种类（**唯一清单**：双认 / 迁移 / clear 都按它走） */
export const SESSION_KINDS = ["ops", "llm", "usage", "steps", "compact", "changelog", "raw", "turns"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** 会话数据根 `<home>/local/`（不存在则创建） */
export function localDir(home: string): string {
    const d = path.join(home, "local");
    mkdirSync(d, { recursive: true });
    return d;
}

/**
 * uri → 目录段（`projects/4/tasks/379` → 同名三段）。
 * 过滤空段与 `.`/`..`：路径段只用来分层展示，**唯一性仍由 keyOf 保证**。
 */
function uriSegments(taskUri: string): string[] {
    return taskUri.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..");
}

/** 新落位（##379）：`local/<uri 路径…>/<keyOf(uri)>/` */
export function sessionDir(home: string, taskUri: string): string {
    return path.join(localDir(home), ...uriSegments(taskUri), keyOf(taskUri));
}

/** 新落位下的文件绝对路径（**不判存在**；写侧目标） */
export function sessionFile(home: string, taskUri: string, kind: SessionKind): string {
    return path.join(sessionDir(home, taskUri), `${kind}.jsonl`);
}

/** 会话级**旁路状态文件**：`<会话目录>/<name>.json`（当前值快照，不是 append-only 流水） */
export function sessionStateFile(home: string, taskUri: string, name: string): string {
    return path.join(sessionDir(home, taskUri), `${name}.json`);
}

/** 旧平铺落位（##379 之前；存量兼容用） */
export function legacySessionFile(home: string, taskUri: string, kind: SessionKind): string {
    return path.join(localDir(home), `${keyOf(taskUri)}.${kind}.jsonl`);
}

/**
 * 会话文件解析 —— **读侧双认 + 写侧粘旧，同一裁决**（##379）：
 *   1. 新路径存在 → 新；2. 旧平铺存在 → 旧（存量会话继续追加）；3. 都不在 → 新。
 * ⚠️ 三条缺一不可：只有「新优先」会让存量会话的下一次 append 写到新文件 = 历史静默腰斩。
 */
export function resolveSessionFile(home: string, taskUri: string, kind: SessionKind): string {
    const next = sessionFile(home, taskUri, kind);
    if (existsSync(next)) return next;
    const legacy = legacySessionFile(home, taskUri, kind);
    if (existsSync(legacy)) return legacy;
    return next;
}

/** 写侧入口：解析 + **确保父目录**（纯读且高频的场景用 `resolveSessionFile`，别撒空目录） */
export function sessionFileForWrite(home: string, taskUri: string, kind: SessionKind): string {
    const file = resolveSessionFile(home, taskUri, kind);
    mkdirSync(path.dirname(file), { recursive: true });
    return file;
}

/** 本地根 `local/` 的路径（**不带建目录**；给纯读判据用，别用 `localDir`） */
function localDirPath(home: string): string {
    return path.join(home, "local");
}

/**
 * 该会话在两个落位下**是否留下过任何痕迹**（任何 kind 的文件 / 会话目录里的任何东西）。
 *
 * 用途（##444）：降级横幅要区分「从未跑过轮次」与「跑过但明细没了」—— 判据就是这条。
 * ⚠️ **纯读**：不建目录（同 `hasConversation` 的取向）。把这里换成 `localDir` /
 * `sessionDir` / `sessionFileForWrite` 会重新制造「看一眼就多一个空会话目录」的垃圾。
 */
export function hasAnySessionData(home: string, taskUri: string): boolean {
    const root = localDirPath(home);
    const key = keyOf(taskUri);
    for (const kind of SESSION_KINDS) {
        if (existsSync(path.join(root, `${key}.${kind}.jsonl`))) return true;
    }
    const dir = path.join(root, ...uriSegments(taskUri), key);
    try {
        return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

/** 该会话在**新老两个落位**下的全部文件（迁移用） */
export function sessionFileCandidates(home: string, taskUri: string): { file: string; legacy: boolean }[] {
    const seen = new Map<string, boolean>();
    for (const kind of SESSION_KINDS) {
        const next = sessionFile(home, taskUri, kind);
        const old = legacySessionFile(home, taskUri, kind);
        if (!seen.has(next)) seen.set(next, false);
        if (!seen.has(old)) seen.set(old, true);
    }
    return [...seen].map(([file, legacy]) => ({ file, legacy }));
}

/**
 * 「清空对话」要删的会话文件（**两个落位都删**）。
 * `changelog` **不在清单里**（跨会话审计时间线）。
 * `turns` 必须一起删（##424）：否则降级链会把「已经清掉的对话」从 turns 里重新翻出来。
 */
export const CLEARED_SESSION_KINDS = ["ops", "llm", "raw", "steps", "usage", "compact", "turns"] as const;

export function sessionFilesToClear(home: string, taskUri: string): string[] {
    const out: string[] = [];
    for (const kind of CLEARED_SESSION_KINDS) {
        out.push(sessionFile(home, taskUri, kind), legacySessionFile(home, taskUri, kind));
    }
    // 旁路状态快照（##431）：留着它 = 「清空对话」后仍记着旧边界。
    out.push(sessionStateFile(home, taskUri, "compact-state"));
    return out;
}

/** 会话 Op 流文件路径（**带建父目录**） */
export function opsFile(home: string, taskUri: string): string {
    return sessionFileForWrite(home, taskUri, "ops");
}

/** 每轮结论账（`turns.jsonl`，##424）：降级重建材料 + 压缩边界（##432） */
export function turnsFile(home: string, taskUri: string): string {
    return sessionFileForWrite(home, taskUri, "turns");
}

/** 压缩账本路径（append-only：compact / measure / undo 事件） */
export function compactFile(home: string, taskUri: string): string {
    return sessionFileForWrite(home, taskUri, "compact");
}

/** 全量消息日志路径（append-only；行号即消息序号） */
export function llmFile(home: string, taskUri: string): string {
    return sessionFileForWrite(home, taskUri, "llm");
}

/** 会话日志的相对路径（相对 home）——写进投递文本给模型/人照此回取 */
export function llmLogRelPath(home: string, taskUri: string): string {
    return path.relative(home, llmFile(home, taskUri)).split(path.sep).join("/");
}

/** 该任务**是否对话过**（##355「干净任务」的判据：ops 存在且非空） */
export function hasConversation(home: string, taskUri: string): boolean {
    try {
        // 纯读：**不建目录**（列表页逐条调）
        return statSync(resolveSessionFile(home, taskUri, "ops")).size > 0;
    } catch {
        return false;
    }
}
