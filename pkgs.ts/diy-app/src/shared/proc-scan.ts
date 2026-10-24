// 🎯 「这台 app 起了哪些进程」的判据（纯函数，零 IO）—— ##408 刀 10
//
// 用户 2026-10-23 的口径：
//   「还需要一个总的 job/shell 的 run 管理器……如果 shell 用 `nohup xxx &` 开一个后台进程、
//    自己轮询，我们 app 能观测吗？我希望**所有** job/shell 的进程都通过我们管理器看到。」
//
// 病：活体表只有「我们登记过的 run」。而 agent 完全可以在命令里写 `nohup xxx &`——
// 那种进程从没经过 `run-registry`，于是面板上看不见、也杀不掉，只能靠人选 `ps` 猜。
//
// 判据（为什么不按"父进程是不是我们"来认领）：
//   `bash -c "nohup cmd &"` 的 bash 退出后，`cmd` 会被 **reparent 到 launchd**（ppid=1）——
//   按父子关系扫，这种"最想抓的"恰好漏掉。所以按**进程组**认领：所有 spawn 都走
//   `detached: true`（`pgid == 子进程 pid`），组 id 是我们自己发出去的号，孤儿之后仍然有效。
//
// 于是「归我们管」= `pgid ∈ 我们发过的组` ∪ `是 app 的子孙`。前者抓孤儿，后者抓没 detached 的漏网。
//
// 本文件只管**判据与解析**（能拿 `ps` 文本夹具单测）；真跑 `ps` 在
// `main/services/process-scan.ts`，登记组 id 在 `main/services/owned-groups.ts`。

/** `ps -axo pid=,ppid=,pgid=,etime=,pcpu=,rss=,command=` 的一行。 */
export interface PsRow {
    pid: number;
    ppid: number;
    /** 进程组 id（`detached` spawn 时 = 组长 pid） */
    pgid: number;
    /** `[[dd-]hh:]mm:ss` 原样（解析成 ms 由 `parseEtime` 做） */
    etimeText: string;
    /** 瞬时 CPU%（ps 给的是**采样平值**，只作参考，不当判据） */
    pcpu: number | null;
    /** 常驻内存 KiB */
    rssKb: number | null;
    command: string;
}

/** 归我们管的进程：ps 行 + 认领依据。 */
export interface OwnedProc extends PsRow {
    /** 这条进程属于哪条 run（`null` = 没登记 —— 例如命令里自己 `nohup xxx &` 起的） */
    runId: string | null;
    /** 是不是某条 run 的**根进程**（`pid === run.pid`）；false = 该 run 的子孙或野进程 */
    isRunRoot: boolean;
}

/** 一行 `ps` 输出 → `PsRow`。解析不出的行**跳过**（`ps` 输出里有空行/异常行）。 */
export function parsePsRows(stdout: string): PsRow[] {
    const out: PsRow[] = [];
    for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        const pgid = Number(m[3]);
        const cpu = Number(m[5]);
        out.push({
            pid,
            ppid,
            pgid,
            etimeText: m[4] ?? "",
            pcpu: Number.isFinite(cpu) ? cpu : null,
            rssKb: Number(m[6]) || null,
            command: (m[7] ?? "").trim(),
        });
    }
    return out;
}

/**
 * Chromium/Electron 自己的辅助进程 —— 它们也是 app 的子孙，但**不是** agent 起的活。
 *
 * 判据（review 抓到过一次误杀，所以这里收窄）：**必须同时**是 Chromium 系的二进制
 * **且**带辅助进程标记。早先只看 `--type=`：那是任意命令都可能带的通用标志
 * （`rg --type=py …`、`tsc --type=…`），一条正常后台活会被整条丢弃 —— 与「我希望所有
 * job/shell 的进程都看得见」正好相反。
 */
export function isAppHelperProc(command: string): boolean {
    // 扫描自己（`process-scan.ts` 的那条 ps）会出现在自己的 ps 输出里 —— 别把观测工具当活干。
    if (command.startsWith("ps -axo pid=,ppid=,pgid=")) return true;
    // 这两类名字本身就是 Chromium 专属，不含歧义
    if (/crashpad_handler/.test(command)) return true;
    if (/Electron Helper|Chromium Helper/.test(command)) return true;
    // 其余：命令行里**同时**出现 Electron/Chromium 与 `--type=` 才算辅助进程
    return /--type=/.test(command) && /Electron|Chromium/.test(command);
}

/** 组登记：组 id → 是谁起的（只为显示"这堆进程是哪条命令留下的"）。 */
export interface GroupOwner {
    /** 起的时刻（ms epoch） */
    at: number;
    command: string;
    cwd: string;
    /** 后台 run 的 id（前台命令没有） */
    runId?: string;
    taskUri?: string;
}

export interface SelectOptions {
    /** app 主进程 pid（它的子孙也算我们起的） */
    selfPid: number;
    /** 我们 spawn 过的进程组 */
    groups: ReadonlyMap<number, GroupOwner>;
    /** run 根进程 pid → runId（用于把子孙归到某条 run 名下） */
    runPids: ReadonlyMap<number, string>;
}

/**
 * 从全机 `ps` 快照里挑出**归我们管**的进程。
 *
 * 认领两条路（缺一不可，理由见文件头）：
 *   ① `pgid` 是我们发过的组 —— 抓 reparent 到 launchd 的孤儿；
 *   ② 祖先链走到 `selfPid` —— 抓没走 detached 的漏网（例如将来某个工具自己 spawn）。
 *
 * 输出按 pid 升序（派生的顺序稳定，表格不会每刷一次就跳行）。
 */
export function selectOwnedProcs(rows: readonly PsRow[], opts: SelectOptions): OwnedProc[] {
    const byPid = new Map<number, PsRow>();
    for (const r of rows) byPid.set(r.pid, r);

    const isDescendantOfSelf = (row: PsRow): boolean => {
        let cur = row;
        const seen = new Set<number>();
        while (cur.ppid > 1 && !seen.has(cur.pid)) {
            seen.add(cur.pid);
            if (cur.ppid === opts.selfPid) return true;
            const parent = byPid.get(cur.ppid);
            if (!parent) return false;
            cur = parent;
        }
        return false;
    };

    /** 往上找最近一条 run 的根 pid（子孙要归到那条 run 名下，不能各自成孤儿）。 */
    const runIdOfAncestors = (row: PsRow): string | undefined => {
        let cur = byPid.get(row.ppid);
        const seen = new Set<number>();
        while (cur && !seen.has(cur.pid)) {
            seen.add(cur.pid);
            const hit = opts.runPids.get(cur.pid);
            if (hit) return hit;
            cur = byPid.get(cur.ppid);
        }
        return undefined;
    };

    const out: OwnedProc[] = [];
    for (const row of rows) {
        if (row.pid === opts.selfPid) continue;
        if (isAppHelperProc(row.command)) continue;
        const groupOwner = opts.groups.get(row.pgid);
        // pgid 命中 run 根 pid 也算"归我们管"：根退了之后，组名册迟早过期，而 pgid 一直是那个号
        const mine = groupOwner !== undefined || opts.runPids.has(row.pgid) || isDescendantOfSelf(row);
        if (!mine) continue;
        // 组号 = run 根 pid（spawn 一律 `detached`）：根退了、子孙被 reparent 到 launchd 之后，
        // 父子链已经断了，**只剩 pgid 这一条线**能归到「谁起的」（`nohup … &` 就是这种）。
        const runId =
            opts.runPids.get(row.pid) ?? opts.runPids.get(row.pgid) ?? runIdOfAncestors(row) ?? groupOwner?.runId ?? null;
        out.push({ ...row, runId, isRunRoot: opts.runPids.has(row.pid) });
    }
    return out.sort((a, b) => a.pid - b.pid);
}

/**
 * 一条 run 名下的进程 **≠** 它的根进程。
 *
 * 为什么要分开：`bash -c "server & ..."` 里 run 的根 bash 可能早就退了，真正在干活的是
 * 留在这个组里的子孙。面板若只看根 pid，就会把"还在跑"说成"已结束"。
 */
export function childrenOfRun(procs: readonly OwnedProc[], runId: string): OwnedProc[] {
    return procs.filter((p) => p.runId === runId && !p.isRunRoot);
}
