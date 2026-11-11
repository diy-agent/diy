// tests/core/output-budget.test.ts
// ═══════════════════════════════════════════════════════════════
// ##429 输出预算：**软硬分离**（真发 = min(软上限, 模型硬上限)）+ 覆盖链 + 场景缺省。
//
// 这是在钉一条**花钱的判据**，所以每条都要有"反例也算得出来"：
//   ① 不配任何东西 ⇒ 对话 65536（##522 从 16384 抬高：思考 token 也计入 output），摘要 8000，小任务 200
//   ② 覆盖链：任务 > 人物 > 全局 > 场景缺省；`layer` 必须报**生效**的那一层
//   ③ 全局是**天花板**：任务/人物写多大都不得越过它（被压低时 clamped 记原值）
//   ④ 模型硬上限更小 ⇒ 真发值被模型压低（cappedByModel），反之不压低
//   ⑤ 非法值（0 / 负数 / NaN）一律当"没设"，不许把 0 下发给上游
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    OUTPUT_SCENE_DEFAULTS,
    OUTPUT_WINDOW_FLOOR,
    describeOutputBudget,
    outputRoomInWindow,
    resolveOutputBudget,
} from "../../src/shared/output-budget";
import { DEFAULT_LIMITS, resolveLimits } from "../../src/main/services/local-agent";
import { DEFAULT_COST_ALARM, costAlarmsOf, newCostAlarmState } from "../../src/shared/cost-alarm";

describe("##429 ① 场景缺省（不配任何东西）", () => {
    it("对话 65536 / 摘要 8000 / 小任务 200", () => {
        expect(OUTPUT_SCENE_DEFAULTS).toMatchObject({ chat: 65536, summary: 8000, small: 200 });
        for (const [scene, want] of [
            ["chat", 65536],
            ["summary", 8000],
            ["small", 200],
        ] as const) {
            const b = resolveOutputBudget({ scene });
            expect(b.tokens).toBe(want);
            expect(b.layer).toBe("scene-default");
            expect(b.cappedByModel).toBe(false);
        }
    });

    it("DEFAULT_LIMITS 的全局上限 = 对话场景缺省，且来源标 default", () => {
        expect(DEFAULT_LIMITS.maxOutputTokens).toBe(OUTPUT_SCENE_DEFAULTS.chat);
        expect(DEFAULT_LIMITS.maxOutputTokensSource).toBe("default");
    });
});

describe("##429 ② 覆盖链：任务 > 人物 > 全局 > 场景缺省", () => {
    it("四层各自生效时 layer 都说得出是谁定的", () => {
        expect(resolveOutputBudget({ scene: "chat", task: 8000, persona: 4000, global: 2000 }).tokens).toBe(2000);
        // 任务最大，但全局 2000 是天花板 ⇒ 生效的是全局（见 ③）
        expect(resolveOutputBudget({ scene: "chat", persona: 4000, global: 6000 }).layer).toBe("persona");
        expect(resolveOutputBudget({ scene: "chat", global: 6000 }).layer).toBe("global");
        expect(resolveOutputBudget({ scene: "chat" }).layer).toBe("scene-default");
        expect(resolveOutputBudget({ scene: "chat", persona: 4000, global: 6000 }).tokens).toBe(4000);
    });

    it("任务层优先于人物层", () => {
        const b = resolveOutputBudget({ scene: "chat", task: 12000, persona: 4000 });
        expect(b).toMatchObject({ tokens: 12000, layer: "task" });
    });

    it("resolveLimits：没人配 maxOutputTokens ⇒ source=default；配了 ⇒ file / env", () => {
        expect(resolveLimits(null, {}).maxOutputTokensSource).toBe("default");
        expect(resolveLimits({ maxOutputTokens: 2000 }, {}).maxOutputTokensSource).toBe("file");
        const env = resolveLimits({ maxOutputTokens: 2000 }, { DIY_LOCAL_MAX_OUTPUT_TOKENS: "3000" });
        expect(env).toMatchObject({ maxOutputTokens: 3000, maxOutputTokensSource: "env" });
    });
});

describe("##429 ③ 全局层同时是天花板", () => {
    it("人物写 40000、全局 8000 ⇒ 真发 8000，且 clamped 记着原值与来源", () => {
        const b = resolveOutputBudget({ scene: "chat", persona: 40000, global: 8000 });
        expect(b.tokens).toBe(8000);
        expect(b.layer).toBe("global");
        expect(b.clamped).toEqual({ layer: "persona", value: 40000 });
    });

    it("没被压低时不产生 clamped（避免日志里出现无意义的空壳）", () => {
        expect(resolveOutputBudget({ scene: "chat", persona: 4000, global: 8000 }).clamped).toBeUndefined();
    });
});

describe("##429 ④ 模型硬上限只压不抬", () => {
    it("模型 limit.output=8000 ⇒ 真发 8000 并标 cappedByModel", () => {
        const b = resolveOutputBudget({ scene: "chat", modelLimit: 8000 });
        expect(b).toMatchObject({ tokens: 8000, soft: 65536, cappedByModel: true, modelLimit: 8000 });
    });

    it("模型比软上限更宽 ⇒ 真发 = 软上限（不再撞 131072 那种硬上限）", () => {
        const b = resolveOutputBudget({ scene: "chat", modelLimit: 131072 });
        expect(b.tokens).toBe(65536);
        expect(b.cappedByModel).toBe(false);
    });

    it("模型硬上限未知（null）⇒ 只用软上限，不编一个数", () => {
        const b = resolveOutputBudget({ scene: "chat", modelLimit: null });
        expect(b).toMatchObject({ tokens: 65536, modelLimit: null, cappedByModel: false });
    });
});

describe("##429 ⑤ 非法值一律当没设（绝不把 0 下发给上游）", () => {
    it("0 / 负数 / NaN 逐层被忽略，退回下一层", () => {
        expect(resolveOutputBudget({ scene: "chat", task: 0, persona: -1, global: Number.NaN }).tokens).toBe(65536);
        expect(resolveOutputBudget({ scene: "chat", task: 0, persona: 4000 }).tokens).toBe(4000);
    });
});

describe("##429 文案（日志 / 流量页 / notice 共用）", () => {
    it("说得出数值、来源层与模型硬上限", () => {
        const b = resolveOutputBudget({ scene: "chat", persona: 4000, modelLimit: 131072 });
        expect(describeOutputBudget(b)).toBe("4000（人物设定） · 模型硬上限 131072");
    });

    it("被模型压低时要写明“已压低”", () => {
        const b = resolveOutputBudget({ scene: "chat", modelLimit: 8000 });
        expect(describeOutputBudget(b)).toContain("已压低");
    });
});

describe("##429 ⑤ 成本门槛告警（纯判据）", () => {
    it("缺省阈值 $0.10 单步 / $0.50 单轮", () => {
        expect(DEFAULT_COST_ALARM).toEqual({ stepUsd: 0.1, turnUsd: 0.5 });
    });

    it("单步超阈 ⇒ 一条 cost-step；同轮再来一次超阈不再报（防刷屏）", () => {
        const s = newCostAlarmState();
        const first = costAlarmsOf(s, 0.2, 0.2);
        expect(first.alarms.map((a) => a.kind)).toEqual(["cost-step"]);
        const second = costAlarmsOf(first.state, 0.9, 1.1);
        expect(second.alarms.map((a) => a.kind)).toEqual(["cost-turn"]); // 单步已报过，只剩单轮
    });

    it("阈值 0 / null = 关闭该类告警", () => {
        expect(costAlarmsOf(newCostAlarmState(), 5, 5, { stepUsd: null, turnUsd: 0 }).alarms).toEqual([]);
    });

    it("无价目（null）不算花超：不许把“不知道多少钱”算成 0 或超阈", () => {
        expect(costAlarmsOf(newCostAlarmState(), null, null).alarms).toEqual([]);
    });

    it("正好等于阈值不报（判据是 > 而不是 >=）", () => {
        expect(costAlarmsOf(newCostAlarmState(), 0.1, 0.5).alarms).toEqual([]);
    });
});

describe("##429 ③ 告警阈值可配（limits.json / env）", () => {
    it("缺省 $0.10 / $0.50；文件与 env 都能覆盖；0 = 关闭；env 支持 0", () => {
        expect(resolveLimits(null, {})).toMatchObject({ costWarnStepUsd: 0.1, costWarnTurnUsd: 0.5 });
        expect(resolveLimits({ costWarnStepUsd: 0 }, {}).costWarnStepUsd).toBe(0); // 0 = 关闭，文件也认
        expect(resolveLimits({ costWarnStepUsd: 0.02 }, {}).costWarnStepUsd).toBe(0.02);
        expect(resolveLimits(null, { DIY_LOCAL_COST_WARN_TURN_USD: "0" }).costWarnTurnUsd).toBe(0);
        expect(resolveLimits(null, { DIY_LOCAL_COST_WARN_STEP_USD: "0.3" }).costWarnStepUsd).toBe(0.3);
    });
});

// ═══════════════════════════════════════════════════════════════
// ##522 第三项 min：**窗口剩余**（抄 opencode `outputLimit` 的口径）
//
// 真发值 = min(软上限, 模型上限, 窗口剩余)。这一项与"我们愿付多少"无关，
// 只防两件事：① 输入快撑满时还要 65k ⇒ 上游以「输入+输出>窗口」直接拒；
// ② 为了防 ① 而把常数压到很小 ⇒ 写作任务天天被他自己的设置掐断。
// ═══════════════════════════════════════════════════════════════
describe("##522 窗口剩余", () => {
    it("窗口未知（null / 0）⇒ null：不施加第三项", () => {
        expect(outputRoomInWindow(null, 1000)).toBeNull();
        expect(outputRoomInWindow(0, 1000)).toBeNull();
    });

    it("窗口宽裕 ⇒ 剩余 = 窗口 − 输入×1.15（低估安全垫）", () => {
        expect(outputRoomInWindow(1_000_000, 247_000)).toBe(715_950);
        expect(outputRoomInWindow(1_000_000, null)).toBe(1_000_000);
    });

    it("输入吃满窗口 ⇒ 落到下限，绝不吐 0 / 负数（否则上游拒 max_tokens<1）", () => {
        expect(outputRoomInWindow(1_000_000, 900_000)).toBe(OUTPUT_WINDOW_FLOOR);
        expect(outputRoomInWindow(1000, 1000)).toBe(OUTPUT_WINDOW_FLOOR);
    });
});
