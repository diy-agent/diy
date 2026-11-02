// instances.ts — 把「注册表 + 进程表」合成 UI 要的每一条状态。
//
// 数据源只有一个：`~/.diy-instances/<pid>.json`（##495 的注册表，##502 之前加了 `app` 字段）。
// **不轮询 ps 判断谁在跑** —— 只在拿到一条活记录之后，才补 PID 的内存 / 运行时长这类细节。
//
// 老记录（没有 `app`，字段是 null）要能容忍：不报错、不当作「在跑」；只有能从 argv / cwd
// 认出是哪个 app 时才补一条兜底（见 inferApp）。

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";
import type { DevSnapshot, TargetRuntime, TargetStatus } from "./shared.js";
import type { ResolvedTarget } from "./targets.js";

/** 注册表目录：与 diy-app / apps/web 同一口径（`DIY_INSTANCE_REGISTRY` 可覆盖，测试隔离用） */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env["DIY_INSTANCE_REGISTRY"];
    if (override !== undefined && override.trim() !== "") return override.trim();
    return join(homedir(), ".diy-instances");
}

/** 注册表一条（宽松版：只取 UI 用得到的字段；缺字段 = 缺省值） */
export interface InstanceRecordLite {
    readonly pid: number;
    /** ##495 起的字段；老记录 = null */
    readonly app: string | null;
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
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const parents = Array.isArray(o["parents"])
        ? (o["parents"] as unknown[])
              .map((h) => h as Record<string, unknown>)
              .filter((h) => typeof h["pid"] === "number" && typeof h["command"] === "string")
              .map((h) => ({ pid: h["pid"] as number, command: h["command"] as string }))
        : [];
    return {
        pid: o["pid"],
        app: typeof o["app"] === "string" && o["app"] !== "" ? o["app"] : null,
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
        if (rec === null) {
            try {
                unlinkSync(file);
            } catch {
                /* 忽略 */
            }
            continue;
        }
        if (!alive(rec.pid)) {
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

/** 老记录的兜底：从 argv / cwd 认出 app 短名（认不出 = null） */
export function inferApp(rec: InstanceRecordLite): string | null {
    const haystack = `${rec.cwd} ${rec.argv.join(" ")}`;
    const table: readonly (readonly [string, string])[] = [
        ["pkgs.ts/diy-app", "diy-app"],
        ["apps/chat", "diy-chat"],
        ["apps/web", "diy-web"],
        ["apps/remote-shell", "diy-remote-shell"],
        ["apps/minimal", "diy-minimal"],
        ["apps/dev", "diy-dev"],
    ];
    for (const [dir, app] of table) {
        if (haystack.includes(dir)) return app;
    }
    return null;
}

/** 这条记录是否属于该目标（app + 变体 + 端口；web 两个入口靠端口区分） */
export function matchRecord(target: ResolvedTarget, records: readonly InstanceRecordLite[]): InstanceRecordLite | null {
    const app = target.app;
    return (
        records.find((rec) => {
            const recApp = rec.app ?? inferApp(rec);
            if (recApp !== app) return false;
            if (rec.variant !== "" && rec.variant !== target.variant) return false;
            if (target.port !== undefined && rec.port !== target.port) return false;
            return true;
        }) ?? null
    );
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

/** 实例 URI：`diy://<nodeId>/<app>.<variant>` */
export function instanceUri(nodeId: string, app: string, variant: string): string {
    return `diy://${nodeId}/${app}.${variant}`;
}

export interface SnapshotInputs {
    readonly repoRoot: string;
    readonly records: readonly InstanceRecordLite[];
    /** 已拉起但还没写注册表的（构建 / 启动中） */
    readonly starting: ReadonlySet<string>;
    /** 数据根 → instance-id（读文件 / 首次生成，由调用方负责 IO） */
    readonly nodeIdOf: (home: string, app: string) => string;
    /** pid → 内存字节数（注入：单测不跑 ps） */
    readonly memOf?: (pid: number) => number | null;
    readonly now?: number;
    readonly registry?: string;
}

/** 纯合成：目标清单 + 注册表记录 → 每条的状态（不碰 IO，便于单测） */
export function buildSnapshot(targets: readonly ResolvedTarget[], inputs: SnapshotInputs): DevSnapshot {
    const now = inputs.now ?? Date.now();
    const memOf = inputs.memOf ?? (() => null);
    const entries: TargetStatus[] = targets.map((target) => {
        const rec = matchRecord(target, inputs.records);
        const nodeId = inputs.nodeIdOf(target.homePath, target.app);
        const base = {
            id: target.id,
            group: target.group,
            name: target.name,
            app: target.app,
            variant: target.variant,
            cwd: target.cwd,
            home: target.homePath,
            homeDisplay: displayPath(target.homePath, inputs.repoRoot),
            command: target.commandLine,
            ...(target.port === undefined ? {} : { port: target.port }),
            uri: instanceUri(nodeId, target.app, target.variant),
        };
        if (rec === null) {
            return {
                ...base,
                running: false,
                starting: inputs.starting.has(target.id),
                runtime: null,
            };
        }
        const started = Date.parse(rec.startedAt);
        const runtime: TargetRuntime = {
            pid: rec.pid,
            port: rec.port,
            startedAt: rec.startedAt,
            uptimeMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
            memBytes: memOf(rec.pid),
            cmdline: rec.argv.join(" "),
            cwd: rec.cwd,
            env: rec.env,
        };
        return { ...base, running: true, starting: false, runtime };
    });
    return {
        repoRoot: inputs.repoRoot,
        registryDir: inputs.registry ?? registryDir(),
        runningCount: entries.filter((e) => e.running).length,
        entries,
    };
}
