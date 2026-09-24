// src/shared/context/preview.ts
// 🎯 上下文树试验场的**示范数据**与视图组装（纯函数，可在 node 里跑基准）。
//
// 一个前提必须说清：这里是**示范数据**，不是当前任务的真实上下文。
// 造它的理由：Context Tree 要落到 UI 上给人看，但真实接线属 108/146（本任务不接线），
// 所以造一棵**读得懂**的小树（像某个任务跑起来的样子），而不是运行时的真实值。
//
// 输出按「人怎么看这件事」组织，而不是按内部实现：
//   tree    一棵变量树（全部 path）
//   rules   ★核心：划分规则表 —— 哪个变量属于哪一份，为什么
//   system  稳定那份的 render 结果（进提示词开头，可缓存）
//   runtime 易变那份的 render 结果（进 user 消息）
//   message 两份合成后的消息形态

import { emptyCursor, project, runtimeText, systemText } from "./projection";
import { applyFacts, createTree, setPlacement, setPlaces, valueHashes } from "./reducer";
import { renderPlace, renderUnitsOf, toYaml } from "./render";
import { isPlainObject, placeOf, rendererOf } from "./tree";
import { WIRE_VERSION } from "./wire";
import type {
    ContextContainer,
    ContextFact,
    ContextPath,
    ContextTreeState,
} from "./types";

/** 树节点（扁平列表；path 点分段自带层级，UI 按前缀缩进即可） */
export interface LabTreeNode {
    path: ContextPath;
    /** 该 path 是不是投递单元（place）本身 */
    isPlace: boolean;
    /** 渲染方式：yaml / text / template */
    renderer: string;
    /** 值的单行预览（template 节点显示源码） */
    preview: string;
    /** 值 hash（前 12 位，人读用） */
    valueHash: string;
    /** 它属于哪个投递单元（无归属 = 不参与投递） */
    place: ContextPath | null;
    /** 所属单元落在哪个容器 */
    container: ContextContainer | null;
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
    /** 渲染后文本 */
    text: string;
    /** 字节数（预算视角） */
    bytes: number;
}

export interface ContextLab {
    /** 场景名 */
    scenario: string;
    /** 场景标题 */
    title: string;
    /** 一句话说明数据来源（必须是示范，不能让人误以为是当前任务） */
    note: string;
    wireVersion: string;
    tree: LabTreeNode[];
    rules: LabRule[];
    system: LabDelivery;
    runtime: LabDelivery;
    /** 合成后的消息形态 */
    message: { system: string; user: string; note: string };
}

/** 单行预览（长文本截断，换行折成 ⏎） */
function oneLine(v: unknown, max = 72): string {
    const text = isPlainObject(v) || Array.isArray(v) ? toYaml(v) : String(v ?? "");
    const flat = text.replace(/\n/g, " ⏎ ");
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

/** 树上每个 path 一行（对象自身也算一行 —— 容器在树里也要可见） */
function treeOf(state: ContextTreeState): LabTreeNode[] {
    const hashes = valueHashes(state);
    const out: LabTreeNode[] = [];
    const walk = (node: unknown, base: string): void => {
        if (base) {
            const spec = rendererOf(state, base);
            const place = placeOf(state, base);
            out.push({
                path: base,
                isPlace: state.places.includes(base),
                renderer: spec.renderer,
                preview: spec.renderer === "template" ? oneLine(spec.source) : oneLine(node),
                valueHash: (hashes[base] ?? "").slice(0, 12),
                place,
                container: place ? (state.placement[place] ?? "runtime") : null,
            });
        }
        if (!isPlainObject(node)) return;
        for (const [k, v] of Object.entries(node)) walk(v, base ? `${base}.${k}` : k);
    };
    walk(state.values, "");
    // 只有模板声明、值树里没有的 path 也要出现
    for (const [p, spec] of Object.entries(state.renderers)) {
        if (spec.renderer === "template" && !out.some((n) => n.path === p)) {
            const place = placeOf(state, p);
            out.push({
                path: p,
                isPlace: state.places.includes(p),
                renderer: "template",
                preview: oneLine(spec.source),
                valueHash: (hashes[p] ?? "").slice(0, 12),
                place,
                container: place ? (state.placement[place] ?? "runtime") : null,
            });
        }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 规则表的「为什么归这边」——按容器给一句话，具体理由看场景声明 */
function reasonFor(container: ContextContainer, why?: string): string {
    if (why) return why;
    return container === "system"
        ? "稳定：进程 / 项目 / 任务身份，跨 step 不变 → 进提示词开头，可被缓存"
        : "易变：随 step 或环境变化 → 进 user 消息，不污染 system 缓存";
}

/** 跑一个场景 → 试验场视图数据 */
export function runScenario(scenario: ContextScenario): ContextLab {
    let tree = createTree();
    for (const f of scenario.facts) tree = applyFacts(tree, [f]).state;
    tree = setPlaces(tree, scenario.places);
    for (const [p, c] of Object.entries(scenario.placement)) tree = setPlacement(tree, p, c);

    // 两份额之间的顺序按 place 字典序，golden/上屏都稳定
    const sysPlaces = tree.places.filter((p) => tree.placement[p] === "system").sort();
    const runPlaces = tree.places.filter((p) => (tree.placement[p] ?? "runtime") === "runtime").sort();
    const sysText = systemText(tree);
    const runText = runtimeText(tree);

    const rules: LabRule[] = tree.places
        .slice()
        .sort()
        .map((place) => ({
            place,
            container: tree.placement[place] ?? "runtime",
            renders: renderUnitsOf(tree, place),
            reason: reasonFor(tree.placement[place] ?? "runtime", scenario.why?.[place]),
        }));

    return {
        scenario: scenario.name,
        title: scenario.title,
        note: scenario.note ?? "示范数据：非当前任务的真实上下文",
        wireVersion: WIRE_VERSION,
        tree: treeOf(tree),
        rules,
        system: { places: sysPlaces, text: sysText, bytes: byteLen(sysText) },
        runtime: { places: runPlaces, text: runText, bytes: byteLen(runText) },
        message: {
            system: sysText,
            user: `Current runtime context:\n${runText || "none"}`,
            note: "system 进提示词开头（可缓存）；runtime 作为 user 消息附在末尾（supersedes=all）",
        },
    };
}

/** 让 project() 参与编译（本文件只用它做一致性校验，避免 treeꞏprojection 两套口径） */
export const previewProjection = (s: ContextTreeState) => project(s, emptyCursor()).projection;

export { renderPlace };

// ─── 场景（示范数据）──────────────────────────────────

export interface ContextScenario {
    name: string;
    title: string;
    note?: string;
    places: ContextPath[];
    placement: Record<ContextPath, ContextContainer>;
    facts: ContextFact[];
    /** 覆盖个别 place 的「为什么归这边」 */
    why?: Partial<Record<ContextPath, string>>;
}

/**
 * 一棵「像某个任务跑起来」的示范树：
 *   system 份 = 身份（diy / 项目 / 任务 / 项目说明）
 *   runtime 份 = 环境、技能、任务列表（这些每次都可能变）
 */
const TASK_SCENARIO: ContextScenario = {
    name: "task",
    title: "一个任务场景（示范）",
    note: "示范数据：这棵树是编的，不是当前任务的真实上下文（真实接线属 108/146）",
    places: ["diy", "env", "instructions", "project", "skills", "task", "tasks"],
    placement: {
        diy: "system",
        project: "system",
        task: "system",
        instructions: "system",
        env: "runtime",
        skills: "runtime",
        tasks: "runtime",
    },
    why: {
        diy: "进程身份：本次运行用哪个 CLI / 数据根，整个会话不变",
        instructions: "项目说明来自模版，只在任务/项目切换时变 —— 放 system 最省",
        env: "环境探测结果（可用的命令行工具）随机器/时间变，不该污染 system 缓存",
        skills: "技能清单随安装变动，属会话期易变项",
        tasks: "任务列表随其他任务的状态刷新而变，是最典型的易变项",
    },
    facts: [
        // system 份：身份
        { type: "patch", path: "diy.cli", op: "set", value: "/repo/diy.sh" },
        { type: "patch", path: "diy.home", op: "set", value: "~/.diy" },
        { type: "patch", path: "project.path", op: "set", value: "~/git/diy/diy" },
        { type: "patch", path: "project.label", op: "set", value: "diy" },
        { type: "patch", path: "task.uri", op: "set", value: "projects/4/tasks/148" },
        { type: "patch", path: "task.title", op: "set", value: "Context Tree 垂直切片" },
        { type: "patch", path: "task.state", op: "set", value: "active" },
        {
            type: "replace",
            path: "instructions.project",
            content: "<p>项目 {{project.label}}（{{project.path}}）</p>",
            contentFormat: "template-text",
        },
        // runtime 份：易变
        { type: "patch", path: "env.os.soft", op: "set", value: ["playwright-cli", "rg", "jq"] },
        { type: "patch", path: "env.clock", op: "set", value: "2026-09-24 22:40" },
        {
            type: "patch",
            path: "skills.list",
            op: "set",
            value: [
                { name: "dev-commit", desc: "规范化提交" },
                { name: "diy-dev", desc: "diy 开发工作流" },
            ],
        },
        { type: "patch", path: "tasks.140.status", op: "set", value: "done" },
        { type: "patch", path: "tasks.141.status", op: "set", value: "doing" },
        { type: "patch", path: "tasks.148.status", op: "set", value: "active" },
    ],
};

export const SCENARIOS: ContextScenario[] = [TASK_SCENARIO];

export function labDefault(): ContextLab {
    return runScenario(TASK_SCENARIO);
}

export function scenarioByName(name: string): ContextScenario {
    return SCENARIOS.find((s) => s.name === name) ?? TASK_SCENARIO;
}

export { runtimeText };
