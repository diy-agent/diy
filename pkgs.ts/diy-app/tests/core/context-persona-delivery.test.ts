// tests/core/context-persona-delivery.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 P0-1 的**真发字节**验收（209 review 缺口清单第 1 条 / 210 工单）：
//   真发（Context Tree 投递）必须带上人物行为指令、身份行、行为规范与保命契约。
//
// 209 的实测结论是"persona 行为指令：模板线=true，真发 system=false、runtime=false；
// 身份/<rules>/<guard> 同样双 false" —— 本文件把它钉成回归：这些字节必须出现在
// **真发 system 容器**里（不是模版线预览里）。
//
// 另外钉住 148 的治疗目标不被这次修复打回去：改任务正文 → system 逐字节不变。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembleGlobals, assembleSystem, DELIVERED_SECTIONS } from "../../src/main/services/prompt-registry";
import { buildDelivery } from "../../src/shared/context/delivery";
import { loadSystemPlaces } from "../../src/main/core/context-config";

const PID = "1";
const TASK = `projects/${PID}/tasks/1`;
const PERSONA_INSTRUCTION = "每次回答前先称一声「大王」。";

let home: string;

/** 造一个隔离数据根：任务 + 指定行为指令的人物 */
function makeHome(instructions: string, body = "第一版正文\n"): string {
    const h = mkdtempSync(join(tmpdir(), "diy-p01-"));
    mkdirSync(join(h, "projects", PID, "tasks", "1"), { recursive: true });
    mkdirSync(join(h, "projects", PID), { recursive: true });
    writeFileSync(join(h, "projects", PID, "meta.yaml"), `id: '${PID}'\npath: ${h}\n`, "utf-8");
    writeFileSync(
        join(h, TASK, "AGENTS.md"),
        `---\ntitle: 'P0-1 验收'\nstate: active\npersona: persona/1\n---\n${body}`,
        "utf-8",
    );
    writeFileSync(
        join(h, "personas.yaml"),
        `default: persona/1\npersonas:\n  'persona/1':\n    name: 二副\n    model: mimo-v2.6-flash\n    reasoningEffort: none\n    instructions: ${JSON.stringify(instructions)}\n`,
        "utf-8",
    );
    return h;
}

const deliveryOf = (h: string) => {
    const globals = assembleGlobals(h, PID, { taskUri: TASK, diyCli: "/repo/diy.sh" }) as unknown as Record<string, unknown>;
    return { globals, d: buildDelivery(globals, loadSystemPlaces(h)) };
};

beforeEach(() => {
    home = makeHome(PERSONA_INSTRUCTION);
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe("P0-1：真发 system 必须带行为契约", () => {
    it("三节都是投递单元并归 system（不在名单 = 两个容器都不投，那正是 P0-1）", () => {
        const { d } = deliveryOf(home);
        for (const name of Object.keys(DELIVERED_SECTIONS)) {
            expect(d.tree.places, name).toContain(name);
            expect(d.tree.placement[name], name).toBe("system");
            expect(d.system.places, name).toContain(name);
        }
    });

    it("★ 真发 system 含人物行为指令与身份行（209 实测的两项 false 必须变 true）", () => {
        const { d } = deliveryOf(home);
        expect(d.system.text).toContain(PERSONA_INSTRUCTION);
        expect(d.system.text).toContain("你现在的人物是「二副」");
        // 模板线（模版渲染）与真发线同源：两边都必须在（209 的口径是"两边对比全 true"）
        const tpl = assembleSystem(home, PID, { taskUri: TASK, diyCli: "/repo/diy.sh" }).system;
        for (const needle of [PERSONA_INSTRUCTION, "你现在的人物是「二副」"]) {
            expect(tpl.includes(needle), `模板线缺 ${needle}`).toBe(true);
            expect(d.system.text.includes(needle), `真发缺 ${needle}`).toBe(true);
            expect(d.runtime.text.includes(needle), `真发把行为契约错放 runtime：${needle}`).toBe(false);
        }
    });

    it("★ 真发 system 含 <rules> 与 <guard>（保命契约不许丢）", () => {
        const { d } = deliveryOf(home);
        expect(d.system.text).toContain("<rules>");
        expect(d.system.text).toContain("<guard>");
        expect(d.system.text).toContain("禁止执行会杀死宿主进程的命令");
        expect(d.runtime.text).not.toContain("<guard>");
    });

    it("行为指令为空时不注入该段（不写空行凑数），身份行仍在", () => {
        const h2 = makeHome("");
        try {
            const { d } = deliveryOf(h2);
            expect(d.system.text).toContain("你现在的人物是「二副」");
            expect(d.system.text).not.toContain(PERSONA_INSTRUCTION);
        } finally {
            rmSync(h2, { recursive: true, force: true });
        }
    });

    it("改人物行为指令 → 下一轮 system 跟着变（指令不是编译期常量）", () => {
        const { d } = deliveryOf(home);
        const h2 = makeHome("先说结论，再给依据。");
        try {
            const { d: d2 } = deliveryOf(h2);
            expect(d.system.text).not.toBe(d2.system.text);
            expect(d2.system.text).toContain("先说结论，再给依据。");
        } finally {
            rmSync(h2, { recursive: true, force: true });
        }
    });
});

describe("P0-1 修复不得打回 148 的治疗目标", () => {
    it("★ 改任务正文：system 逐字节不变，只有 runtime 变（前缀缓存不被打断）", () => {
        const before = deliveryOf(home);
        writeFileSync(
            join(home, TASK, "AGENTS.md"),
            `---\ntitle: 'P0-1 验收'\nstate: active\npersona: persona/1\n---\n第二版正文，改过一遍\n`,
            "utf-8",
        );
        const after = deliveryOf(home);
        expect(after.d.system.text).toBe(before.d.system.text);
        expect(after.d.runtime.text).not.toBe(before.d.runtime.text);
        expect(after.d.runtime.text).toContain("第二版正文，改过一遍");
        // 行为契约属稳定侧：正文编辑不该让它们换位置/换字节
        expect(after.d.system.places).toEqual(before.d.system.places);
    });

    it("行为契约进 system 后仍在 system 预算内（不会把预算撑爆反而拒发）", () => {
        const { d } = deliveryOf(home);
        // 内置三节合计只有几百字节；给一个宽松上限，防将来把整份 AGENTS.md 塞进契约节点
        expect(d.system.bytes).toBeLessThan(16 * 1024);
    });

    it("system 名单可被 context.yaml 覆盖：把 guard 划走 → 它就不再投（配置真源生效）", () => {
        writeFileSync(
            join(home, "context.yaml"),
            `systemPlaces:\n  - diy\n  - project\n  - cwd\n  - chain\n  - task.title\n  - task.uri\n  - task.state\n  - task.dir\n  - identity\n  - rules\n`,
            "utf-8",
        );
        const { d } = deliveryOf(home);
        expect(d.system.text).toContain("<rules>");
        expect(d.system.text).not.toContain("<guard>");
        expect(d.runtime.text).toContain("<guard>");
    });
});
