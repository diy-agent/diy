/**
 * task-lineage — 一个任务所在的「整颗任务树」行（从根任务 DFS、树序、带深度）。
 *
 * 供 TaskDetailContent 的「任务树」块用。**以最近的根任务为根、展开它自己的子树**
 * （根任务下的所有兄弟分支都算「自己人」，自然纳入），当前任务标 `current`。
 * 出处：##183 第 4 点（hover 时只显示一条线很乱、脑疲劳，应显示整颗树并定位本任务），
 * 落地见 ##233；顶级场景见下（##258 / R4 收紧了 RV-04 的越界）。
 *
 * **当前任务本身就是顶级（根）**时退化为「自己 + 子孙」—— 不把项目下其余根任务
 * 一起平铺（RV-04 曾这么做，被 ##258 改回）。
 *
 * 父子关系的真相源是**任务树**（`parentUri`），不是 URI 路径 ——
 * `projects/<pid>/tasks/<n>` 只表达「哪个项目第几号」，不表达层级。
 */
import type { TreeNode } from "../store/taskStore";

export interface LineageRow {
    uri: string;
    /** 缩进层级：根任务从 0 起，子级依次 +1（与 URI 路径无关，由 parentUri 树决定） */
    depth: number;
    /** 是否为本视图的「当前任务」 */
    current: boolean;
    num?: string;
    title?: string;
    state?: string;
}

/** 在任务树里找节点（App / TaskTree 各有一份同形实现，这里再收一处） */
export function findNode(nodes: TreeNode[], uri: string): TreeNode | undefined {
    for (const n of nodes) {
        if (n.uri === uri) return n;
        const hit = findNode(n.children ?? [], uri);
        if (hit) return hit;
    }
    return undefined;
}

/** 从根到 uri 的节点链（含 uri 自己）；找不到返回 null */
function chainTo(nodes: TreeNode[], uri: string): TreeNode[] | null {
    for (const n of nodes) {
        if (n.uri === uri) return [n];
        const sub = chainTo(n.children ?? [], uri);
        if (sub) return [n, ...sub];
    }
    return null;
}

/**
 * 生成整树行（**从根任务深度优先、树序**）。
 *
 * 步骤：先求出从顶层到 `uri` 的链，链中**第一个有 uri 的节点**即根任务
 * （项目节点没有 uri、不能成行，故滤掉再取 —— 顺带避免「跳过一行」让后续缩进整体多一级）；
 * 再从该根任务 DFS 全部子孙。根任务下的兄弟分支因同属该根而自然纳入；
 * 但**项目下的其余根任务不属于本根**，顶级场景下不会出现（##258）。
 *
 * `seen` 兼作**防环**：脏数据（互相认父、自己当自己的子）不该把这里转死。
 * 根的父若指向已删除任务，`chainTo` 找不到自会以当前可达的顶层任务为根（##87 语义：
 * parent 悬空的任务视为根，不丢失）。
 */
export function lineageRows(nodes: TreeNode[], uri: string): LineageRow[] {
    const raw = chainTo(nodes, uri);
    // 树里还没有它（刚建 / 树未加载完）→ 只显示自己，不至于空白
    if (!raw || raw.length === 0) return [{ uri, depth: 0, current: true }];

    const rows: LineageRow[] = [];
    const seen = new Set<string>();
    const walk = (n: TreeNode, depth: number) => {
        if (!n.uri || seen.has(n.uri)) return;
        seen.add(n.uri);
        rows.push({
            uri: n.uri,
            depth,
            current: n.uri === uri,
            num: n.num,
            title: n.title,
            state: n.state,
        });
        for (const c of n.children ?? []) walk(c, depth + 1);
    };

    /*
     * 根 = 链中第一个有 uri 的节点（项目节点无 uri 不能成行）。
     * 从它 DFS 全部子孙即行 —— 根任务下的兄弟分支同属该根，自动纳入。
     *
     * **当前任务就是顶级时**，rootNode 即当前任务本身 → 只剩「自己 + 子孙」，
     * 项目下其余顶级任务（不属于本根）不再出现（##258 / R4）。
     * 不再按 `parent.kind === "project"` 把 DFS 起点换成「项目节点的全部任务子级」
     * —— RV-04 那套会让顶级任务平铺整个项目的顶级列表。
     */
    const firstIdx = raw.findIndex((n) => !!n.uri);
    const rootNode = raw[firstIdx]!;
    walk(rootNode, 0);
    return rows;
}

/**
 * `ancestor` 是否在 `uri` 的祖先链上（含直接父）—— 拖拽防环预检用（RV-07）：
 * 把任务拖到自己的子孙下会成环，main 侧有守卫（task.ts 防环），这里提前拦**只为体验**
 * （非法落点在客户端就报，不等 main 抛错）。数据安全本就由 main 保证。
 */
export function isAncestorOf(nodes: TreeNode[], ancestor: string, uri: string): boolean {
    const chain = chainTo(nodes, uri);
    if (!chain) return false;
    return chain.some((n) => n.uri === ancestor);
}
