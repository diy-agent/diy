// 🎯 名册回收用的 live 集合（OS 无关）
//
// 判据：**登记过的号 ∩ 本轮快照** + **仍有后代被认领的锚点**。
// 不能拿「全机所有 pid」当 live —— 那样 `ownedGroups.retain()` 几乎不删，老组永远留在锚点集合里；
// pid 一旦复用，lineage 会把新进程误认成「我们起的」。
// 也不能只留「根进程还在」的组 —— 根退了但 `nohup` 子孙还在时，锚点必须活到子孙消失为止。

import type { OwnedProc } from "../../shared/proc-scan";
import type { OwnQuery, ProcessRow } from "./types";

export function registeredLive(
    query: Pick<OwnQuery, "groups" | "runPids">,
    rows: readonly ProcessRow[],
    procs: readonly OwnedProc[],
): Set<number> {
    const present = new Set(rows.map((r) => r.pid));
    const live = new Set<number>();
    for (const id of query.groups.keys()) if (present.has(id)) live.add(id);
    for (const id of query.runPids.keys()) if (present.has(id)) live.add(id);
    // 根已退、但子孙还在同一组的（POSIX）：组必须继续留在名册里，否则孤儿失去认领依据。
    for (const row of rows) {
        if (row.pgid !== null && row.pgid !== row.pid && query.groups.has(row.pgid)) live.add(row.pgid);
    }
    // Windows 的 lineage 锚点：被认领的孤儿反过来证明锚点仍然有效。
    for (const p of procs) if (p.anchorPid !== undefined) live.add(p.anchorPid);
    return live;
}
