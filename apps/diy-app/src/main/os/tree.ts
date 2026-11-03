// 🎯 进程树聚合（OS 无关的纯函数）
//
// 输入 = 策略层归一化后的行（见 os/types.ts::ProcessRow），输出 = 共享判据要的树视图。
// 放在这里的原因：POSIX 与 Windows 的**取数**方式不同，但「从全表算后代/CPU 和」是同一套逻辑；
// 留在任一策略文件里都会让另一边复制一份。

import type { ProcessTree } from "./types";

export interface TreeNode {
    pid: number;
    ppid: number;
    /** 该进程的 CPU%（缺省 0） */
    pcpu: number | null;
    command: string;
}

/** 从 `rows` 里算 `rootPid` 的树：直接子进程数 / 全部后代 / CPU 和。 */
export function aggregateTree(rows: readonly TreeNode[], rootPid: number): ProcessTree {
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const childrenOf = new Map<number, TreeNode[]>();
    for (const r of rows) {
        const list = childrenOf.get(r.ppid);
        if (list) list.push(r);
        else childrenOf.set(r.ppid, [r]);
    }

    const root = byPid.get(rootPid);
    let cpu = root?.pcpu ?? 0;
    const descendants: { pid: number; command: string }[] = [];
    const seen = new Set<number>([rootPid]);
    const queue: number[] = [rootPid];
    while (queue.length > 0) {
        const cur = queue.shift() as number;
        for (const child of childrenOf.get(cur) ?? []) {
            if (seen.has(child.pid)) continue; // 防御：pid 复用 / 环
            seen.add(child.pid);
            cpu += child.pcpu ?? 0;
            descendants.push({ pid: child.pid, command: child.command });
            queue.push(child.pid);
        }
    }
    const directChildCount = (childrenOf.get(rootPid) ?? []).filter((c) => seen.has(c.pid)).length;
    return { directChildCount, descendants, treeCpuPercent: Math.round(cpu * 10) / 10 };
}
