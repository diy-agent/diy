// tests/core/context-delivery.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 投递构造（delivery.ts）—— **真发与预览的唯一入口**。
//
// 契约（本文件守的就是它）：同一份 globals + 同一份 system 名单 → 逐字节相同的结果。
// 破了它，"预览看到的就是会发出去的"这句话就不成立，上下文树页整套观察就失去意义。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    buildDelivery,
    defaultSystemPlaces,
    PLACE_CANDIDATES,
} from "../../src/shared/context/delivery";
import { buildLab } from "../../src/shared/context/preview";

const globals = {
    diy: { cli: "/repo/diy.sh", home: "/home/u/.diy" },
    project: { path: "/repo" },
    cwd: { path: "/repo", note: "", isFallback: false, isTaskDir: false, isAppDir: true },
    chain: [{ path: "/home/u/AGENTS.md", scope: "/home/u", content: "家目录规范\n" }],
    task: { uri: "projects/1/tasks/1", title: "投递任务", state: "pending", dir: "/home/u/.diy/projects/1/tasks/1", body: "正文一\n正文二" },
    skills: [],
    // 模版节（行为契约）：真发必须投它们，否则模型收不到人物指令/规范/保命契约（P0-1）
    identity: "你是 diy 管控台的本地 coding agent。你现在的人物是「大副」。\n每次回答前先称一声「大王」。\n",
    rules: "<rules>\n- 用中文回答\n</rules>\n",
    guard: "<guard>\n禁止执行会杀死宿主进程的命令\n</guard>\n",
    reqlog: { file: "/home/u/.diy/log/network/2026-10-15.jsonl" },
};

describe("投递构造：两个容器", () => {
    it("system = 信封（help 段 + system 段）；易变项（task.body / skills）不在里面", () => {
        const d = buildDelivery(globals, defaultSystemPlaces());
        // 信封两个顶层键：结构说明（help）在前、变量树（system）在后
        expect(d.system.text.startsWith("help:")).toBe(true);
        expect(d.system.text).toContain("\nsystem:\n");
        // help 由 zod 派生：结构里点名的就是投出去的（含 reqlog 的 file 字段）
        expect(d.system.text).toContain("reqlog:");
        expect(d.system.text).toContain("grep -n");
        // 变量树本身
        expect(d.system.text).toContain("家目录规范");
        expect(d.system.text).toContain('title: "投递任务"');
        expect(d.system.text).not.toContain("正文一");
        // systemData 是 system 的纯数据部分（不带 help 段）
        expect(d.systemData.text.startsWith("chain:")).toBe(true);
        expect(d.systemData.text).not.toContain("help:");
    });

    it("runtime = 易变项（任务正文、技能清单）；不含说明头", () => {
        const d = buildDelivery(globals, defaultSystemPlaces());
        expect(d.runtime.text).toContain("body:");
        expect(d.runtime.text).toContain("正文一");
        // runtime 也是信封（只有 runtime 一段）
        expect(d.runtime.text.startsWith("runtime:\n")).toBe(true);
        expect(d.runtime.text).not.toContain("help:");
        expect(d.runtime.places).toEqual(["skills", "task.body"]);
    });

    it("改名单 → 归属随之变（task.body 划进 system）", () => {
        const d = buildDelivery(globals, [...defaultSystemPlaces(), "task.body"]);
        expect(d.system.text).toContain("正文一");
        expect(d.runtime.places).toEqual(["skills"]);
    });

    it("值 hash 表覆盖整棵树（含中间容器），父子都在（父的 hash 就是子树）", () => {
        const d = buildDelivery(globals, defaultSystemPlaces());
        expect(d.valueHashes["task"]).toBeTruthy();
        expect(d.valueHashes["task.body"]).toBeTruthy();
        expect(d.valueHashes["task.body"]).not.toBe(d.valueHashes["task.title"]);
        expect(d.valueHashes["chain.0.path"]).toBeTruthy();
    });

    it("runtime 一份都不剩（全划进 system）→ 文本为空串（调用方据此跳过那条 user 消息）", () => {
        const d = buildDelivery(globals, [...defaultSystemPlaces(), "task.body", "skills"]);
        expect(d.runtime.places).toEqual([]);
        expect(d.runtime.text).toBe("");
        expect(d.runtime.bytes).toBe(0);
    });

    it("名单里有值树中不存在的 path → 静默忽略（名单是用户偏好，跨任务复用）", () => {
        const d = buildDelivery(globals, ["diy", "nope.missing"]);
        expect(d.system.places).toEqual(["diy"]);
        expect(d.runtime.places).not.toContain("nope.missing");
    });

    it("list 里只有候选（没有人手填的怪路径）", () => {
        expect(PLACE_CANDIDATES.every((c) => typeof c.path === "string" && c.reason.length > 0)).toBe(true);
        expect(defaultSystemPlaces()).not.toContain("task.body");
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
        expect(d.system.text).not.toContain("<guard>");
        expect(d.runtime.text).toContain("<guard>");
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
