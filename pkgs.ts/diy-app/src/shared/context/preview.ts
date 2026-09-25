// src/shared/context/preview.ts
// 🎯 上下文树页的**视图数据**（纯函数）：把真实 globals 变成「树 + 规则 + 两份投递」。
//
// 数据是**当前任务的真实上下文**（`assembleGlobals` 的产物），不是编造的示范数据：
//   diy / project / task / cwd / chain(AGENTS.md 链) / skills
// 「真实」是刻意的选择 —— 编造的值（/repo/diy.sh 之类）会让人把界面上的内容
// 误当成当前任务的上下文，也看不出划分规则到底解决了什么问题。
//
// 规则表只声明 **system 名单**：没进名单的自动归 runtime（不是两套表，避免两边打架）。

import { project as projectTree } from "./projection";
import { applyFacts, createTree, setPlacement, setPlaces } from "./reducer";
import { previewOf, renderPathsTraced } from "./render";
import { getValue, isPlainObject, placeOf, rendererOf } from "./tree";
import { emptyCursor } from "./projection";
import { hashValue } from "./hash";
import { WIRE_VERSION } from "./wire";
import type { ContextContainer, ContextFact, ContextPath, ContextTreeState } from "./types";

/** 树节点（扁平列表；path 点分段自带层级，UI 按前缀缩进） */
export interface LabTreeNode {
    path: ContextPath;
    /** 是不是投递单元（place）本身 */
    isPlace: boolean;
    /** 渲染方式：yaml / text / template */
    renderer: string;
    /** 值的单行预览（父层级留空 —— 它的子树在下面几行里） */
    preview: string;
    /** 值 hash（前 12 位） */
    valueHash: string;
    /** 它属于哪个投递单元（无归属 = 不参与投递） */
    place: ContextPath | null;
    /** 所属单元落在哪个容器 */
    container: ContextContainer | null;
    /** 是不是有值（无值的节点只作为结构出现，值是空的） */
    hasValue: boolean;
}

/** 划分规则表的一行 = 一个投递单元 */
export interface LabRule {
    place: ContextPath;
    container: ContextContainer;
    /** 这个单元里有哪些渲染单元（会实际变成文本的 path） */
    renders: ContextPath[];
    /** 为什么归这边（人话） */
    reason: string;
}

/** 一份投递内容 */
export interface LabDelivery {
    places: ContextPath[];
    text: string;
    bytes: number;
    /**
     * path → 该 path 在 `text` 里的行号区间（1 基闭区间）。
     * 与 text 出自同一次渲染（`renderPathsTraced`），故高亮/滚动一定指得准。
     */
    lines: Record<ContextPath, { from: number; to: number }>;
}

/** 每步 diff 用到的快照（与 history.ts 的 StepSnapshot 同构） */
export interface LabSnapshotInput {
    valueHashes: Record<string, string>;
    systemText: string;
    systemPlaces: string[];
    runtimeText: string;
    runtimePlaces: string[];
}

export interface ContextLab {
    /** 这份上下文属于哪个任务 */
    taskUri: string;
    /** 数据来源说明 */
    source: string;
    wireVersion: string;
    tree: LabTreeNode[];
    rules: LabRule[];
    system: LabDelivery;
    runtime: LabDelivery;
    /**
     * 实际会发出去的请求体（JSON）—— 与真发同一条构造链，只把 messages 换成
     * 「system 份 + runtime 份」，这样看到的就是"这棵树最后变成什么请求"。
     */
    request: { body: Record<string, unknown> | null; note: string; model: string };
    /** 供「变更」view 记 step（值 hash 表 + 两份文本） */
    snapshot: LabSnapshotInput;
}

/** 候选投递单元（规则表里可选的行；不重叠） */
export interface PlaceCandidate {
    path: ContextPath;
    /** 默认是否归 system */
    system: boolean;
    /** 稳定性判断（也就是"为什么"） */
    reason: string;
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

/**
 * 候选投递单元 = 顶层字段 + 少数需要单独拆开的子字段。
 *
 * 为什么顶层之外还要拆：`task` 下面 `title/uri/state/dir` 在任务存续期内基本不变，
 * 而 `body` 每次编辑任务就变 —— 按第一层粗暴划分会把这两类塞进同一份，
 * 要么浪费 system 缓存，要么让易变内容污染 system。规则表的意义正在这里。
 */
export const PLACE_CANDIDATES: PlaceCandidate[] = [
    { path: "diy", system: true, reason: "进程身份（CLI / 数据根）：整个会话不变" },
    { path: "project", system: true, reason: "项目路径：只在切项目时变" },
    { path: "cwd", system: true, reason: "工作目录：任务存续期内固定" },
    { path: "chain", system: true, reason: "AGENTS.md 链：只在目录/文件改动时变" },
    { path: "task.title", system: true, reason: "任务标题：偶尔改一次" },
    { path: "task.uri", system: true, reason: "任务 URI：不变" },
    { path: "task.state", system: true, reason: "任务状态：偶尔改一次" },
    { path: "task.dir", system: true, reason: "任务目录：不变" },
    { path: "task.body", system: false, reason: "任务正文：每次编辑正文就变 → 放 runtime，不污染 system 缓存" },
    { path: "skills", system: false, reason: "技能清单：安装/升级技能就变" },
];

/** 默认 system 名单 */
export function defaultSystemPlaces(): ContextPath[] {
    return PLACE_CANDIDATES.filter((c) => c.system).map((c) => c.path);
}

function reasonFor(path: ContextPath): string {
    const hit = PLACE_CANDIDATES.find((c) => c.path === path);
    if (hit) return hit.reason;
    return "未登记的单元：默认归 runtime";
}

/** 把 globals 灌成一棵 Context Tree（每个顶层字段一条事实） */
export function treeOfGlobals(globals: Record<string, unknown>): ContextTreeState {
    void emptyCursor;
    let tree = createTree();
    const facts: ContextFact[] = Object.entries(globals).map(([k, v]) => ({
        type: "patch" as const,
        path: k,
        op: "set" as const,
        value: v,
    }));
    tree = applyFacts(tree, facts).state;
    return tree;
}

/** 树上的每一行（含中间容器；容器不显示值 —— 子树在下面几行里） */
function nodesOf(state: ContextTreeState): LabTreeNode[] {
    const out: LabTreeNode[] = [];
    /**
     * 递归成行。**数组也要展开** —— 否则 `chain`（AGENTS.md 链）只显示一行压缩摘要，
     * 看着就和"没有数据"一样；而这些元素恰恰是稳定性各不相同的独立变量
     * （`chain.0` = ~/AGENTS.md 很稳，`chain.3` = 项目 AGENTS.md 随项目变）。
     * 元素用下标寻址（`chain.0`），与 JSONPath 的 `$..chain[0]` 一一对应。
     */
    const walk = (node: unknown, base: string, isContainer: boolean): void => {
        if (base) {
            const spec = rendererOf(state, base);
            const present = getValue(state, base) !== undefined;
            const place = placeOf(state, base);
            out.push({
                path: base,
                isPlace: state.places.includes(base),
                renderer: spec.renderer,
                // 容器行（对象/数组）只表态：值在下面几行里，重复输出没有信息量
                preview: isContainer ? "" : previewOf(state, base),
                valueHash: hashValue(node).slice(0, 12),
                place,
                container: place ? (state.placement[place] ?? "runtime") : null,
                hasValue: present,
            });
        }
        if (isPlainObject(node)) {
            const entries = Object.entries(node);
            for (const [k, v] of entries) {
                walk(v, base ? `${base}.${k}` : k, isPlainObject(v) || Array.isArray(v));
            }
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((v, i) => walk(v, base ? `${base}.${i}` : String(i), isPlainObject(v) || Array.isArray(v)));
        }
    };
    walk(state.values, "", true);
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 组装视图数据（真实 globals + system 名单） */
export function buildLab(
    globals: Record<string, unknown>,
    systemPlaces: readonly ContextPath[],
    taskUri: string,
    /** 请求体（由 main 侧用真实 SDK 链 + 我们这两份内容构造；纯函数层不碰 SDK） */
    request: ContextLab["request"] = { body: null, note: "未构造请求体", model: "" },
): ContextLab {
    // places 取「候选里存在的」+ system 名单（后者可能含候选外的手填 path）
    const existing = new Set(Object.keys(globals));
    const inTree = (p: ContextPath): boolean => existing.has(p.split(".")[0]);
    const places = [...new Set([...PLACE_CANDIDATES.map((c) => c.path), ...systemPlaces])]
        .filter(inTree)
        .filter((p) => candidatesCompatible(p, systemPlaces))
        .sort();

    let tree = treeOfGlobals(globals);
    tree = setPlaces(tree, places);
    for (const p of places) {
        tree = setPlacement(tree, p, systemPlaces.includes(p) ? "system" : "runtime");
    }

    const sysPlaces = tree.places.filter((p) => tree.placement[p] === "system").sort();
    const runPlaces = tree.places.filter((p) => (tree.placement[p] ?? "runtime") === "runtime").sort();
    // 文本与行号映射同出一次渲染 —— 高亮/滚动才不会指错行
    const sys = renderPathsTraced(tree, sysPlaces);
    const run = renderPathsTraced(tree, runPlaces);
    const sysText = sys.text;
    const runText = run.text;

    const treeNodes = nodesOf(tree);
    return {
        taskUri,
        source: "当前任务的真实上下文（assembleGlobals 的产物）",
        wireVersion: WIRE_VERSION,
        tree: treeNodes,
        rules: tree.places.slice().sort().map((place) => ({
            place,
            container: tree.placement[place] ?? "runtime",
            renders: renderUnits(tree, place),
            reason: reasonFor(place),
        })),
        system: { places: sysPlaces, text: sysText, bytes: byteLen(sysText), lines: sys.lines },
        runtime: { places: runPlaces, text: runText, bytes: byteLen(runText), lines: run.lines },
        request,
        snapshot: {
            valueHashes: Object.fromEntries(treeNodes.map((n) => [n.path, n.valueHash])),
            systemText: sysText,
            systemPlaces: sysPlaces,
            runtimeText: runText,
            runtimePlaces: runPlaces,
        },
    };
}

/** 候选兼容性：与已选 system 名单不得互为祖先/后代（places 的硬规则） */
function candidatesCompatible(p: ContextPath, systemPlaces: readonly ContextPath[]): boolean {
    for (const s of systemPlaces) {
        if (s === p) continue;
        if (s.startsWith(`${p}.`) || p.startsWith(`${s}.`)) return false;
    }
    return true;
}

/** 该 place 下会实际变成文本的 path */
function renderUnits(state: ContextTreeState, place: ContextPath): ContextPath[] {
    const out: ContextPath[] = [];
    const walk = (node: unknown, base: string): void => {
        if (base && (base === place || base.startsWith(`${place}.`))) {
            if (!isPlainObject(node)) out.push(base);
        }
        if (!isPlainObject(node)) return;
        for (const [k, v] of Object.entries(node)) walk(v, base ? `${base}.${k}` : k);
    };
    walk(state.values, "");
    return out.sort();
}

/** 调试用：确认投影与 project() 口径一致 */
export const labProjection = (s: ContextTreeState) => projectTree(s, emptyCursor()).projection;
