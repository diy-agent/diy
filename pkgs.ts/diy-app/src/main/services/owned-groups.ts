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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { GroupOwner } from "../../shared/proc-scan";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
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

/** 比开机时刻还早多少毫秒算「上一轮开机的残骸」（`uptime` 只到秒级，留 5s 容差）。 */
const BOOT_SKEW_MS = 5_000;

/**
 * 本次开机时刻（ms）—— 名册的**跨重启判据**。
 *
 * `os.uptime()` 在 macOS 上就是 `kern.boottime`（Linux 是 `/proc/uptime`），零子进程零依赖。
 * 为什么需要它：组号就是 pid，重启后系统从低位重新分配 —— 盘上留着的旧号会被**新的无辜
 * 进程**占用，于是名册把它认领成「任务 N 起的」，「结束进程」还会按组杀掉它。
 * 而「登记得比开机还早」这一个事实足以否掉整条：**重启杀光一切**，那条记录描述的进程
 * 必然已经死了（我们起的都不是 launchd 服务，跨不过重启）。
 */
export function bootTimeMs(now: number = Date.now(), upSec: number = uptime()): number {
    return now - Math.round(upSec * 1000);
}

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

/**
 * 盘上条目 → 内存表（抽成独立函数只为**可测**：那条判定躲在 `load` 的 `await readFile`
 * 后面，端到端测不到「谁先跑完」的竞态）。
 *
 * **内存优先**：内存里已有的 pgid 一律跳过 —— 启动早期 `record` 抢在 `load` 之前跑完时，
 * 盘上的旧条目（上一轮会话的命令 / 缺 `taskUri`·`runId`）不许把它整条覆盖。
 * 没有这条判定，pid 复用时会说成「这条孤儿是上一轮那条命令起的」，指向错的来源。
 *
 * **跨重启丢弃**（传了 `bootAt` 时）：登记时刻早于本次开机 ⇒ 必定是上一轮开机的残骸，
 * 直接丢（理由见 `bootTimeMs`）。`at` 缺失/为 0 的老条目同样丢掉 —— 它无法证明自己属于
 * 本次开机，而误留的代价是**杀错进程**、误丢的代价只是认不出老孤儿（退化成不落盘）。
 */
export function applyLoaded(map: Map<number, GroupOwner>, raw: unknown, bootAt?: number): void {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
        const it = item as { pgid?: unknown; owner?: Partial<GroupOwner> };
        const pgid = Number(it.pgid);
        const o = it.owner;
        if (!Number.isInteger(pgid) || pgid <= 0 || !o || typeof o.command !== "string") continue;
        if (map.has(pgid)) continue;
        const at = typeof o.at === "number" ? o.at : 0;
        if (bootAt !== undefined && at < bootAt - BOOT_SKEW_MS) continue;
        map.set(pgid, {
            at,
            command: o.command,
            cwd: typeof o.cwd === "string" ? o.cwd : "",
            ...(typeof o.runId === "string" ? { runId: o.runId } : {}),
            ...(typeof o.taskUri === "string" ? { taskUri: o.taskUri } : {}),
        });
    }
}

export class OwnedGroups {
    private readonly map = new Map<number, GroupOwner>();
    private readonly file?: string;
    private readonly isAlive: (pgid: number) => boolean;

    constructor(opts: OwnedGroupsOptions = {}) {
        this.file = opts.file;
        this.isAlive = opts.alive ?? aliveGroup;
        // 读盘是异步的（用户 2026-10-24：app 里不许有同步 IO），但构造函数不能 await。
        // 于是把这次读挂成一个 Promise：**读不读得完都不影响登记**（`record` 只写内存）。
        //
        // ⚠️ `get` / `snapshot` 是**同步**的（要能嵌进纯函数），所以启动早期（`ready` 还没
        // resolve）查旧条目会读不到 —— 需要**完整**视图的路径必须自己 `await ready`
        // （`process-scan::scanOwnedProcs` 就是这么做的）。反向是安全的：`load` 见到内存里
        // 已有的 pgid 一律跳过，不会用盘上的旧条目覆盖启动早期刚登记的归属。
        this.ready = this.load();
    }

    /** 首读完成的信号（坏文件/读不到也 resolve —— 认不出老孤儿是退化，不是错误）。 */
    readonly ready: Promise<void>;

    /** 从盘上读回组号索引（坏文件/读不到一律当空，绝不因此炸启动）。 */
    private async load(): Promise<void> {
        if (!this.file) return;
        try {
            const text = await readFile(this.file, "utf8");
            applyLoaded(this.map, JSON.parse(text) as unknown, bootTimeMs());
        } catch {
            // 坏索引 = 认不出老孤儿，功能退化但一切照跑
        }
    }

    /**
     * 落盘（失败只留痕，不影响内存态）。
     *
     * **异步 + 合并**：`record` 是热路径（每条 bash 调用都走），同步重写整份 JSON 会把
     * 主进程按在磁盘上（用户 2026-10-24：app 里不许有同步 IO）。这里改成"脏标记 + 单飞"：
     * 正在写就只标脏，写完再看一次 —— N 次连续登记最多合并成 2 次写。
     */
    private save(): void {
        if (!this.file) return;
        this.dirty = true;
        if (!this.inflight) void this.flush();
    }

    private dirty = false;
    /** 正在写的那次（`flush()` 要能等它，否则测试读到的可能是半截/空文件） */
    private inflight: Promise<void> | null = null;

    /**
     * 把脏状态写完（测试可以 await 它，确认盘上内容）。
     *
     * 语义：**等上一次写完，再判要不要再写一轮** —— 直接 `if (saving) return` 会让
     * 后来者立刻返回、读到还没落盘的旧文件（实测踩过：测试读到空文件）。
     */
    async flush(): Promise<void> {
        if (!this.file) return;
        if (this.inflight) await this.inflight;
        if (!this.dirty) return;
        this.inflight = this.doFlush();
        try {
            await this.inflight;
        } finally {
            this.inflight = null;
        }
    }

    private async doFlush(): Promise<void> {
        while (this.dirty) {
            this.dirty = false;
            const list = [...this.map.entries()].map(([pgid, owner]) => ({ pgid, owner }));
            try {
                // ⚠️ 目录可能还不存在（##408 review 的真 bug）：`log/job/groups.json` 所在的那层
                //    只有 run-registry 建 `log/job/runs` 时顺手存在，**全新数据根 / 还没起过后台
                //    run 时没人建它** ⇒ 每次 record 都 ENOENT + 一条 warn，名册永远落不了盘，
                //    而「重启后还能认领孤儿」整个建立在这份文件上。
                await mkdir(dirname(this.file as string), { recursive: true });
                // non-atomic-ok: 索引可丢可重建，写坏的代价只是认不出老孤儿
                await writeFile(this.file as string, `${JSON.stringify(list)}\n`, "utf8");
            } catch (e) {
                // 写失败要**留住脏标记**：清掉就再也不会重试，这一轮的内存状态永远不落盘。
                // 但此刻也别在失败里空转 —— 交给下一次 `save()` 再试。
                this.dirty = true;
                console.warn("[job] 进程组索引写入失败（下次变更重试）", this.file, e);
                return;
            }
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

    /**
     * 前台命令跑完后**立刻撤掉**它的组记录 —— 除非组里还有活口。
     *
     * 为什么要有：用户口径「前台不记录」。这条记录存在的唯一理由是「它可能在跑，
     * 跑完/退出了要能认出留下的孤儿」。命令结束且一个进程都没剩 ⇒ 记录就该消失，
     * 名册不再被几千条 `ls` 撑着（也避免 512 上限被无用条目占满）。
     * 组里还有活口 = 命令留下了 `nohup … &` 的子孙 ⇒ **必须留**（那是唯一的认领线索）。
     */
    release(pgid: number): void {
        if (!Number.isInteger(pgid) || pgid <= 0) return;
        if (!this.map.has(pgid)) return;
        if (this.isAlive(pgid)) return;
        this.map.delete(pgid);
        this.save();
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
     * 只丢"扫不到进程且已过宽限期"的组。**跨重启**那类误认领由 `applyLoaded` 的开机判据
     * 处理（旧条目根本进不来内存）；**同一次开机内**的组号复用这里不管 —— 组号就是 pid，
     * macOS 顺序分配、涨到上限才回绕，要撞上手头的号得先生成近十万个进程，代价远超收益。
     * 真撞上时还有一道闸：`job.killproc` 调用前会重扫 `ps` 校验（见 `process-scan`）。
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
