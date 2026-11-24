/**
 * units.ts —— 任务内「分解树 + 执行依赖」的**派生量**（纯函数，无 IO）。
 *
 * # 两种关系，各管一件事（2026-11-24 用户裁）
 *
 *   · **树（`parent`）= 组成**：这块功能由哪些子块构成。人分解需求时说的话，天然是递归切分。
 *   · **边（`deps`）= 先后**：谁做完才能做谁。真正的执行约束，常常**跨功能域**。
 *
 * 压成一张扁平 DAG（只有节点 + 边）的代价是「顺序」必须全部显式 —— 实测里模型并行发 9 次
 * `unit_add`、`deps` 全空、然后自己补 9 条边；它并不是漏了，是「分解」和「排顺序」被挤进
 * 同一个调用。分开之后，**同父兄弟按 `seq` 先后串行**，树本身就是执行顺序的骨架：
 * 域内的线性推进不用画边，只有跨域才补 `unit_link`。
 *
 * # 三条判据
 *
 *   · `ready`   = **叶子** 且 open 且「所有 deps 做完」且「同父前序兄弟都做完」
 *   · `blocked` = 叶子且 open，但不满足上面任一条 —— 为什么卡住由 `heldBy` / `deps` 说清
 *   · 容器（有子）**不进 ready / blocked / doing**：它是功能域分组，不是可执行单元。
 *     状态派生：子全 done → done，否则不进行动集合（`groups` 列出来，视图照样上色）。
 *
 * 「删节点 = 解锁后继」不在这里处理：边在删除时已经随节点删掉，这里只看现存事实。
 */
import type { BatchRecord, UnitDep, UnitRecord, UnitStatus } from './db';

/** 一个节点 + 它在树上的位置 + 在依赖图上的位置 */
export interface UnitBoardRow {
    id: string;
    title: string;
    body: string;
    /**
     * **有效**状态：叶子 = 落库值；容器 = 由子派生（全 done → done，否则 open）。
     * 容器节点落库的 status 不参与判断 —— 只有叶子能被勾 done。
     */
    status: UnitStatus;
    /** 父（功能域）；`null` = 根。父不存在（悬空 / 脏数据）时这里也报 `null`，见 `danglingParents` */
    parent: string | null;
    /** 子节点（按 `seq` 排 = 兄弟先后） */
    children: string[];
    /** 有没有子 = 是不是「功能域容器」 */
    group: boolean;
    /** 树深（根 = 0）：视图按它缩进，`rows` 本身已是树的先序 */
    depth: number;
    /** 前置：这些做完才能做我（跨域边 + 同批显式给的边） */
    deps: string[];
    /** 后继：我做完才能做它们 */
    dependents: string[];
    /** 拓扑层（0 起）：按 `deps` 算，不是树的深度 —— 它回答「哪几条能同时做」 */
    layer: number;
    /** 所属**交付批次**的 id；`null` = 未分批。与 parent / deps 正交，见 `UnitBatchView` */
    batch: string | null;
}

export interface UnitBoard {
    /** 全部节点，**树的先序**（根按 seq，子按 seq）—— 视图直接照这个顺序缩进绘制 */
    rows: UnitBoardRow[];
    /** 根节点 id（树的先序） */
    roots: string[];
    /** 现在能做的：**只有叶子**（容器是分组，永远不进这里） */
    ready: string[];
    /** 正在做的叶子 */
    doing: string[];
    /** 卡住的叶子，按「离能做的距离」排不出来就不要排 —— 顺序 = 树先序 */
    blocked: string[];
    /** 派生状态为 done 的**全部**节点（含子已全 done 的容器） */
    done: string[];
    /** 容器（有子）的 id，树先序 */
    groups: string[];
    /**
     * 叶子被别人挡住的**直接原因**：`id → 挡住它的那个 id`。
     * 兄弟串行挡住时指向前序兄弟（这不是 `deps`，把边画出来会淹掉真正的跨域约束）。
     */
    heldBy: Record<string, string>;
    layers: UnitBoardRow[][];
    /**
     * 依赖图有环。**正常为 false**（`Store.linkUnits` 建边就挡环），
     * 所以它为 true 只可能是库里被别的东西写脏了 —— 视图该把它亮出来，而不是静默画歪。
     */
    cyclic: boolean;
    /** 父指向一个不存在的 id（脏数据 / 先建子后建父的中间态）：这些节点当根处理并报出来 */
    danglingParents: string[];
}

/** 只取算 board 要用的字段（测试里可以直接造这几项，不用凑齐 UnitRecord） */
export type UnitFacts = Pick<UnitRecord, 'id' | 'title' | 'status' | 'seq'> &
    Partial<Pick<UnitRecord, 'body' | 'parent' | 'taskId' | 'batch' | 'createdAt' | 'updatedAt'>>;

/**
 * 算一张 board。输入顺序不敏感；输出顺序稳定（树的先序 → 层 → 创建序 → id）。
 *
 * 分层用 Kahn：入度 0 的进第 0 层，剥掉它们后新的入度 0 进第 1 层……剥不动的就是环。
 */
export function unitBoard(units: readonly UnitFacts[], deps: readonly UnitDep[]): UnitBoard {
    const byId = new Map<string, UnitFacts>();
    for (const unit of units) byId.set(unit.id, unit);
    const seqOf = (id: string): number => byId.get(id)?.seq ?? 0;

    // ── 树：parent → children（子按 seq，兄弟先后即 seq 先后）────────────────
    const danglingParents: string[] = [];
    const parentOf = new Map<string, string | null>();
    for (const unit of units) {
        const parent = unit.parent ?? null;
        // 父不存在（悬空）= 当根；自己也不是自己的父
        parentOf.set(unit.id, parent !== null && parent !== unit.id && byId.has(parent) ? parent : null);
        if (parent !== null && (parent === unit.id || !byId.has(parent))) danglingParents.push(unit.id);
    }
    // 父链成环（脏数据）：环上的节点当根，免得下面的遍历转不出来
    for (const unit of units) {
        const seen = new Set<string>([unit.id]);
        let cursor = parentOf.get(unit.id) ?? null;
        while (cursor !== null) {
            if (seen.has(cursor)) {
                parentOf.set(unit.id, null);
                if (!danglingParents.includes(unit.id)) danglingParents.push(unit.id);
                break;
            }
            seen.add(cursor);
            cursor = parentOf.get(cursor) ?? null;
        }
    }
    const childrenOf = new Map<string, string[]>();
    for (const unit of units) childrenOf.set(unit.id, []);
    for (const unit of units) {
        const parent = parentOf.get(unit.id) ?? null;
        if (parent !== null) childrenOf.get(parent)!.push(unit.id);
    }
    for (const children of childrenOf.values()) {
        children.sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
    }

    // 树的先序（根按 seq）：`rows` 的排序就是它 —— 视图照这个顺序缩进即可
    const roots = units
        .filter((unit) => (parentOf.get(unit.id) ?? null) === null)
        .map((unit) => unit.id)
        .sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
    const order: string[] = [];
    const depthOf = new Map<string, number>();
    const walk = (id: string, depth: number): void => {
        if (depthOf.has(id)) return; // 防御：环已经被拆掉了，这里只是别让脏数据无限递归
        depthOf.set(id, depth);
        order.push(id);
        for (const child of childrenOf.get(id) ?? []) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);

    // ── 依赖边 ─────────────────────────────────────────────────────────
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

    // ── 有效状态：自底向上（先序的逆序 = 子一定先算完）────────────────────
    const statusOf = new Map<string, UnitStatus>();
    for (const id of [...order].reverse()) {
        const children = childrenOf.get(id) ?? [];
        if (children.length === 0) {
            statusOf.set(id, byId.get(id)!.status);
            continue;
        }
        const childStatuses = children.map((child) => statusOf.get(child)!);
        statusOf.set(
            id,
            childStatuses.every((status) => status === 'done') ? 'done' : 'open',
        );
    }
    const isDone = (id: string): boolean => statusOf.get(id) === 'done';

    // ── ready / blocked：只有叶子能执行；兄弟串行 = 前序兄弟都要 done ─────────
    //
    // 串行要**沿父链传递**：第二个功能域（根 `e`）被第一个域（根 `d`）挡着时，`e` 的子也一起被挡
    // —— 否则「域间串行」就只约束了容器的状态，不约束里面真正干活的叶子（实现时漏过这一条，
    // 第二个域的叶子会提前变 ready）。
    const ready: string[] = [];
    const doing: string[] = [];
    const blocked: string[] = [];
    const done: string[] = [];
    const heldBy: Record<string, string> = {};

    /** 一个节点的兄弟集合（根之间也算兄弟：多个功能域默认按书写顺序推进） */
    const siblingsOf = (id: string): string[] => {
        const parent = parentOf.get(id) ?? null;
        return parent === null ? roots : (childrenOf.get(parent) ?? []);
    };

    /**
     * 沿祖先链看「还有哪个前序兄弟没做完」：返回**最近的一个**（叶子自己的兄弟优先）。
     *
     * 两个例外：
     *   · **显式依赖优先于书写顺序** —— 如果前序兄弟反过来依赖我（`我 → 它` 有边），它不能被自己的
     *     位置挡住，否则两边互等：实测场景是「先建的 A 声明 deps: ['B']，B 后建、seq 更大」——
     *     不跳过就会 A 等 B（依赖）+ B 等 A（兄弟序）= 两个都做不了。
     *   · `isDone` 用派生状态，所以容器一旦子全完成就不再挡后面。
     */
    const pendingAncestorSibling = (id: string): string | undefined => {
        let cursor: string | null = id;
        while (cursor !== null) {
            const siblings = siblingsOf(cursor);
            const position = siblings.indexOf(cursor);
            const unfinished =
                position <= 0
                    ? undefined
                    : [...siblings.slice(0, position)]
                          .reverse()
                          .find((sib) => !isDone(sib) && !(depsOf.get(sib) ?? []).includes(cursor!));
            if (unfinished !== undefined) return unfinished;
            cursor = parentOf.get(cursor) ?? null;
        }
        return undefined;
    };

    for (const id of order) {
        const status = statusOf.get(id)!;
        const children = childrenOf.get(id) ?? [];
        if (children.length > 0) {
            if (status === 'done') done.push(id);
            continue; // 容器不进 ready / doing / blocked
        }
        if (status === 'done') {
            done.push(id);
            continue;
        }
        if (status === 'doing') {
            doing.push(id);
            continue;
        }
        // open 的叶子：三件事都得满足 —— 自己的 deps、同父前序兄弟、以及不悬空
        const unfinishedDep = (depsOf.get(id) ?? []).find((dep) => !isDone(dep));
        if (unfinishedDep !== undefined) {
            heldBy[id] = unfinishedDep;
            blocked.push(id);
            continue;
        }
        // 兄弟串行：自己前序兄弟 + 每一层祖先的前序兄弟（域间串行靠这条传递下来）
        const unfinishedSibling = pendingAncestorSibling(id);
        if (unfinishedSibling !== undefined) {
            heldBy[id] = unfinishedSibling;
            blocked.push(id);
            continue;
        }
        ready.push(id);
    }

    const groupSet = new Set(units.filter((unit) => (childrenOf.get(unit.id) ?? []).length > 0).map((unit) => unit.id));

    const rows: UnitBoardRow[] = order.map((id) => {
        const unit = byId.get(id)!;
        return {
            id,
            title: unit.title,
            body: unit.body ?? '',
            status: statusOf.get(id)!,
            parent: parentOf.get(id) ?? null,
            children: childrenOf.get(id) ?? [],
            group: groupSet.has(id),
            depth: depthOf.get(id) ?? 0,
            deps: depsOf.get(id)!,
            dependents: dependentsOf.get(id)!,
            layer: layerOf.get(id)!,
            batch: unit.batch ?? null,
        };
    });

    const layers: UnitBoardRow[][] = [];
    for (const row of [...rows].sort((a, b) => a.layer - b.layer)) {
        while (layers.length <= row.layer) layers.push([]);
        layers[row.layer]!.push(row);
    }

    return {
        rows,
        roots,
        ready,
        doing,
        blocked,
        done,
        groups: rows.filter((row) => row.group).map((row) => row.id),
        heldBy,
        layers,
        cyclic,
        danglingParents,
    };
}

/**
 * 把 board 渲染成**缩进树文本**（一行一个节点）—— 给人看、也直接进 system 上下文。
 *
 * 为什么不是 JSON：树的形状用缩进就表达完了，JSON 要为每层付 `{"children":[...]}` 的税，
 * 20 个节点能差出三四倍 token，而模型读缩进列表和读嵌套 JSON 一样准。
 *
 * 每行：`<缩进>- [状态] title （id）`，后面按需接 `← 等 <id>`（被谁挡着）。
 */
export function unitTreeLines(
    board: UnitBoard,
    options?: {
        withBody?: boolean;
        /** 行尾标上所属批次（`〔p1〕`）—— 分批是正交的一层，树本身不按批次分组 */
        withBatch?: boolean;
    },
): string[] {
    const blocked = new Set(board.blocked);
    const doing = new Set(board.doing);
    const ready = new Set(board.ready);
    return board.rows.map((row) => {
        const indent = '  '.repeat(row.depth);
        const mark = row.status === 'done' ? 'x' : ready.has(row.id) ? '>' : doing.has(row.id) ? '~' : blocked.has(row.id) ? '.' : ' ';
        const tail: string[] = [];
        if (options?.withBatch === true && row.batch !== null) tail.push(`〔${row.batch}〕`);
        if (board.heldBy[row.id] !== undefined) tail.push(`← 等 ${board.heldBy[row.id]}`);
        if (options?.withBody === true && row.body !== '') tail.push(`body: ${row.body}`);
        return `${indent}- [${mark}] ${row.title} (${row.id})${tail.length === 0 ? '' : `  ${tail.join('  ')}`}`;
    });
}

// ── 交付批次（派发 / 验收的单位）──────────────────────────────────────

/**
 * 批次的**派生阶段**。注意它不是说「批次有状态」—— 批次自己只存 `acceptedAt` 一个事实，
 * 其余全从成员推出来：
 *
 *   · `empty`    —— 还没挂成员（刚建的空批，只占个位子）
 *   · `todo`     —— 有活但一个都开不了（整批被批外挡着，看 `waitingOn`）
 *   · `active`   —— 有可做 / 正在做（**派发的最佳时机**：这时才有人有事干）
 *   · `review`   —— 成员全做完、还没验收（该有人看一眼 diff 说「过」）
 *   · `accepted` —— 验收通过
 *
 * `accepted` 反过来压过其他阶段：验收过再往里加活，阶段仍是 accepted，但会多出一个提醒（见视图）。
 */
export type UnitBatchStage = 'empty' | 'todo' | 'active' | 'review' | 'accepted';

export interface UnitBatchView {
    id: string;
    title: string;
    note: string;
    acceptedAt: number | null;
    stage: UnitBatchStage;
    /** 成员（**树先序**，与 board.rows 一致）；容器也算 —— 整域划进来时容器就是这批的骨架 */
    members: string[];
    /** 成员里的叶子，按 ready / doing / blocked / done 分桶（容器只可能出现在 done） */
    ready: string[];
    doing: string[];
    blocked: string[];
    done: string[];
    /** 挡住本批的**批外**节点（直接原因，去重、树先序）：这些不完成，本批开不了工 */
    waitingOn: string[];
    total: number;
    doneCount: number;
}

/** 只取算批次视图要用的字段（测试里直接造这几项） */
export type BatchFacts = Pick<BatchRecord, 'id' | 'title'> &
    Partial<Pick<BatchRecord, 'note' | 'acceptedAt' | 'seq'>>;

/**
 * 把「批次 × 图」算成视图列表（纯函数）。不传批次就没有视图 —— **批次必须显式存在**，
 * 不从树的形状推导（2026-11-24 用户裁）：域边界只是常见情形，真判据是「一次 diff 能不能看懂」。
 *
 * 顺序：先按批次自己的写入序，再按成员在树里第一次出现的位置 —— 全空批不会插到中间把人搞乱。
 */
export function unitBatchViews(board: UnitBoard, batches: readonly BatchFacts[]): UnitBatchView[] {
    const ready = new Set(board.ready);
    const doing = new Set(board.doing);
    const blocked = new Set(board.blocked);
    const done = new Set(board.done);
    const position = new Map<string, number>();
    board.rows.forEach((row, index) => position.set(row.id, index));

    return batches
        .map((batch) => {
            const members = board.rows.filter((row) => row.batch === batch.id).map((row) => row.id);
            const memberSet = new Set(members);
            const of = (set: Set<string>): string[] => members.filter((id) => set.has(id));

            // 批外挡路者：成员被挡住时，`heldBy` 指向批外 = 本批的入场券。只报直接原因（不追链）
            const waitingOn: string[] = [];
            for (const id of members) {
                const holder = board.heldBy[id];
                if (holder === undefined || memberSet.has(holder) || waitingOn.includes(holder)) continue;
                waitingOn.push(holder);
            }
            // 只依赖批外节点、又没被 heldBy 点名的（比如 deps 指出去）也补上
            for (const id of members) {
                for (const dep of board.rows[position.get(id)!]!.deps) {
                    if (memberSet.has(dep) || done.has(dep) || waitingOn.includes(dep)) continue;
                    waitingOn.push(dep);
                }
            }
            waitingOn.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));

            const readyOf = of(ready);
            const doingOf = of(doing);
            const blockedOf = of(blocked);
            const doneOf = of(done);
            const total = members.length;

            let stage: UnitBatchStage;
            if (batch.acceptedAt !== null && batch.acceptedAt !== undefined) stage = 'accepted';
            else if (total === 0) stage = 'empty';
            else if (doneOf.length === total) stage = 'review';
            else if (readyOf.length + doingOf.length > 0) stage = 'active';
            else stage = 'todo';

            return {
                id: batch.id,
                title: batch.title,
                note: batch.note ?? '',
                acceptedAt: batch.acceptedAt ?? null,
                stage,
                members,
                ready: readyOf,
                doing: doingOf,
                blocked: blockedOf,
                done: doneOf,
                waitingOn,
                total,
                doneCount: doneOf.length,
            };
        })
        .sort((a, b) => {
            const seqA = batches.find((batch) => batch.id === a.id)?.seq ?? 0;
            const seqB = batches.find((batch) => batch.id === b.id)?.seq ?? 0;
            const firstA = a.members.length === 0 ? Number.MAX_SAFE_INTEGER : (position.get(a.members[0]!) ?? 0);
            const firstB = b.members.length === 0 ? Number.MAX_SAFE_INTEGER : (position.get(b.members[0]!) ?? 0);
            return seqA - seqB || firstA - firstB || a.id.localeCompare(b.id);
        });
}
