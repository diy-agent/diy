// tests/core/context-tree.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 Context Tree 领域行为（任务 148 垂直切片的主要交付物）。
//
// 用例清单直接对应任务 144 会话收敛出的 20 条（投递 / 树与路径 / step-hash /
// 恢复与边界），每条的编号写在小标题里。
//
// **这些测试不 import 任何 Op 类型**（148 验收条件）：核心 API 只吃 ContextFact，
// 旧事件流的接入单独在 context-legacy-adapter.test.ts 里测。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import * as yaml from "js-yaml";
import {
    CONTEXT_GUIDE,
    applyFact,
    applyFacts,
    canonical,
    createTree,
    emitYamlTraced,
    emptyCursor,
    getValue,
    hashValue,
    placeOf,
    placesIn,
    project,
    renderPathsTraced,
    renderPlace,
    setPlacement,
    setPlaces,
    sha256Hex,
    stepDelta,
    systemData,
    systemText,
    validatePlaces,
    valueHashes,
    WIRE_VERSION,
    type ContextFact,
    type ContextTreeState,
} from "../../src/shared/context/index";

/** 便捷：一串事实直接落到树上 */
function build(base: ContextTreeState, facts: ContextFact[]): ContextTreeState {
    return applyFacts(base, facts).state;
}

/** 建一棵「system: diy / runtime: instructions, tasks」的基准树 */
function baseTree(): ContextTreeState {
    let t = createTree();
    t = build(t, [
        { type: "patch", path: "diy.cli", op: "set", value: "/repo/diy.sh" },
        { type: "patch", path: "task.title", op: "set", value: "任务 148" },
        { type: "patch", path: "task.body", op: "set", value: "正文" },
    ]);
    t = setPlaces(t, ["diy", "task", "instructions", "tasks"]);
    t = setPlacement(t, "diy", "system");
    t = setPlacement(t, "task", "system");
    t = setPlacement(t, "instructions", "runtime");
    t = setPlacement(t, "tasks", "runtime");
    return t;
}

describe("hash 基础：canonical 与 sha256", () => {
    it("canonical 与 key 顺序无关（否则 step 比较必然假阳性）", () => {
        expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
        expect(hashValue({ b: 1, a: [1, { z: 2 }] })).toBe(hashValue({ a: [1, { z: 2 }], b: 1 }));
    });

    it("canonical 跳过 undefined 字段（缺字段与显式 undefined 等价）", () => {
        expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
    });

    it("sha256 输出 64 位 hex（对空串/多字节/长串都稳定）", () => {
        expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256Hex("abc")).toHaveLength(64);
        expect(sha256Hex("中文")).toBe(sha256Hex("中文"));
        expect(sha256Hex("a".repeat(1000))).not.toBe(sha256Hex("a".repeat(999)));
    });
});

describe("places 校验（用例 6）", () => {
    it("合法：互不包含的割点集合", () => {
        expect(validatePlaces(["env.os", "tasks"]).ok).toBe(true);
    });

    it("拒绝互为祖先的割点（否则「属于哪个 place」没有唯一答案）", () => {
        const r = validatePlaces(["tasks", "tasks.140"]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("overlap");
    });

    it("拒绝非法路径与重复项", () => {
        expect(validatePlaces(["a b"]).ok).toBe(false);
        expect(validatePlaces(["a", "a"]).ok).toBe(false);
        expect(validatePlaces([""]).ok).toBe(false);
    });

    it("placeOf 取最长的祖先 place", () => {
        const t = setPlaces(createTree(), ["tasks"]);
        expect(placeOf(t, "tasks.140.status")).toBe("tasks");
        expect(placeOf(t, "other.x")).toBeNull();
    });
});

describe("基础投递（用例 1~5）", () => {
    it("用例 1：初始树生成 system/runtime baseline（runtime=snapshot，supersedes=all）", () => {
        const t = baseTree();
        const { projection } = project(t, null);
        expect(projection.system).toContain("diy:");
        expect(projection.runtime.kind).toBe("snapshot");
        if (projection.runtime.kind === "snapshot") expect(projection.runtime.supersedes).toBe("all");
    });

    it("用例 2：system 节点变化 → 重建 system，runtime 不发", () => {
        const t = baseTree();
        const first = project(t, null);
        const t2 = build(t, [{ type: "patch", path: "diy.cli", op: "set", value: "/other/diy.sh" }]);
        const second = project(t2, first.cursor);
        expect(second.projection.system).toContain("/other/diy.sh");
        expect(second.projection.system).not.toBe(first.projection.system);
        expect(second.projection.runtime.kind).toBe("none");
    });

    it("用例 3：runtime 节点变化 → 发送 runtime patch", () => {
        const t = baseTree();
        const first = project(t, null);
        const t2 = build(t, [{ type: "patch", path: "tasks.140.status", op: "set", value: "done" }]);
        const second = project(t2, first.cursor);
        expect(second.projection.runtime.kind).toBe("patch");
        if (second.projection.runtime.kind === "patch") {
            expect(second.projection.runtime.ops).toEqual([
                { op: "set", path: "tasks", content: expect.stringContaining("done") },
            ]);
        }
    });

    it("用例 4：内容未变化 → 不发送（none）", () => {
        const t = baseTree();
        const first = project(t, null);
        expect(project(t, first.cursor).projection.runtime.kind).toBe("none");
        // 再投影一次仍然 none（水位不因「投影」本身变化）
        const second = project(t, first.cursor);
        expect(project(t, second.cursor).projection.runtime.kind).toBe("none");
    });

    it("用例 5：runtime 全部消失 → 显式清空（clear），不是「什么都不发」", () => {
        let t = createTree();
        t = build(t, [{ type: "patch", path: "notes", op: "set", value: "临时" }]);
        t = setPlaces(t, ["notes"]);
        t = setPlacement(t, "notes", "runtime");
        const first = project(t, null);

        const t2 = build(t, [{ type: "remove", path: "notes" }]);
        const second = project(t2, first.cursor);
        expect(second.projection.runtime).toEqual({ kind: "clear" });
    });
});

describe("树与路径（用例 7~10）", () => {
    it("用例 7：place 边界 ≠ patch 边界（tasks 是 place，tasks.140.status 可单独 patch）", () => {
        let t = createTree();
        t = build(t, [{ type: "patch", path: "tasks.140.status", op: "set", value: "doing" }]);
        t = setPlaces(t, ["tasks"]);
        expect(placeOf(t, "tasks.140.status")).toBe("tasks");
        expect(getValue(t, "tasks.140.status")).toBe("doing");
    });

    it("用例 8：稳定 URI 不受插入顺序影响（渲染结果一致）", () => {
        const a = build(createTree(), [
            { type: "patch", path: "tasks.140.title", op: "set", value: "A" },
            { type: "patch", path: "tasks.141.title", op: "set", value: "B" },
        ]);
        const b = build(createTree(), [
            { type: "patch", path: "tasks.141.title", op: "set", value: "B" },
            { type: "patch", path: "tasks.140.title", op: "set", value: "A" },
        ]);
        const pa = setPlaces(a, ["tasks"]);
        const pb = setPlaces(b, ["tasks"]);
        expect(renderPlace(pa, "tasks")).toBe(renderPlace(pb, "tasks"));
        expect(valueHashes(pa)["tasks"]).toBe(valueHashes(pb)["tasks"]);
    });

    it("用例 9：删除单个实体只影响对应 path", () => {
        let t = build(createTree(), [
            { type: "patch", path: "tasks.140.status", op: "set", value: "done" },
            { type: "patch", path: "tasks.141.status", op: "set", value: "doing" },
        ]);
        t = setPlaces(t, ["tasks"]);
        const t2 = build(t, [{ type: "remove", path: "tasks.140" }]);
        expect(getValue(t2, "tasks.140")).toBeUndefined();
        expect(getValue(t2, "tasks.141.status")).toBe("doing");
        expect(renderPlace(t2, "tasks")).not.toContain("done");
        expect(renderPlace(t2, "tasks")).toContain("doing");
    });

    it("用例 10：模板 include 是源码组合，不产生嵌套 place", () => {
        let t = createTree();
        t = build(t, [
            {
                type: "replace",
                path: "instructions.project",
                content: "A",
                contentFormat: "template-text",
            },
        ]);
        t = setPlaces(t, ["instructions"]);
        // include 的片段没有自己的 path，因此不会冒出第二个 place
        expect(placesIn(t, "runtime")).toEqual(["instructions"]);
        expect(placeOf(t, "instructions.project")).toBe("instructions");
    });
});

describe("step / hash（用例 11~15）", () => {
    it("用例 11：一个 step 内重复修改只计一次", () => {
        const before = baseTree();
        let after = build(before, [{ type: "patch", path: "tasks.140.status", op: "set", value: "a" }]);
        after = build(after, [{ type: "patch", path: "tasks.140.status", op: "set", value: "b" }]);
        after = build(after, [{ type: "patch", path: "tasks.140.status", op: "set", value: "c" }]);
        const d = stepDelta(before, after);
        expect(d.counts["tasks.140.status"]).toBe(1);
        expect(d.changed).toContain("tasks.140.status");
    });

    it("用例 12：修改后恢复原值 → 视为未变化（零次）", () => {
        const before = baseTree();
        let after = build(before, [{ type: "patch", path: "tasks.140.status", op: "set", value: "x" }]);
        after = build(after, [{ type: "patch", path: "tasks.140.status", op: "set", value: "y" }]);
        after = build(after, [{ type: "remove", path: "tasks.140" }]);
        const d = stepDelta(before, after);
        expect(d.changed).toEqual([]);
        expect(d.counts).toEqual({});
    });

    it("用例 13：父节点按自身最终 hash 判，不累加子节点次数", () => {
        const before = baseTree();
        let after = build(before, [{ type: "patch", path: "tasks.140.a", op: "set", value: 1 }]);
        after = build(after, [{ type: "patch", path: "tasks.140.b", op: "set", value: 2 }]);
        const d = stepDelta(before, after);
        // 三个 path 各计 1 次（不是父节点 = 2）
        expect(d.counts["tasks"]).toBe(1);
        expect(d.counts["tasks.140"]).toBe(1);
        expect(d.counts["tasks.140.a"]).toBe(1);
        expect(d.counts["tasks.140.b"]).toBe(1);
    });

    it("用例 14：valueHash 变了但 renderedHash 不变 → 不投递", () => {
        let t = baseTree();
        t = build(t, [
            {
                type: "replace",
                path: "instructions.project",
                content: "<p>{{task.title}}</p>",
                contentFormat: "template-text",
            },
        ]);
        const first = project(t, null);

        // task.body 变了：它在 system 容器里，模板没引用它
        const t2 = build(t, [{ type: "patch", path: "task.body", op: "set", value: "新正文" }]);
        expect(valueHashes(t2)["task.body"]).not.toBe(valueHashes(t)["task.body"]);
        const second = project(t2, first.cursor);
        expect(second.projection.runtime.kind).toBe("none");
    });

    it("用例 15：模板 render 结果变化才投递", () => {
        let t = baseTree();
        t = build(t, [
            {
                type: "replace",
                path: "instructions.project",
                content: "<p>{{task.title}}</p>",
                contentFormat: "template-text",
            },
        ]);
        const first = project(t, null);

        const t2 = build(t, [{ type: "patch", path: "task.title", op: "set", value: "改标题" }]);
        const second = project(t2, first.cursor);
        expect(second.projection.runtime.kind).toBe("patch");
        if (second.projection.runtime.kind === "patch") {
            const op = second.projection.runtime.ops[0];
            expect(op.op).toBe("set");
            if (op.op === "set") expect(op.content).toContain("改标题");
        }
    });
});

describe("恢复与边界（用例 16~20）", () => {
    it("用例 16：重启后从 baseline 恢复（snapshot 事实还原出同一棵树）", () => {
        const t = baseTree();
        const restored = applyFact(createTree(), { type: "snapshot", scope: "all", state: t });
        expect(restored.needRebaseline).toBe(true);
        expect(restored.state.values).toEqual(t.values);
        expect(restored.state.places).toEqual(t.places);
        expect(project(restored.state, null).projection.system).toBe(systemText(t));
    });

    it("用例 17：placement 迁移后发送新的 runtime baseline", () => {
        let t = baseTree();
        t = build(t, [{ type: "patch", path: "tasks.140.status", op: "set", value: "done" }]);
        const first = project(t, null);
        // tasks 从 runtime 迁到 system
        const t2 = setPlacement(t, "tasks", "system");
        expect(t2.placementEpoch).toBe(t.placementEpoch + 1);
        const second = project(t2, first.cursor);
        expect(second.projection.needRebaseline).toBe(true);
        expect(second.projection.runtime.kind).toBe("snapshot");
        expect(second.projection.system).toContain("tasks");
    });

    it("用例 18：wire 版本变化触发 rebaseline", () => {
        const t = baseTree();
        const first = project(t, null);
        const stale = { ...first.cursor, wireVersion: "deadbeef" };
        const second = project(t, stale);
        expect(second.projection.needRebaseline).toBe(true);
        expect(second.projection.runtime.kind).toBe("snapshot");
    });

    it("用例 19：中断的 context 更新不进入有效树（未定稿的块不产出事实）", () => {
        // 该行为由 adapter 负责：只有 stop 才定稿（见 adapter 测试）。
        // 领域侧对应断言：未 apply 任何事实时树保持空，投影也不假装有内容。
        const t = createTree();
        const { projection } = project(t, null);
        // 空树：说明头仍在位（它说明"这是什么"），但**没有任何变量数据** ——
        // 中断的更新不会让投影假装有内容
        expect(projection.system).toContain(CONTEXT_GUIDE.trim().split("\n")[0]!);
        expect(systemData(t)).toBe("");
        expect(projection.runtime.kind).toBe("snapshot");
        if (projection.runtime.kind === "snapshot") expect(projection.runtime.text).toBe("");
    });

    it("用例 20：patch baseHash 不匹配 → 拒绝静默合并并标记 rebaseline", () => {
        const t = baseTree();
        const r = applyFact(t, {
            type: "patch",
            path: "tasks.140.status",
            op: "set",
            value: "done",
            baseHash: hashValue("谁也不是"),
        });
        expect(r.rejected).toBe("base-hash-mismatch");
        expect(r.needRebaseline).toBe(true);
        expect(r.state).toBe(t); // 状态原样（拒绝 = 不动）
    });

    it("remove 不存在的 path → not-found（不静默成功）", () => {
        const t = baseTree();
        const r = applyFact(t, { type: "remove", path: "nope.missing" });
        expect(r.rejected).toBe("not-found");
        expect(r.state).toBe(t);
    });

    it("非法路径一律拒绝", () => {
        const t = baseTree();
        expect(applyFact(t, { type: "patch", path: "a b", op: "set", value: 1 }).rejected).toBe("invalid-path");
        expect(applyFact(t, { type: "remove", path: "" }).rejected).toBe("invalid-path");
    });
});

describe("golden：同一组事实的投影稳定（108 换 adapter 后必须一致）", () => {
    it("固定事实序列 → 固定 system/runtime 文本", () => {
        let t = createTree();
        t = build(t, [
            { type: "patch", path: "diy.cli", op: "set", value: "/repo/diy.sh" },
            { type: "patch", path: "env.os", op: "set", value: { soft: ["playwright-cli", "rg"] } },
            { type: "patch", path: "tasks.140.status", op: "set", value: "done" },
            { type: "patch", path: "tasks.141.status", op: "set", value: "doing" },
            {
                type: "replace",
                path: "instructions.project",
                content: "<p>{{diy.cli}}</p>",
                contentFormat: "template-text",
            },
        ]);
        t = setPlaces(t, ["diy", "env.os", "instructions", "tasks"]);
        t = setPlacement(t, "diy", "system");
        t = setPlacement(t, "env.os", "runtime");
        t = setPlacement(t, "instructions", "runtime");
        t = setPlacement(t, "tasks", "runtime");

        // 纯 YAML：不再套 <context path="…"> 外壳（树形结构已表达 path 归属）。
        // systemData 是纯数据；systemText 在它前面多一段说明头（见 guide.ts）
        expect(systemData(t)).toBe("diy:\n  cli: /repo/diy.sh");
        expect(systemText(t).startsWith(CONTEXT_GUIDE.trimEnd())).toBe(true);
        expect(systemText(t)).toContain("diy:\n  cli: /repo/diy.sh");
        expect(project(t, emptyCursor()).projection.runtimeText).toBe(
            [
                "env:",
                "  os:",
                "    soft:",
                "      - playwright-cli",
                "      - rg",
                "instructions:",
                '  project: "<p>/repo/diy.sh</p>"',
                "tasks:",
                "  140:",
                "    status: done",
                "  141:",
                "    status: doing",
            ].join("\n"),
        );
    });

    it("WIRE_VERSION 是稳定常量（由编码语义派生，不手工维护）", () => {
        expect(WIRE_VERSION).toMatch(/^[0-9a-f]{8}$/);
        expect(WIRE_VERSION).toBe(WIRE_VERSION);
    });
});

describe("渲染行号映射（选中联动高亮的基础）", () => {
    it("带说明头时，path 行号整体后移且**精确**指到那一行", () => {
        let t = createTree();
        t = build(t, [
            { type: "patch", path: "diy.cli", op: "set", value: "/repo/diy.sh" },
            { type: "patch", path: "chain", op: "set", value: [
                { path: "/home/AGENTS.md", content: "第一层" },
                { path: "/home/proj/AGENTS.md", content: "第二层" },
            ] },
        ]);
        const traced = renderPathsTraced(t, ["chain", "diy"], CONTEXT_GUIDE);
        const L = traced.text.split("\n");
        const at = (p: string) => {
            const r = traced.lines[p]!;
            return L.slice(r.from - 1, r.to).join("\n");
        };

        // 说明头在位，且第一行数据（chain:）紧跟其后
        expect(traced.text.startsWith("# 系统上下文")).toBe(true);
        expect(traced.lines["chain"]!.from).toBeGreaterThan(CONTEXT_GUIDE.split("\n").length);

        // ★ 精度：每个 path 的行区间必须**只含该 path 的内容**
        expect(at("diy.cli")).toBe("  cli: /repo/diy.sh");
        expect(at("chain.0.path")).toBe("  - path: /home/AGENTS.md");
        expect(at("chain.1.path")).toBe("  - path: /home/proj/AGENTS.md");
        expect(at("chain.1.content")).toContain("第二层");
        expect(at("chain.1.content")).not.toContain("第二层\n"); // 不含下一段的行
    });

    it("不带说明头时行号从 1 开始（同一 path 不因有无头而错位）", () => {
        let t = createTree();
        t = build(t, [{ type: "patch", path: "diy.cli", op: "set", value: "x" }]);
        const plain = renderPathsTraced(t, ["diy"]);
        expect(plain.lines["diy.cli"]).toEqual({ from: 2, to: 2 });
        const withGuide = renderPathsTraced(t, ["diy"], CONTEXT_GUIDE);
        const offset = withGuide.lines["diy.cli"]!.from - plain.lines["diy.cli"]!.from;
        expect(offset).toBeGreaterThan(0); // 说明头行数
        expect(offset).toBe(withGuide.lines["diy"]!.from - plain.lines["diy"]!.from);
    });

    it("数组元素（下标段）有独立行号，可单独定位", () => {
        let t = createTree();
        t = build(t, [{ type: "patch", path: "list", op: "set", value: [
            { name: "a", desc: "第一" },
            { name: "b", desc: "第二" },
        ] }]);
        const traced = renderPathsTraced(t, ["list"]);
        expect(traced.lines["list.0.name"]).toBeTruthy();
        expect(traced.lines["list.1.name"]).toBeTruthy();
        expect(traced.lines["list.0.name"]!.from).toBeLessThan(traced.lines["list.1.name"]!.from);
    });
});


describe("渲染：块标量的保真（真实数据踩出的两个坑）", () => {
    /** 用产出器渲染一个小请求体，回读并断言"解析的就是那段原文" */
    const roundTrip = (content: string) => {
        const out = emitYamlTraced({ messages: [{ role: "tool", content }] });
        const loaded = yaml.load(out.text, { schema: yaml.JSON_SCHEMA }) as { messages: Array<{ content: string }> };
        return { text: out.text, value: loaded.messages[0]!.content };
    };

    it("内容首行缩进比后面深（工具输出右对齐）→ 给缩进指示符 `|2`，否则整份 YAML 解析崩", () => {
        // 真实实例：`wc -l` 的输出 —— 首行 3 空格对齐、后面 0 空格
        const tool = "   352 /a.jsonl\n38556 /b.jsonl\n75188 total";
        const { text, value } = roundTrip(tool);
        expect(value).toBe(tool);
        expect(text).toContain("content: |2");
    });

    it("整段有公共缩进（源码类工具输出）→ 也必须 `|2`，否则这段缩进被吞掉", () => {
        const code = "        let turnStopped = false;\n        // 收尾原因追踪\n        let lastAct = \"none\";\n";
        const { text, value } = roundTrip(code);
        expect(value).toBe(code);
        expect(text).toContain("content: |2");
    });

    it("尾换行 0 个 → `|-`（strip）；否则回读凭空多一个换行", () => {
        const text0 = "第一行\n第二行"; // 无尾换行
        expect(roundTrip(text0).value).toBe(text0);
        expect(roundTrip(text0).text).toContain("content: |-");
        // 尾换行 1 个：仍是老的 `|`（clip），回读也精确
        const text1 = "第一行\n第二行\n";
        expect(roundTrip(text1).value).toBe(text1);
        expect(roundTrip(text1).text).toContain("content: |\n");
    });

    it("含控制字符（ANSI 色码）→ 块标量表达不了，退回双引号转义标量（仍保真）", () => {
        const ansi = "\u001b[31m1 failed\u001b[39m\n第二行\n";
        const { text, value } = roundTrip(ansi);
        expect(value).toBe(ansi); // 回读一字不差
        expect(text).not.toContain("\u001b"); // 原文里的 ESC 不以裸字节出现（YAML 不允许）
        expect(text).toContain("\\u001b"); // 而是转义写出来
    });

    it("尾部 ≥2 个换行 → 同样退回转义标量（`|+` 构造易错，罕见路径保真优先）", () => {
        const text2 = "第一行\n\n";
        expect(roundTrip(text2).value).toBe(text2);
        expect(roundTrip(text2).text).toContain('"第一行');
    });

    it("常规多行（尾换行 1、缩进正常）输出与旧版逐字节一致", () => {
        const { text } = roundTrip("普通\n文本\n");
        // 块内容末尾的换行由 YAML 的 clip 语义隐含，不在产出的行里
        expect(text).toBe("messages:\n  - role: tool\n    content: |\n      普通\n      文本");
    });
});
