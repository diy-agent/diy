// registry.ts — apps/web 的**实例注册表自报**（`~/.diy-instances/<pid>.json`）。
//
// 为什么 web 要自己写：注册表原先只有 diy-app（Electron）启动时自报，`apps/web` 不写 ⇒
// local 发现器（`@diy-agent/remote/node` 的 localDiscoverer）永远扫不到 web 实例，
// 于是 local 发现器的远程导航页列不出它、同格多实例也无从判定（##495 根因一）。
//
// 落盘格式与 `pkgs.ts/diy-app/src/main/core/instance-registry.ts` **同一份**（那个文件是读侧）：
//   pid / app / launch / worktree / port / pingPort / diyHome / variant / env / argv / cwd / startedAt / updatedAt / parents
// 额外的两个字段是 web 侧的增量：`address`（自报算好的地址）与 `app`（发现器要靠它拼地址）。
// `launch` / `worktree` 是 ##502 第二轮新增：dev 启动器靠 `(worktree, app, launch)` 把运行时对回
// app.yaml 的静态清单；手工跑（没给 `DIY_LAUNCH`）时为 null，读侧宽松。
// diy-app 的 parseRecord 对多余字段是宽松的，加了不影响它读。
//
// ⚠️ 清理不保证执行（SIGKILL / 崩溃）：读侧（local 发现器）以 /ping 探活过滤死条目，
//    本文件的 remove 只是「正常退出时立刻消失」的快路径。

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultRegistryDir, writeFileAtomic } from '@diy-agent/remote/node';

/**
 * 仓库根 = 往上找到第一个带 `.git` 的目录（与 @diy-agent/workbench 的 `repoRootOf` 同一判据）。
 * 不调 git：启动路径上不多一次子进程；认不出就退回起点。
 */
export function repoRootOf(start: string = process.cwd()): string {
    let dir = resolve(start);
    for (let i = 0; i < 12; i++) {
        if (existsSync(join(dir, '.git'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(start);
}

/** 启动瞬间快照的一跳父进程（与 diy-app 同一形状） */
export interface ParentHop {
    pid: number;
    command: string;
}

/** 本实例在注册表里的那一条 */
export interface WebInstanceRecord {
    pid: number;
    /** 主监听端口（http / ws / 静态 / ping 同一个） */
    port: number | null;
    /** `/ping` 端口：web 上就是主端口（与 diy-app 的独立 ping 端口不同） */
    pingPort: number | null;
    diyHome: string;
    variant: string;
    env: string;
    argv: string[];
    cwd: string;
    startedAt: string;
    updatedAt: string;
    parents: ParentHop[];
    /** app 短名（发现器据此判「同格」） */
    app: string;
    /** launch id（app.yaml 里的一条启动命令，如 `web-8123`）；缺省 null（老记录 / 手工跑） */
    launch: string | null;
    /** 启动它的 git worktree 根；缺省 null */
    worktree: string | null;
    /** 自报的显示地址（含冲突端口，见 server.ts 的 resolveAddress） */
    address: string;
}

export function registryDir(): string {
    return defaultRegistryDir();
}

export function recordFile(dir: string, pid: number): string {
    return join(dir, `${pid}.json`);
}

/** 本地时区 ISO（与 diy-app 的 `localISOString` 同形：`2026-11-01T08:18:58.938+0800`） */
export function localISOString(date: Date = new Date()): string {
    const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
        `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
    );
}

/**
 * 快照父进程链（**启动瞬间**才有意义：父退了就永久丢失，与 diy-app 同理）。
 * POSIX 走 `ps`；Windows / 取不到就截断（只作线索，读侧不依赖它）。
 */
export function snapshotParents(ppid: number = process.ppid, depth = 4): ParentHop[] {
    if (process.platform === 'win32') return [];
    const out: ParentHop[] = [];
    let cur = ppid;
    for (let i = 0; i < depth && cur > 1; i++) {
        const got = hopOf(cur);
        if (got === null) break;
        out.push(got.hop);
        if (got.ppid === cur) break;
        cur = got.ppid;
    }
    return out;
}

function hopOf(pid: number): { hop: ParentHop; ppid: number } | null {
    const result = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf-8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const line = result.stdout.trim();
    const match = /^(\d+)\s+([\s\S]+)$/.exec(line);
    if (match === null) return null;
    const ppid = Number(match[1]);
    const command = match[2] ?? '';
    if (!Number.isFinite(ppid) || command === '') return null;
    return { hop: { pid, command }, ppid };
}

/** 写自己那一条（原子：同目录临时文件 + rename，读侧可能并发） */
export function writeRecord(dir: string, record: WebInstanceRecord): void {
    writeFileAtomic(recordFile(dir, record.pid), `${JSON.stringify(record, null, 2)}\n`);
}

/** 局部更新（读-改-写）；记录不在则什么都不做 */
export function updateRecord(dir: string, pid: number, patch: Partial<WebInstanceRecord>): void {
    let current: WebInstanceRecord;
    try {
        current = JSON.parse(readFileSync(recordFile(dir, pid), 'utf-8')) as WebInstanceRecord;
    } catch {
        return;
    }
    writeRecord(dir, { ...current, ...patch, updatedAt: localISOString() });
}

/** 删除记录（退出清理）；不存在不算错 */
export function removeRecord(dir: string, pid: number): void {
    try {
        unlinkSync(recordFile(dir, pid));
    } catch {
        /* 已不在 */
    }
}

/** 这条文件是不是「我自己」的（冲突判定时跳过自己，免得自己 ping 自己） */
export function isOwnRecordFile(file: string, pid: number = process.pid): boolean {
    return file.endsWith(`${sep}${pid}.json`);
}
