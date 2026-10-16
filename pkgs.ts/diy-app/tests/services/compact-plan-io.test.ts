// tests/services/compact-plan-io.test.ts
// 🎯 plan 的**手与闸**（##362 M3a）—— 工具（compact_plan）与 RPC 共用的那一份 I/O
//
// 钉住四条验收（对应 ##362 body 的「验收」节）：
//   ① 闸关时 set 被拒（**文件 md5 不变**，且**不抛错** —— 抛错会被当成工具失败）
//   ② 非法 plan 被拒（抛错 + 文件一字不改）
//   ③ 闸开时 set 成功 + 快照落盘（`plan-history/`）
//   ④ restore 回滚到上一份（且回滚本身也留快照 = 可回滚）
// 另：审计落 `log/compact/plan-edits.jsonl`（set/restore 各一行）。

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { autoCompactFile, saveAutoCompact } from "../../src/main/core/auto-compact-config";
import { DEFAULT_AUTO_COMPACT } from "../../src/shared/context/auto-compact";
import { DEFAULT_KEEP, type KeepStage } from "../../src/shared/context/compact-keep";
import {
    agentWriteAllowed,
    listPlanSnapshots,
    planCheck,
    planEditLogFile,
    planGet,
    planHistoryDir,
    planRestore,
    planSet,
} from "../../src/main/services/compact-plan-io";

const HOME = join(diyHome(), "plan-io-home");
const TASK = "projects/1/tasks/1";
const md5 = (f: string): string => createHash("md5").update(readFileSync(f)).digest("hex");
const snapshotFile = (id: string): string => join(planHistoryDir(HOME), `${id}.yaml`);

const KEEP_A = "- type: steps\n  must: true\n  clip: {type: full}\n  data: {n: 6}\n- type: ladder\n";
const KEEP_B = "- type: recent\n  data: {n: 3}\n";

/** 建立一份初始 plan（闸关 —— `history` 里没有 allowAgentWrite） */
const seedConfig = (extraHistory: Record<string, unknown> = {}): void => {
    saveAutoCompact(HOME, { ...DEFAULT_AUTO_COMPACT, history: { keep: [...DEFAULT_KEEP], ...extraHistory } });
};
/** 开闸（用户在配置里显式打开） */
const openGate = (): void => seedConfig({ allowAgentWrite: true });

beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true });
});

describe("plan 的手与闸（##362 M3a）", () => {
    it("① 闸关：set 被拒（返回文本、不抛错），且配置 md5 不变", () => {
        seedConfig();
        expect(agentWriteAllowed(HOME)).toBe(false);
        const before = md5(autoCompactFile(HOME));
        const r = planSet({ home: HOME, taskUri: TASK, via: "agent", keepText: KEEP_B });
        expect(r.ok).toBe(false);
        expect(r.written).toBe(false);
        expect(r.blocked).toBe("agent-write-disabled");
        // 关键：让模型知道「不是你写错了、是没权限」，而不是一个工具失败
        expect(r.text).toContain("history.allowAgentWrite=false");
        expect(md5(autoCompactFile(HOME))).toBe(before);
        // 闸关也记账（审计要能回答"agent 试过没有"）
        const rows = readFileSync(planEditLogFile(HOME), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        expect(rows.at(-1)).toMatchObject({ op: "set", result: "blocked", via: "agent" });
    });

    it("② 闸开但 plan 非法：抛错，且配置一字不改", () => {
        openGate();
        const before = md5(autoCompactFile(HOME));
        expect(() => planSet({ home: HOME, taskUri: TASK, via: "agent", keepText: "- type: nope\n" })).toThrow(/未知取法/);
        expect(md5(autoCompactFile(HOME))).toBe(before);
        const rows = readFileSync(planEditLogFile(HOME), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        expect(rows.at(-1)).toMatchObject({ op: "set", result: "rejected" });
    });

    it("③ 闸开：set 成功 → 生效级列表变了 + 快照落盘（内容是**旧 keep**）", () => {
        openGate();
        const r = planSet({ home: HOME, taskUri: TASK, via: "agent", keepText: KEEP_B });
        expect(r.ok).toBe(true);
        expect(r.written).toBe(true);
        expect(r.snapshotId).toBeTruthy();
        expect(planGet(HOME).keep.map((s) => s.type)).toEqual(["recent"]);
        // 快照 = 写之前的旧 keep（回滚目标）
        expect(existsSync(snapshotFile(r.snapshotId!))).toBe(true);
        expect(JSON.stringify(listPlanSnapshots(HOME))).toContain(r.snapshotId!);
        const rows = readFileSync(planEditLogFile(HOME), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        const ok = rows.at(-1)!;
        expect(ok).toMatchObject({ op: "set", result: "ok", snapshotId: r.snapshotId });
        expect(ok.afterKeep.map((s: KeepStage) => s.type)).toEqual(["recent"]);
        expect(ok.beforeKeep.map((s: KeepStage) => s.type)).toEqual(["steps", "ladder"]);
    });

    it("④ restore：回滚到上一份（缺省最近一份），且回滚也留快照（可回滚）", () => {
        seedConfig();
        const a = planSet({ home: HOME, taskUri: TASK, via: "user", keepText: KEEP_A }); // 盘上 → A
        expect(a.written).toBe(true);
        const b = planSet({ home: HOME, taskUri: TASK, via: "user", keepText: KEEP_B }); // A → B
        expect(planGet(HOME).keep.map((s) => s.type)).toEqual(["recent"]);
        const rb = planRestore({ home: HOME, taskUri: TASK, via: "user" });
        expect(rb.written).toBe(true);
        // 回到 A（= b 之前写下的那份快照）
        expect(planGet(HOME).keep.map((s) => s.type)).toEqual(["steps", "ladder"]);
        // 回滚本身也留了快照（内容是回滚前的 B）⇒ 再 restore 能回到 B
        const rb2 = planRestore({ home: HOME, taskUri: TASK, via: "user" });
        expect(planGet(HOME).keep.map((s) => s.type)).toEqual(["recent"]);
        expect(rb2.snapshotId).not.toBe(rb.snapshotId);
        void b;
    });

    it("闸只管 agent：user（CLI/UI）路径不受闸约束", () => {
        seedConfig(); // 闸关
        expect(planSet({ home: HOME, taskUri: TASK, via: "user", keepText: KEEP_B }).written).toBe(true);
    });

    it("agent 也能回滚（闸开时），且 get/check 任何时候都可用", () => {
        seedConfig(); // 闸关
        expect(planGet(HOME).writeAllowed).toBe(false);
        const chk = planCheck({ home: HOME, taskUri: TASK, keepText: KEEP_B });
        expect(chk.ok).toBe(true);
        expect(chk.scope).toBe("global");
        expect(chk.note).toContain("所有任务");
        openGate();
        planSet({ home: HOME, taskUri: TASK, via: "agent", keepText: KEEP_B });
        const back = planRestore({ home: HOME, taskUri: TASK, via: "agent" });
        expect(back.ok).toBe(true);
        expect(planGet(HOME).keep.map((s) => s.type)).toEqual(["steps", "ladder"]);
    });

    it("check 的 measure 注入：must 层撑爆硬上限 ⇒ 不通过（判据可确定性测）", () => {
        seedConfig();
        const r = planCheck({
            home: HOME,
            taskUri: TASK,
            keepText: KEEP_A,
            measure: () => ({ mustBytes: 2048, hardCapBytes: 1024 }),
        });
        expect(r.ok).toBe(false);
        expect(r.issues.some((i) => i.code === "keep.mustOverCap")).toBe(true);
    });
});
