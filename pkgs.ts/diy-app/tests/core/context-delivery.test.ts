// tests/core/context-delivery.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 投递构造（delivery.ts）—— **真发与预览的唯一入口**。
//
// 契约（本文件守的就是它）：同一份 globals + 同一份 system 名单 → 逐字节相同的结果。
// 破了它，"预览看到的就是会发出去的"这句话就不成立，上下文树页整套观察就失去意义。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { buildDelivery, defaultSystemPlaces, PLACE_CANDIDATES } from "@diy/context/delivery";
import { buildLab } from "../../src/shared/context/preview";
import { project } from "@diy/context/projection";

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

describe("投递构造：两个容器", () => {
    it("system = 信封（help + system + runtime 全量）；易变项也在 system 里（##442 2026-10-27 口径）", () => {
        const d = buildDelivery(globals, defaultSystemPlaces());
        // 信封三个顶层键：结构说明（help）在前、稳定树（system）、易变树（runtime）
        expect(d.system.text.startsWith("help:")).toBe(true);
        expect(d.system.text).toContain("\nsystem:\n");
        expect(d.system.text).toContain("\nruntime:\n");
        // 两条树都在 system 消息里：稳定项 + 易变项
        expect(d.system.text).toContain("家目录规范");
        expect(d.system.text).toContain("created: 2026-10-01");
        expect(d.system.text).toContain("正文一");
        expect(d.system.text).toContain("reqlog:");
        // systemData 仍是**稳定树**的纯数据段（调试 / 旧 diff 用），不含 runtime
        expect(d.systemData.text).not.toContain("正文一");
        expect(d.systemData.text).not.toContain("reqlog");
        expect(d.systemData.text.startsWith("chain:")).toBe(true);
        expect(d.systemData.text).not.toContain("help:");
    });

    it("runtime = 易变项（任务头易变字段、任务正文、技能清单、cwd、reqlog）；不含说明头", () => {
        const d = buildDelivery(globals, defaultSystemPlaces());
        expect(d.runtime.text).toContain("body:");
        expect(d.runtime.text).toContain("正文一");
        // runtime 也是信封（只有 runtime 一段）
        expect(d.runtime.text.startsWith("runtime:\n")).toBe(true);
        expect(d.runtime.text).not.toContain("help:");
        expect(d.runtime.text).toContain("reqlog:");
        expect(d.runtime.places).toEqual([
            "cwd",
            "reqlog",
            "skills",
            "task.body",
            "task.change_type",
            "task.module",
            "task.priority",
            "task.state",
            "task.title",
            "task.updated",
        ]);
    });

    it("改名单 → 归属随之变（task.body 划进 system）", () => {
        const d = buildDelivery(globals, [...defaultSystemPlaces(), "task.body"]);
        expect(d.system.text).toContain("正文一");
        expect(d.runtime.places).not.toContain("task.body");
    });

    it("值 hash 表覆盖整棵树（含中间容器），父子都在（父的 hash 就是子树）", () => {
        const d = buildDelivery(globals, defaultSystemPlaces());
        expect(d.valueHashes["task"]).toBeTruthy();
        expect(d.valueHashes["task.body"]).toBeTruthy();
        expect(d.valueHashes["task.body"]).not.toBe(d.valueHashes["task.title"]);
        expect(d.valueHashes["chain.0.path"]).toBeTruthy();
    });

    it("runtime 一份都不剩（全划进 system）→ 文本为空串（调用方据此跳过那条 user 消息）", () => {
        const d = buildDelivery(
            globals,
            PLACE_CANDIDATES.map((c) => c.path),
        );
        expect(d.runtime.places).toEqual([]);
        expect(d.runtime.text).toBe("");
        expect(d.runtime.bytes).toBe(0);
    });

    it("名单里有值树中不存在的 path → 静默忽略（名单是用户偏好，跨任务复用）", () => {
        const d = buildDelivery(globals, ["diy", "nope.missing"]);
        expect(d.system.places).toEqual(["diy"]);
        expect(d.runtime.places).not.toContain("nope.missing");
    });

    it("★ 可选子单元缺席 ⇒ 不算 place（review1 R2：否则每步 diff 都报 set … ''，白烧 token 还砸缓存）", () => {
        // 病灶（第 26 刀改 `inTree` 之前）：只看**顶层键**在不在 ⇒ `room` 在、`room.recent` 没有时
        // 仍把 `room.recent` 当 place ⇒ 渲染成空串 ⇒ 每步 diff 一条 `set room.recent: ''`。
        // 判据 =「整条 path 真的存在」，对**任何**可选子单元成立；`room.recent` 是当前唯一的
        // 嵌套可选**候选**（`PLACE_CANDIDATES`），故这里用它当样本。
        const room = { roomId: "projects/1/tasks/1", name: "#1", list: [] };
        const full = {
            ...globals,
            room: { members: room, recent: { items: [{ from: "human:chen56", at: "t", text: "一" }] } },
        };
        const partial = { ...globals, room: { members: room } };

        const d1 = buildDelivery(full, defaultSystemPlaces());
        expect(d1.runtime.places).toContain("room.members");
        expect(d1.runtime.places).toContain("room.recent");
        const { cursor } = project(d1.tree, null);

        // ① 子单元缺席 ⇒ 不在 places 里（`room` 这个顶层键还在）
        const d2 = buildDelivery(partial, defaultSystemPlaces());
        expect(d2.runtime.places).toContain("room.members");
        expect(d2.runtime.places).not.toContain("room.recent");
        // ② 投影里**不存在**这个单元 —— 不是 `set room.recent: ''`
        //   （place 集合变了 ⇒ 投影按 snapshot 兜底，这是既有语义；关键是空的单元不被造出来）
        const rt = project(d2.tree, cursor).projection.runtime;
        const touched = rt.kind === "patch" ? rt.ops.filter((o) => o.path === "room.recent") : [];
        expect(touched).toEqual([]);
        expect(rt.kind === "snapshot" ? rt.text : "").not.toContain("recent:");
    });

    it("list 里只有候选（没有人手填的怪路径）", () => {
        expect(PLACE_CANDIDATES.every((c) => typeof c.path === "string" && c.reason.length > 0)).toBe(true);
        expect(defaultSystemPlaces()).not.toContain("task.body");
    });
});

describe("默认最小 system 名单（##426）", () => {
    it("★ 名单就是「存续期内不变」那一撮：加了新字段进 system 必须先想清楚它会不会变", () => {
        expect(defaultSystemPlaces().slice().sort()).toEqual(
            [
                "chain",
                "diy",
                "guard",
                "identity",
                "project",
                "rules",
                "task.created",
                "task.dir",
                "task.parent",
                "task.uri",
            ].sort(),
        );
        // 头号缓存杀手：state / updated（每改一次任务就变）
        for (const p of [
            "task.state",
            "task.updated",
            "task.title",
            "task.change_type",
            "task.module",
            "task.priority",
            "task.persona",
        ]) {
            expect(defaultSystemPlaces(), p).not.toContain(p);
        }
        // 按天变的 reqlog、含回退判定的 cwd 也不在 system
        expect(defaultSystemPlaces()).not.toContain("reqlog");
        expect(defaultSystemPlaces()).not.toContain("cwd");
    });

    it("★ 变量树全在 system：state 迁移只改 runtime 段，稳定树段（systemData）逐字节不变", () => {
        const before = buildDelivery(globals, defaultSystemPlaces());
        const after = buildDelivery(
            { ...globals, task: { ...globals.task, state: "in_progress", updated: "2026-10-25" } },
            defaultSystemPlaces(),
        );
        // 新口径（##442 2026-10-27）：runtime 也进 system，所以 **纯函数产物** 会随 state 变；
        // 「前缀缓存不被砸」由运行层的**段首快照**保证（`frozenSystemTextOf`，见 context-refresh 用例），
        // 不在 `buildDelivery` 这一层。这里钉稳定树段本身不变。
        expect(after.systemData.text).toBe(before.systemData.text);
        expect(after.system.text).not.toBe(before.system.text);
        expect(after.runtime.text).not.toBe(before.runtime.text);
        // 同样地，cwd 的回退 / reqlog 换日期也不该动**稳定树段**
        const cwdChanged = buildDelivery(
            { ...globals, cwd: { ...globals.cwd, note: "回退", isFallback: true } },
            defaultSystemPlaces(),
        );
        expect(cwdChanged.systemData.text).toBe(before.systemData.text);
    });

    it("每个候选都有非空理由（页面「划分规则」表直接显示它）", () => {
        for (const c of PLACE_CANDIDATES) expect(c.reason.trim().length, c.path).toBeGreaterThan(0);
    });
});

describe("行为契约（identity / rules / guard）默认归 system", () => {
    it("★ 三节默认在 system 名单里，且落在 system 容器（不在名单 = 两个容器都不投）", () => {
        const sys = defaultSystemPlaces();
        for (const name of ["identity", "rules", "guard"]) {
            expect(sys, name).toContain(name);
        }
        const d = buildDelivery(globals, sys);
        for (const name of ["identity", "rules", "guard"]) {
            expect(d.system.places, name).toContain(name);
            expect(d.runtime.places, name).not.toContain(name);
        }
        expect(d.system.text).toContain("每次回答前先称一声「大王」。");
        expect(d.system.text).toContain("<rules>");
        expect(d.system.text).toContain("<guard>");
    });

    it("persona **值**不单独投（身份节里已含人物名与指令，重复投会白占前缀缓存）", () => {
        const withPersona = { ...globals, persona: { name: "大副", instructions: "每次回答前先称一声「大王」。" } };
        const d = buildDelivery(withPersona, defaultSystemPlaces());
        expect(d.tree.places).not.toContain("persona");
        // 不投的是**值节点** `persona`（纯数据段里不出现它）。
        // ⚠️ 判据用 `systemData`（纯数据）而**非** `system.text`（含 help 段）：help 由 zod 派生，
        // 里面有 **`task.persona`** —— 那是任务头字段（##322），与全局 `persona` 值节点是两回事；
        // 用 `not.toContain("persona:")` 会让一个子串把两件事混成一件（merge main 后实测踩到）。
        expect(d.systemData.text).not.toContain("persona");
        expect(d.runtime.text).not.toContain("persona");
        // 但指令本身必须在（来自 identity 节）
        expect(d.system.text).toContain("每次回答前先称一声「大王」。");
    });

    it("把行为契约划到 runtime → 它们从 system 消失、出现在 runtime（名单真源说了算）", () => {
        const sys = defaultSystemPlaces().filter((p) => p !== "guard");
        const d = buildDelivery(globals, sys);
        // 稳定树段（systemData）里没有；它落在 runtime 段（而 runtime 段现在也在 system 消息里）
        expect(d.systemData.text).not.toContain("<guard>");
        expect(d.runtime.text).toContain("<guard>");
        expect(d.system.text).toContain("<guard>");
    });
});

describe("投递构造：预览与真发同源（这条一旦破了，整个观察页就失去意义）", () => {
    it("buildLab 的 system/runtime 与 buildDelivery 逐字节相同（同一名单下发的是同一份）", () => {
        const sys = defaultSystemPlaces();
        const d = buildDelivery(globals, sys);
        const lab = buildLab(globals, sys, "projects/1/tasks/1");
        expect(lab.system.text).toBe(d.system.text);
        expect(lab.runtime.text).toBe(d.runtime.text);
        expect(lab.system.places).toEqual(d.system.places);
        expect(lab.runtime.places).toEqual(d.runtime.places);
        // 行号映射也同源（预览的高亮靠它）
        expect(lab.system.lines["task.title"]).toEqual(d.system.lines["task.title"]);
    });

    it("顺序敏感：places 排序稳定（同输入两次 → 同一字节）", () => {
        const a = buildDelivery(globals, defaultSystemPlaces());
        const b = buildDelivery(globals, [...defaultSystemPlaces()].reverse());
        expect(a.system.text).toBe(b.system.text);
        expect(a.runtime.text).toBe(b.runtime.text);
    });
});
