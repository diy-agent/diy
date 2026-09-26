// src/shared/context/delivery.ts
// 🎯 一轮请求的**投递内容**（真发与预览的唯一构造入口，纯函数）。
//
// 为什么必须同源：预览的全部价值就是"看到的就是会发出去的"。真发（local-agent 的 runTurn）
// 与预览（ctxlab 页）都调本文件 —— 同一份 globals、同一份 system 名单、同一套渲染，
// 于是两边逐字节相同；任何"预览另算一份"的写法都会让两边慢慢漂移。
//
// 两个容器（144 的结论，实现上就是两段文本 + 两种投递位置）：
//   system  —— 每次请求**全量重建**，放 streamText 的 system 参数（不进消息历史，故天然无补丁）
//   runtime —— 易变部分，作为**尾部 user 消息**投递（不进块树/llm 历史，每轮现拼，故不会累积）
//
// 划分只声明 **system 名单**：没进名单的自动归 runtime（不是两套表，避免两边打架）。

import { project as projectTree } from "./projection";
import { applyFacts, createTree, setPlacement, setPlaces } from "./reducer";
import { renderPathsTraced } from "./render";
import { CONTEXT_GUIDE } from "./guide";
import { hashValue } from "./hash";
import { WIRE_VERSION } from "./wire";
import { isPlainObject } from "./tree";
import type { ContextFact, ContextPath, ContextTreeState } from "./types";
import { emptyCursor } from "./projection";

/** 候选投递单元（规则表里可选的行；不重叠） */
export interface PlaceCandidate {
    path: ContextPath;
    /** 默认是否归 system */
    system: boolean;
    /** 稳定性判断（也就是"为什么"） */
    reason: string;
}

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

/** 默认 system 名单（真发与预览共用；用户可在页面上改，改动只影响该页面预览） */
export function defaultSystemPlaces(): ContextPath[] {
    return PLACE_CANDIDATES.filter((c) => c.system).map((c) => c.path);
}

/** 一份容器的投递内容 */
export interface DeliveryPart {
    places: ContextPath[];
    text: string;
    bytes: number;
    /**
     * path → 该 path 在 `text` 里的行号区间（1 基闭区间）。
     * 与 text 出自同一次渲染（`renderPathsTraced`），故高亮/滚动一定指得准。
     */
    lines: Record<ContextPath, { from: number; to: number }>;
}

/** 一轮请求的投递（真发用它发；预览用它显示；快照把它记下来给 diff 用） */
export interface Delivery {
    tree: ContextTreeState;
    /** system 容器全文（含说明头）：放 system 参数 */
    system: DeliveryPart;
    /** system 的**纯数据**部分（不带说明头）—— golden 比对与调试用 */
    systemData: DeliveryPart;
    /** runtime 容器全文：作为尾部 user 消息 */
    runtime: DeliveryPart;
    /** path → 子树值 hash（前 12 位）：步间比较"哪些变量变了" */
    valueHashes: Record<ContextPath, string>;
    wireVersion: string;
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

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

/** 值树里每个节点一条 hash（含中间容器；父的 hash 就是它整棵子树的 hash） */
function valueHashesOf(state: ContextTreeState): Record<ContextPath, string> {
    const out: Record<ContextPath, string> = {};
    const walk = (node: unknown, base: string): void => {
        if (base) out[base] = hashValue(node).slice(0, 12);
        if (isPlainObject(node)) {
            for (const [k, v] of Object.entries(node)) walk(v, base ? `${base}.${k}` : k);
        } else if (Array.isArray(node)) {
            node.forEach((v, i) => walk(v, base ? `${base}.${i}` : String(i)));
        }
    };
    walk(state.values, "");
    return out;
}

/** 候选兼容性：与已选 system 名单不得互为祖先/后代（places 的硬规则） */
function candidatesCompatible(p: ContextPath, systemPlaces: readonly ContextPath[]): boolean {
    for (const s of systemPlaces) {
        if (s === p) continue;
        if (s.startsWith(`${p}.`) || p.startsWith(`${s}.`)) return false;
    }
    return true;
}

/**
 * 构造一轮投递（**真发与预览的唯一入口**）。
 * systemPlaces 缺省用推荐名单；名单里不存在于值树的 path 自动忽略（不报错：
 * 名单是用户偏好，跨任务复用时会有些 path 没有）。
 */
export function buildDelivery(
    globals: Record<string, unknown>,
    systemPlaces: readonly ContextPath[] = defaultSystemPlaces(),
): Delivery {
    // places 取「候选里存在的」+ system 名单（后者可能含候选外的手填 path）
    const existing = new Set(Object.keys(globals));
    const inTree = (p: ContextPath): boolean => existing.has(p.split(".")[0]);
    const places = [...new Set([...PLACE_CANDIDATES.map((c) => c.path), ...systemPlaces])]
        .filter(inTree)
        .filter((p) => candidatesCompatible(p, systemPlaces))
        .sort();

    let tree = treeOfGlobals(globals);
    tree = setPlaces(tree, places);
    for (const p of places) tree = setPlacement(tree, p, systemPlaces.includes(p) ? "system" : "runtime");

    const sysPlaces = tree.places.filter((p) => tree.placement[p] === "system").sort();
    const runPlaces = tree.places.filter((p) => (tree.placement[p] ?? "runtime") === "runtime").sort();
    // 文本与行号映射同出一次渲染 —— 高亮/滚动才不会指错行。
    // system 份带说明头（结构 + 解读规则，纯文本，见 guide.ts）：这就是"提示词"本体，
    // 要先说明这是什么、怎么读。
    const sys = renderPathsTraced(tree, sysPlaces, CONTEXT_GUIDE);
    const sysData = renderPathsTraced(tree, sysPlaces);
    const run = renderPathsTraced(tree, runPlaces);

    const part = (p: ContextPath[], t: { text: string; lines: DeliveryPart["lines"] }): DeliveryPart => ({
        places: p,
        text: t.text,
        bytes: byteLen(t.text),
        lines: t.lines,
    });
    return {
        tree,
        system: part(sysPlaces, sys),
        systemData: part(sysPlaces, sysData),
        runtime: part(runPlaces, run),
        valueHashes: valueHashesOf(tree),
        wireVersion: WIRE_VERSION,
    };
}

/** 调试用：确认投递与 project() 口径一致 */
export const deliveryProjection = (s: ContextTreeState) => projectTree(s, emptyCursor()).projection;
