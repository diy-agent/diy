// tests/services/plan-store.test.ts
// 🎯 plan 版本存储（##378 M3b）：**内容寻址 CAS + 版本链 index**
//
// 钉住 body 的判据：
//   R1 同内容必同 id（键序无关 / 无空白）· 内容变 id 必变
//   R2 版本内容 = 纯 plan 数据（不含 ts/op/via/taskUri/parent/brief）
//   R4 **不设份数上限**（写 30 版全在）
//   R5 index 是链唯一真源：`parent` 串起，`current` = 末行；同内容再写**不追加**
// 另：`describePlanChange` / `renderPlanVersionDiff` 是 UI 与 CLI 共用的纯函数（##329 R1 教训）。

import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { DEFAULT_KEEP, type KeepStage } from "../../src/shared/context/compact-keep";
import {
    appendPlanVersion,
    canonicalJson,
    currentPlanVersion,
    describePlanChange,
    isPlanVersionId,
    listPlanVersions,
    planChainFile,
    planScopeKey,
    planStoreDir,
    planVersionDoc,
    planVersionFile,
    planVersionId,
    readPlanVersion,
    renderPlanVersionDiff,
    writePlanVersion,
} from "../../src/main/services/plan-store";

const HOME = join(diyHome(), "plan-store-home");
const TASK = "projects/1/tasks/1";
const KEEP_A: KeepStage[] = [...DEFAULT_KEEP];
const KEEP_B: KeepStage[] = [{ type: "recent", data: { n: 3 } }];

const docOf = (keep: readonly KeepStage[], source: "config" | "default" = "config") => planVersionDoc({ source, keep });
const chainRows = (): { version: string; parent: string | null; op: string; brief: string }[] =>
    readFileSync(planChainFile(HOME), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true });
});

describe("CAS：内容寻址（R1 / R2）", () => {
    it("同内容两写 ⇒ 磁盘 1 份（第二次 created:false，且文件 mtime 不变）", () => {
        const a = writePlanVersion(HOME, docOf(KEEP_A));
        expect(a.created).toBe(true);
        const before = readFileSync(planVersionFile(HOME, a.version), "utf-8");
        const b = writePlanVersion(HOME, docOf(KEEP_A));
        expect(b.created).toBe(false);
        expect(b.version).toBe(a.version);
        expect(readdirSync(planStoreDir(HOME))).toHaveLength(1);
        expect(readFileSync(planVersionFile(HOME, a.version), "utf-8")).toBe(before);
    });

    it("同内容同 id：**键序无关**（canonical 按字典序）—— 手工构造逆序键也得同一个 id", () => {
        const x = planVersionDoc({ source: "config", keep: [{ type: "recent", data: { n: 3 } }] });
        // 逆序 + 混入 undefined（canonical 丢弃 undefined 键 ⇒ 与上面等价）
        const y = { keep: [{ data: { n: 3 }, type: "recent" as const }], source: "config" as const, v: 1 as const, extra: undefined };
        expect(planVersionId(y as typeof x)).toBe(planVersionId(x));
        expect(canonicalJson(y)).toBe(canonicalJson(x));
    });

    it("内容变 ⇒ id 必变（自校验；手改 CAS 文件 ⇒ 读回 null）", () => {
        const a = planVersionId(docOf(KEEP_A));
        const b = planVersionId(docOf(KEEP_B));
        const c = planVersionId(docOf(DEFAULT_KEEP, "default"));
        expect(new Set([a, b, c]).size).toBe(3);
        // source 也进 hash（config vs default 语义不同 ⇒ 不是同一版）
        expect(a).not.toBe(c);

        writePlanVersion(HOME, docOf(KEEP_A));
        const file = planVersionFile(HOME, a);
        // 手改内容 ⇒ id 与内容不再对应 ⇒ 自校验失败，拒绝读回（不当成好版本用）
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        writeFileSync(file, JSON.stringify({ ...parsed, keep: KEEP_B }), "utf-8");
        expect(readPlanVersion(HOME, a)).toBeNull();
    });

    it("版本文档只含纯 plan 数据（R2：元信息进 index，否则同内容不同时间会 hash 成两份）", () => {
        const doc = docOf(KEEP_A) as unknown as Record<string, unknown>;
        expect(Object.keys(doc).sort()).toEqual(["keep", "source", "v"]);
        for (const k of ["ts", "op", "via", "taskUri", "parent", "brief"]) expect(doc).not.toHaveProperty(k);
    });

    it("非法 id / 不存在的版本 ⇒ null（读盘前必过形状校验，防路径穿越）", () => {
        expect(readPlanVersion(HOME, "../../etc/passwd")).toBeNull();
        expect(readPlanVersion(HOME, "plan-000000000000")).toBeNull();
        expect(isPlanVersionId("plan-0123456789ab")).toBe(true);
        expect(isPlanVersionId("plan-XYZ")).toBe(false);
    });
});

describe("版本链 index（R5）", () => {
    it("set / restore / reset 都入链，parent 串起，current = 末行", () => {
        const s1 = appendPlanVersion({ home: HOME, doc: docOf(KEEP_A), op: "set", via: "user", taskUri: TASK });
        const s2 = appendPlanVersion({ home: HOME, doc: docOf(KEEP_B), op: "set", via: "agent", taskUri: TASK });
        const s3 = appendPlanVersion({ home: HOME, doc: docOf(KEEP_A), op: "restore", via: "user", taskUri: TASK });
        const s4 = appendPlanVersion({ home: HOME, doc: docOf(DEFAULT_KEEP, "default"), op: "reset", via: "user", taskUri: TASK });
        expect([s1, s2, s3, s4].every((x) => x.appended)).toBe(true);
        const rows = listPlanVersions(HOME);
        expect(rows.map((r) => r.op)).toEqual(["set", "set", "restore", "reset"]);
        expect(rows[0]!.parent).toBeNull();
        expect(rows[1]!.parent).toBe(rows[0]!.version);
        expect(rows[2]!.parent).toBe(rows[1]!.version);
        expect(rows[3]!.parent).toBe(rows[2]!.version);
        // 回滚到旧内容 = 链上出现**相同 version 的不同行**（记的是「谁在什么时候用了它」）
        expect(rows[2]!.version).toBe(rows[0]!.version);
        expect(currentPlanVersion(HOME)!.version).toBe(rows[3]!.version);
        // brief 是人读一句话（不是空串）
        expect(rows.every((r) => r.brief.length > 0)).toBe(true);
        expect(rows[3]!.brief).toContain("reset");
    });

    it("同内容再写 ⇒ 不追加（不是一次版本变化；否则链上出现重复行 + 自指 parent）", () => {
        appendPlanVersion({ home: HOME, doc: docOf(KEEP_A), op: "set", via: "user", taskUri: TASK });
        const again = appendPlanVersion({ home: HOME, doc: docOf(KEEP_A), op: "set", via: "user", taskUri: TASK });
        expect(again.appended).toBe(false);
        expect(listPlanVersions(HOME)).toHaveLength(1);
        expect(chainRows()).toHaveLength(1);
    });

    it("**不设份数上限**（R4）：30 版全在（CAS 30 份 + 链 30 行）", () => {
        for (let i = 1; i <= 30; i++) {
            appendPlanVersion({
                home: HOME,
                doc: docOf([{ type: "recent", data: { n: i } }]),
                op: "set",
                via: "user",
                taskUri: TASK,
            });
        }
        expect(readdirSync(planStoreDir(HOME))).toHaveLength(30);
        expect(listPlanVersions(HOME)).toHaveLength(30);
        expect(currentPlanVersion(HOME)!.parent).toBe(listPlanVersions(HOME)[28]!.version);
    });

    it("坏行跳过（崩溃半行 / 裸文本不影响整条链）", () => {
        appendPlanVersion({ home: HOME, doc: docOf(KEEP_A), op: "set", via: "user", taskUri: TASK });
        writeFileSync(planChainFile(HOME), readFileSync(planChainFile(HOME), "utf-8") + "{半行\n\n", "utf-8");
        appendPlanVersion({ home: HOME, doc: docOf(KEEP_B), op: "set", via: "user", taskUri: TASK });
        expect(listPlanVersions(HOME).map((r) => r.version)).toEqual([
            planVersionId(docOf(KEEP_A)),
            planVersionId(docOf(KEEP_B)),
        ]);
    });

    it("作用域键复用 keyOf（唯一算法）：全局作用域目录名以 plan-scope_global 开头且带 sha12", () => {
        expect(planScopeKey({ type: "global" })).toMatch(/^plan-scope_global-[0-9a-f]{12}$/);
        // 与「另写一份算法」的区别：同 scope ⇒ 同键（稳定），换 scope 算法只需加一支
        expect(planScopeKey({ type: "global" })).toBe(planScopeKey({ type: "global" }));
    });
});

describe("人读摘要 / 对比（纯函数，UI 与 CLI 共用）", () => {
    it("describePlanChange：级数变化 + 逐级差异，一行放得下", () => {
        expect(describePlanChange(KEEP_A, KEEP_B, "set")).toContain("2 级 → 1 级");
        const same = describePlanChange(KEEP_A, [...DEFAULT_KEEP], "set");
        expect(same).toContain("内容未变");
        expect(describePlanChange(KEEP_A, [DEFAULT_KEEP[0]!, DEFAULT_KEEP[1]!, { type: "recent", data: { n: 2 } }], "set")).toContain(
            "+recent n=2",
        );
        expect(describePlanChange([], KEEP_A, "set")).toContain("0 → 2 级");
    });

    it("renderPlanVersionDiff：逐级对齐 `= / - / +`（diff 只作视图，全文仍是真源）", () => {
        const d = renderPlanVersionDiff({ version: "plan-aaaaaaaaaaaa", keep: KEEP_A }, { version: "plan-bbbbbbbbbbbb", keep: KEEP_B });
        expect(d).toContain("--- plan-aaaaaaaaaaaa");
        expect(d).toContain("+++ plan-bbbbbbbbbbbb");
        expect(d).toContain("- 1. steps");
        expect(d).toContain("+ 1. recent n=3");
    });
});
