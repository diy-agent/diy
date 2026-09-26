// tests/core/persona.test.ts
// 🎯 agent 人物（persona）文件层的意图测试：默认兜底 / 往返 / 回落 / 写入前校验
//
// 这里锁的是**配置真源**的语义（模型属于人物、任务只持引用）：
//   · 文件不存在也能开箱可用（内置人物），且缺省人物是数据不是代码里的硬编码回落
//   · 任务指向消失的人物时**回落缺省并出声**，绝不静默换模型
//   · 非法配置（未知模型 / 档位不支持）在**写入前**拦住，而不是等上游 400

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import {
    assertPersonaDef,
    defaultPersonaName,
    listPersonas,
    loadPersonas,
    personaByName,
    personaForTask,
    personasFile,
    savePersonas,
} from "../../src/main/core/persona";
import { BUILTIN_PERSONA_NAME } from "../../src/shared/persona";
import { DEFAULT_MODEL } from "../../src/shared/models";

/** 写一份任务文件（只保留 persona 判定需要的字段） */
function writeTask(uri: string, front: string): void {
    const fp = join(diyHome(), uri, "AGENTS.md");
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, `---\n${front}\n---\n\n正文\n`, "utf-8");
}

const TWO = {
    default: "密探",
    personas: {
        密探: { model: "mimo-v2.6-flash", reasoningEffort: "low", style: "只回要点。", desc: "轻量快问快答" },
        大副: { model: DEFAULT_MODEL, reasoningEffort: "medium", style: "", desc: "默认" },
    },
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    rmSync(personasFile(diyHome()), { force: true });
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe("内置缺省人物（personas.yaml 不存在）", () => {
    it("开箱即用：一个人物，且缺省名 = 内置名", () => {
        const file = loadPersonas(diyHome());
        expect(Object.keys(file.personas)).toEqual([BUILTIN_PERSONA_NAME]);
        expect(defaultPersonaName(diyHome())).toBe(BUILTIN_PERSONA_NAME);
        // 缺省人物的模型必须与全局默认模型一致（否则"重启回到的模型"会是第三个值）
        expect(personaByName(diyHome(), BUILTIN_PERSONA_NAME)?.model).toBe(DEFAULT_MODEL);
        expect(listPersonas(diyHome())).toHaveLength(1);
    });

    it("文件损坏 / 空人物表：回落内置且出声（不静默）", () => {
        writeFileSync(personasFile(diyHome()), "{ 这不是 yaml: [", "utf-8");
        expect(defaultPersonaName(diyHome())).toBe(BUILTIN_PERSONA_NAME);
        expect(warn).toHaveBeenCalled();

        warn.mockClear();
        writeFileSync(personasFile(diyHome()), "default: 大副\npersonas: {}\n", "utf-8");
        expect(defaultPersonaName(diyHome())).toBe(BUILTIN_PERSONA_NAME);
        expect(warn).toHaveBeenCalled();
    });
});

describe("personas.yaml 读写", () => {
    it("保存后 reload 一致，且书写顺序保留（UI 选择器照此展示）", () => {
        savePersonas(diyHome(), TWO);
        expect(defaultPersonaName(diyHome())).toBe("密探");
        expect(listPersonas(diyHome()).map((p) => p.name)).toEqual(["密探", "大副"]);
        expect(personaByName(diyHome(), "密探")).toEqual({ name: "密探", ...TWO.personas["密探"] });
    });

    it("default 指向不存在的人物 → 退到人物表第一个（不报错、不留空）", () => {
        savePersonas(diyHome(), { ...TWO, default: "查无此人" });
        expect(defaultPersonaName(diyHome())).toBe("密探");
    });
});

describe("任务 → 人物解析（personaForTask）", () => {
    it("任务带 persona：用该人物", () => {
        savePersonas(diyHome(), TWO);
        writeTask("projects/9/tasks/1", "title: 'a'\nstate: pending\npersona: 密探");
        expect(personaForTask(diyHome(), "projects/9/tasks/1").name).toBe("密探");
        expect(personaForTask(diyHome(), "projects/9/tasks/1").model).toBe("mimo-v2.6-flash");
    });

    it("任务缺 persona 字段（手删）：回落缺省人物**并出声**", () => {
        // 正常数据不会缺该字段（创建时物化 + 存量已迁移）；缺只可能是用户手改 AGENTS.md。
        // 回落但不静默：「这次用哪个模型」是必须可观测的事实。
        savePersonas(diyHome(), TWO);
        writeTask("projects/9/tasks/2", "title: 'b'\nstate: pending");
        expect(personaForTask(diyHome(), "projects/9/tasks/2").name).toBe("密探");
        expect(warn).toHaveBeenCalled();
    });

    it("任务指向已不存在的人物：回落缺省**并出声**（换模型不能不打招呼）", () => {
        savePersonas(diyHome(), TWO);
        writeTask("projects/9/tasks/3", "title: 'c'\nstate: pending\npersona: 已删除的人物");
        expect(personaForTask(diyHome(), "projects/9/tasks/3").name).toBe("密探");
        expect(warn).toHaveBeenCalled();
    });

    it("无任务场景（空 uri）：用缺省人物", () => {
        savePersonas(diyHome(), TWO);
        expect(personaForTask(diyHome(), "").name).toBe("密探");
    });
});

describe("定义校验（写入前拦住非法配置）", () => {
    it("未知模型被拒", () => {
        expect(() => assertPersonaDef({ model: "不存在的模型", reasoningEffort: "none", style: "", desc: "" })).toThrow(
            /未知模型/,
        );
    });

    it("档位不在该模型支持集内被拒（各模型词表不同）", () => {
        // mimo-v2.6-flash 不支持 xhigh（见 shared/models.ts 的实测注释）
        expect(() =>
            assertPersonaDef({ model: "mimo-v2.6-flash", reasoningEffort: "xhigh", style: "", desc: "" }),
        ).toThrow(/不支持推理强度/);
    });

    it("合法组合通过", () => {
        expect(() =>
            assertPersonaDef({ model: "mimo-v2.6-flash", reasoningEffort: "high", style: "sir", desc: "" }),
        ).not.toThrow();
    });
});
