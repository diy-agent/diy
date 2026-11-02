// instances.ts — **动态状态**：注册表（`~/.diy-instances/*.json`）+ 进程细节 → 每条 launch 运行与否。
//
// ##502 第二轮：注册表只回答「谁活着」，不参与「有什么能启动」。
// 匹配键 = `(worktree, app, launch)`：
//   · worktree：绝对路径相等（resolve 后再比）
//   · app：注册表里的 `app` 允许写作 `<name>` 或 `diy-<name>`（历史口径并存）
//   · launch：app.yaml 里那条启动命令的 id；老记录为 null ⇒ 匹配不上（读侧不报错，只是显示未启动）
//
// 老记录（没有 launch / worktree 字段，甚至没有 app）一律宽松：parseRecord 给 null，绝不抛。

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";
import type { AppSpec, DevSnapshot, EntryStatus, LaunchRuntime, LaunchStatus, WorktreeInfo } from "./shared.js";

/** 注册表目录：与 diy-app / apps/web 同一口径（`DIY_INSTANCE_REGISTRY` 可覆盖，测试隔离用） */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env["DIY_INSTANCE_REGISTRY"];
    if (override !== undefined && override.trim() !== "") return override.trim();
    return join(homedir(), ".diy-instances");
}

/** 注册表一条（宽松版：只取 UI 用得到的字段；缺字段 = 缺省值） */
export interface InstanceRecordLite {
    readonly pid: number;
    /** app 短名；老记录 = null */
    readonly app: string | null;
    /** launch id；老记录 = null */
    readonly launch: string | null;
    /** 启动它的 git worktree 根；老记录 = null */
    readonly worktree: string | null;
    readonly port: number | null;
    readonly diyHome: string;
    readonly variant: string;
    readonly env: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly parents: readonly { readonly pid: number; readonly command: string }[];
}

export function parseRecord(raw: unknown): InstanceRecordLite | null {
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o["pid"] !== "number" || !Number.isFinite(o["pid"]) || o["pid"] <= 0) return null;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const nullableStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const parents = Array.isArray(o["parents"])
        ? (o["parents"] as unknown[])
              .map((h) => h as Record<string, unknown>)
              .filter((h) => typeof h["pid"] === "number" && typeof h["command"] === "string")
              .map((h) => ({ pid: h["pid"] as number, command: h["command"] as string }))
        : [];
    return {
        pid: o["pid"],
        app: nullableStr(o["app"]),
        launch: nullableStr(o["launch"]),
        worktree: nullableStr(o["worktree"]),
        port: num(o["port"]),
        diyHome: str(o["diyHome"]),
        variant: str(o["variant"]),
        env: str(o["env"]),
        argv: Array.isArray(o["argv"]) ? (o["argv"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
        cwd: str(o["cwd"]),
        startedAt: str(o["startedAt"]),
        updatedAt: str(o["updatedAt"]),
        parents,
    };
}

/** pid 是否活着（EPERM = 有进程但没权限发信号 ⇒ 活着） */
export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * 读全表：坏 JSON / 死进程的条目直接删掉（「关掉一个实例下次就不再出现」靠这条，
 * 退出钩子不保证执行）。目录不存在 ⇒ 空表（第一次跑，正常态）。
 */
export function readRecords(
    dir: string = registryDir(),
    alive: (pid: number) => boolean = isPidAlive,
): InstanceRecordLite[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const out: InstanceRecordLite[] = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = join(dir, name);
        let rec: InstanceRecordLite | null = null;
        try {
            rec = parseRecord(JSON.parse(readFileSync(file, "utf-8")));
        } catch {
            rec = null;
        }
        if (rec === null || !alive(rec.pid)) {
            try {
                unlinkSync(file);
            } catch {
                /* 忽略 */
            }
            continue;
        }
        out.push(rec);
    }
    return out;
}

/** 注册表里的 app 名与 app.yaml 的 name 是否指同一个 app（`chat` / `diy-chat` 两种历史口径） */
export function sameApp(recordApp: string | null, appName: string): boolean {
    if (recordApp === null) return false;
    return recordApp === appName || recordApp === `diy-${appName}`;
}

/** 路径相等（resolve 后比；不同写法 / 尾斜杠不该判成两个 worktree） */
export function samePath(a: string | null, b: string): boolean {
    if (a === null) return false;
    return resolve(a) === resolve(b);
}

export interface LaunchRefLike {
    readonly worktree: string;
    readonly app: string;
    readonly launch: string;
}

/** 这条记录是否对应这个 launch（三元组） */
export function matchRecord(record: InstanceRecordLite, ref: LaunchRefLike): boolean {
    return samePath(record.worktree, ref.worktree) && sameApp(record.app, ref.app) && record.launch === ref.launch;
}

/** 展示形式的路径：仓库内相对路径优先，其次 `~` 缩写，最后原样 */
export function displayPath(path: string, repoRoot: string): string {
    const rel = relative(resolve(repoRoot), resolve(path));
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    const home = homedir();
    if (path === home) return "~";
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
    return path;
}

/** worktree 的展示名：`<家目录缩写或路径>（<分支>）` */
export function worktreeLabel(worktree: string, branch: string | null, repoRoot: string): string {
    const where = displayPath(worktree, repoRoot);
    return branch === null ? where : `${where}  ${branch}`;
}

/** 端口替换：`http://localhost:8123` + 实际端口 8124 → `http://localhost:8124` */
export function withPort(url: string, port: number | null): { href: string; mismatch: boolean } {
    if (port === null) return { href: url, mismatch: false };
    try {
        const parsed = new URL(url);
        const configuredPort =
            parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : null;
        if (configuredPort === port) return { href: url, mismatch: false };
        parsed.port = String(port);
        return { href: parsed.toString(), mismatch: true };
    } catch {
        return { href: url, mismatch: false };
    }
}

export interface SnapshotInputs {
    readonly repoRoot: string;
    readonly worktrees: readonly WorktreeInfo[];
    /** worktree → apps（调用方负责 IO 与解析问题收集） */
    readonly appsOf: (worktree: string) => readonly AppSpec[];
    readonly records: readonly InstanceRecordLite[];
    /** 已拉起但还没写注册表的（key = `(worktree, app, launch)`） */
    readonly starting: ReadonlySet<string>;
    readonly problems?: readonly string[];
    /** worktree 是否构建过 */
    readonly builtOf?: (worktree: string) => boolean;
    /** pid → 内存字节数（注入：单测不跑 ps） */
    readonly memOf?: (pid: number) => number | null;
    readonly now?: number;
    readonly registry?: string;
}

export function launchKey(worktree: string, app: string, launch: string): string {
    return `${resolve(worktree)}\u0000${app}\u0000${launch}`;
}

/** 纯合成：静态清单 + 注册表记录 → 每条 launch 的状态（不碰 IO，便于单测） */
export function buildSnapshot(targets: readonly WorktreeInfo[], inputs: SnapshotInputs): DevSnapshot {
    const now = inputs.now ?? Date.now();
    const memOf = inputs.memOf ?? (() => null);
    const builtOf = inputs.builtOf ?? (() => true);
    const launches: LaunchStatus[] = [];
    let appCount = 0;
    for (const worktree of targets) {
        const apps = inputs.appsOf(worktree.path);
        appCount += apps.length;
        const built = builtOf(worktree.path);
        for (const app of apps) {
            for (const launch of app.launches) {
                const key = launchKey(worktree.path, app.name, launch.id);
                const record = inputs.records.find((rec) => matchRecord(rec, { worktree: worktree.path, app: app.name, launch: launch.id }));
                const running = record !== undefined;
                const actualPort = running ? record.port : null;
                const entries: EntryStatus[] = launch.entries.map((entry) => {
                    if (entry.kind !== "web" || entry.url === undefined) {
                        return { ...entry, href: null, configuredUrl: entry.url ?? null, portMismatch: false };
                    }
                    const { href, mismatch } = withPort(entry.url, running ? actualPort : null);
                    return {
                        ...entry,
                        href,
                        configuredUrl: entry.url,
                        portMismatch: mismatch,
                    };
                });
                const runtime: LaunchRuntime | null =
                    record === undefined
                        ? null
                        : {
                              pid: record.pid,
                              port: record.port,
                              startedAt: record.startedAt,
                              uptimeMs: (() => {
                                  const started = Date.parse(record.startedAt);
                                  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
                              })(),
                              memBytes: memOf(record.pid),
                              cmdline: record.argv.join(" "),
                              cwd: record.cwd,
                              diyHome: record.diyHome,
                          };
                launches.push({
                    key,
                    worktree: worktree.path,
                    worktreeLabel: worktreeLabel(worktree.path, worktree.branch, inputs.repoRoot),
                    branch: worktree.branch,
                    app: app.name,
                    appTitle: app.title,
                    launch: launch.id,
                    launchTitle: launch.title ?? launch.id,
                    command: launch.command,
                    appDir: app.dir,
                    built,
                    running,
                    starting: !running && inputs.starting.has(key),
                    entries,
                    runtime,
                });
            }
        }
    }
    return {
        repoRoot: inputs.repoRoot,
        registryDir: inputs.registry ?? registryDir(),
        worktreeCount: targets.length,
        appCount,
        runningCount: launches.filter((item) => item.running).length,
        problems: inputs.problems ?? [],
        launches,
    };
}
