// tests/services/compact-plan-io.test.ts
// 🎯 plan 的**手与闸**（##362 M3a）—— 工具（compact_plan）与 RPC 共用的那一份 I/O
//
// 钉住四条验收（对应 ##362 body 的「验收」节）：
//   ① 闸关时 set 被拒（**文件 md5 不变**，且**不抛错** —— 抛错会被当成工具失败）
//   ② 非法 plan 被拒（抛错 + 文件一字不改）
//   ③ 闸开时 set 成功 + 快照落盘（`plan-history/`）
//   ④ restore 回滚到上一份（且回滚本身也留快照 = 可回滚）
//   ⑤⑥⑦⑧ reset（##363 M3a 补）：删键回出厂缺省 + 快照 + 闸 + 幂等
// 另：审计落 `log/compact/plan-edits.jsonl`（set/restore/reset 各一行）。

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { diyHome } from "../../src/main/core/state";
import { autoCompactFile, loadAutoCompact, saveAutoCompact } from "../../src/main/core/auto-compact-config";
import { DEFAULT_AUTO_COMPACT } from "../../src/shared/context/auto-compact";
import { budgetBytesOf } from "../../src/shared/context/compaction";
import { DEFAULT_KEEP, type KeepStage } from "../../src/shared/context/compact-keep";
import {
    agentWriteAllowed,
    listPlanSnapshots,
    planCheck,
    planEditLogFile,
    planGet,
    planHistoryDir,
    planReset,
    planRestore,
    planSet,
    renderPlanView,
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

// ─── ##370：读侧**出声** —— 缺键不再整份作废，且「为什么」冒泡到 plan get ─────
// 病：漏一个必填键 ⇒ `safeParse` 失败 ⇒ 整份回 DEFAULT（keep 一起没），而 `raw` 仍是原文
// ⇒ 用户「plan 不见了」却查不到原因（只在应用日志一行）。这条钉「出声面」。
describe("plan get 的出声（##370）", () => {
    it("缺一个必填键 ⇒ keep 仍在（不再整份作废）+ warnings 说清缺哪一层、回落成什么", () => {
        // 手写一份**只漏 `policy.summary`** 的配置（用户/LLM 手写 yaml 的典型漏法）
        const doc = {
            ...DEFAULT_AUTO_COMPACT,
            history: { keep: [{ type: "recent", data: { n: 3 } }], allowAgentWrite: true },
        };
        const text = yaml.dump(doc, { indent: 2, noRefs: true }).replace(/^\s*summary:.*\n/m, "");
        expect(text).not.toMatch(/^\s*summary:/m); // 确实漏了那个键
        writeFileSync(autoCompactFile(HOME), text, "utf-8");

        const v = planGet(HOME);
        // 🔑 核心：旧行为是整份回默认（source=default、keep 丢、闸静默变 false）
        expect(v.source).toBe("config");
        expect(v.keep.map((s) => s.type)).toEqual(["recent"]);
        expect(v.writeAllowed).toBe(true);
        // 出声：哪一层 + 回落成什么
        const w = v.warnings.find((x) => x.path === "policy.summary");
        expect(w, JSON.stringify(v.warnings)).toBeTruthy();
        expect(w!.message).toContain("已回落 false");
        // 原文照旧可读（不是"没数据"）
        expect(v.raw).toContain("keep:");
        // 人读文本（工具输出 / CLI 共用）也要带出声
        expect(renderPlanView(v)).toContain("出声");
        // 干净读入时**不出声**（不留噪音）
        saveAutoCompact(HOME, { ...DEFAULT_AUTO_COMPACT, history: { keep: [{ type: "recent", data: { n: 3 } }] } });
        expect(planGet(HOME).warnings).toEqual([]);
    });
});

// ─── reset（##363 M3a 补）：逃生窗口 —— 删键回出厂缺省 ──────────────
// 「逃生」的判据：reset **不依赖任何快照** —— 快照全坏时它是唯一落点（restore 做不到）。
describe("plan reset 逃生窗口（##363）", () => {
    /** 造一份带自定义 policy / mode 的配置（用来验 reset 只动 keep、其余原样） */
    const seedRich = (history: Record<string, unknown> = {}): void => {
        saveAutoCompact(HOME, {
            ...DEFAULT_AUTO_COMPACT,
            mode: "auto",
            policy: { mode: "budget", modeData: { budgetBytes: 4096, toolResult: { render: "path" } }, summary: false },
            history: { keep: [...DEFAULT_KEEP], ...history },
        });
    };

    it("⑤ reset（user）：keep 键**消失** → source 回落 default；mode/triggers/policy/allowAgentWrite 原样保留", () => {
        seedRich({ allowAgentWrite: true });
        expect(planGet(HOME).source).toBe("config");
        const r = planReset({ home: HOME, taskUri: TASK, via: "user" });
        expect(r.ok).toBe(true);
        expect(r.written).toBe(true);
        expect(r.after?.map((s) => s.type)).toEqual(DEFAULT_KEEP.map((s) => s.type));

        // ⚠️ 删键（不是写死 DEFAULT_KEEP 字面量）：`history` 里没有 `keep` 这个键
        const doc = yaml.load(readFileSync(autoCompactFile(HOME), "utf-8")) as {
            history?: { keep?: unknown; allowAgentWrite?: boolean };
            mode?: string;
            policy?: unknown;
        };
        expect(doc.history?.keep).toBeUndefined();
        expect(planGet(HOME).source).toBe("default");
        expect(planGet(HOME).keep.map((s) => s.type)).toEqual(DEFAULT_KEEP.map((s) => s.type));

        // 其余全保留（reset 只重置 plan）
        const cfg = loadAutoCompact(HOME);
        expect(cfg.mode).toBe("auto");
        expect(cfg.triggers).toEqual(DEFAULT_AUTO_COMPACT.triggers);
        expect(budgetBytesOf(cfg.policy)).toBe(4096);
        expect(cfg.history?.allowAgentWrite).toBe(true);
    });

    it("⑥ reset 前**快照落盘**（内容是旧 keep）⇒ restore 能回滚回 reset 前", () => {
        seedConfig(); // keep = 缺省
        planSet({ home: HOME, taskUri: TASK, via: "user", keepText: KEEP_B }); // 盘上 → recent
        expect(planGet(HOME).keep.map((s) => s.type)).toEqual(["recent"]);

        const r = planReset({ home: HOME, taskUri: TASK, via: "user" });
        expect(r.written).toBe(true);
        expect(r.snapshotId).toBeTruthy();
        expect(existsSync(snapshotFile(r.snapshotId!))).toBe(true);
        // 快照内容 = reset 前的旧 keep（recent），不是缺省
        const snap = yaml.load(readFileSync(snapshotFile(r.snapshotId!), "utf-8")) as { op?: string; keep?: KeepStage[] };
        expect(snap.op).toBe("reset");
        expect(snap.keep?.map((s) => s.type)).toEqual(["recent"]);
        // 已回落缺省
        expect(planGet(HOME).source).toBe("default");

        // reset 也可被 restore 回滚（回滚本身也可回滚，同 ##362 口径）
        const rb = planRestore({ home: HOME, taskUri: TASK, via: "user" });
        expect(rb.written).toBe(true);
        expect(planGet(HOME).source).toBe("config");
        expect(planGet(HOME).keep.map((s) => s.type)).toEqual(["recent"]);

        // 审计：op:reset 一行，beforeKeep = 旧 keep、afterKeep = 缺省回显
        const rows = readFileSync(planEditLogFile(HOME), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        const reset = rows.find((x) => x.op === "reset" && x.result === "ok")!;
        expect(reset.snapshotId).toBe(r.snapshotId);
        expect(reset.beforeKeep.map((s: KeepStage) => s.type)).toEqual(["recent"]);
        expect(reset.afterKeep.map((s: KeepStage) => s.type)).toEqual(DEFAULT_KEEP.map((s) => s.type));
    });

    it("⑦ 闸关：agent 的 op:reset 被拒（文本不抛错）、文件 md5 不变；闸开即可 reset", () => {
        seedConfig(); // 闸关（history 无 allowAgentWrite）
        expect(agentWriteAllowed(HOME)).toBe(false);
        const before = md5(autoCompactFile(HOME));
        const r = planReset({ home: HOME, taskUri: TASK, via: "agent" });
        expect(r.ok).toBe(false);
        expect(r.written).toBe(false);
        expect(r.blocked).toBe("agent-write-disabled");
        // 让模型知道是「没权限」而非「你写错了」
        expect(r.text).toContain("history.allowAgentWrite=false");
        // 逃生窗口的 scope 提示必带（模型要知道自己在动全局）
        expect(r.text).toContain("所有任务");
        expect(md5(autoCompactFile(HOME))).toBe(before);
        // 闸关也记账
        const rows = readFileSync(planEditLogFile(HOME), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        expect(rows.at(-1)).toMatchObject({ op: "reset", result: "blocked", via: "agent" });

        // 开闸后 agent 可 reset（逃生窗口对 agent 开放 = 它能在自伤后自救）
        openGate();
        const ok = planReset({ home: HOME, taskUri: TASK, via: "agent" });
        expect(ok.ok).toBe(true);
        expect(ok.written).toBe(true);
        expect(planGet(HOME).source).toBe("default");
    });

    it("⑧ 已是缺省（无 keep 键）⇒ reset 幂等成功：不写文件、不多存快照", () => {
        // 只有闸、没有 keep 的配置 = 「未配置 plan」
        saveAutoCompact(HOME, { ...DEFAULT_AUTO_COMPACT, history: { allowAgentWrite: true } });
        expect(planGet(HOME).source).toBe("default");
        const before = md5(autoCompactFile(HOME));
        const snapsBefore = listPlanSnapshots(HOME).length;
        const r = planReset({ home: HOME, taskUri: TASK, via: "agent" });
        expect(r.ok).toBe(true);
        expect(r.written).toBe(false);
        expect(r.noop).toBe(true);
        expect(r.text).toContain("已是缺省");
        expect(md5(autoCompactFile(HOME))).toBe(before);
        expect(listPlanSnapshots(HOME).length).toBe(snapsBefore);
        // 闸不被幂等路径关掉（allowAgentWrite 原样）
        expect(loadAutoCompact(HOME).history?.allowAgentWrite).toBe(true);
    });
});
