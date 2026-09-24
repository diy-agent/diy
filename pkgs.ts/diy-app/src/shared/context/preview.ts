// src/shared/context/preview.ts
// 🎯 试验场用：把一组内置场景跑成「树 + 每步投递动作」（纯函数，可在 node 里跑基准）。
//
// 为什么场景要在 shared 而不是 main：它只是 ContextTree 的一组固定输入，和渲染器无关；
// 放这里测试能直接断言，UI 只是把它画出来。
//
// 三个场景各对应 144 结论里最容易被实现错的三块：
//   basic    —— 投递四态（snapshot / patch / none / clear）
//   template —— renderedHash 才是投递判据（值变了但渲染没变 → 不发）
//   boundary —— placement 迁移与 wire 版本变化 → rebaseline

import { project } from "./projection";
import { applyFacts, createTree, setPlacement, setPlaces, stepDelta, valueHashes } from "./reducer";
import { isPlainObject, rendererOf } from "./tree";
import { toYaml } from "./render";
import { WIRE_VERSION } from "./wire";
import type {
    ContextContainer,
    ContextFact,
    ContextPath,
    ContextTreeState,
    RuntimeCursor,
    RuntimeDelivery,
} from "./types";

export interface PreviewStep {
    note: string;
    facts: ContextFact[];
    /** 这一步之后做一次 placement 迁移（可选） */
    migrate?: { path: ContextPath; container: ContextContainer };
    /** 把水位里的 wireVersion 改旧，模拟「换过 wire 编码」（可选） */
    staleWire?: boolean;
}

export interface ContextScenario {
    name: string;
    title: string;
    places: ContextPath[];
    placement: Record<ContextPath, ContextContainer>;
    steps: PreviewStep[];
}

export interface PreviewStepResult {
    note: string;
    /** 这一步的 runtime 投递（人读文案） */
    delivery: string;
    needRebaseline: boolean;
    /** 这一步实际变了的 path（step 前后比最终 hash） */
    changed: ContextPath[];
}

export interface PreviewNode {
    path: ContextPath;
    /** 节点的渲染方式（yaml / text / template） */
    renderer: string;
    /** 值或模板源码的单行预览 */
    preview: string;
    valueHash: string;
}

export interface ContextPreview {
    scenario: string;
    title: string;
    wireVersion: string;
    places: { path: ContextPath; container: ContextContainer }[];
    nodes: PreviewNode[];
    system: string;
    runtimeText: string;
    steps: PreviewStepResult[];
}

/** 单行预览（值 → 一行；长文本截断） */
function oneLine(v: unknown, max = 72): string {
    const text = isPlainObject(v) || Array.isArray(v) ? toYaml(v) : String(v ?? "");
    const flat = text.replace(/\n/g, " ⏎ ");
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 把 runtime 投递翻译成人读文案 */
export function describeDelivery(d: RuntimeDelivery): string {
    switch (d.kind) {
        case "none":
            return "不发（内容未变）";
        case "patch":
            return d.ops
                .map((o) => (o.op === "set" ? `set ${o.path}` : `remove ${o.path}`))
                .join("；");
        case "snapshot":
            return `snapshot（supersedes=${d.supersedes}）`;
        case "clear":
            return "clear（显式清空）";
    }
}

/** 树上的节点视图（值树每个 path 一条 + 模板声明） */
function nodesOf(state: ContextTreeState): PreviewNode[] {
    const hashes = valueHashes(state);
    const out: PreviewNode[] = [];
    const walk = (node: unknown, base: string): void => {
        if (base) {
            const spec = rendererOf(state, base);
            out.push({
                path: base,
                renderer: spec.renderer,
                preview: spec.renderer === "template" ? oneLine(spec.source) : oneLine(node),
                valueHash: hashes[base] ?? "",
            });
        }
        if (!isPlainObject(node)) return;
        for (const [k, v] of Object.entries(node)) walk(v, base ? `${base}.${k}` : k);
    };
    walk(state.values, "");
    for (const [p, spec] of Object.entries(state.renderers)) {
        if (spec.renderer === "template" && !out.some((n) => n.path === p)) {
            out.push({
                path: p,
                renderer: "template",
                preview: oneLine(spec.source),
                valueHash: hashes[p] ?? "",
            });
        }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 跑一个场景：逐 step 应用事实并投影，记录每步的投递动作 */
export function runScenario(scenario: ContextScenario): ContextPreview {
    let tree = createTree();
    tree = setPlaces(tree, scenario.places);
    for (const [p, c] of Object.entries(scenario.placement)) tree = setPlacement(tree, p, c);

    let cursor: RuntimeCursor | null = null;
    const steps: PreviewStepResult[] = [];
    for (const step of scenario.steps) {
        const before = tree;
        tree = applyFacts(tree, step.facts).state;
        if (step.migrate) tree = setPlacement(tree, step.migrate.path, step.migrate.container);
        const { projection, cursor: next } = project(tree, cursor);
        cursor = step.staleWire ? { ...next, wireVersion: "deadbeef" } : next;
        steps.push({
            note: step.note,
            delivery: describeDelivery(projection.runtime),
            needRebaseline: projection.needRebaseline,
            changed: stepDelta(before, tree).changed,
        });
    }

    const final = project(tree, cursor);
    return {
        scenario: scenario.name,
        title: scenario.title,
        wireVersion: WIRE_VERSION,
        places: tree.places.map((p) => ({ path: p, container: tree.placement[p] ?? "runtime" })),
        nodes: nodesOf(tree),
        system: final.projection.system,
        runtimeText: final.projection.runtimeText,
        steps,
    };
}

// ─── 内置场景 ──────────────────────────────────────────

const BASIC: ContextScenario = {
    name: "basic",
    title: "基础投递：snapshot / patch / none / clear",
    places: ["diy", "instructions", "task", "tasks"],
    placement: { diy: "system", instructions: "system", task: "system", tasks: "runtime" },
    steps: [
        {
            note: "初始树：写入 diy / task / instructions / tasks",
            facts: [
                { type: "patch", path: "diy.cli", op: "set", value: "/repo/diy.sh" },
                { type: "patch", path: "task.title", op: "set", value: "Context Tree 垂直切片" },
                { type: "patch", path: "task.body", op: "set", value: "在旧事件流上先落地" },
                {
                    type: "replace",
                    path: "instructions.project",
                    content: "<p>项目：diy（{{diy.cli}}）</p>",
                    contentFormat: "template-text",
                },
                { type: "patch", path: "tasks.140.status", op: "set", value: "done" },
                { type: "patch", path: "tasks.141.status", op: "set", value: "doing" },
            ],
        },
        {
            note: "改 task.title（system 容器）→ 重建 system，runtime 不发",
            facts: [{ type: "patch", path: "task.title", op: "set", value: "改过的标题" }],
        },
        {
            note: "改 tasks.140.status（runtime 容器）→ 发增量 patch",
            facts: [{ type: "patch", path: "tasks.140.status", op: "set", value: "doing" }],
        },
        { note: "什么都不改 → 不发", facts: [] },
        {
            note: "删掉 tasks（runtime 唯一的 place）→ 显式清空",
            facts: [{ type: "remove", path: "tasks" }],
        },
    ],
};

const TEMPLATE: ContextScenario = {
    name: "template",
    title: "renderedHash 才是投递判据",
    places: ["diy", "task", "instructions"],
    placement: { diy: "system", task: "system", instructions: "runtime" },
    steps: [
        {
            note: "初始：模板只引用 task.title",
            facts: [
                { type: "patch", path: "diy.cli", op: "set", value: "/repo/diy.sh" },
                { type: "patch", path: "task.title", op: "set", value: "标题" },
                { type: "patch", path: "task.body", op: "set", value: "正文" },
                {
                    type: "replace",
                    path: "instructions.project",
                    content: "<p>{{task.title}}</p>",
                    contentFormat: "template-text",
                },
            ],
        },
        {
            note: "改 task.body（模板没引用）→ 值变了但渲染没变 → 不发",
            facts: [{ type: "patch", path: "task.body", op: "set", value: "新正文" }],
        },
        {
            note: "改 task.title（模板引用了）→ 渲染变了 → 发 patch",
            facts: [{ type: "patch", path: "task.title", op: "set", value: "新标题" }],
        },
    ],
};

const BOUNDARY: ContextScenario = {
    name: "boundary",
    title: "placement 迁移与 wire 版本变化 → rebaseline",
    places: ["diy", "tasks"],
    placement: { diy: "system", tasks: "runtime" },
    steps: [
        {
            note: "初始树 → 建立 runtime baseline",
            facts: [
                { type: "patch", path: "diy.cli", op: "set", value: "/repo/diy.sh" },
                { type: "patch", path: "tasks.140.status", op: "set", value: "done" },
            ],
        },
        {
            note: "把 tasks 从 runtime 迁到 system → placement 变 → 必须重发 baseline",
            facts: [],
            migrate: { path: "tasks", container: "system" },
        },
        {
            note: "（把水位标成旧 wire 版本，模拟换过 wire 编码）",
            facts: [],
            staleWire: true,
        },
        {
            note: "再投影一次 → wire 版本不一致 → 重发 baseline",
            facts: [],
        },
    ],
};

export const SCENARIOS: ContextScenario[] = [BASIC, TEMPLATE, BOUNDARY];

export function scenarioByName(name: string): ContextScenario {
    return SCENARIOS.find((s) => s.name === name) ?? BASIC;
}
