// rotate.ts — 文件名与轮转（**两种同时做**，判据见 ##482）：
//   · 按天：文件名 `YYYY-MM-DD.log`（本地日期），跨天自动新建；按天清理旧组（maxDays）
//   · 按大小：单文件超 maxBytes ⇒ `2026-10-31.log` → `.1` → `.2` …，超 maxFiles 删最旧
//
// 为什么日期用本地时刻：人看日志先看「今天」，而记录里的 `at` 字段仍是 ISO（机器读）。
// 日期只进文件名，**不改记录内容**。

import { readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** `<日期>.log` / `<日期>.log.<N>`（只认本包写出的形态） */
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.log(?:\.(\d+))?$/;

function pad(value: number, width = 2): string {
    return String(value).padStart(width, '0');
}

/** 本地日期键 `YYYY-MM-DD`（文件名与按天清理共用同一把尺子） */
export function dayKey(date: Date): string {
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function unlinkIfExists(file: string): Promise<void> {
    try {
        await unlink(file);
    } catch (error) {
        if (!isNotFound(error)) throw error;
    }
}

async function renameIfExists(from: string, to: string): Promise<void> {
    try {
        await rename(from, to);
    } catch (error) {
        if (!isNotFound(error)) throw error;
    }
}

/**
 * 大小轮转：`base` → `base.1`，旧 `base.1` → `base.2` …，超过 `maxFiles` 的最旧份删掉。
 * `maxFiles = 0` ⇒ 不留历史（直接删掉当前文件，下次写新建）。
 *
 * 顺序：先删 `.maxFiles`，再从大到小挪，最后把当前文件挪成 `.1` —— 中途失败最多丢最旧一份，
 * 不会出现「当前文件被覆盖」。
 */
export async function rotateFiles(file: string, maxFiles: number): Promise<void> {
    if (maxFiles <= 0) {
        await unlinkIfExists(file);
        return;
    }
    await unlinkIfExists(`${file}.${maxFiles}`);
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
        await renameIfExists(`${file}.${index}`, `${file}.${index + 1}`);
    }
    await rename(file, `${file}.1`);
}

/**
 * 按天清理：只留最近 `keepDays` 天（含 `today`）的日志组（当前文件 + 它的 `.N` 历史一起删）。
 * 文件名只当提示（与库内 `at` 不比对）—— 这里是清理，不是数据校验。
 */
export async function pruneDays(dir: string, keepDays: number, today: string): Promise<void> {
    if (keepDays <= 0) return;
    const [year, month, day] = today.split('-').map(Number);
    const cutoff = dayKey(new Date(year, month - 1, day - (keepDays - 1)));
    const names = await readdir(dir);
    for (const name of names) {
        const match = DAY_FILE_RE.exec(name);
        if (match === null) continue;
        const fileDay = match[1];
        if (fileDay !== undefined && fileDay < cutoff) await unlinkIfExists(join(dir, name));
    }
}
