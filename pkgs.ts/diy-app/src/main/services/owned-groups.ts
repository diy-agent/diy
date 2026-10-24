// 🎯 我们 spawn 过的**进程组**名册 —— ##408 刀 10
//
// 为什么需要单独一本名册：`ps` 里认领"自己的进程"不能靠父子关系 —— 命令里
// `nohup cmd &` 起的进程在 `bash -c` 退出后会被 reparent 到 launchd（ppid=1），
// 正是"最想抓的那类"，按父子关系扫会漏得干干净净（判据见 `shared/proc-scan.ts` 头注）。
//
// 我们 spawn 一律 `detached: true`（`pgid == 子进程 pid`），所以「组 id」等于我们自己
// 发出去的号 —— 记下来，之后按组认领，孤儿也不会丢。
//
// 刻意薄：内存 Map、随 app 退出即空（与 run 表同口径：不做恢复、不落盘）。
// 唯一要管的是**别无限长**：每次扫描后把"组里一个进程都不剩"的号丢掉（宽限 30s，
// 避免刚登记就扫描时进程还没被 `ps` 抓到而被误删）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { GroupOwner } from "../../shared/proc-scan";
import { join } from "node:path";
import { readRuntimeConfig } from "../../runtime";

/**
 * 组里还有没有活口（信号 0：**同步且不起进程**，比 `ps` 便宜一个数量级）。
 *
 * `EPERM` 也算活着：组里确实有进程，只是不归我们发信号。
 */
export function aliveGroup(pgid: number): boolean {
    if (!Number.isInteger(pgid) || pgid <= 0) return false;
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** 名册上限：一次会话里起过的组不该无界（超了先丢没活口的，再丢最老的）。 */
const MAX_GROUPS = 512;

/** 新登记的组在这么短时间内不参与"无进程即丢弃"（见文件头）。 */
const RETAIN_GRACE_MS = 30_000;

export interface OwnedGroupsOptions {
    /** 组里还有没有活口（缺省 `kill(-pgid, 0)`；测试注入假判据） */
    alive?: (pgid: number) => boolean;
    /**
     * 落盘文件（可选）。**这不是"进程恢复"**：只记「这些组号是我起的」这一条索引，
     * 好让 app 重启后仍能认出 `nohup xxx &` 留下的孤儿（它们的 ppid 已经是 launchd）。
     * 没有这个索引，重启后那些进程就叫"别人的进程"，既看不见也杀不掉。
     */
    file?: string;
}

export class OwnedGroups {
    private readonly map = new Map<number, GroupOwner>();
    private readonly file?: string;
    private readonly isAlive: (pgid: number) => boolean;

    constructor(opts: OwnedGroupsOptions = {}) {
        this.file = opts.file;
        this.isAlive = opts.alive ?? aliveGroup;
        this.load();
    }

    /** 从盘上读回组号索引（坏文件/读不到一律当空，绝不因此炸启动）。 */
    private load(): void {
        if (!this.file || !existsSync(this.file)) return;
        try {
            const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
            if (!Array.isArray(raw)) return;
            for (const item of raw) {
                const it = item as { pgid?: unknown; owner?: Partial<GroupOwner> };
                const pgid = Number(it.pgid);
                const o = it.owner;
                if (!Number.isInteger(pgid) || pgid <= 0 || !o || typeof o.command !== "string") continue;
                this.map.set(pgid, {
                    at: typeof o.at === "number" ? o.at : 0,
                    command: o.command,
                    cwd: typeof o.cwd === "string" ? o.cwd : "",
                    ...(typeof o.runId === "string" ? { runId: o.runId } : {}),
                    ...(typeof o.taskUri === "string" ? { taskUri: o.taskUri } : {}),
                });
            }
        } catch {
            // 坏索引 = 认不出老孤儿，功能退化但一切照跑
        }
    }

    /** 落盘（失败只留痕，不影响内存态）。 */
    private save(): void {
        if (!this.file) return;
        try {
            const list = [...this.map.entries()].map(([pgid, owner]) => ({ pgid, owner }));
            writeFileSync(this.file, `${JSON.stringify(list)}\n`, "utf8"); // non-atomic-ok: 索引可丢可重建，写坏的代价只是认不出老孤儿
        } catch (e) {
            console.warn("[job] 进程组索引写入失败", this.file, e);
        }
    }

    /**
     * 登记一个组。同组重复登记**只补空字段**（`taskUri` / `runId`）：
     * 命令层先登记（它只知道 command/cwd），工具层随后补上"属于哪个任务/哪条 run"。
     * 其余字段以首次为准（组号是 pid，复用了说明不是同一条命令）。
     */
    record(pgid: number, owner: GroupOwner): void {
        if (!Number.isInteger(pgid) || pgid <= 0) return;
        const exist = this.map.get(pgid);
        if (exist) {
            let patched = false;
            if (!exist.taskUri && owner.taskUri) {
                exist.taskUri = owner.taskUri;
                patched = true;
            }
            if (!exist.runId && owner.runId) {
                exist.runId = owner.runId;
                patched = true;
            }
            if (patched) {
                this.map.set(pgid, exist);
                this.save();
            }
            return;
        }
        this.map.set(pgid, owner);
        this.prune();
        this.save();
    }

    /**
     * 超上限时剪枝（review 抓到的两个真问题）：
     *
     *   ① **只剪已经没有活口的组** —— 前台命令现在每条都登记组，512 条 `ls` 就能把
     *      还在跑的后台任务组挤掉，而这份索引是重启后**唯一**的认领依据（挤掉 = 孤儿
     *      变成"别人的进程"，既看不见也杀不掉）。
     *   ② 剪完**落盘** —— 原实现先 save 后 delete，盘上会长期多一条幽灵条目。
     */
    private prune(): void {
        if (this.map.size <= MAX_GROUPS) return;
        const byAge = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [pgid] of byAge) {
            if (this.map.size <= MAX_GROUPS) break;
            if (this.isAlive(pgid)) continue;
            this.map.delete(pgid);
        }
        // 全活着（极端）：仍然要收敛，否则无界 —— 只能丢最老的活口组
        for (const [pgid] of byAge) {
            if (this.map.size <= MAX_GROUPS) break;
            this.map.delete(pgid);
        }
    }

    get(pgid: number): GroupOwner | undefined {
        return this.map.get(pgid);
    }

    /** 快照（给 `selectOwnedProcs` 用；只读）。 */
    snapshot(): ReadonlyMap<number, GroupOwner> {
        return this.map;
    }

    /**
     * 扫描后清理：`livePgids` = 本轮 `ps` 里还活着的组。
     *
     * 只丢"扫不到进程且已过宽限期"的组 —— 组号被系统复用给别的进程时也不会误认领
     * （那种情况 pgid 仍在 livePgids 里，但命令已经不同；那是极端巧合，不额外处理）。
     */
    retain(livePgids: ReadonlySet<number>, now: number): void {
        // 迭代中会 delete：先拍快照（Map 的迭代器允许边迭代边删，但在这里"先拍后删"更直白）
        const snapshot: Array<[number, GroupOwner]> = Array.from(this.map.entries());
        let dirty = false;
        for (const [pgid, owner] of snapshot) {
            if (livePgids.has(pgid)) continue;
            if (now - owner.at < RETAIN_GRACE_MS) continue;
            this.map.delete(pgid);
            dirty = true;
        }
        if (dirty) this.save();
    }

    size(): number {
        return this.map.size;
    }

    clear(): void {
        this.map.clear();
        this.save();
    }
}

/** 全局单例：索引落 `$DIY_HOME/log/job/groups.json`（只记组号归属，不记 run 状态）。 */
export const ownedGroups = new OwnedGroups({ file: groupIndexPath() });

/** 组索引文件路径（跟随数据根，绝不硬编码）。 */
export function groupIndexPath(home: string = readRuntimeConfig().home): string {
    return join(home, "log", "job", "groups.json");
}
