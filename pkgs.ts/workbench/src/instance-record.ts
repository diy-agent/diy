// instance-record.ts — 外壳宿主启动时**自报**一条实例记录（`~/.diy-instances/<pid>.json`）。
//
// 为什么外壳要管：dev 启动器靠这份注册表判断「哪个 app 活着」（`app` 字段 = 短名），
// 而 apps/chat / apps/minimal / apps/remote-shell 都跑在本外壳上。原先只有 diy-app 与
// apps/web 自报，其余 app 在启动器里永远显示「未启动」。这里补上通用的那份。
//
// 格式与 diy-app 的 `core/instance-registry.ts` 同一份（那个文件是读侧）：
//   pid / app / port / pingPort / diyHome / variant / env / argv / cwd / startedAt / updatedAt / parents
// 读侧对未知字段宽松；本文件少写 port（外壳没有 RPC 端口）时写 null。
//
// 生命周期：启动写 → 退出删。「退出清理不保证执行」（SIGKILL / 崩溃），读侧另有 pid 存活过滤。

import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/** 启动瞬间快照的一跳父进程 */
export interface ParentHop {
    readonly pid: number;
    readonly command: string;
}

/** 注册表目录：`DIY_INSTANCE_REGISTRY` 覆盖；缺省真实家目录下 `~/.diy-instances` */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env["DIY_INSTANCE_REGISTRY"];
    if (override !== undefined && override.trim() !== "") return override.trim();
    return join(realHomeDir(), ".diy-instances");
}

/** 真实家目录（不读 $HOME：测试 / 隔离实例会改写它） */
function realHomeDir(): string {
    try {
        return userInfo().homedir || homedir();
    } catch {
        return homedir();
    }
}

/** 本地时区 ISO（与 diy-app 的 localISOString 同形：`2026-11-02T11:00:00.000+0800`） */
export function localISOString(date: Date = new Date()): string {
    const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
        `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
    );
}

/** 父进程链最多快照几跳 */
export const PARENT_DEPTH = 4;

/** 取一个进程的 ppid 与命令行；取不到 ⇒ null（Windows 不猜，直接截断） */
export function processHop(pid: number): { hop: ParentHop; ppid: number } | null {
    if (!Number.isFinite(pid) || pid <= 1 || process.platform === "win32") return null;
    try {
        const out = execFileSync("ps", ["-o", "ppid=", "-o", "command=", "-p", String(pid)], {
            encoding: "utf-8",
            timeout: 1500,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const space = out.indexOf(" ");
        if (space <= 0) return null;
        const ppid = Number(out.slice(0, space));
        const command = out.slice(space + 1).trim();
        if (!Number.isFinite(ppid) || command === "") return null;
        return { hop: { pid, command }, ppid };
    } catch {
        return null;
    }
}

/** 快照父进程链（启动瞬间才有意义；任何一步失败只截断，不抛） */
export function snapshotParents(ppid: number = process.ppid, depth = PARENT_DEPTH): ParentHop[] {
    const out: ParentHop[] = [];
    let cur = ppid;
    for (let i = 0; i < depth && cur > 1; i++) {
        const got = processHop(cur);
        if (got === null) break;
        out.push(got.hop);
        if (got.ppid === cur) break;
        cur = got.ppid;
    }
    return out;
}

/** 原子写（同目录临时文件 + rename），读侧可能与本进程并发 */
function writeAtomic(file: string, content: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
        writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
        renameSync(tmp, file);
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            /* 忽略 */
        }
        throw e;
    }
}

export function recordPath(dir: string, pid: number): string {
    return join(dir, `${pid}.json`);
}

export interface SelfRecordOptions {
    /** app 短名（`diy-app` / `diy-chat`…） */
    readonly app: string;
    readonly diyHome: string;
    readonly variant: string;
    readonly env: string;
    readonly dir?: string;
    /** 注入时间源（单测） */
    readonly now?: () => string;
    /** 注入父链快照（单测不跑 ps） */
    readonly parents?: () => ParentHop[];
}

/**
 * 写自己那一条；返回记录路径。**返回路径而不是 void**：宿主可在日志里落一行，排查时能看到
 * 「它到底写到哪儿去了」（注册表目录可被环境变量改写，猜不得）。
 */
export function writeSelfRecord(options: SelfRecordOptions): string {
    const dir = options.dir ?? registryDir();
    const pid = process.pid;
    const now = options.now ?? (() => localISOString());
    const startedAt = localISOString(new Date(Date.now() - process.uptime() * 1000));
    const record = {
        pid,
        app: options.app,
        port: null,
        pingPort: null,
        diyHome: options.diyHome,
        variant: options.variant,
        env: options.env,
        argv: [...process.argv],
        cwd: process.cwd(),
        startedAt,
        updatedAt: now(),
        parents: (options.parents ?? (() => snapshotParents()))(),
    };
    const file = recordPath(dir, pid);
    writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
    return file;
}

/** 退出清理；不存在不算错 */
export function removeSelfRecord(dir: string = registryDir(), pid: number = process.pid): void {
    try {
        unlinkSync(recordPath(dir, pid));
    } catch {
        /* 已不在 */
    }
}
