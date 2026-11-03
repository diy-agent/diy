// tests/core/agent-limits.test.ts
// 🎯 本地 agent 运行限制合并链：默认值 < limits.json < 环境变量 DIY_LOCAL_*
import { describe, it, expect } from "vitest";
import { resolveLimits, DEFAULT_LIMITS } from "../../src/main/services/local-agent";

describe("resolveLimits", () => {
    it("无文件无 env → 默认", () => {
        expect(resolveLimits(null, {})).toEqual(DEFAULT_LIMITS);
    });
    it("文件覆盖默认；env 覆盖文件", () => {
        expect(resolveLimits({ maxSteps: 3 }, {}).maxSteps).toBe(3);
        expect(resolveLimits({ maxSteps: 3 }, { DIY_LOCAL_MAX_STEPS: "2" }).maxSteps).toBe(2);
    });
    it("非法值逐级忽略（文件负数、env 非数字都回退）", () => {
        expect(resolveLimits({ maxSteps: -1 }, { DIY_LOCAL_MAX_OUTPUT_TOKENS: "abc" }).maxSteps).toBe(
            DEFAULT_LIMITS.maxSteps,
        );
        expect(
            resolveLimits({ maxSteps: -1 }, { DIY_LOCAL_MAX_OUTPUT_TOKENS: "abc" }).maxOutputTokens,
        ).toBe(DEFAULT_LIMITS.maxOutputTokens);
    });
    it("env 空串视为未设置", () => {
        expect(resolveLimits(null, { DIY_LOCAL_MAX_STEPS: "" }).maxSteps).toBe(DEFAULT_LIMITS.maxSteps);
    });
    it("maxSteerQueue（##306）：默认 1000，文件与 env 都能覆盖，非法值逐级回退", () => {
        expect(DEFAULT_LIMITS.maxSteerQueue).toBe(1000);
        expect(resolveLimits({ maxSteerQueue: 5 }, {}).maxSteerQueue).toBe(5);
        expect(resolveLimits(null, { DIY_LOCAL_MAX_STEER_QUEUE: "7" }).maxSteerQueue).toBe(7);
        expect(resolveLimits({ maxSteerQueue: 5 }, { DIY_LOCAL_MAX_STEER_QUEUE: "abc" }).maxSteerQueue).toBe(5);
    });
});
