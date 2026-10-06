// tests/core/history-index.test.ts
// 🎯 压缩索引的**格式说明节点**（##269）—— 纯函数 + 变量树契约
//
// 三条契约：
//   ① 字段表**从 zod 派生**（不是手写）—— 改 schema 忘改文案这种事不可能发生；
//   ② 回取命令里带的路径 = **唯一出口**（../core/local-paths 的 keyOf），不能用别处另算一份；
//   ③ 它是**稳定**项：同一任务同一路径两次构造逐字相同（进 system 才不砸前缀缓存）。

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { historyIndexValue } from "../../src/shared/context/history-index";
import { DroppedNoteSchema, DroppedSegmentSchema } from "../../src/shared/context/dropped";
import { fieldDocs } from "../../src/shared/schema-doc";
import { AssembleGlobalsSchema } from "../../src/shared/prompt-schema";
import { buildVarTree, flattenVars } from "../../src/shared/var-tree";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { assembleGlobals } from "../../src/main/services/prompt-registry";
import { llmLogRelPath } from "../../src/main/core/local-paths";

const REL = "local/projects_4_tasks_9-abcd1234ef56.llm.jsonl";

describe("historyIndexValue：格式说明从 zod 派生", () => {
    const v = historyIndexValue(REL);

    it("① 顶层字段表与 DroppedNoteSchema 的派生结果**逐项相同**", () => {
        expect(v.note).toEqual(fieldDocs(DroppedNoteSchema));
        expect(v.segment).toEqual(fieldDocs(DroppedSegmentSchema));
        // 至少确认关键字段在（防 schema 被清空而测试仍通过）
        expect(v.note.map((f) => f.name)).toEqual(["total", "segments"]);
        expect(v.segment.map((f) => f.name)).toEqual(["range", "kind", "turns", "tools", "why"]);
    });

    it("② 回取命令直接用给定路径（不另算 key），且给了按行与按轮两条路", () => {
        expect(v.source).toContain(REL);
        expect(v.retrieve.byLine).toContain(REL);
        expect(v.retrieve.byTurn).toContain(REL);
        expect(v.retrieve.byLine).toContain("sed -n");
        expect(v.retrieve.byTurn).toContain("grep -n");
        expect(v.retrieve.byLine).toContain("$DIY_HOME");
    });

    it("③ 稳定：同一路径两次构造逐字相同（可缓存的前提）", () => {
        expect(JSON.stringify(historyIndexValue(REL))).toBe(JSON.stringify(historyIndexValue(REL)));
    });

    it("说明里点明注记在 messages 里、且行号即消息序号（模型要据此回取）", () => {
        expect(v.noteLocation).toContain("user");
        expect(v.source).toContain("行号即消息序号");
    });
});

describe("变量树契约：historyIndex 是正式节点（可看、可切 system/runtime）", () => {
    it("出现在变量契约的扁平清单与定义树里", () => {
        const flat = flattenVars(AssembleGlobalsSchema).map((s) => s.path);
        expect(flat).toContain("historyIndex");
        expect(flat).toContain("historyIndex.retrieve.byLine");
        expect(flat).toContain("historyIndex.note");
        const tree = buildVarTree(AssembleGlobalsSchema);
        const node = tree.find((n) => n.name === "historyIndex")!;
        expect(node).toBeTruthy();
        expect(node.type).toBe("object");
    });

    it("assembleGlobals 真的注入了它（路径来自 local-paths 的唯一出口）", () => {
        const pid = createProject(join(diyHome(), "hi-work"));
        const uri = createTask({ title: "索引节点", project: pid });
        const g = assembleGlobals(diyHome(), pid, { taskUri: uri }) as { historyIndex: { source: string } };
        expect(g.historyIndex.source).toContain(llmLogRelPath(uri));
        expect(llmLogRelPath(uri).startsWith("local/")).toBe(true);
    });
});

describe("注记渲染：schema 已在 system 时只留数据 + 指路", () => {
    it("schemaInSystem：不重复字段表/回取命令，但保留数据与指路", async () => {
        const { renderDroppedNote } = await import("../../src/shared/context/dropped");
        const note = {
            total: 10,
            segments: [{ range: [1, 10] as [number, number], kind: "turns" as const, turns: ["t1"], tools: ["bash"], why: "只保留最近 1 轮" }],
        };
        const slim = renderDroppedNote(note, { file: REL, schemaInSystem: true });
        expect(slim).toContain("historyIndex");
        expect(slim).toContain("dropped:");
        expect(slim).toContain("total: 10");
        expect(slim).toContain("range: [1, 10]");
        expect(slim).not.toContain("sed -n"); // 回取命令不重复
        // 自带完整头（llm.jsonl 单独读时仍自解释）
        const full = renderDroppedNote(note, { file: REL });
        expect(full).toContain("sed -n '1,10p'");
        expect(full).toContain("# 字段（由 zod 定义派生，勿手写）：");
    });
});
