// src/shared/context/preview.ts
// 🎯 上下文树页的**视图数据**（纯函数）：把真实 globals 变成「树 + 规则 + 两份投递」。
//
// 数据是**当前任务的真实上下文**（`assembleGlobals` 的产物），不是编造的示范数据：
//   diy / project / task / cwd / chain(AGENTS.md 链) / skills
// 「真实」是刻意的选择 —— 编造的值（/repo/diy.sh 之类）会让人把界面上的内容
// 误当成当前任务的上下文，也看不出划分规则到底解决了什么问题。
//
// 规则表只声明 **system 名单**：没进名单的自动归 runtime（不是两套表，避免两边打架）。

import { previewOf } from "./render";
import { getValue, isPlainObject, placeOf, rendererOf } from "./tree";
import { hashValue } from "./hash";
import { emptyCursor, project as projectTree } from "./projection";
import {
    buildDelivery,
    PLACE_CANDIDATES,
    type Delivery,
    type DeliveryPart,
} from "./delivery";
import type { ContextContainer, ContextPath, ContextTreeState } from "./types";

// 划分策略与投递构造住在 delivery.ts（真发与预览共用那一条链），这里只做转出，
// 让"页面数据"与"投递内容"两个概念在 import 处也分得清。
export { PLACE_CANDIDATES, defaultSystemPlaces } from "./delivery";
export type { PlaceCandidate, DeliveryPart as LabDelivery, Delivery } from "./delivery";

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
    system: DeliveryPart;
    runtime: DeliveryPart;
    /**
     * 实际会发出去的请求体（JSON）—— 与真发同一条构造链，只把 messages 换成
     * 「system 份 + runtime 份」，这样看到的就是"这棵树最后变成什么请求"。
     */
    request: { body: Record<string, unknown> | null; note: string; model: string };
    /** 供「变更」view 记 step（值 hash 表 + 两份文本） */
    snapshot: LabSnapshotInput;
}

/** 该 place 为什么归这边（人话；未登记的给默认说明） */
function reasonFor(path: ContextPath): string {
    const hit = PLACE_CANDIDATES.find((c) => c.path === path);
    if (hit) return hit.reason;
    return "未登记的单元：默认归 runtime";
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

/** 组装视图数据（真实 globals + system 名单；投递部分走 delivery.ts 的同一条链） */
export function buildLab(
    globals: Record<string, unknown>,
    systemPlaces: readonly ContextPath[],
    taskUri: string,
    /** 请求体（由 main 侧用真实 SDK 链 + 我们这两份内容构造；纯函数层不碰 SDK） */
    request: ContextLab["request"] = { body: null, note: "未构造请求体", model: "" },
): ContextLab {
    const d: Delivery = buildDelivery(globals, systemPlaces);
    const treeNodes = nodesOf(d.tree);
    return {
        taskUri,
        source: "当前任务的真实上下文（assembleGlobals 的产物）",
        wireVersion: d.wireVersion,
        tree: treeNodes,
        rules: d.tree.places.slice().sort().map((place) => ({
            place,
            container: d.tree.placement[place] ?? "runtime",
            renders: renderUnits(d.tree, place),
            reason: reasonFor(place),
        })),
        system: d.system,
        runtime: d.runtime,
        request,
        snapshot: {
            valueHashes: d.valueHashes,
            systemText: d.system.text,
            systemPlaces: d.system.places,
            runtimeText: d.runtime.text,
            runtimePlaces: d.runtime.places,
        },
    };
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
