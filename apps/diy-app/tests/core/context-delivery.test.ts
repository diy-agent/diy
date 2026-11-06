// tests/core/context-delivery.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 投递构造（delivery.ts）—— **真发与预览的唯一入口**。
//
// 契约（本文件守的就是它）：同一份 globals → 逐字节相同的结果；信封只有**一份全量**
// （`help:` + `vars:`，##520 起没有 system/runtime 两容器）。
// 破了它，"预览看到的就是会发出去的"这句话就不成立，上下文树页整套观察就失去意义。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { buildDelivery, PLACE_CANDIDATES, unitPaths } from "@diy-agent/context/delivery";
import { buildLab } from "../../src/shared/context/preview";
import { project } from "@diy-agent/context/projection";

const globals = {
    diy: { cli: "/repo/diy.sh", home: "/home/u/.diy" },
    project: { path: "/repo" },
    cwd: { path: "/repo", note: "", isFallback: false, isTaskDir: false, isAppDir: true },
    chain: [{ path: "/home/u/AGENTS.md", scope: "/home/u", content: "家目录规范\n" }],
    task: {
        uri: "projects/1/tasks/1",
        title: "投递任务",
        state: "pending",
        dir: "/home/u/.diy/projects/1/tasks/1",
        created: "2026-10-01",
        parent: "",
        updated: "2026-10-01",
        change_type: "",
        module: "",
        priority: "",
        body: "正文一\n正文二",
    },
    skills: [],
    // 模版节（行为契约）：真发必须投它们，否则模型收不到人物指令/规范/保命契约（P0-1）
    identity: "你是 diy 管控台的本地 coding agent。你现在的人物是「大副」。\n每次回答前先称一声「大王」。\n",
    rules: "<rules>\n- 用中文回答\n</rules>\n",
    guard: "<guard>\n禁止执行会杀死宿主进程的命令\n</guard>\n",
    reqlog: { file: "/home/u/.diy/log/network/2026-10-15.jsonl" },
};

describe("投递构造：一份全量", () => {
    it("text = 信封（help + vars 全量）；所有单元都在同一段里", () => {
        const d = buildDelivery(globals);
        // 信封两个顶层键：结构说明（help）在前、变量树（vars）在后
        expect(d.text.text.startsWith("help:")).toBe(true);
        expect(d.text.text).toContain("\nvars:\n");
        expect(d.text.text).not.toContain("\nsystem:\n");
        expect(d.text.text).not.toContain("\nruntime:\n");
        // 稳定项 + 易变项全在同一份 vars 里
        expect(d.text.text).toContain("家目录规范");
        expect(d.text.text).toContain("created: 2026-10-01");
        expect(d.text.text).toContain("正文一");
        expect(d.text.text).toContain("reqlog:");
    });

    it("data = 纯数据段（不带 help），含全部存在的单元", () => {
        const d = buildDelivery(globals);
        expect(d.data.text).not.toContain("help:");
        expect(d.data.text.startsWith("chain:")).toBe(true);
        expect(d.data.text).toContain("正文一");
        expect(d.data.text).toContain("reqlog:");
        // 行号映射与 text 同源：只保留 vars 段里的 path
        expect(d.text.lines["task.title"]).toBeTruthy();
        expect(d.data.lines).toEqual({});
    });

    it("places = 候选里整条 path 真的存在的那些（排序稳定）", () => {
        const d = buildDelivery(globals);
        expect(d.text.places).toEqual([
            "chain",
            "cwd",
            "diy",
            "guard",
            "identity",
            "project",
            "reqlog",
            "rules",
            "skills",
            "task.body",
            "task.change_type",
            "task.created",
            "task.dir",
            "task.module",
            "task.parent",
            "task.priority",
            "task.state",
            "task.title",
            "task.updated",
            "task.uri",
        ]);
        expect(d.data.places).toEqual(d.text.places);
    });

    it("值 hash 表覆盖整棵树（含中间容器），父子都在（父的 hash 就是子树）", () => {
        const d = buildDelivery(globals);
        expect(d.valueHashes["task"]).toBeTruthy();
        expect(d.valueHashes["task.body"]).toBeTruthy();
        expect(d.valueHashes["task.body"]).not.toBe(d.valueHashes["task.title"]);
        expect(d.valueHashes["chain.0.path"]).toBeTruthy();
    });

    it("空 globals → `vars: {}`（存在但为空，不是没有这个变量）", () => {
        const d = buildDelivery({});
        expect(d.text.places).toEqual([]);
        expect(d.text.text).toContain("vars: {}");
        expect(d.text.bytes).toBeGreaterThan(0); // help 段仍在
    });

    it("★ 可选子单元缺席 ⇒ 不算 place（review1 R2：否则每步 diff 都报 set … ''，白烧 token 还砸缓存）", () => {
        // 判据 =「整条 path 真的存在」，对**任何**可选子单元成立；`room.recent` 是当前唯一的
        // 嵌套可选**候选**（`PLACE_CANDIDATES`），故这里用它当样本。
        const room = { roomId: "projects/1/tasks/1", name: "#1", list: [] };
        const full = {
            ...globals,
            room: { members: room, recent: { items: [{ from: "human:chen56", at: "t", text: "一" }] } },
        };
        const partial = { ...globals, room: { members: room } };

        const d1 = buildDelivery(full);
        expect(d1.text.places).toContain("room.members");
        expect(d1.text.places).toContain("room.recent");
        const { cursor } = project(d1.tree, null);

        // ① 子单元缺席 ⇒ 不在 places 里（`room` 这个顶层键还在）
        const d2 = buildDelivery(partial);
        expect(d2.text.places).toContain("room.members");
        expect(d2.text.places).not.toContain("room.recent");
        // ② 增量里**不存在**这个单元 —— 不是 `set room.recent: ''`
        const delta = project(d2.tree, cursor).projection.delta;
        const touched = delta.kind === "patch" ? delta.ops.filter((o) => o.path === "room.recent") : [];
        expect(touched).toEqual([]);
        expect(delta.kind === "snapshot" ? delta.text : "").not.toContain("recent:");
    });

    it("list 里只有候选（没有人手填的怪路径），且每个候选都有非空理由", () => {
        expect(PLACE_CANDIDATES.every((c) => typeof c.path === "string" && c.reason.length > 0)).toBe(true);
        expect(unitPaths()).toEqual(PLACE_CANDIDATES.map((c) => c.path));
    });
});

describe("全量快照：任何值变都只动这一份（不砸缓存靠段首冻结，不靠挑选单元）", () => {
    it("★ state 迁移 ⇒ 全文变；同一份单元集合不变（增量按单元算）", () => {
        const before = buildDelivery(globals);
        const after = buildDelivery({
            ...globals,
            task: { ...globals.task, state: "in_progress", updated: "2026-10-25" },
        });
        // 纯函数产物会随 state 变；「前缀缓存不被砸」由运行层的**段首快照**保证
        // （`frozenSystemTextOf`，见 context-refresh 用例），不在 `buildDelivery` 这一层。
        expect(after.text.text).not.toBe(before.text.text);
        expect(after.text.places).toEqual(before.text.places);
    });

    it("每个候选都有非空理由（页面「结构树」表直接显示它）", () => {
        for (const c of PLACE_CANDIDATES) expect(c.reason.trim().length, c.path).toBeGreaterThan(0);
    });
});

describe("行为契约（identity / rules / guard）默认在信封里", () => {
    it("★ 三节都在全量里（不在候选 = 根本不投）", () => {
        const d = buildDelivery(globals);
        for (const name of ["identity", "rules", "guard"]) {
            expect(d.text.places, name).toContain(name);
        }
        expect(d.text.text).toContain("每次回答前先称一声「大王」。");
        expect(d.text.text).toContain("<rules>");
        expect(d.text.text).toContain("<guard>");
    });

    it("persona **值**不单独投（身份节里已含人物名与指令，重复投会白占前缀缓存）", () => {
        const withPersona = { ...globals, persona: { name: "大副", instructions: "每次回答前先称一声「大王」。" } };
        const d = buildDelivery(withPersona);
        expect(d.tree.places).not.toContain("persona");
        // 判据用纯数据段而**非**信封全文：help 里有 `task.persona`（任务头字段，##322），
        // 用 `not.toContain("persona")` 会让子串把两件事混成一件。
        expect(d.data.text).not.toContain("persona");
        // 但指令本身必须在（来自 identity 节）
        expect(d.text.text).toContain("每次回答前先称一声「大王」。");
    });

    it("persona 值存在时也不会出现在任何单元里（只做结构，不做单元）", () => {
        const withPersona = { ...globals, persona: { name: "大副" } };
        const d = buildDelivery(withPersona);
        expect(d.valueHashes["persona"]).toBeTruthy();
        expect(d.text.places).not.toContain("persona");
    });
});

describe("投递构造：预览与真发同源（这条一旦破了，整个观察页就失去意义）", () => {
    it("buildLab 的 text 与 buildDelivery 逐字节相同（同一份 globals 下发的是同一份）", () => {
        const d = buildDelivery(globals);
        const lab = buildLab(globals, "projects/1/tasks/1");
        expect(lab.text.text).toBe(d.text.text);
        expect(lab.data.text).toBe(d.data.text);
        expect(lab.text.places).toEqual(d.text.places);
        // 行号映射也同源（预览的高亮靠它）
        expect(lab.text.lines["task.title"]).toEqual(d.text.lines["task.title"]);
    });

    it("顺序敏感：places 排序稳定（同输入两次 → 同一字节）", () => {
        const a = buildDelivery(globals);
        const b = buildDelivery({ ...globals });
        expect(a.text.text).toBe(b.text.text);
    });
});
