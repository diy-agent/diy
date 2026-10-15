// tests/core/compact-keep.test.ts
// 🎯 装配管道进配置（##344 M2）—— `history.keep[]` 的契约面
//
// 钉住五条验收（对应 ##344 body 的「验收」节）：
//   ① **读写往返一致**：配置文本 → 级列表 → 生效管道 →（读回）语义等价；
//   ② **回落不回归**：配置无 `keep` ⇒ 行为 = ##343 M1 的缺省管道（逐级等价 + 选择结果等价）；
//   ③ **非法 plan 拒绝**：级类型 / clip 形状 / 空列表 ⇒ 拒绝且**不改文件**；
//   ④ **事件账 v3 可回放**：v3 带 plan 快照；v2 旧行仍可读（`plan` 缺席 = 缺省管道）；
//   ⑤ `check` 的 must 层硬上限判据（测量注入 ⇒ 可确定性测）。

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import * as yaml from "js-yaml";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import {
    DEFAULT_EXEMPT_STEPS,
    DEFAULT_HEADTAIL_CLIP_DATA,
    retypeStage,
    validateKeepStages,
    keepStageLabel,
    withClip,
    withLimit,
    withMust,
    type KeepStage,
} from "../../src/shared/context/compact-keep";
import { DEFAULT_AUTO_COMPACT, normalizeAutoCompact, type AutoCompactConfig } from "../../src/shared/context/auto-compact";
import {
    autoCompactFile,
    loadAutoCompact,
    parseKeepText,
    readAutoCompactText,
    saveAutoCompact,
    saveKeepConfig,
} from "../../src/main/core/auto-compact-config";
import { keepStagesToPlan, defaultBudgetPlan, runPlan } from "../../src/main/services/compaction-plan";
import { parseCompactLog, utf8Bytes, type ClipSpec } from "../../src/shared/context/compaction";
import { checkKeep, formatCheckFailure } from "../../src/main/services/compact-plan-service";
import type { LocalModelMessage } from "../../src/main/services/local-blocks";

const HOME = join(diyHome(), "keep-home");
beforeAll(() => {
    rmSync(autoCompactFile(HOME), { force: true });
});

/** 造会话消息（够小，预算随便给；只关心"谁被选中"） */
const msg = (role: "user" | "assistant" | "tool", content: string, turn: string, step?: string): LocalModelMessage => ({
    role,
    content,
    turn,
    ...(step ? { step } : {}),
});
const SESSION: LocalModelMessage[] = [
    msg("user", "u1", "t1"),
    msg("assistant", "过程1", "t1", "t1_s1"),
    msg("assistant", "结论1", "t1", "t1_s1"),
    msg("user", "u2", "t2"),
    msg("assistant", "结论2", "t2", "t2_s1"),
];
const costOf = (m: LocalModelMessage): number => utf8Bytes(JSON.stringify(m));
const run = (keep: readonly KeepStage[] | undefined, budget: number) =>
    runPlan(SESSION, keepStagesToPlan(keep, budget), { costOf: (m) => costOf(m) });

describe("① 级列表 → 管道：must/limit/clip 各自生效", () => {
    it("must → 不占预算（预算 0 也…不：预算 0 = 清零，见 ②）；正常预算下 must 级先挑走", () => {
        const keep: KeepStage[] = [
            { type: "role", must: true, data: { role: "user" } },
            { type: "ladder" },
        ];
        const stages = keepStagesToPlan(keep, 10_000).stages;
        expect(stages.map((s) => s.budget)).toEqual(["exempt", "count"]);
        // 预算 1 字节：阶梯级（count）一条也塞不下；必保级（exempt）**不占预算** ⇒ 用户消息仍在
        const thrifty = run(keep, 1);
        expect(thrifty.kept).toEqual([0, 3]);
        // 预算写得下时，阶梯级再把结论补上（必保级已经挑走的不重复计费）
        const roomy = run(keep, 10_000);
        expect(roomy.kept).toEqual([0, 1, 2, 3, 4]);
    });

    it("同一取法出现两次 → 后一级什么都挑不到（`validateKeepStages` 出 warn）", () => {
        const { issues } = validateKeepStages([{ type: "ladder" }, { type: "ladder" }]);
        expect(issues.some((i) => i.level === "warn" && i.code === "keep.duplicate")).toBe(true);
    });

    it("每级可声明 clip（先选中级生效）；缺省回落 defaultClip", () => {
        const FULL: ClipSpec = { type: "full" };
        const keep: KeepStage[] = [
            { type: "recent", clip: FULL, data: { n: 2 } },
            { type: "ladder" },
        ];
        const sel = runPlan(SESSION, keepStagesToPlan(keep, 10_000), { costOf: () => 1 });
        // 「最近 2 条」= 下标 4/3（先声明 full）；其余由后续级补，未声明 clip ⇒ null（回落 defaultClip）
        expect(sel.clips?.[4]).toEqual(FULL);
        expect(sel.clips?.[4]).toEqual(FULL);
        expect(sel.clips?.[0]).toBeNull();
    });

    it("steps 取法 = 最近 N 步；`keepStageLabel` 一处文案", () => {
        const keep: KeepStage[] = [{ type: "steps", must: true, clip: { type: "full" }, data: { n: DEFAULT_EXEMPT_STEPS } }];
        // 「最近 6 步」：本会话只有 2 步 ⇒ 全部带步索引的消息入选（下标 1/2/4；0/3 是轮首 user，无步索引）
        const sel = runPlan(SESSION, keepStagesToPlan(keep, 10_000), { costOf: () => 1 });
        expect(sel.kept).toEqual([1, 2, 4]);
        expect(keepStageLabel(keep[0]!)).toBe("最近 6 步");
    });
});

describe("② 回落不回归：无 keep ⇒ 与 ##343 M1 的缺省管道逐级等价", () => {
    const HEADTAIL: ClipSpec = { type: "headtail", data: { head: 1, tail: 1, maxLineChars: 100, maxKeepBytes: 200 } };

    it("keep 缺省 / 空数组 ⇒ DEFAULT_KEEP（= 保底 6 步 full + 阶梯）", () => {
        for (const keep of [undefined, null, [] as KeepStage[]]) {
            const stages = keepStagesToPlan(keep, 4096, HEADTAIL).stages;
            const def = defaultBudgetPlan(4096, HEADTAIL).stages;
            expect(stages.map((s) => [s.budget, s.limit, s.clip])).toEqual(def.map((s) => [s.budget, s.limit, s.clip]));
        }
    });

    it("选择结果与缺省管道**逐个下标相同**（预算由小到大扫一遍）", () => {
        for (const budget of [0, 1, 3, 10, 30, 100, 10_000]) {
            const a = runPlan(SESSION, keepStagesToPlan(undefined, budget, HEADTAIL), { costOf: (m) => costOf(m) });
            const b = runPlan(SESSION, defaultBudgetPlan(budget, HEADTAIL), { costOf: (m) => costOf(m) });
            expect(a.kept).toEqual(b.kept);
        }
    });

    it("预算 0 = 清零：keep 里有 must 级也一样不投（清零优先于必保）", () => {
        const keep: KeepStage[] = [{ type: "role", must: true, data: { role: "user" } }];
        expect(runPlan(SESSION, keepStagesToPlan(keep, 0), { costOf }).kept).toEqual([]);
    });
});

describe("③ 写侧：校验后才落地；非法 ⇒ 拒绝且不改文件", () => {
    it("合法 plan：写 → 读回语义等价（往返一致）", () => {
        const keep: KeepStage[] = [
            { type: "steps", must: true, limit: 6, clip: { type: "full" }, data: { n: 6 } },
            { type: "role", data: { role: "user" } },
            { type: "ladder", clip: { type: "headtail", data: { head: 2, tail: 2, maxLineChars: 100, maxKeepBytes: 1000 } } },
        ];
        const w = saveKeepConfig(HOME, keep);
        expect(w.keep).toEqual(keep);
        expect(w.issues.filter((i) => i.level === "error")).toEqual([]);
        const back = loadAutoCompact(HOME).history?.keep;
        expect(back).toEqual(keep);
        // 真源文本里确实有级列表（人可读、可 diff）
        const text = readAutoCompactText(HOME);
        expect(text).toContain("keep:");
        expect(text).toContain("steps");
        // 反馈：写盘用的是**文本**（`plan set` 的入参）→ 走 parseKeepText
        expect(parseKeepText(JSON.stringify(keep))).toEqual(keep);
        expect(parseKeepText(`keep:\n  - type: ladder\n`)).toEqual([{ type: "ladder" }]);
    });

    it("非法 plan：类型错 / clip 形状错 / 空列表 ⇒ 拒绝且**文件一字不改**", () => {
        saveKeepConfig(HOME, [{ type: "ladder" }]);
        const before = readFileSync(autoCompactFile(HOME), "utf-8");
        const bad: unknown[] = [
            [{ type: "ladderr" }], // 取法名错
            [{ type: "summary" }], // 规格留口、尚未启用 ⇒ 也要拒绝（并说明是"未启用"而非"未知"）
            [{ type: "steps", data: { n: 0 } }], // 参数越界
            [{ type: "ladder", clip: { type: "headtail", data: { head: 1 } } }], // clip 形状错
            [], // 空级列表（要清零请改预算）
            "ladder", // 根本不是数组
        ];
        for (const k of bad) {
            expect(() => saveKeepConfig(HOME, k), JSON.stringify(k)).toThrow();
            expect(readFileSync(autoCompactFile(HOME), "utf-8")).toBe(before);
        }
        // 具体理由要能说清（人读）
        try {
            saveKeepConfig(HOME, [{ type: "summary" }]);
            expect.unreachable();
        } catch (e) {
            expect((e as Error).message).toContain("尚未启用");
        }
    });

    it("读侧宽松：盘上 keep 非法 ⇒ 只丢 history（mode/triggers/policy 照用）", () => {
        const cfg: AutoCompactConfig = { ...DEFAULT_AUTO_COMPACT, history: undefined };
        // 直接经文件写坏（绕过写侧校验）：整份配置合法，只有 keep 里那一级是错的
        writeFileSync(
            autoCompactFile(HOME),
            yaml.dump({ ...DEFAULT_AUTO_COMPACT, mode: "auto", history: { keep: [{ type: "nope" }] } }),
            "utf-8",
        );
        const loaded = loadAutoCompact(HOME);
        expect(loaded.mode).toBe("auto"); // 没被整份丢掉（只丢 history）
        expect(loaded.history).toBeUndefined(); // 非法级 ⇒ 回落缺省管道
        expect(normalizeAutoCompact(cfg).mode).toBe(DEFAULT_AUTO_COMPACT.mode);
        saveAutoCompact(HOME, cfg);
    });
});

describe("④ 事件账 v3：plan 快照可回放；v2 旧行仍可读", () => {
    it("v3 行带 plan；v2 行 plan 缺席（= 当时是缺省管道）", () => {
        const base = {
            kind: "compact",
            id: "x",
            ts: "t",
            by: "cli",
            trigger: "manual",
            policy: { mode: "budget", modeData: { budgetBytes: 1024, toolResult: { render: "asis" } }, summary: false },
            boundary: { keptFromTurnId: null, keepFromOpIndex: 1 },
            size: { before: { turns: 1, messages: 1, bytes: 1, estTokens: 1 }, after: { turns: 0, messages: 0, bytes: 0, estTokens: 0 }, keptTurns: 0, droppedTurns: 1 },
        };
        const v2 = JSON.stringify({ ...base, v: 2 });
        const v3 = JSON.stringify({
            ...base,
            v: 3,
            plan: { budgetBytes: 1024, keep: [{ type: "steps", must: true, clip: { type: "full" }, data: { n: 6 } }], source: "config" },
        });
        const events = parseCompactLog(`${v2}\n${v3}\n`);
        const compacts = events.filter((e) => e.kind === "compact");
        expect(compacts).toHaveLength(2);
        expect(compacts[0]!.v).toBe(2);
        expect(compacts[0]!.plan).toBeUndefined();
        expect(compacts[1]!.v).toBe(3);
        expect(compacts[1]!.plan?.source).toBe("config");
        expect(compacts[1]!.plan?.keep[0]).toMatchObject({ type: "steps", must: true });
    });
});

describe("⑤ check：静态判据 + must 层硬上限（测量注入）", () => {
    it("静态：取法名错 ⇒ ok=false 且 keep 为空（不给人半截 plan）", () => {
        const r = checkKeep({ rawKeep: [{ type: "oops" }], source: "config", budgetBytes: 1024 });
        expect(r.ok).toBe(false);
        expect(r.keep).toEqual([]);
        expect(formatCheckFailure(r)).toContain("未知取法");
    });

    it("动态：must 层实占超硬上限 ⇒ error（测量由调用方注入）", () => {
        const keep = [{ type: "steps", must: true, data: { n: 6 } }];
        const ok = checkKeep({ rawKeep: keep, source: "config", budgetBytes: 1024, measure: () => ({ mustBytes: 10, hardCapBytes: 100 }) });
        expect(ok.ok).toBe(true);
        expect(ok.must).toEqual({ mustBytes: 10, hardCapBytes: 100, over: false });
        const over = checkKeep({ rawKeep: keep, source: "config", budgetBytes: 1024, measure: () => ({ mustBytes: 200, hardCapBytes: 100 }) });
        expect(over.ok).toBe(false);
        expect(over.issues.some((i) => i.code === "keep.mustOverCap")).toBe(true);
        expect(formatCheckFailure(over)).toContain("必保层");
    });

    it("无 must 级 ⇒ 不量（must 缺省），仍给出报告", () => {
        const r = checkKeep({ rawKeep: [{ type: "ladder" }], source: "default", budgetBytes: 0, measure: () => ({ mustBytes: 999, hardCapBytes: 1 }) });
        expect(r.must).toBeUndefined();
        expect(r.ok).toBe(true);
    });
});

describe("⑥ 级列表编辑（UI 用的纯函数）：改一个字段不动别的，且不改出非法形状", () => {
    const base: KeepStage = { type: "role", must: true, limit: 3, clip: { type: "full" }, data: { role: "user" } };
    /** 编辑后的级必须仍是**合法**形状（zod + yaml 往返；`clip: null` 这种坑在此现形） */
    const legal = (s: KeepStage): boolean => {
        const r = validateKeepStages([s]);
        return !r.issues.some((i) => i.level === "error");
    };

    it("改 clip：传值与清空各自正确；**清空是「不写」而不是「写 null」**", () => {
        const ht = withClip(base, { type: "headtail", data: DEFAULT_HEADTAIL_CLIP_DATA });
        expect(ht.clip).toEqual({ type: "headtail", data: DEFAULT_HEADTAIL_CLIP_DATA });
        // headtail 缺省参数是**完整**的一包（不会留半拉形状）
        expect(legal(ht)).toBe(true);

        const cleared = withClip(ht, undefined);
        expect("clip" in cleared).toBe(false); // 键消失，不是 undefined 也不是 null
        expect(JSON.stringify(cleared)).not.toContain("clip");
        expect(legal(cleared)).toBe(true);

        // 反例：真写成 `clip: null` 会被 schema 判非法（js-yaml 会把 null 落成 `clip: null`）
        expect(legal({ ...cleared, clip: null } as unknown as KeepStage)).toBe(false);
        // 而「键不存在」经 yaml 往返仍是键不存在（= 回落全局 clip）
        saveKeepConfig(HOME, [cleared]);
        expect(loadAutoCompact(HOME).history?.keep?.[0]).toEqual(cleared);
    });

    it("改 must / limit：undefined = 删键（回到缺省语义），传值 = 覆盖", () => {
        expect(withMust(base, false).must).toBe(false);
        const noMust = withMust(base, undefined);
        expect("must" in noMust).toBe(false);
        expect(noMust.limit).toBe(3); // 别的字段不动
        expect(noMust.clip).toEqual(base.clip);

        const noLimit = withLimit(base, undefined);
        expect("limit" in noLimit).toBe(false);
        expect(noLimit.must).toBe(true);
        expect(withLimit(base, 7).limit).toBe(7);
    });

    it("换取法：公共字段留下、data 换成该取法的一包（不清空必保/裁剪）", () => {
        const asSteps = retypeStage(base, "steps");
        expect(asSteps).toMatchObject({ type: "steps", must: true, limit: 3, clip: { type: "full" }, data: { n: DEFAULT_EXEMPT_STEPS } });
        const asLadder = retypeStage(asSteps, "ladder");
        expect(asLadder).toEqual({ type: "ladder", must: true, limit: 3, clip: { type: "full" } }); // ladder 无 data
        expect(retypeStage(base, "role")).toMatchObject({ type: "role", data: { role: "user" } }); // 同类互换保原值
        // 每种取法的产出都合法（对话框里换来换去不会撞非法形状）
        for (const t of ["ladder", "role", "recent", "steps"] as const) expect(legal(retypeStage(base, t)), t).toBe(true);
    });
});
