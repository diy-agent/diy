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
import { buildDelivery } from "@diy-agent/context/delivery";

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
    const globals = assembleGlobals(h, PID, { taskUri: TASK, diyCli: "/repo/diy.sh" }) as unknown as Record<
        string,
        unknown
    >;
    return { globals, d: buildDelivery(globals) };
};

beforeEach(() => {
    home = makeHome(PERSONA_INSTRUCTION);
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe("P0-1：真发 system 必须带行为契约", () => {
    it("三节都是投递单元并出现在全量信封里（不在候选 = 根本不投，那正是 P0-1）", () => {
        const { d } = deliveryOf(home);
        for (const name of Object.keys(DELIVERED_SECTIONS)) {
            expect(d.tree.places, name).toContain(name);
            expect(d.text.places, name).toContain(name);
        }
    });

    it("★ 真发 system 含人物行为指令与身份行（209 实测的两项 false 必须变 true）", () => {
        const { d } = deliveryOf(home);
        expect(d.text.text).toContain(PERSONA_INSTRUCTION);
        expect(d.text.text).toContain("你现在的人物是「二副」");
        // 模板线（模版渲染）与真发线同源：两边都必须在（209 的口径是"两边对比全 true"）
        const tpl = assembleSystem(home, PID, { taskUri: TASK, diyCli: "/repo/diy.sh" }).system;
        for (const needle of [PERSONA_INSTRUCTION, "你现在的人物是「二副」"]) {
            expect(tpl.includes(needle), `模板线缺 ${needle}`).toBe(true);
            expect(d.text.text.includes(needle), `真发缺 ${needle}`).toBe(true);
        }
    });

    it("★ 真发 system 含 <rules> 与 <guard>（保命契约不许丢）", () => {
        const { d } = deliveryOf(home);
        expect(d.text.text).toContain("<rules>");
        expect(d.text.text).toContain("<guard>");
        expect(d.text.text).toContain("生产实例");
        expect(d.text.text).toContain("绝不可杀");
    });

    it("行为指令为空时不注入该段（不写空行凑数），身份行仍在", () => {
        const h2 = makeHome("");
        try {
            const { d } = deliveryOf(h2);
            expect(d.text.text).toContain("你现在的人物是「二副」");
            expect(d.text.text).not.toContain(PERSONA_INSTRUCTION);
        } finally {
            rmSync(h2, { recursive: true, force: true });
        }
    });

    it("改人物行为指令 → 下一轮 system 跟着变（指令不是编译期常量）", () => {
        const { d } = deliveryOf(home);
        const h2 = makeHome("先说结论，再给依据。");
        try {
            const { d: d2 } = deliveryOf(h2);
            expect(d.text.text).not.toBe(d2.text.text);
            expect(d2.text.text).toContain("先说结论，再给依据。");
        } finally {
            rmSync(h2, { recursive: true, force: true });
        }
    });
});

describe("P0-1 修复不得打回 148 的治疗目标", () => {
    it("★ 改任务正文：行为契约字节不动，正文在下一份全量里（段首冻结由运行层负责）", () => {
        const before = deliveryOf(home);
        writeFileSync(
            join(home, TASK, "AGENTS.md"),
            `---\ntitle: 'P0-1 验收'\nstate: active\npersona: persona/1\n---\n第二版正文，改过一遍\n`,
            "utf-8",
        );
        const after = deliveryOf(home);
        // 纯函数产物会随正文变；前缀缓存由运行层的**段首快照**保证。
        // 这里钉：新正文进了全量；行为契约仍在；单元集合不变（增量只报 task.body）。
        expect(after.d.text.text).not.toBe(before.d.text.text);
        expect(after.d.text.text).toContain("第二版正文，改过一遍");
        for (const needle of [PERSONA_INSTRUCTION, "<rules>", "<guard>"]) {
            expect(after.d.text.text).toContain(needle);
        }
        expect(after.d.text.places).toEqual(before.d.text.places);
    });

    it("行为契约进 system 后仍在 system 预算内（不会把预算撑爆反而拒发）", () => {
        const { d } = deliveryOf(home);
        // 内置三节合计只有几百字节；给一个宽松上限，防将来把整份 AGENTS.md 塞进契约节点
        // （判据只看**稳定树段**：runtime 现在也在 system 消息里，但那不是行为契约的预算）
        expect(d.data.bytes).toBeLessThan(16 * 1024);
    });

    it("guard 的值不存在时整个单元缺席（不再有「划走」的名单，只看值在不在）", () => {
        const { globals, d } = deliveryOf(home);
        const without = { ...globals } as Record<string, unknown>;
        delete without.guard;
        const d2 = buildDelivery(without);
        expect(d.text.text).toContain("<guard>");
        expect(d2.text.places).not.toContain("guard");
        expect(d2.text.text).not.toContain("<guard>");
    });
});
