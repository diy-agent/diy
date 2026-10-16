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
import { runtimeDiffEnvelope, systemDataText, systemEnvelope, runtimeEnvelope } from "./envelope";
import { hashValue } from "./hash";
import { WIRE_VERSION } from "./wire";
import { isPlainObject } from "./tree";
import type { ContextFact, ContextPath, ContextTreeState } from "./types";
import { TASK_HEAD_FIELDS, type TaskHeadField } from "../task-head";
import { emptyCursor } from "./projection";

/** 候选投递单元（规则表里可选的行；不重叠） */
export interface PlaceCandidate {
    path: ContextPath;
    /** 默认是否归 system */
    system: boolean;
    /** 稳定性判断（也就是"为什么"） */
    reason: string;
}

/** 任务头字段的投递理由（逐键必填：清单在 shared/task-head.ts 的 TASK_HEAD_FIELDS） */
const TASK_HEAD_REASONS: Record<TaskHeadField, string> = {
    title: "任务标题：偶尔改一次",
    state: "任务状态：偶尔改一次",
    parent: "父任务 URI：只在 move 时变",
    created: "创建时间：不变",
    updated: "最后编辑时间：编辑时变（与 title 同频）",
    change_type: "变更性质：偶尔改一次",
    module: "模块：偶尔改一次",
    priority: "优先级：偶尔改一次",
    persona: "绑定的人物：绑定时变（空 = 跟随缺省）",
};

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
    // 任务头（frontmatter）字段（##322：**读侧显式给头**，确认任务/取父级不必去 cat 文件）。
    // 它们就是文件头的同一份（不是副本），随文件走；容量都很小，与 title 同频（编辑就变）。
    // **名单不在此手抄**：path 从 TASK_HEAD_FIELDS 派生（##322 review R3），reason 必须逐键齐全
    // （Record<TaskHeadField,string> ⇒ 新增头字段漏写 reason 直接编译失败，这就是要的效果）。
    ...TASK_HEAD_FIELDS.map((f) => ({ path: `task.${f.key}`, system: true, reason: TASK_HEAD_REASONS[f.key] })),
    { path: "task.uri", system: true, reason: "任务 URI：不变" },
    { path: "task.dir", system: true, reason: "任务目录：不变" },
    // ── 模版节（identity / rules / guard，值是模版渲染结果；见 prompt-registry 的 DELIVERED_SECTIONS）──
    // 为什么必须有：它们此前**完全不在投递里**（名单没有 = 两个容器都不投）—— 真发于是丢掉
    // 人物行为指令、行为规范与保命契约（209 review P0-1 实测：persona/身份/<rules>/<guard> 全 false）。
    // 为什么不列 persona：身份节（identity.md）里已经有「人物是「X」」+ 行为指令，
    // 再列 persona 会把同一段指令投两遍（浪费前缀缓存、也让人分不清哪份为准）。
    { path: "identity", system: true, reason: "身份：人物名 + 行为指令（模版节渲染结果）；任务存续期内不变 → 可缓存" },
    { path: "rules", system: true, reason: "行为规范：静态文本，只在改模版时变" },
    { path: "guard", system: true, reason: "保命契约：静态文本，丢了模型可能换写法杀宿主进程" },
    // 「我自己的东西在哪、怎么找」：稳定信息 → 默认进 system。
    // 用户 2026-10-15：上下文树主要是**给模型定位信息**用的 —— 关键位置（我这个任务真发的请求
    // 落到哪个文件、怎么找）给不出来，模型就无法自查"我上一步到底发出去了什么"。
    // 值只有 `file`（纯数据）；路径规则/定位命令在 `.describe()` → 信封的 `help.reqlog`。
    { path: "reqlog", system: true, reason: "真发请求的流量日志在哪：稳定（仅文件名按天变）→ 可缓存" },
    { path: "task.body", system: false, reason: "任务正文：每次编辑正文就变 → 放 runtime，不污染 system 缓存" },
    { path: "skills", system: false, reason: "技能清单：安装/升级技能就变" },
];

/** 默认 system 名单（真发与预览共用；用户可在页面上改，改动只影响该页面预览） */
export function defaultSystemPlaces(): ContextPath[] {
    return PLACE_CANDIDATES.filter((c) => c.system).map((c) => c.path);
}

/** 一份容器的投递内容（信封里的一段） */
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

/**
 * 一轮请求的投递（真发用它发；预览用它显示；快照把它记下来给 diff 用）。
 *
 * 文本形态 = **信封**（见 envelope.ts）：`system.text` = `help:` + `system:` 两段的一份 YAML；
 * `runtime.text` = `runtime:` 一段（首投全量）。轮中途的 `runtimeDiff:` 由
 * `runtimeDiffDelivery` 按"变化的原子单元"现造。
 */
export interface Delivery {
    tree: ContextTreeState;
    /** system 容器全文（信封：`help:` + `system:`）→ 放 `streamText` 的 system 参数 */
    system: DeliveryPart;
    /** system 的**纯数据**部分（只有变量树、不带 help 段）—— golden 比对与调试用 */
    systemData: DeliveryPart;
    /** runtime 容器全文（信封：`runtime:` 一段）→ 作为尾部 user 消息 */
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
 * 一份 system 名单对应的**有效投递单元**（不含 `inTree` 过滤）：候选 ∪ 名单，再去掉与名单
 * 互为祖先后代的候选（`places` 的硬规则）。
 *
 * 为什么提出来：`buildDelivery` 与**历史归因**（`unitsFromSystemPlaces`）必须用同一份名单 ——
 * 各算一份必然漂移。反例（review RV-14）：只遍历 `PLACE_CANDIDATES` 时，手填的候选外单元被整个丢掉
 * （它的变化报成"无原因"）；名单里是**祖先级**单元（如手填 `task`）时，还会把被挤掉的候选
 * 当成幽灵单元造出来（`task.body` → 谎报 `task.body(runtime)`，实际该轮是 `task(system)`）。
 */
export function unitPathsOf(systemPlaces: readonly ContextPath[]): ContextPath[] {
    return [...new Set([...PLACE_CANDIDATES.map((c) => c.path), ...systemPlaces])].filter((p) =>
        candidatesCompatible(p, systemPlaces),
    );
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
    const places = unitPathsOf(systemPlaces).filter(inTree).sort();

    let tree = treeOfGlobals(globals);
    tree = setPlaces(tree, places);
    for (const p of places) tree = setPlacement(tree, p, systemPlaces.includes(p) ? "system" : "runtime");

    const sysPlaces = tree.places.filter((p) => tree.placement[p] === "system").sort();
    const runPlaces = tree.places.filter((p) => (tree.placement[p] ?? "runtime") === "runtime").sort();
    // system 信封：`help:`（**唯一的结构说明源**，由 zod 递归派生）+ `system:`（变量树）。
    // 一次产出同时给出文本与行号映射（emitValue 边写边记）—— 高亮/滚动才不会指错行；
    // 行号键剥掉 `system.` 前缀，与变量树 path 口径一致。
    const sys = systemEnvelope(tree, sysPlaces, runPlaces);
    const run = runtimeEnvelope(tree, runPlaces);

    const part = (p: ContextPath[], t: { text: string; lines: DeliveryPart["lines"] }): DeliveryPart => ({
        places: p,
        text: t.text,
        bytes: byteLen(t.text),
        lines: t.lines,
    });
    return {
        tree,
        system: part(sysPlaces, sys),
        systemData: part(sysPlaces, { text: systemDataText(tree, sysPlaces), lines: {} }),
        runtime: part(runPlaces, run),
        valueHashes: valueHashesOf(tree),
        wireVersion: WIRE_VERSION,
    };
}

/**
 * 轮中途那一步的 `runtimeDiff:` 信封（**只列变化的原子单元** → 变更后的当前值）。
 *
 * 为什么是「变更后的当前值」而不是 before/after 摘要：这一步的作用是**纠正模型手里的数据**
 * ——它要的是新值；旧值它本来就在上下文里（该轮首步的全量 runtime）。给截断的 before/after
 * 只会让它继续按旧值干活（那正是「几小时的会话建立在错误数据上」这个 bug 的形态）。
 *
 * 无变化的单元 → 空 places → 空串（调用方跳过注入，不砸前缀缓存）。
 */
export function runtimeDiffDelivery(tree: ContextTreeState, paths: readonly ContextPath[]): DeliveryPart {
    const sorted = [...paths].sort();
    const r = runtimeDiffEnvelope(tree, sorted);
    return { places: sorted, text: r.text, bytes: byteLen(r.text), lines: r.lines };
}

/**
 * 该 path 在这种划分下是否归 **runtime**。
 * 判据与 `buildDelivery` 同一套（不在 places 里的按 runtime 算）—— 分叉出一份"runtime 判据"
 * 必然与真发漂移（哪里是 system 才是真源）。
 */
export function isRuntimePlace(tree: ContextTreeState, path: ContextPath): boolean {
    return !tree.places.includes(path) || (tree.placement[path] ?? "runtime") === "runtime";
}

/** 调试用：确认投递与 project() 口径一致 */
export const deliveryProjection = (s: ContextTreeState) => projectTree(s, emptyCursor()).projection;
