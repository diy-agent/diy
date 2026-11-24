/**
 * units.ts —— 任务内 unit DAG 的**派生量**（纯函数，无 IO）。
 *
 * 数据只有两份事实：`unit`（节点 + 状态）与 `dep`（`from` 先做完 → `to` 才能做）。
 * 其它一切（可做集合、阻塞原因、拓扑层）都是**算出来的**，不落库 —— 落库就会和两份事实
 * 三方不一致，而它们本来就不需要独立维护。
 *
 * 三条判据（设计见 `docs/plans/2026-11-24-task-units-dag.md` §2）：
 *
 *   · `ready`    = `open` 且**所有前置 `done`** —— 「现在该做什么」的唯一答案
 *   · `blocked`  = `open` 且有未完成前置 —— 「为什么还不能做」靠 `deps` 就能解释
 *   · `layers`   = 拓扑分层：同一层之间没有依赖，天然是 DAG 的骨架（视图按层排）
 *
 * 「删前置 = 解锁后继」不在这里处理：边在删除时已经随节点删掉了，这里只看现存事实。
 */
import type { UnitDep, UnitRecord, UnitStatus } from './db';

/** 一个节点 + 它在图上的位置（前置 / 后继 / 第几层） */
export interface UnitBoardRow {
    id: string;
    title: string;
    body: string;
    status: UnitStatus;
    /** 前置：这些做完才能做我 */
    deps: string[];
    /** 后继：我做完才能做它们 */
    dependents: string[];
    /** 拓扑层（0 起）：同层之间无依赖关系 */
    layer: number;
}

export interface UnitBoard {
    /** 全部节点，按 (层, 创建序) 排 —— 视图直接照这个顺序画 */
    rows: UnitBoardRow[];
    /** 各状态的 id 集合（顺序 = `rows` 顺序） */
    ready: string[];
    doing: string[];
    blocked: string[];
    done: string[];
    layers: UnitBoardRow[][];
    /**
     * 图里有环。**正常为 false**（`Store.linkUnits` 建边就挡环），
     * 所以它为 true 只可能是库里被别的东西写脏了 —— 视图该把它亮出来，而不是静默画歪。
     */
    cyclic: boolean;
}

/** 只取算 board 要用的字段（测试里可以直接造这几项，不用凑齐 UnitRecord） */
export type UnitFacts = Pick<UnitRecord, 'id' | 'title' | 'status' | 'seq'> &
    Partial<Pick<UnitRecord, 'body' | 'taskId' | 'createdAt' | 'updatedAt'>>;

/**
 * 算一张 board。输入顺序不敏感；输出顺序稳定（层 → 创建序 → id）。
 *
 * 分层用 Kahn：入度 0 的进第 0 层，剥掉它们后新的入度 0 进第 1 层……剥不动的就是环。
 */
export function unitBoard(units: readonly UnitFacts[], deps: readonly UnitDep[]): UnitBoard {
    const byId = new Map<string, UnitFacts>();
    for (const unit of units) byId.set(unit.id, unit);

    // 悬空边（端点不在图上）一律忽略：`removeUnit` 已经删边，这里只是防御脏数据
    const edges = deps.filter((dep) => byId.has(dep.from) && byId.has(dep.to));
    const depsOf = new Map<string, string[]>();
    const dependentsOf = new Map<string, string[]>();
    for (const unit of units) {
        depsOf.set(unit.id, []);
        dependentsOf.set(unit.id, []);
    }
    for (const edge of edges) {
        depsOf.get(edge.to)!.push(edge.from);
        dependentsOf.get(edge.from)!.push(edge.to);
    }

    const layerOf = new Map<string, number>();
    const pendingIn = new Map<string, number>();
    for (const unit of units) pendingIn.set(unit.id, depsOf.get(unit.id)!.length);
    let frontier = units.filter((unit) => pendingIn.get(unit.id) === 0).map((unit) => unit.id);
    let layer = 0;
    while (frontier.length > 0) {
        for (const id of frontier) layerOf.set(id, layer);
        const next: string[] = [];
        for (const id of frontier) {
            for (const to of dependentsOf.get(id)!) {
                const left = pendingIn.get(to)! - 1;
                pendingIn.set(to, left);
                if (left === 0) next.push(to);
            }
        }
        frontier = next;
        layer += 1;
    }

    const cyclic = layerOf.size !== units.length;
    // 环上的节点无法分层：放在最后一层，仍然列出来（不静默吞掉）
    const cyclicLayer = layer;
    for (const unit of units) if (!layerOf.has(unit.id)) layerOf.set(unit.id, cyclicLayer);

    const ready: string[] = [];
    const doing: string[] = [];
    const blocked: string[] = [];
    const done: string[] = [];

    const rows: UnitBoardRow[] = units
        .map((unit) => ({
            id: unit.id,
            title: unit.title,
            body: unit.body ?? '',
            status: unit.status,
            deps: depsOf.get(unit.id)!,
            dependents: dependentsOf.get(unit.id)!,
            layer: layerOf.get(unit.id)!,
        }))
        .sort((a, b) => {
            if (a.layer !== b.layer) return a.layer - b.layer;
            const seqA = byId.get(a.id)?.seq ?? 0;
            const seqB = byId.get(b.id)?.seq ?? 0;
            if (seqA !== seqB) return seqA - seqB;
            return a.id.localeCompare(b.id);
        });

    for (const row of rows) {
        if (row.status === 'done') done.push(row.id);
        else if (row.status === 'doing') doing.push(row.id);
        else {
            // ready 只看前置是否都 done —— 不做传递闭包，因为 `done` 已经是终态事实
            const allDone = row.deps.every((id) => byId.get(id)?.status === 'done');
            (allDone ? ready : blocked).push(row.id);
        }
    }

    const layers: UnitBoardRow[][] = [];
    for (const row of rows) {
        while (layers.length <= row.layer) layers.push([]);
        layers[row.layer]!.push(row);
    }

    return { rows, ready, doing, blocked, done, layers, cyclic };
}
