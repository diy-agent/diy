// instance-record.ts — 外壳宿主启动时**自报**一条实例记录（`~/.diy-instances/<pid>.json`）。
//
// 为什么外壳要管：dev 启动器靠这份注册表判断「哪个 app 活着」（`app` 字段 = 短名），
// 而 apps/chat / apps/minimal 都跑在本外壳上。原先只有 diy-app 与
// apps/web 自报，其余 app 在启动器里永远显示「未启动」。这里补上通用的那份。
//
// 格式与 diy-app 的 `core/instance-registry.ts` 同一份（那个文件是读侧）：
//   pid / app / port / pingPort / diyHome / variant / env / argv / cwd / startedAt / updatedAt / parents
// 读侧对未知字段宽松；本文件少写 port（外壳没有 RPC 端口）时写 null。
//
// 生命周期：启动写 → 退出删。「退出清理不保证执行」（SIGKILL / 崩溃），读侧另有 pid 存活过滤。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureRegistryDir, migrateLegacyRegistry, registryDir as registryDirOf } from "@diy-agent/dev-paths";

/** 启动瞬间快照的一跳父进程 */
export interface ParentHop {
    readonly pid: number;
    readonly command: string;
}

/**
 * 注册表目录：**唯一真源在 `@diy-agent/dev-paths`**（`~/.diy/dev/apps`）。
 *
 * 这里只是转发 —— 位置改一次要改五处（workbench / diy-app / apps/web / remote / dev 启动器），
 * 所以统一收敛到那个包，别再在本文件里拼路径。
 */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
    return registryDirOf(env);
}

/**
 * 仓库根 = 往上找到第一个带 `.git`（目录或 worktree 的 `.git` 文件）的目录。
 * 不调 git 命令：启动路径上不能多一次子进程（且 packaged 环境不一定有 git）。
 * 认不出来就退回起点（宁可少一个字段，不抛）。
 */
export function repoRootOf(start: string = process.cwd()): string {
    let dir = resolve(start);
    for (let i = 0; i < 12; i++) {
        if (existsSync(join(dir, ".git"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(start);
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

/** 读数据根的 `instance-id`（有问题 / 不存在 ⇒ null；不写盘） */
function readInstanceId(home: string): string | null {
    try {
        const text = readFileSync(join(home, "instance-id"), "utf-8").trim();
        return text === "" ? null : text;
    } catch {
        return null;
    }
}

/**
 * 实例 URI：`diy://<instance-id>/<app>.<launch>`（与 dev 启动器的「实例 URI」同一口径）。
 *
 * 为什么不只是标题：一个窗口要能回答「我是谁、命令能打给谁」——`app.launch` 区分同一 app 的不同启动
 * 方式，`instance-id` 区分不同数据根（生产 / 各 worktree 的 lab）。instance-id 读不出来时退化成
 * `<app>.<launch>`：宁可短一点，也不伪造一个看似合法的 id。
 */
export function instanceUri(options: { readonly app: string; readonly launch?: string | null; readonly diyHome?: string }): string {
    const tail = options.launch === undefined || options.launch === null ? options.app : `${options.app}.${options.launch}`;
    const nodeId = options.diyHome === undefined ? null : readInstanceId(options.diyHome);
    return nodeId === null ? tail : `diy://${nodeId}/${tail}`;
}

/** 窗口标题：`<标题> — <实例 URI>`（无 app 名时原样返回，不让临时宿主也背上 URI） */
export function instanceWindowTitle(options: { readonly title?: string; readonly app?: string; readonly launch?: string | null; readonly diyHome?: string }): string {
    const base = options.title ?? "Workbench";
    if (options.app === undefined) return base;
    return `${base} — ${instanceUri({ app: options.app, launch: options.launch ?? null, diyHome: options.diyHome })}`;
}

export interface SelfRecordOptions {
    /** app 短名（`diy-app` / `diy-chat`…） */
    readonly app: string;
    /** launch id（app.yaml 里的一条启动命令：`lab` / `web-8123`）；缺省 null */
    readonly launch?: string | null;
    /** 启动它的 git worktree 根；缺省 = 从 cwd 往上找 */
    readonly worktree?: string | null;
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
    // 旧位置（`~/.diy-instances`）一次性搬家：写侧顺手触发，读侧才不用兼容两套目录
    migrateLegacyRegistry();
    const dir = options.dir ?? ensureRegistryDir();
    const pid = process.pid;
    const now = options.now ?? (() => localISOString());
    const startedAt = localISOString(new Date(Date.now() - process.uptime() * 1000));
    const record = {
        pid,
        app: options.app,
        launch: options.launch ?? null,
        worktree: options.worktree === undefined ? repoRootOf() : options.worktree,
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
/**
 * 回填本实例记录里的运行期字段（端口等）—— **就地改、原子写**。
 *
 * 为什么要单独一个函数：端口只有 bind 之后才知道，而记录是启动瞬间写的（那时候还没端口）。
 * 以前 diy-app 自己有一份 `updateRecord`，dev 没有 ⇒ 注册表里 dev 的 `port` 永远 null，
 * 远程发现器只可能靠 `/ping` 看到它，连不上。这里把「回填」收成共用的一份。
 */
export function updateSelfRecord(
    patch: { port?: number | null; pingPort?: number | null; name?: string | null },
    dir: string = registryDir(),
    pid: number = process.pid,
): boolean {
    const file = recordPath(dir, pid);
    let raw: string;
    try {
        raw = readFileSync(file, "utf-8");
    } catch {
        return false; // 记录还没写（或已被清）—— 回填不是关键路径，静默跳过
    }
    let current: Record<string, unknown>;
    try {
        current = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return false; // 坏文件不在这里修，交给读侧
    }
    const next = { ...current, ...patch, updatedAt: localISOString() };
    writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    return true;
}

export function removeSelfRecord(dir: string = registryDir(), pid: number = process.pid): void {
    try {
        unlinkSync(recordPath(dir, pid));
    } catch {
        /* 已不在 */
    }
}
