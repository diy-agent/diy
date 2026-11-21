// task-dir.ts —— 任务目录：`<数据根>/tasks/2026-11-21/<id>/`
//
// 三个决定：
//   1. **按创建日分桶，永不移动**。日期取自 `createdAt`（创建后不可变），所以改项目 /
//      改状态 / 改 workspace 都不搬目录，也不需要额外存一列 —— 路径由 (createdAt, id) 推出来。
//   2. **平铺日期段**，不用 `YYYY/MM/DD`：最后一级都是「当日任务数」，扇出一样；
//      平铺路径更短，一年 365 个目录一眼可浏览，`rm -rf tasks/2025-*` 也能归档。
//   3. **DB 是写入口真源**，这里的文件是导出物：人读、grep、备份用。
//      手改 `task.md` 会在下一次保存时被覆盖 —— 不要把它当第二个真源。
//
// 写文件失败只记日志、不影响 DB：磁盘满 / 权限不对不该让任务存不下去。

import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JournalEntry, TaskRecord } from './db';

const pad = (value: number): string => String(value).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD（不用 UTC：晚上建的任务会跑到「昨天」） */
export function dayOf(at: number): string {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 目录名里的 id 段：`:` 在 Windows 上是非法字符，历史 id（`task:t-001`）会被替换成 `-`。
 * 新 id 是 UUIDv7，原样就是安全的。
 */
function safeSegment(id: string): string {
    return id.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** 任务目录（只算路径，不创建） */
export function taskDirOf(root: string, task: { id: string; createdAt: number }): string {
    return join(root, 'tasks', dayOf(task.createdAt), safeSegment(task.id));
}

/** `task.md` 的内容：frontmatter + 正文。字符串一律走 JSON 双引号，避免 `:` / 引号把 YAML 打断 */
export function renderTaskDoc(task: TaskRecord): string {
    const field = (key: string, value: string | number | null): string =>
        value === null ? `${key}:` : `${key}: ${typeof value === 'number' ? value : JSON.stringify(value)}`;
    return [
        '---',
        field('id', task.id),
        field('number', task.number),
        field('title', task.title),
        field('summary', task.summary),
        field('project', task.projectId),
        field('workspace', task.workspace),
        field('status', task.status),
        field('created', new Date(task.createdAt).toISOString()),
        field('updated', new Date(task.updatedAt).toISOString()),
        '---',
        '',
        task.body,
        '',
    ].join('\n');
}

/** 写 `task.md`（原子写：临时文件 + rename，避免半截文件被 agent 读到） */
export function writeTaskDoc(root: string, task: TaskRecord): void {
    const dir = taskDirOf(root, task);
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    const target = join(dir, 'task.md');
    const temp = `${target}.tmp`;
    writeFileSync(temp, renderTaskDoc(task), 'utf8');
    renameSync(temp, target);
}

/** 追加一条日志（append-only；文件不存在就创建 —— 目录由第一次保存建好） */
export function appendJournalLine(root: string, task: TaskRecord, entry: JournalEntry): void {
    const dir = taskDirOf(root, task);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * 删任务不删产物：整个目录挪进 `tasks/_trash/<日期>-<id>`。
 * 直接 `rm -rf` 会把截图 / 日志一起删掉，而「删任务」通常只是不想再看到它。
 */
export function trashTaskDir(root: string, task: TaskRecord): void {
    const from = taskDirOf(root, task);
    if (!existsSync(from)) return; // 从没写过文件的旧任务：没有目录可挪
    const to = join(root, 'tasks', '_trash', `${dayOf(task.createdAt)}-${safeSegment(task.id)}`);
    mkdirSync(join(root, 'tasks', '_trash'), { recursive: true });
    renameSync(from, to);
}
