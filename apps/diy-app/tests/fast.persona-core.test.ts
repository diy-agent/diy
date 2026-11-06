/**
 * fast.persona-core.test.ts — persona 核心逻辑的**函数级**测试（不起 Electron、不起 CLI、不需 build）
 *
 * 为什么另起一个文件（##518 测试提速调查）：
 *   `tests/cli.intent.persona.test.ts` 里同一条规则的验证要付三次「进程税」：
 *     ① 每个断言起一个 `./diy.sh` 子进程（热 0.4s / 冷 2.7s）；
 *     ② UI 轮询靠 `ui inspect`（又一条 CLI），`waitUntil` 每轮 = 0.4s + 100ms sleep，失败吃满 5s；
 *     ③ 跑之前必须 `DIY_VARIANT=test ./sha.sh build`（Electron 产物）。
 *   而「造 24 个人物 / 缺省指向谁 / 改名不断引用」这类规则**只依赖 persona 的纯逻辑与文件层**，
 *   根本不需要窗口。放在这里跑是毫秒级，也让 intent 那边只剩「真的要点得动」的那几条。
 *
 * 分工：本文件 = 数据与规则（快、稳定）；`cli.intent.*` = 真实 UI 交互（慢、必要）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
    defaultPersonaId,
    listPersonas,
    loadPersonas,
    savePersonas,
    personaById,
    personasFile,
} from "../src/main/core/persona";

let home: string;
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "persona-core-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** 直接写 personalities 文件（等价于 CLI 的 24 次 `agent persona set`，但只是一次 IO） */
function seed(count: number): string[] {
    const base = loadPersonas(home);
    for (let i = 0; i < count; i++) {
        base.personas[`persona/${String(900 + i)}`] = {
            name: `占位${String(i)}`,
            model: "mimo-v2.6-flash",
            reasoningEffort: "medium",
            instructions: "",
        };
    }
    savePersonas(home, base);
    return Array.from({ length: count }, (_, i) => `persona/${String(900 + i)}`);
}

describe("persona 核心（函数级，无进程）", () => {
    it("造 24 个人物 + 缺省指向中位：一次 IO 搞定", () => {
        const ids = seed(24);
        const file = loadPersonas(home);
        file.default = ids[11]!;
        savePersonas(home, file);

        expect(listPersonas(home)).toHaveLength(25); // 内置 1 + 24
        expect(defaultPersonaId(home)).toBe(ids[11]);
        expect(personaById(home, ids[11]!)?.name).toBe("占位11");
    });

    it("改名不断引用（引用存 id）", () => {
        const [id] = seed(1);
        const file = loadPersonas(home);
        file.personas[id!] = { ...file.personas[id!]!, name: "改过的名字" };
        savePersonas(home, file);
        expect(personaById(home, id!)?.name).toBe("改过的名字");
    });

    it("文件损坏 → 退回内置人物，且不抛", () => {
        writeFileSync(personasFile(home), "personas: [not-an-object");
        expect(listPersonas(home).length).toBeGreaterThan(0);
    });

    it("缺省指向不存在的人 → 退到表里第一个（不造悬空引用）", () => {
        const file = loadPersonas(home);
        file.default = "persona/does-not-exist";
        writeFileSync(personasFile(home), yamlStringify(file, { indent: 2 }));
        const parsed = yamlParse(readFileSync(personasFile(home), "utf-8")) as { default: string };
        expect(parsed.default).toBe("persona/does-not-exist"); // 文件照写
        expect(defaultPersonaId(home)).not.toBe("persona/does-not-exist"); // 但生效值不回悬空
    });
});
