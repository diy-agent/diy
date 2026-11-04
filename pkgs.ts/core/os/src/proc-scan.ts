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
// Windows 没有 pgid（`ProcessRow.pgid === null`）⇒ 走 **PPID 锚点**（锚点可以已经退出，
// Windows 不 reparent）＋创建时间窗；两条路都在本文件实现，上层不分支。
//
// **但「归我们管」≠「该列出来」**（用户 2026-10-24 定口径「前台进程不进观察名单，不属于 job，
// 就是当前 llm 自己的事情，不管、不列出、不记录」）：前台命令**组根还活着**时整组跳过 ——
// 否则 agent 每跑一条 `rg`/`git`/`tsc`，面板就闪一条「野进程」，命令一结束又消失（实测症状）。
// 判据 = 组根（`pgid` 那条 pid，detached ⇒ 根 pid == 组号）仍在 `ps` 快照里；根一退，
// 组里剩下的就是 `nohup … &` 的孤儿，才该列出来（那是「谁起的」的唯一线索）。
//
// 本文件只管**判据与解析**（能拿 `ps` 文本夹具单测）；真跑 `ps` 在
// `main/services/process-scan.ts`，登记组 id 在 `main/services/owned-groups.ts`。

/** `ps -axo pid=,ppid=,pgid=,etime=,pcpu=,rss=,command=` 的一行（策略层归一化后的形状）。 */
export interface PsRow {
    pid: number;
    ppid: number;
    /** 进程组 id（POSIX；Windows 没有这个概念 ⇒ null，R4） */
    pgid: number | null;
    /** `[[dd-]hh:]mm:ss` 原样（解析成 ms 由 `parseEtime` 做） */
    etimeText: string;
    /** 瞬时 CPU%（ps 给的是**采样平值**，只作参考，不当判据） */
    pcpu: number | null;
    /** 常驻内存 KiB */
    rssKb: number | null;
    command: string;
    /**
     * 进程创建时刻（epoch ms；采不到 null/缺省）。
     * 用途：Windows 的「PPID 锚点」认领靠它排除 pid 复用的误认（见 `selectOwnedProcs`）。
     */
    createdAt?: number | null;
}

/** 认领依据（决定「能不能杀」：lineage 只凭父链，必须额外过创建时间窗）。 */
export type ProcClaim = "pgid" | "run-root" | "descendant" | "lineage";

/** 归我们管的进程：ps 行 + 认领依据。 */
export interface OwnedProc extends PsRow {
    /** 这条进程属于哪条 run（`null` = 没登记 —— 例如命令里自己 `nohup xxx &` 起的） */
    runId: string | null;
    /** 是不是某条 run 的**根进程**（`pid === run.pid`）；false = 该 run 的子孙或野进程 */
    isRunRoot: boolean;
    /** 认领依据（`lineage` = 只靠 PPID 锚点，Windows 无进程组时用） */
    claim: ProcClaim;
    /** `lineage` 认领时的锚点 pid（run 根 / 组根）；其余情况缺省 */
    anchorPid?: number;
}

/** 一行 `ps` 输出 → `PsRow`。解析不出的行**跳过**（`ps` 输出里有空行/异常行）。 */

/**
 * Chromium/Electron 自己的辅助进程 —— 它们也是 app 的子孙，但**不是** agent 起的活。
 *
 * 判据（review 抓到过一次误杀，所以这里收窄）：**必须同时**是 Chromium 系的二进制
 * **且**带辅助进程标记。早先只看 `--type=`：那是任意命令都可能带的通用标志
 * （`rg --type=py …`、`tsc --type=…`），一条正常后台活会被整条丢弃 —— 与「我希望所有
 * job/shell 的进程都看得见」正好相反。
 *
 * 注意：「观测工具自己」的排除不属于这里（那是平台相关的命令行），由调用方把
 * `SelectOptions.isObserver` 传进来（实现见 os/posix.ts、os/win32.ts）。
 */
export function isAppHelperProc(command: string): boolean {
    // 这两类名字本身就是 Chromium 专属，不含歧义
    if (/crashpad_handler/.test(command)) return true;
    if (/Electron Helper|Chromium Helper/.test(command)) return true;
    // 其余：命令行里**同时**出现 Electron/Chromium 与 `--type=` 才算辅助进程
    return /--type=/.test(command) && /Electron|Chromium/.test(command);
}

/** 组登记：组 id → 是谁起的（只为显示"这堆进程是哪条命令留下的"）。 */
export interface GroupOwner {
    /** 起的时刻（ms epoch；登记组时写入） */
    at: number;
    /** 根进程的创建时刻（ms epoch；登记时能拿到就写，拿不到用 `at` 兜底） */
    createdAt?: number | null;
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
    /** 「这是观测工具自己」的判据（平台相关，由 os 策略提供；缺省不过滤） */
    isObserver?: (command: string) => boolean;
    /** 判定时间窗用的当前时刻（缺省 `Date.now()`；单测注入固定值） */
    now?: number;
}

/** 身份判据：锚点 pid 若还在快照里，其创建时刻应与登记时刻一致（容差 5s）；不一致 = pid 复用。 */
const ANCHOR_IDENTITY_SKEW_MS = 5_000;
/** 兜底保险丝：拿不到创建时刻（POSIX 只有秒级 etime 且换算失败）时才用，不是主判据。 */
const ANCHOR_FALLBACK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

    /** 认领锚点 = 我们记过的 run 根 pid ∪ 组名册里的组号（POSIX 是 pgid，Windows 是根 pid）。 */
    const anchors = new Set<number>([...opts.runPids.keys(), ...opts.groups.keys()]);
    const anchorRunId = (pid: number): string | undefined =>
        opts.runPids.get(pid) ?? opts.groups.get(pid)?.runId;
    /**
     * 锚点身份判据（**不是时间年龄**）：
     *   · 锚点不在本轮快照里 ⇒ 这个 pid 没被复用 ⇒ 锚点有效（继续给孤儿当依据）；
     *   · 锚点在快照里 ⇒ 当前创建时刻应与登记时刻一致（`createdAt ?? at`，容差 5s）；
     *     不一致 = 这个 pid 已经是另一个进程 ⇒ 锚点立刻退休，不许再认领/苟活；
     *   · 拿不到创建时刻 ⇒ 才退化成 7 天保险丝（常量只是兜底，不是主判据）。
     */
    const now = opts.now ?? Date.now();
    const anchorValid = (anchorPid: number): boolean => {
        const owner = opts.groups.get(anchorPid);
        if (!owner) return true; // 只有 runPids 记录、没有身份信息：不猜
        const live = byPid.get(anchorPid);
        if (!live) return true; // 号空着 ⇒ 没被复用
        const expected = owner.createdAt ?? owner.at;
        if (live.createdAt != null) return Math.abs(live.createdAt - expected) <= ANCHOR_IDENTITY_SKEW_MS;
        return now - owner.at <= ANCHOR_FALLBACK_AGE_MS;
    };

    /**
     * 沿 ppid 链往上找第一个满足 `hit` 的 pid。
     *
     * **允许命中目标本身不在快照里**（Windows 的 `nohup … &`：根 bash 已退，孤儿的 PPID
     * 仍指向那个死掉的 pid —— Windows 不 reparent，这是它比 `pgid` 更有信息量的地方）。
     * 中间节点则必须存在：断链就放弃（不猜）。
     */
    const walkTo = (row: PsRow, hit: (ppid: number) => boolean): number | null => {
        let cur = row;
        const seen = new Set<number>();
        while (!seen.has(cur.pid)) {
            seen.add(cur.pid);
            const ppid = cur.ppid;
            if (ppid <= 0) return null;
            if (hit(ppid)) return ppid;
            const parent = byPid.get(ppid);
            if (!parent) return null;
            cur = parent;
        }
        return null;
    };

    const isDescendantOfSelf = (row: PsRow): boolean =>
        walkTo(row, (ppid) => ppid === opts.selfPid) !== null;

    /** `lineage` 认领：父链命中锚点（锚点本身可以已经退出）。 */
    const lineageOf = (row: PsRow): { anchorPid: number; runId?: string } | null => {
        const anchorPid = walkTo(row, (ppid) => anchors.has(ppid) && anchorValid(ppid));
        return anchorPid === null ? null : { anchorPid, runId: anchorRunId(anchorPid) };
    };

    /** 往上找最近一条 run 的根 pid（子孙要归到那条 run 名下，不能各自成孤儿）。 */
    const runIdOfAncestors = (row: PsRow): string | undefined => {
        let cur = byPid.get(row.ppid);
        const seen = new Set<number>();
        while (cur && !seen.has(cur.pid)) {
            seen.add(cur.pid);
            const hit = opts.runPids.get(cur.pid) ?? opts.groups.get(cur.pid)?.runId;
            if (hit) return hit;
            cur = byPid.get(cur.ppid);
        }
        return undefined;
    };

    const out: OwnedProc[] = [];
    for (const row of rows) {
        if (row.pid === opts.selfPid) continue;
        if (isAppHelperProc(row.command)) continue;
        if (opts.isObserver?.(row.command)) continue;
        const groupOwner = row.pgid === null ? undefined : opts.groups.get(row.pgid);
        const pgidOwned =
            row.pgid !== null && (groupOwner !== undefined || opts.runPids.has(row.pgid));
        const runRoot = opts.runPids.has(row.pid) && anchorValid(row.pid);
        const lineage = lineageOf(row);
        const descendant = isDescendantOfSelf(row);
        const mine = pgidOwned || descendant || runRoot || lineage !== null;
        if (!mine) continue;
        // 组号 = run 根 pid（spawn 一律 `detached`）：根退了、子孙被 reparent 到 launchd 之后，
        // 父子链已经断了，**只剩 pgid 这一条线**能归到「谁起的」（`nohup … &` 就是这种）。
        // Windows 没有 pgid，则靠 lineage 的锚点把孤儿归回原 run。
        const runId =
            (runRoot ? opts.runPids.get(row.pid) : undefined) ??
            (row.pgid !== null ? opts.runPids.get(row.pgid) : undefined) ??
            lineage?.runId ??
            runIdOfAncestors(row) ??
            groupOwner?.runId ??
            null;
        // 前台命令本体（组名册里没有 runId + 组根还活着）⇒ 不列：那是当前这一轮 llm 自己的事。
        // 只对**有组记录**的行判（`isDescendantOfSelf` 抓到的漏网没有组记录，仍要显示 ——
        // 否则将来某条 spawn 忘了 detached 时，进程会彻底从面板消失）。
        if (runId === null && groupOwner !== undefined && row.pgid !== null && byPid.has(row.pgid)) continue;
        // Windows 的 lineage 版本：锚点还活着且是前台命令（无 runId）⇒ 同样是「当前这轮自己的事」。
        // 锚点一退，留下的是孤儿 ⇒ 立刻列出（这正是要抓的那类）。
        const lineageOwner = lineage ? opts.groups.get(lineage.anchorPid) : undefined;
        if (lineage && runId === null && lineageOwner !== undefined && byPid.has(lineage.anchorPid)) continue;
        const claim: ProcClaim = runRoot
            ? "run-root"
            : pgidOwned
              ? "pgid"
              : descendant
                ? "descendant"
                : "lineage";
        out.push({
            ...row,
            runId,
            isRunRoot: runRoot,
            claim,
            ...(lineage ? { anchorPid: lineage.anchorPid } : {}),
        });
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
