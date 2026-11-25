// server/registry.ts —— 实例自报注册表（`<devRoot>/apps/<pid>.json`）。
//
// 为什么必须**启动时**自报（不能事后追父链）：diy2 常被 `sha.sh dev` / `bin/diy2` / 编辑器
// 任务拉起，父进程一退（或被 launchd 接管）就再也查不出「谁开的、哪个 worktree、哪个数据根」。
// 唯一能拿到这些信息的时刻是它刚起来的那一瞬间 —— 快照落档。
//
// 位置口径与 `@diy-agent/dev-paths`（仓库唯一真源）一致：`~/.diy/dev/apps`：
//   · 挂 `.diy` 下但独立分区：注册表描述「本机有哪些实例」，跨数据根，属于设备级；
//   · **不能**放进某个实例的 home（如 run/diy2/lab）—— 那样别的工具看不见它。
// 这里不 import 那个包：它的 `main` 指 `dist/`（构建产物），干净 worktree 里没有 →
// dev 会连带起不来。故本地实现同一份路径口径（方差见 tests/registry.test.ts 的覆盖），
// 覆盖变量沿用共享那一组名字（`DIY_INSTANCE_REGISTRY` > `DIY_DEV_HOME`），不认 `DIY2_*`（见 registryDir）。
//
// 生命周期：启动写 → 就绪回填 port → 退出删。**退出清理不保证执行**（SIGKILL / 崩溃），
// 故读侧一律按 pid 存活过滤，并顺手删死条目 —— 「关掉就不再出现」靠这条，不靠退出钩子。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { APP_ID, realHomeDir } from './config';
import { openLog } from './log';

const log = openLog('registry');

/** 一个父进程跳（`parents[0]` = 直接父亲） */
export interface ParentHop {
    pid: number;
    command: string;
}

/**
 * 一条实例记录。字段名与 `apps/diy-app` 的 `InstanceRecord` 对齐（读侧是同一批工具：
 * dev 启动器 / workbench / remote 发现），新增字段只加不删，缺字段读侧当 null。
 */
export interface InstanceRecord {
    pid: number;
    app: string | null;
    launch: string | null;
    worktree: string | null;
    name: string | null;
    mode: 'source' | 'packaged' | null;
    /** RPC/HTTP 端口；启动早期写的那一份是 null，监听成功后回填 */
    port: number | null;
    /** diy2 没有独立的 ping 端口，固定 null（字段保留，读侧宽松） */
    pingPort: number | null;
    /** 实例自己认定的数据根（探活判据就是它） */
    diyHome: string;
    variant: string;
    env: string;
    argv: string[];
    cwd: string;
    startedAt: string;
    updatedAt: string;
    parents: ParentHop[];
}

/** dev 根：`DIY_DEV_HOME` 覆盖；缺省 `<真实家目录>/.diy/dev` */
export function devRoot(env: NodeJS.ProcessEnv = process.env): string {
    const override = env['DIY_DEV_HOME']?.trim();
    if (override !== undefined && override !== '') return override;
    return join(realHomeDir(), '.diy', 'dev');
}

/**
 * 注册表目录：`DIY_INSTANCE_REGISTRY` > `<devRoot>/apps`。
 *
 * 故意**不认** `DIY2_*`：那一族是运行配置前缀，`bin/diy2` 会把整族清掉再交给 CLI
 * （防继承），写在这里等于永远不会生效。注册表是「本机进程目录」，不是运行配置。
 */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
    const shared = env['DIY_INSTANCE_REGISTRY']?.trim();
    if (shared !== undefined && shared !== '') return shared;
    return join(devRoot(env), 'apps');
}

export function recordPath(dir: string, pid: number): string {
    return join(dir, `${pid}.json`);
}

/** pid 是否活着。EPERM = 有那个进程但发不了信号 ⇒ **活着** */
export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * 解析一条记录（纯函数）。**宽松**：注册表是「别人的进程写的文件」，没有信任基础 ——
 * 字段类型不对就当没有，宁可少一行也不拿半个对象去渲染。
 */
export function parseRecord(raw: unknown): InstanceRecord | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!isNum(o['pid']) || o['pid'] <= 0) return null;
    if (!('port' in o) || !(o['port'] === null || isNum(o['port']))) return null;
    if (!isStr(o['diyHome'])) return null;
    const parents: ParentHop[] = Array.isArray(o['parents'])
        ? (o['parents'] as unknown[])
              .map((entry) => {
                  const hop = entry as Record<string, unknown>;
                  return isNum(hop?.['pid']) && typeof hop?.['command'] === 'string'
                      ? { pid: hop['pid'], command: hop['command'] }
                      : null;
              })
              .filter((hop): hop is ParentHop => hop !== null)
        : [];
    return {
        pid: o['pid'],
        port: (o['port'] as number | null) ?? null,
        app: isStr(o['app']) ? o['app'] : null,
        launch: isStr(o['launch']) ? o['launch'] : null,
        worktree: isStr(o['worktree']) ? o['worktree'] : null,
        name: isStr(o['name']) ? o['name'] : null,
        mode: o['mode'] === 'source' || o['mode'] === 'packaged' ? o['mode'] : null,
        pingPort: isNum(o['pingPort']) ? o['pingPort'] : null,
        diyHome: o['diyHome'],
        variant: typeof o['variant'] === 'string' ? o['variant'] : '',
        env: typeof o['env'] === 'string' ? o['env'] : '',
        argv: Array.isArray(o['argv'])
            ? (o['argv'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : [],
        cwd: typeof o['cwd'] === 'string' ? o['cwd'] : '',
        startedAt: typeof o['startedAt'] === 'string' ? o['startedAt'] : '',
        updatedAt: typeof o['updatedAt'] === 'string' ? o['updatedAt'] : '',
        parents,
    };
}

/** 取一个进程的一跳（POSIX 的 `ps`；拿不到就 null，不要为了注册表把启动搞崩） */
export function processHop(pid: number): { hop: ParentHop; ppid: number } | null {
    if (!Number.isFinite(pid) || pid <= 1) return null;
    try {
        const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' });
        const line = out.trim();
        if (line === '') return null;
        const match = /^(\d+)\s+(.*)$/s.exec(line);
        if (match === null) return null;
        return { hop: { pid, command: match[2]!.trim() }, ppid: Number.parseInt(match[1]!, 10) };
    } catch {
        return null;
    }
}

/** 父进程链最多快照几跳（再多也没有信息量） */
export const PARENT_DEPTH = 4;

/** 快照父进程链（**启动瞬间**才有意义）；`lookup` 可注入，便于单测喂假表 */
export function snapshotParents(
    ppid: number = process.ppid,
    lookup: (pid: number) => { hop: ParentHop; ppid: number } | null = processHop,
    depth: number = PARENT_DEPTH,
): ParentHop[] {
    const out: ParentHop[] = [];
    let cur = ppid;
    for (let i = 0; i < depth && cur > 1; i++) {
        const got = lookup(cur);
        if (got === null) break;
        out.push(got.hop);
        if (got.ppid === cur) break;
        cur = got.ppid;
    }
    return out;
}

/** 原子写：临时文件 + rename（读侧与本进程并发，不能让它看到半截 JSON） */
function writeAtomic(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
}

/** 写一条记录 */
export function writeRecord(dir: string, rec: InstanceRecord): void {
    writeAtomic(recordPath(dir, rec.pid), `${JSON.stringify(rec, null, 2)}\n`);
}

/** 读一条记录；不存在 / 坏 JSON / 字段不合格 → null */
export function readRecord(dir: string, pid: number): InstanceRecord | null {
    try {
        return parseRecord(JSON.parse(readFileSync(recordPath(dir, pid), 'utf8')));
    } catch {
        return null;
    }
}

/** 局部更新（读-改-写）；记录不在则什么都不做（**不凭空造一条**） */
export function updateRecord(dir: string, pid: number, patch: Partial<InstanceRecord>): void {
    const current = readRecord(dir, pid);
    if (current === null) return;
    writeRecord(dir, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

/** 删记录；不存在不算错 */
export function removeRecord(dir: string, pid: number = process.pid): void {
    try {
        unlinkSync(recordPath(dir, pid));
    } catch {
        /* 已不在 */
    }
}

/** 读全表 + 按存活过滤，**顺手删死条目**；目录不存在 → 空表（第一次跑的正常态） */
export function readRecords(dir: string, alive: (pid: number) => boolean = isPidAlive): InstanceRecord[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const out: InstanceRecord[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const pid = Number.parseInt(name.slice(0, -'.json'.length), 10);
        if (!Number.isFinite(pid)) continue;
        const rec = readRecord(dir, pid);
        if (rec === null || !alive(rec.pid)) {
            try {
                unlinkSync(join(dir, name));
            } catch {
                /* 删不掉就算了 */
            }
            continue;
        }
        out.push(rec);
    }
    return out.sort((a, b) => a.pid - b.pid);
}

/** 只留本 app 的记录（注册表是跨 app 共享的，`app` 字段是唯一判据） */
export function readAppRecords(dir: string, app: string = APP_ID): InstanceRecord[] {
    return readRecords(dir).filter(
        (rec) => rec.app === app || (rec.app === null && rec.argv.some((a) => a.includes('diy2'))),
    );
}

/** 本进程的记录骨架（`port` 先给 null，监听成功后 `updateRecord` 回填） */
export function currentRecord(opts: {
    app: typeof APP_ID;
    launch: string | null;
    name: string | null;
    worktree: string | null;
    mode: 'source' | 'packaged' | null;
    diyHome: string;
    variant: string;
    env: string;
    argv?: string[];
}): InstanceRecord {
    const now = new Date().toISOString();
    return {
        pid: process.pid,
        app: opts.app,
        launch: opts.launch,
        worktree: opts.worktree,
        name: opts.name,
        mode: opts.mode,
        port: null,
        pingPort: null,
        diyHome: opts.diyHome,
        variant: opts.variant,
        env: opts.env,
        argv: opts.argv ?? process.argv.slice(2),
        cwd: process.cwd(),
        startedAt: now,
        updatedAt: now,
        parents: snapshotParents(),
    };
}

/** 注册表目录是否存在（诊断用；写侧自己会 mkdir） */
export function registryExists(dir: string): boolean {
    return existsSync(dir);
}

/** 自报所需的配置切片（`Diy2Config` 结构上满足它；这里不 import 是为了不让注册表依赖配置全貌） */
export interface AnnounceTarget {
    app: typeof APP_ID;
    home: string;
    /** 入口名（prod / lab / staging）；记录里的 `variant` 字段也写它（老读者还在看） */
    launch: string;
    env: string;
    name: string | null;
    repoRoot: string | null;
}

/**
 * 自报本进程（启动即写，拿到端口后回填）。**失败只告警**：注册表写不进去
 * （只读家目录 / 权限）不该让一个能干活的服务起不来。
 */
export function announce(target: AnnounceTarget, port: number | null): void {
    const dir = registryDir();
    try {
        writeRecord(
            dir,
            currentRecord({
                app: target.app,
                launch: target.launch,
                name: target.name,
                worktree: target.repoRoot,
                mode: target.repoRoot === null ? 'packaged' : 'source',
                diyHome: target.home,
                variant: target.launch,
                env: target.env,
            }),
        );
        if (port !== null) updateRecord(dir, process.pid, { port });
    } catch (error) {
        log.error('注册表写入失败', { dir }, error);
    }
}

/** 撤销自报（退出时）；失败无声 —— 读侧本来就按 pid 存活过滤 */
export function retract(): void {
    try {
        removeRecord(registryDir());
    } catch {
        /* 忽略 */
    }
}
