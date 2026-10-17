// tests/core/model-pricing.test.ts
// 🎯 「按哪条模型给这一步计价」—— 上游**裸 modelId** 的歧义与 provider 限定（##372）。
//
// 为什么值得单测：
//   · `findModel(裸 id)` 在多 provider 收录时**故意**返回 undefined（不猜，见其头注）；
//     而计价调用点拿到的是**上游回执**里的裸 id —— 于是 costOf 静默 null、金额被当 0 累加，
//     现象是"会话金额恒为 0"，且**不报错、不留痕**（真实事故：deepseek-v4.1-flash 同时被
//     opencode-go 与 opencode 收录）。
//   · 修法（限定到本请求的 provider/account）必须证明两件事：
//       ① 多 provider 收录时**确实命中本请求那一家**（不是「随便挑一个」——同一 id 不同 provider
//          是不同商品，价可能不同）；
//       ② 查不到时**退回本请求模型且留痕**（不许静默按原模型算）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    costOf,
    findModel,
    findPricedModel,
    ratesOfModel,
    respondedIdCandidates,
    setModelCatalog,
    type ResolvedModel,
} from "../../src/shared/models";
import { OPENCODE_GO_SNAPSHOT, FIXTURE_DEFAULT_REF } from "../fixtures/models";

const AMBIGUOUS_ID = "deepseek-v4.1-flash";

/** 目录夹具：把歧义模型**再挂一家 provider**（假想第二家是 `opencode`，价刻意不同以便区分命中谁） */
const ds = OPENCODE_GO_SNAPSHOT.find((m) => m.id === AMBIGUOUS_ID)!;
const CATALOG: ResolvedModel[] = [
    ...OPENCODE_GO_SNAPSHOT,
    // 第二家 provider 收录同一个裸 id（这就是「裸 id 歧义」的成因）
    { ...ds, provider: "opencode", ref: `0@opencode/${AMBIGUOUS_ID}`, cost: { input: 9.99, output: 9.99, cacheRead: 0.999 } },
    // opencode-go 下的第二个账号：**元数据一致**（同 provider 多账号 → 优先本账号，价相同）
    { ...ds, account: "work", ref: `work@opencode-go/${AMBIGUOUS_ID}` },
];

beforeAll(() => setModelCatalog(CATALOG));
afterAll(() => setModelCatalog(OPENCODE_GO_SNAPSHOT));

describe("病灶本身：裸 id 多 provider 收录 = 歧义（不猜）", () => {
    it("findModel(裸 id) → undefined；costOf(裸 id) → null（修前的值就是它）", () => {
        expect(findModel(AMBIGUOUS_ID)).toBeUndefined();
        expect(costOf(AMBIGUOUS_ID, 1000)).toBeNull();
    });
    it("完全限定名照常能查（歧义不影响限定名）", () => {
        expect(findModel(`0@opencode-go/${AMBIGUOUS_ID}`)?.provider).toBe("opencode-go");
        expect(costOf(`0@opencode-go/${AMBIGUOUS_ID}`, 1000)?.input).toBe(0.15);
    });
});

describe("respondedIdCandidates：回执的三种形状都要能剥到 catalog 的 id", () => {
    it("裸 id 原样", () => {
        expect(respondedIdCandidates(AMBIGUOUS_ID)).toEqual([AMBIGUOUS_ID]);
    });
    it("vendor/id → 追加去前缀的裸 id", () => {
        expect(respondedIdCandidates(`deepseek/${AMBIGUOUS_ID}`)).toEqual([`deepseek/${AMBIGUOUS_ID}`, AMBIGUOUS_ID]);
    });
    it("完全限定名 → 追加 model 段", () => {
        expect(respondedIdCandidates(`0@opencode-go/${AMBIGUOUS_ID}`)).toEqual([`0@opencode-go/${AMBIGUOUS_ID}`, AMBIGUOUS_ID]);
    });
    it("自带 / 的 id 原样排第一（不能被 vendor 规则抢先剥掉）", () => {
        expect(respondedIdCandidates("xiaomi/mimo-v2.6-flash")[0]).toBe("xiaomi/mimo-v2.6-flash");
    });
    it("空 / 全空白 → 无候选", () => {
        expect(respondedIdCandidates(undefined)).toEqual([]);
        expect(respondedIdCandidates("  ")).toEqual([]);
    });
});

describe("findPricedModel：限定到**本请求的 provider**再查（修后的路径）", () => {
    it("裸回流 + 限定 ref → 命中**本请求那一家**的价（不是另一家的 9.99）", () => {
        const p = findPricedModel(AMBIGUOUS_ID, `0@opencode-go/${AMBIGUOUS_ID}`);
        expect(p.basis).toBe("response");
        expect(p.model?.provider).toBe("opencode-go");
        expect(ratesOfModel(p.model, 1000)).toMatchObject({ input: 0.15, output: 0.6, tier: "base" });
    });

    it("同一裸 id、请求走另一家 → 命中另一家的价（证明限定的是 provider，不是「随便挑一个」）", () => {
        const p = findPricedModel(AMBIGUOUS_ID, `0@opencode/${AMBIGUOUS_ID}`);
        expect(p.model?.provider).toBe("opencode");
        expect(ratesOfModel(p.model, 1000)).toMatchObject({ input: 9.99 });
    });

    it("vendor/id 形状的回执同样命中", () => {
        const p = findPricedModel(`deepseek/${AMBIGUOUS_ID}`, `0@opencode-go/${AMBIGUOUS_ID}`);
        expect(p.basis).toBe("response");
        expect(p.model?.provider).toBe("opencode-go");
    });

    it("回执自带限定段（acc@prov/id）→ 剥壳后仍按**本请求**的账号计价（回执里的账号段是回声，不作准）", () => {
        const p = findPricedModel(`work@opencode-go/${AMBIGUOUS_ID}`, `0@opencode-go/${AMBIGUOUS_ID}`);
        expect(p.basis).toBe("response");
        expect(p.model?.ref).toBe(`0@opencode-go/${AMBIGUOUS_ID}`);
    });

    it("同 provider 多账号：优先本请求的那个账号（元数据一致，取谁都对，但要可预期）", () => {
        expect(findPricedModel(AMBIGUOUS_ID, `0@opencode-go/${AMBIGUOUS_ID}`).model?.account).toBe("0");
        expect(findPricedModel(AMBIGUOUS_ID, `work@opencode-go/${AMBIGUOUS_ID}`).model?.account).toBe("work");
    });
});

describe("回落与留痕（不许静默按原模型计价）", () => {
    it("回执模型查不到 → 退按**本请求**模型，basis=request（账上看得见）", () => {
        const p = findPricedModel("gpt-nope-9", `0@opencode-go/${AMBIGUOUS_ID}`);
        expect(p.basis).toBe("request");
        expect(p.model?.ref).toBe(`0@opencode-go/${AMBIGUOUS_ID}`);
        expect(ratesOfModel(p.model, 1000)?.input).toBe(0.15);
    });

    it("回执缺省（上游没报模型）→ 同样按请求模型，basis=request", () => {
        const p = findPricedModel(undefined, FIXTURE_DEFAULT_REF);
        expect(p.basis).toBe("request");
        expect(p.model?.ref).toBe(FIXTURE_DEFAULT_REF);
    });

    it("回执与请求同名（无改写）→ basis=response，金额与旧路径一致", () => {
        const p = findPricedModel(AMBIGUOUS_ID, `0@opencode-go/${AMBIGUOUS_ID}`);
        expect(p.basis).toBe("response");
        expect(ratesOfModel(p.model, 1000)?.input).toBe(costOf(`0@opencode-go/${AMBIGUOUS_ID}`, 1000)?.input);
    });

    it("请求模型本身不在目录 → basis=none，rates null（**不是 0**）", () => {
        const p = findPricedModel("whatever", "0@nope/whatever");
        expect(p.basis).toBe("none");
        expect(p.model).toBeUndefined();
        expect(ratesOfModel(p.model, 1000)).toBeNull();
    });
});
