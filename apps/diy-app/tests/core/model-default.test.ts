// tests/core/model-default.test.ts
// 🎯 缺省模型口径（src/shared/model-default.ts）的契约：free 候选优先 → 退兜底；
// 候选必须**真的在该 provider 的目录里**才用（不在目录 = 种进去显示「模型不可用」）；
// 已下线模型永不入选。口径的人读版本见仓库根 AGENTS.md::model.default。

import { describe, it, expect } from "vitest";
import {
    FALLBACK_MODEL,
    FREE_MODEL_CANDIDATES,
    FREE_MODEL_CHECKED_AT,
    pickDefaultModel,
    RETIRED_MODELS,
} from "../../src/shared/model-default";

describe("pickDefaultModel", () => {
    it("free 候选可用 → 取偏好序**第一个**（前面的优先）", () => {
        const [first, second] = FREE_MODEL_CANDIDATES;
        expect(pickDefaultModel([second!, "mimo-v2.5"])).toBe(second);
        expect(pickDefaultModel([second!, first!, "mimo-v2.5"])).toBe(first);
    });

    it("候选一个都不在目录里 → 退兜底模型", () => {
        expect(pickDefaultModel([])).toBe(FALLBACK_MODEL);
        expect(pickDefaultModel(["some-new-free", "mimo-v2.5-pro"])).toBe(FALLBACK_MODEL);
    });

    it("目录里的**其它** free 不入选（未经人工实测的 free 不猜）", () => {
        expect(pickDefaultModel(["cat-jam-free", "step-5-preview-free"])).toBe(FALLBACK_MODEL);
    });

    it("口径自洽：已下线模型绝不在候选/兜底里", () => {
        for (const id of RETIRED_MODELS) {
            expect(FREE_MODEL_CANDIDATES).not.toContain(id);
            expect(FALLBACK_MODEL).not.toBe(id);
        }
        expect(FREE_MODEL_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
