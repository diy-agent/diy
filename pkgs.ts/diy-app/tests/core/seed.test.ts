// tests/core/seed.test.ts
// 🎯 初始种子的契约：幂等、只配 opencode-go、人物模型 = 0@opencode-go/mimo-v2.6-flash、
// 示例项目/任务形态完整；触发开关只对 preview/lab 缺省开。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelConfig } from "../../src/main/core/model-config";
import { loadPersonas } from "../../src/main/core/persona";
import { autoSeedEnabled, SEED_PERSONA_MODEL, seedHome } from "../../src/main/core/seed";
import { getTask } from "../../src/main/core/state";

const ENV = { OPENCODE_API_KEY: "sk-test-opencode" };

describe("autoSeedEnabled", () => {
    it("缺省：只 preview/lab 开，prod/test 关", () => {
        expect(autoSeedEnabled({ DIY_VARIANT: "preview" })).toBe(true);
        expect(autoSeedEnabled({ DIY_VARIANT: "lab" })).toBe(true);
        expect(autoSeedEnabled({ DIY_VARIANT: "prod" })).toBe(false);
        expect(autoSeedEnabled({ DIY_VARIANT: "test" })).toBe(false);
        expect(autoSeedEnabled({})).toBe(false);
    });
    it("DIY_SEED 显式覆盖（0 关 / 1 开）", () => {
        expect(autoSeedEnabled({ DIY_VARIANT: "preview", DIY_SEED: "0" })).toBe(false);
        expect(autoSeedEnabled({ DIY_VARIANT: "prod", DIY_SEED: "1" })).toBe(true);
    });
});

describe("seedHome", () => {
    let home: string;
    let savedHome: string | undefined;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "diy-seed-"));
        savedHome = process.env["DIY_HOME"];
        process.env["DIY_HOME"] = home; // project/task 走全局数据根（app 里与之同源）
    });
    afterEach(() => {
        if (savedHome === undefined) delete process.env["DIY_HOME"];
        else process.env["DIY_HOME"] = savedHome;
        rmSync(home, { recursive: true, force: true });
    });

    it("空数据根 → 模型/人物/示例项目与任务齐备", () => {
        const r = seedHome(home, ENV);
        expect(r.model).toBe("imported");
        expect(r.persona).toBe("written");
        expect(r.project).not.toBeNull();
        expect(r.tasks).toHaveLength(3);

        const cfg = loadModelConfig(home);
        expect(Object.keys(cfg.stdProviders)).toEqual(["opencode-go"]);
        expect(cfg.stdProviders["opencode-go"]!.accounts[0]!.data.value).toBe("$OPENCODE_API_KEY");

        expect(loadPersonas(home).personas[loadPersonas(home).default]!.model).toBe(
            SEED_PERSONA_MODEL,
        );

        // 任务形态：active 有一条，且有一条子任务挂在它下面
        const active = r.tasks.find((u) => getTask(u)!.state === "active")!;
        const child = r.tasks.find((u) => getTask(u)!.parent === active)!;
        expect(child).toBeDefined();
        expect(getTask(child)!.title).toContain("子任务");
    });

    it("无可用 env → 仍写 $VAR 引用占位（形状完整，UI 标红提示）", () => {
        const r = seedHome(home, {});
        expect(r.model).toBe("placeholder");
        expect(loadModelConfig(home).stdProviders["opencode-go"]!.accounts[0]!.data.value).toBe(
            "$OPENCODE_API_KEY",
        );
    });

    it("幂等：重复种入不动已有数据", () => {
        seedHome(home, ENV);
        const again = seedHome(home, ENV);
        expect(again.model).toBe("exists");
        expect(again.persona).toBe("exists");
        expect(again.project).toBeNull();
        expect(again.tasks).toEqual([]);
        expect(existsSync(join(home, "personas.yaml"))).toBe(true);
    });
});
