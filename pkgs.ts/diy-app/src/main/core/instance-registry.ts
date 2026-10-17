// src/main/core/instance-registry.ts
// 🎯 跨数据根的**实例注册表** —— 「这个实例是谁开的」的唯一可靠来源。
//
// 【为什么必须启动时自报，不能事后追父链】
//   实测：生产实例 `ppid=1`（启动它的 CLI 早退了，被 launchd 接管）—— 事后 `ps` 只剩 `/sbin/launchd`，
//   「谁开的 / 从哪个 worktree 起的 / 什么变体」全都追不出来。唯一能拿到这些信息的时刻是**它刚起来的
//   那一瞬间**（父进程还在），故启动时快照落档。
//
// 【落位】`<真实家目录>/.diy-instances/<pid>.json` —— **不是**生产数据根 `~/.diy`：
//   本注册表描述的是「本机有哪些实例」（跨数据根），既不属于任何单个数据根，也不该进生产数据目录
//   （那里是用户数据，`rule.instance-lifecycle` 明令不动）。故与 `~/.diy` 平级。
//   测试/隔离场景用 `DIY_INSTANCE_REGISTRY` 覆盖（见 tests/setup.ts）—— 否则测试实例会把条目
//   写进真实家目录、还互相看不见。
//
// 【生命周期】启动写入 → 就绪回填 `port` → 退出删除。**但退出清理不保证执行**
//   （SIGKILL / 崩溃 / 测试 harness 的 SIGTERM）：故读取侧一律按 **pid 是否存活**过滤，
//   并把死条目顺手删掉 —— 「关掉一个实例下次就不再出现」靠的是这条，不是退出钩子。

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, mkdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { realHomeDir } from "./instance-identity";

/** 启动时快照的一跳父进程（`parents[0]` = 直接父亲） */
export interface ParentHop {
  pid: number;
  command: string;
}

/** 一条实例注册记录（`<pid>.json`） */
export interface InstanceRecord {
  pid: number;
  /** RPC 端口；未就绪为 null（启动早期写的那一份） */
  port: number | null;
  /** 实例自己认定的数据根（`AppConfig.diyHome`，**经 dev-home 纠正**后的那个） */
  diyHome: string;
  /** 产物变体（prod|test|preview|lab） */
  variant: string;
  /** 运行环境（production|development|test） */
  env: string;
  /** 本进程 argv 原文（「谁开的」再补一层：能看到 --no-sandbox 之类的启动参数） */
  argv: string[];
  cwd: string;
  startedAt: string;
  updatedAt: string;
  /** 启动瞬间快照的父进程链（pid + command），最多 `PARENT_DEPTH` 跳 */
  parents: ParentHop[];
}

/** 注册表目录：`DIY_INSTANCE_REGISTRY` 覆盖（测试隔离），缺省 `<真实家目录>/.diy-instances` */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["DIY_INSTANCE_REGISTRY"];
  if (override && override.trim() !== "") return override;
  return join(realHomeDir(), ".diy-instances");
}

export function recordPath(dir: string, pid: number): string {
  return join(dir, `${pid}.json`);
}

/**
 * 解析一条记录（纯函数）。**宽松**：字段类型不对/缺失即整条作废（返回 null）——
 * 注册表是「别人进程写的文件」，读侧对它没有信任基础，宁可少一行也不拿半个对象去渲染。
 */
export function parseRecord(raw: unknown): InstanceRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!num(o["pid"]) || o["pid"] <= 0) return null;
  if (!("port" in o) || !(o["port"] === null || num(o["port"]))) return null;
  if (!str(o["diyHome"])) return null;
  const parents: ParentHop[] = Array.isArray(o["parents"])
    ? (o["parents"] as unknown[])
        .map((h) => {
          const hop = h as Record<string, unknown>;
          return num(hop?.["pid"]) && typeof hop?.["command"] === "string"
            ? { pid: hop["pid"], command: hop["command"] }
            : null;
        })
        .filter((h): h is ParentHop => h !== null)
    : [];
  return {
    pid: o["pid"],
    port: (o["port"] as number | null) ?? null,
    diyHome: o["diyHome"],
    variant: typeof o["variant"] === "string" ? o["variant"] : "",
    env: typeof o["env"] === "string" ? o["env"] : "",
    argv: Array.isArray(o["argv"]) ? (o["argv"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
    cwd: typeof o["cwd"] === "string" ? o["cwd"] : "",
    startedAt: typeof o["startedAt"] === "string" ? o["startedAt"] : "",
    updatedAt: typeof o["updatedAt"] === "string" ? o["updatedAt"] : "",
    parents,
  };
}

/** pid 是否活着。EPERM = 有那个进程但没权限发信号 ⇒ **活着**（不能当死处理） */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** 按存活过滤（纯函数，便于单测：喂一个「只有某几个 pid 活着」的判定器） */
export function pruneRecords(records: InstanceRecord[], alive: (pid: number) => boolean = isPidAlive): InstanceRecord[] {
  return records.filter((r) => alive(r.pid));
}

/** 写一条记录（**原子**：同目录临时文件 + rename —— 读侧可能与本进程并发，绝不能让读者看到半截 JSON） */
export function writeRecord(dir: string, rec: InstanceRecord): void {
  mkdirSync(dir, { recursive: true });
  const path = recordPath(dir, rec.pid);
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(rec, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** 读一条记录；不存在/坏 JSON/字段不合格 → null */
export function readRecord(dir: string, pid: number): InstanceRecord | null {
  try {
    return parseRecord(JSON.parse(readFileSync(recordPath(dir, pid), "utf-8")));
  } catch {
    return null;
  }
}

/** 局部更新（读-改-写）；记录不在则什么都不做（**不凭空造一条**：写与更新不是同一件事） */
export function updateRecord(dir: string, pid: number, patch: Partial<InstanceRecord>): void {
  const cur = readRecord(dir, pid);
  if (!cur) return;
  writeRecord(dir, { ...cur, ...patch, updatedAt: new Date().toISOString() });
}

/** 删除记录（退出清理）；不存在不算错 */
export function removeRecord(dir: string, pid: number): void {
  try {
    unlinkSync(recordPath(dir, pid));
  } catch {
    /* 已不在 */
  }
}

/**
 * 读全表并按存活过滤；**顺手删掉死者**（死进程的文件留着只会越积越多，而它的信息已无意义）。
 * 目录不存在 → 空表（第一次跑，正常态，不是错误）。
 */
export function readRecords(dir: string, alive: (pid: number) => boolean = isPidAlive): InstanceRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: InstanceRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pid = Number(name.slice(0, -".json".length));
    if (!Number.isFinite(pid)) continue;
    const rec = readRecord(dir, pid);
    if (!rec) {
      try { unlinkSync(join(dir, name)); } catch { /* 忽略 */ }
      continue;
    }
    if (!alive(rec.pid)) {
      try { unlinkSync(join(dir, name)); } catch { /* 忽略 */ }
      continue;
    }
    out.push(rec);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** 父进程链最多快照几跳（祖先再多也没有信息量，且每跳多一次 ps） */
export const PARENT_DEPTH = 4;

/** 跑一次 `ps -p <pid> -o pid=,ppid=,command=`；失败/进程已退 → null */
export function psHop(pid: number): { hop: ParentHop; ppid: number } | null {
  if (!Number.isFinite(pid) || pid <= 1) return null;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,command="], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(out);
    if (!m) return null;
    return { hop: { pid: Number(m[1]), command: (m[3] ?? "").trim() }, ppid: Number(m[2]) };
  } catch {
    return null;
  }
}

/**
 * 快照父进程链（**启动瞬间**才有意义：父退了就永久丢失，见文件头注）。
 * 逐级上溯到 `depth` 跳 / pid ≤ 1 / ps 拿不到为止 —— 任何一步失败都只截断，不抛。
 *
 * `lookup` 可注入（单测喂一张假表，不真跑 ps）。
 */
export function snapshotParents(
  ppid: number = process.ppid,
  lookup: (pid: number) => { hop: ParentHop; ppid: number } | null = psHop,
  depth: number = PARENT_DEPTH,
): ParentHop[] {
  const out: ParentHop[] = [];
  let cur = ppid;
  for (let i = 0; i < depth && cur > 1; i++) {
    const got = lookup(cur);
    if (!got) break;
    out.push(got.hop);
    if (got.ppid === cur) break; // 自环（不该发生，但别死循环）
    cur = got.ppid;
  }
  return out;
}
