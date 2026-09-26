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
    defaultPersonaId,
    listPersonas,
    loadPersonas,
    personaById,
    personaByIdOrName,
    personaForTask,
    personasFile,
    savePersonas,
} from "../../src/main/core/persona";
import { BUILTIN_PERSONA_ID, BUILTIN_PERSONA_NAME } from "../../src/shared/persona";
import { DEFAULT_MODEL } from "../../src/shared/models";

/** 写一份任务文件（只保留 persona 判定需要的字段） */
function writeTask(uri: string, front: string): void {
    const fp = join(diyHome(), uri, "AGENTS.md");
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, `---\n${front}\n---\n\n正文\n`, "utf-8");
}

const TWO = {
    default: "p2",
    personas: {
        p2: { name: "密探", model: "mimo-v2.6-flash", reasoningEffort: "low", style: "只回要点。" },
        p1: { name: "大副", model: DEFAULT_MODEL, reasoningEffort: "medium", style: "" },
    },
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    rmSync(personasFile(diyHome()), { force: true });
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe("内置缺省人物（personas.yaml 不存在）", () => {
    it("开箱即用：一个人物（内置缺省）", () => {
        const file = loadPersonas(diyHome());
        expect(Object.keys(file.personas)).toEqual([BUILTIN_PERSONA_ID]);
        expect(defaultPersonaId(diyHome())).toBe(BUILTIN_PERSONA_ID);
        // 缺省人物的模型必须与全局默认模型一致（否则"重启回到的模型"会是第三个值）
        expect(personaById(diyHome(), BUILTIN_PERSONA_ID)?.model).toBe(DEFAULT_MODEL);
        expect(listPersonas(diyHome())).toHaveLength(1);
    });

    it("文件损坏 / 空人物表：回落内置且出声（不静默）", () => {
        writeFileSync(personasFile(diyHome()), "{ 这不是 yaml: [", "utf-8");
        expect(defaultPersonaId(diyHome())).toBe(BUILTIN_PERSONA_ID);
        expect(warn).toHaveBeenCalled();

        warn.mockClear();
        writeFileSync(personasFile(diyHome()), "default: p1\npersonas: {}\n", "utf-8");
        expect(defaultPersonaId(diyHome())).toBe(BUILTIN_PERSONA_ID);
        expect(warn).toHaveBeenCalled();
    });
});

describe("personas.yaml 读写", () => {
    it("保存后 reload 一致，且书写顺序保留（UI 选择器照此展示）", () => {
        savePersonas(diyHome(), TWO);
        expect(defaultPersonaId(diyHome())).toBe("p2");
        expect(listPersonas(diyHome()).map((p) => p.name)).toEqual(["密探", "大副"]);
        // id 是 key，名字是内容 —— 下发形状把 id 物化成字段，界面/CLI 才有稳定寻址
        expect(personaById(diyHome(), "p2")).toEqual({ id: "p2", ...TWO.personas["p2"] });
        // 按名字也能找到（CLI 便利入口）：人记得的是名字
        expect(personaByIdOrName(diyHome(), "密探")?.id).toBe("p2");
    });

    it("default 指向不存在的人物 → 退到人物表第一个（不报错、不留空）", () => {
        savePersonas(diyHome(), { ...TWO, default: "查无此人" });
        expect(defaultPersonaId(diyHome())).toBe("p2");
    });
});

describe("任务 → 人物解析（personaForTask）", () => {
    it("任务带 persona：用该人物", () => {
        savePersonas(diyHome(), TWO);
        writeTask("projects/9/tasks/1", "title: 'a'\nstate: pending\npersona: p2");
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
        writeTask("projects/9/tasks/3", "title: 'c'\nstate: pending\npersona: p999");
        expect(personaForTask(diyHome(), "projects/9/tasks/3").name).toBe("密探");
        expect(warn).toHaveBeenCalled();
    });

    it("**改人物的名字，任务绑定不受影响**（引用存 id 的理由）", () => {
        // 名字是给人看的标签，id 才是引用键。若拿名字当引用，改名就等于把所有引用打断
        // —— 引用者静默回落缺省人物，即"换模型不打招呼"。
        savePersonas(diyHome(), TWO);
        writeTask("projects/9/tasks/4", "title: 'd'\nstate: pending\npersona: p2");
        expect(personaForTask(diyHome(), "projects/9/tasks/4").name).toBe("密探");

        // 把 p2 改名（定义其余字段不动）
        savePersonas(diyHome(), { ...TWO, personas: { ...TWO.personas, p2: { ...TWO.personas.p2, name: "赫敏" } } });
        const p = personaForTask(diyHome(), "projects/9/tasks/4");
        expect(p.name).toBe("赫敏"); // 名字变了
        expect(p.model).toBe("mimo-v2.6-flash"); // 绑定没断，模型照旧
        expect(warn).not.toHaveBeenCalled(); // 且没有"回落"告警
    });

    it("无任务场景（空 uri）：用缺省人物", () => {
        savePersonas(diyHome(), TWO);
        expect(personaForTask(diyHome(), "").name).toBe("密探");
    });
});

describe("定义校验（写入前拦住非法配置）", () => {
    it("未知模型被拒", () => {
        expect(() => assertPersonaDef({ name: "x", model: "不存在的模型", reasoningEffort: "none", style: "" })).toThrow(
            /未知模型/,
        );
    });

    it("档位不在该模型支持集内被拒（各模型词表不同）", () => {
        // mimo-v2.6-flash 不支持 xhigh（见 shared/models.ts 的实测注释）
        expect(() =>
            assertPersonaDef({ name: "x", model: "mimo-v2.6-flash", reasoningEffort: "xhigh", style: "" }),
        ).toThrow(/不支持推理强度/);
    });

    it("合法组合通过", () => {
        expect(() =>
            assertPersonaDef({ name: "x", model: "mimo-v2.6-flash", reasoningEffort: "high", style: "sir" }),
        ).not.toThrow();
    });
});
