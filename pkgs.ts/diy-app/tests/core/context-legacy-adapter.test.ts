// tests/core/context-legacy-adapter.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 旧事件流（Op）→ ContextFact 的适配层（任务 148）。
//
// 这是**唯一**认识旧格式的地方，也是 108 重构后唯一要替换的地方。因此本文件断言两件事：
//   1. 旧流的每种载体都能正确映射（含「未定稿的块不产出事实」这条边界）
//   2. 端到端 golden：同一组语义，走旧 Op 适配 与 直接喂 ContextFact **结果完全一致**
//      —— 这就是 144 要求的「换 adapter 后 ContextTree 与投影必须不变」的回归网
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    applyFacts,
    createTree,
    opsToFacts,
    project,
    setPlacement,
    setPlaces,
    systemText,
    type ContextFact,
    type ContextTreeState,
    type LegacyOp,
} from "../../src/shared/context/index";

describe("Op → ContextFact 基本映射", () => {
    it("start/delta/stop → 一条 replace（文本增量拼接）", () => {
        const ops: LegacyOp[] = [
            { op: "start", id: "env.os", kind: "context", meta: { renderer: "yaml", place: true, container: "runtime" } },
            { op: "delta", id: "env.os", fields: { content: "soft:\n" } },
            { op: "delta", id: "env.os", fields: { content: "  - rg" } },
            { op: "stop", id: "env.os" },
        ];
        const conv = opsToFacts(ops);
        expect(conv.facts).toEqual([
            { type: "replace", path: "env.os", content: "soft:\n  - rg", contentFormat: "yaml" },
        ]);
        expect(conv.places).toEqual(["env.os"]);
        expect(conv.placement).toEqual({ "env.os": "runtime" });
    });

    it("renderer=template → template-text（落成模板节点，不是文本节点）", () => {
        const conv = opsToFacts([
            { op: "start", id: "instructions.project", kind: "context", meta: { renderer: "template" } },
            { op: "delta", id: "instructions.project", fields: { content: "<p>{{diy.cli}}</p>" } },
            { op: "stop", id: "instructions.project" },
        ]);
        expect(conv.facts[0]).toEqual({
            type: "replace",
            path: "instructions.project",
            content: "<p>{{diy.cli}}</p>",
            contentFormat: "template-text",
        });
    });

    it("patch + fields.value → patch 事实（直接写值，不经文本）", () => {
        const conv = opsToFacts([
            { op: "start", id: "tasks.140", kind: "context", meta: {} },
            { op: "patch", id: "tasks.140", fields: { value: { status: "done" } } },
            { op: "stop", id: "tasks.140" },
        ]);
        expect(conv.facts).toEqual([
            { type: "patch", path: "tasks.140", op: "set", value: { status: "done" } },
        ]);
    });

    it("patch + __removed → remove 事实", () => {
        const conv = opsToFacts([
            { op: "start", id: "notes", kind: "context", meta: {} },
            { op: "delta", id: "notes", fields: { content: "x" } },
            { op: "stop", id: "notes" },
            { op: "patch", id: "notes", fields: { __removed: true } },
        ]);
        expect(conv.facts).toEqual([
            { type: "replace", path: "notes", content: "x", contentFormat: "yaml" },
            { type: "remove", path: "notes" },
        ]);
    });

    it("非 context 的块一律忽略（BlockStore 的普通块不被本适配层解释）", () => {
        const conv = opsToFacts([
            { op: "start", id: "t1", kind: "turn", meta: {} },
            { op: "start", id: "t1_s1", kind: "step", parent: "t1" },
            { op: "delta", id: "t1_s1", fields: { content: "不是 context" } },
            { op: "stop", id: "t1_s1" },
            { op: "stop", id: "t1" },
        ]);
        expect(conv.facts).toEqual([]);
        expect(conv.places).toEqual([]);
    });
});

describe("边界：未定稿的块不产出事实（用例 19）", () => {
    it("只 start + delta、没有 stop → 不产出任何事实", () => {
        const conv = opsToFacts([
            { op: "start", id: "env.os", kind: "context", meta: { place: true } },
            { op: "delta", id: "env.os", fields: { content: "soft:\n  - rg" } },
            // 流在这里断了（进程崩溃 / 取消）
        ]);
        expect(conv.facts).toEqual([]);
    });

    it("空内容且未 patch → 不发（没有内容就没有事实）", () => {
        const conv = opsToFacts([
            { op: "start", id: "empty", kind: "context", meta: {} },
            { op: "stop", id: "empty" },
        ]);
        expect(conv.facts).toEqual([]);
    });

    it("流中断不污染树：把上面那条 Op 流喂进树，树保持空", () => {
        const conv = opsToFacts([
            { op: "start", id: "env.os", kind: "context", meta: { place: true } },
            { op: "delta", id: "env.os", fields: { content: "半截" } },
        ]);
        const t = applyFacts(createTree(), conv.facts).state;
        expect(t.values).toEqual({});
        expect(t.places).toEqual([]);
    });
});

describe("端到端 golden：换 adapter 后结果必须一致（108 回归网）", () => {
    /** 走旧 Op 适配 */
    function viaLegacy(): ContextTreeState {
        const conv = opsToFacts([
            { op: "start", id: "diy.cli", kind: "context", meta: { renderer: "yaml", place: true, container: "system" } },
            { op: "delta", id: "diy.cli", fields: { content: "/repo/diy.sh" } },
            { op: "stop", id: "diy.cli" },
            { op: "start", id: "tasks.140", kind: "context", meta: { place: true, container: "runtime" } },
            { op: "patch", id: "tasks.140", fields: { value: { status: "done" } } },
            { op: "stop", id: "tasks.140" },
            { op: "start", id: "instructions.project", kind: "context", meta: { renderer: "template", place: true } },
            { op: "delta", id: "instructions.project", fields: { content: "<p>{{diy.cli}}</p>" } },
            { op: "stop", id: "instructions.project" },
        ]);
        let t = applyFacts(createTree(), conv.facts).state;
        t = setPlaces(t, conv.places);
        for (const [p, c] of Object.entries(conv.placement)) t = setPlacement(t, p, c);
        return t;
    }

    /** 同一组语义，直接喂 ContextFact（108 之后走这条） */
    function viaFacts(): ContextTreeState {
        const facts: ContextFact[] = [
            { type: "replace", path: "diy.cli", content: "/repo/diy.sh", contentFormat: "yaml" },
            { type: "patch", path: "tasks.140", op: "set", value: { status: "done" } },
            { type: "replace", path: "instructions.project", content: "<p>{{diy.cli}}</p>", contentFormat: "template-text" },
        ];
        let t = applyFacts(createTree(), facts).state;
        t = setPlaces(t, ["diy.cli", "instructions.project", "tasks.140"]);
        t = setPlacement(t, "diy.cli", "system");
        t = setPlacement(t, "instructions.project", "runtime");
        t = setPlacement(t, "tasks.140", "runtime");
        return t;
    }

    it("两棵树的值与 places 完全相同", () => {
        expect(viaLegacy().values).toEqual(viaFacts().values);
        expect(viaLegacy().places).toEqual(viaFacts().places);
        expect(viaLegacy().placement).toEqual(viaFacts().placement);
    });

    it("两棵树的 system / runtime 投影完全相同", () => {
        const a = project(viaLegacy(), null).projection;
        const b = project(viaFacts(), null).projection;
        expect(a.system).toBe(b.system);
        expect(a.runtimeText).toBe(b.runtimeText);
        expect(systemText(viaLegacy())).toBe('<context path="diy.cli">\n/repo/diy.sh\n</context>');
    });
});
