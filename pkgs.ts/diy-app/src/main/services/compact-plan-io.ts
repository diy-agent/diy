// src/main/services/compact-plan-io.ts
// 🎯 装配管道（plan）的**唯一 I/O 实现**（##362 M3a）—— 工具 `compact_plan` 与 RPC
//    `compact plan get|set|check` **共用这一份**（禁两处各写：「CLI 校验通过、工具绕过校验」那种分叉必现）。
//
// ── 为什么要有闸（本模块存在的理由）──
// plan 是**全局配置**（`$DIY_HOME/auto-compact.yaml` 的 `history.keep[]`）：改它 = 改**所有任务、
// 所有 agent** 的投递。所以「把 plan 交给 LLM」不是加个工具就完事，而是**给手的同时给闸**。
// 缺闸的后果是静默的：LLM 写坏 keep ⇒ 全库会话丢上下文。
//
// 四条闸（缺一不可，见 ##362 body §2）：
//   ① 写默认关闭 —— `history.allowAgentWrite`（缺省 false）。关时 **set/restore 不抛错**，
//      返回明确拒绝文本（抛错会被当成工具失败，污染轮次信号，模型看不出「是没权限」）；
//      get / check **始终可用**（只读无需授权）。闸**只管 agent**：CLI/UI 是用户显式操作，不受约束。
//   ② 写前必校验 —— 复用 `saveKeepConfig`（非法 ⇒ 拒绝且**文件一字不改**），不得绕过。
//   ③ 快照 + 回滚 —— 每次成功写入前把**旧 keep** 存 `$DIY_HOME/plan-history/<id>.yaml`（留最近 20 份）；
//      restore 走**同一套**校验 + 快照路径（即回滚本身也可回滚）。
//   ④ 审计 —— 每次 set / restore 追加一行到 `$DIY_HOME/log/compact/plan-edits.jsonl`（`log/` 可清可丢）。
//
// ── 分层 ──
// 判据（validate / checkKeep）在 shared + compact-plan-service；文件 I/O 在 core/auto-compact-config；
// 本模块只做**编排**（闸 → 校验 → 快照 → 写 → 审计）与人读文本。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as yaml from "js-yaml";
import {
    loadAutoCompact,
    parseKeepText,
    readAutoCompactText,
    saveKeepConfig,
} from "../core/auto-compact-config";
import { budgetBytesOf, fmtBytes } from "../../shared/context/compaction";
import { DEFAULT_KEEP, clipLabel, keepStageLabel, type KeepIssue, type KeepStage } from "../../shared/context/compact-keep";
import { checkKeep, formatCheckFailure, type PlanCheckReport } from "./compact-plan-service";

/** 所有写路径返回都带的人读影响面提示（M3b 要的就是模型**知道自己在动全局**） */
export const PLAN_SCOPE_NOTE = "本改动影响**所有任务**的投递（plan 是全局配置）";
export const PLAN_SCOPE = "global" as const;

/** 快照保留份数（多的删最旧） */
export const PLAN_SNAPSHOT_KEEP = 20;

/** 审计落点（相对 `$DIY_HOME`）；`log/` 按 `data.log` 定性 = 可清可丢，不影响运行 */
export const PLAN_EDIT_LOG_REL = join("log", "compact", "plan-edits.jsonl");

export function planHistoryDir(home: string): string {
    return join(home, "plan-history");
}
export function planEditLogFile(home: string): string {
    return join(home, PLAN_EDIT_LOG_REL);
}

/** 写路径的来路：`agent` 走闸，`user`（CLI / UI）不走 */
export type PlanWriteVia = "agent" | "user";

/** 生效 plan 从哪来：`config` = 盘上配置（或显式传入文本）/ `default` = 缺省回落 */
export type PlanSource = "config" | "default";

/**
 * **读**侧的形状判定（唯一一处）：`history.keep` 是非空数组即 `config`，否则回落缺省管道。
 * 与 `normalizeAutoCompact::normalizeHistory` 同一判据 —— 那边保证「非空才落地」，故这里只需看形状。
 */
export function planSourceOf(cfg: { history?: { keep?: unknown } }): PlanSource {
    return Array.isArray(cfg.history?.keep) && (cfg.history!.keep as unknown[]).length > 0 ? "config" : "default";
}

/** 当前**生效**的级列表（配置有就用配置的，否则代码缺省管道） */
export function effectiveKeep(home: string): { source: PlanSource; keep: readonly KeepStage[] } {
    const cfg = loadAutoCompact(home);
    const source = planSourceOf(cfg);
    return { source, keep: source === "config" ? cfg.history!.keep! : DEFAULT_KEEP };
}

/**
 * **闸**：agent 能否写 plan。只有字面 `true` 算开（缺省 false = 关）。
 * 用户 2026-10-16 口径：闸只管 agent；CLI `compact plan set` / UI 编辑器是用户自己的显式操作。
 */
export function agentWriteAllowed(home: string): boolean {
    return loadAutoCompact(home).history?.allowAgentWrite === true;
}

// ─── 读 ──────────────────────────────────────────

export interface PlanView {
    source: PlanSource;
    keep: readonly KeepStage[];
    budgetBytes: number;
    /** 真源原文（`auto-compact.yaml` 全文；缺失 = 空串）—— 供 UI「原始配置」只读视图 */
    raw: string;
    /** agent 写闸是否开着（get/check 恒可用，此值只为让模型/用户知道 set 会不会被拒） */
    writeAllowed: boolean;
    scope: typeof PLAN_SCOPE;
    note: string;
}

export function planGet(home: string): PlanView {
    const cfg = loadAutoCompact(home);
    const source = planSourceOf(cfg);
    return {
        source,
        keep: source === "config" ? cfg.history!.keep! : DEFAULT_KEEP,
        budgetBytes: budgetBytesOf(cfg.policy),
        raw: readAutoCompactText(home),
        writeAllowed: cfg.history?.allowAgentWrite === true,
        scope: PLAN_SCOPE,
        note: PLAN_SCOPE_NOTE,
    };
}

// ─── 校验 ────────────────────────────────────────

export interface PlanCheckArgs {
    home: string;
    taskUri: string;
    /** 待校验的文本（YAML/JSON，数组或 `{keep:[...]}`）；缺省 = 校验盘上生效 plan */
    keepText?: string;
    /**
     * must 层实占字节的**测量**（预算是管不到 must 的，只有实算才知道会不会撑爆）。
     * 由调用方注入真测量（`LocalAgent.measureMustStages`）；缺省跳过该项（只做静态校验）。
     */
    measure?: (keep: KeepStage[]) => { mustBytes: number; hardCapBytes: number };
}

export interface PlanCheckView extends PlanCheckReport {
    scope: typeof PLAN_SCOPE;
    note: string;
}

/** 校验（**不抛**：调用方自行决定 ok=false 是抛错还是回文本给模型） */
export function planCheck(args: PlanCheckArgs): PlanCheckView {
    const cfg = loadAutoCompact(args.home);
    const report = checkKeep({
        rawKeep: args.keepText !== undefined ? parseKeepText(args.keepText) : cfg.history?.keep ?? DEFAULT_KEEP,
        source: args.keepText !== undefined ? "config" : planSourceOf(cfg),
        budgetBytes: budgetBytesOf(cfg.policy),
        ...(args.measure ? { measure: args.measure } : {}),
    });
    return { ...report, scope: PLAN_SCOPE, note: PLAN_SCOPE_NOTE };
}

// ─── 写（快照 + 校验 + 审计）──────────────────────

export interface PlanWriteResult {
    ok: boolean;
    /** 是否真的落盘（闸关 / 校验失败时 false） */
    written: boolean;
    /** 被闸挡下（不是调用方写错 —— 工具侧据此返回"你没权限"而不是抛错） */
    blocked?: "agent-write-disabled";
    before?: readonly KeepStage[];
    after?: readonly KeepStage[];
    snapshotId?: string;
    issues?: KeepIssue[];
    scope: typeof PLAN_SCOPE;
    note: string;
    /** 人读文本（工具输出 / CLI 提示同一份文案，不许两处各写） */
    text: string;
}

export interface PlanWriteArgs {
    home: string;
    taskUri: string;
    via: PlanWriteVia;
    measure?: PlanCheckArgs["measure"];
}

/** 快照内容：**旧 keep** + 一点元信息（回滚时人要能看懂这是哪一次） */
interface PlanSnapshotDoc {
    ts: string;
    taskUri: string;
    op: "set" | "restore";
    keep: readonly KeepStage[];
}

function snapshotIdNow(): string {
    // ISO 里 `:` 在文件名上不安全（Windows）、且排序仍按时间 —— 换成 `-` 同时保住字典序 = 时间序
    return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 写一份快照（旧 keep），返回 snapshotId；顺带按份数上限清理最旧的 */
export function writePlanSnapshot(home: string, taskUri: string, op: "set" | "restore", keep: readonly KeepStage[]): string {
    const dir = planHistoryDir(home);
    mkdirSync(dir, { recursive: true });
    let id = snapshotIdNow();
    // 同毫秒两次写（单测里常见）：追加序号，别互相覆盖（覆盖 = 悄悄少一份可回滚点）
    if (existsSync(join(dir, `${id}.yaml`))) id = `${id}-${Date.now() % 1000}`;
    const doc: PlanSnapshotDoc = { ts: new Date().toISOString(), taskUri, op, keep };
    writeFileSync(join(dir, `${id}.yaml`), yaml.dump(doc, { indent: 2, noRefs: true }), "utf-8");
    prunePlanSnapshots(home);
    return id;
}

/** 列出快照 id（**旧 → 新**；ISO 字典序即时间序） */
export function listPlanSnapshots(home: string): string[] {
    const dir = planHistoryDir(home);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.slice(0, -".yaml".length))
        .sort();
}

function prunePlanSnapshots(home: string): void {
    try {
        const ids = listPlanSnapshots(home);
        for (const id of ids.slice(0, Math.max(0, ids.length - PLAN_SNAPSHOT_KEEP))) {
            rmSync(join(planHistoryDir(home), `${id}.yaml`), { force: true });
        }
    } catch (e) {
        console.warn("[compact-plan] 快照清理失败（不影响本次写入）:", e);
    }
}

/** 读一份快照的级列表（`id` 可带或不带 `.yaml`） */
function readPlanSnapshot(home: string, id: string): { id: string; doc: PlanSnapshotDoc } {
    const clean = id.endsWith(".yaml") ? id.slice(0, -".yaml".length) : id;
    const f = join(planHistoryDir(home), `${clean}.yaml`);
    if (!existsSync(f)) {
        const avail = listPlanSnapshots(home);
        throw new Error(
            `快照不存在：${clean}（现有 ${avail.length} 份${avail.length ? `，最近：${avail.slice(-3).join(" / ")}` : ""}）`,
        );
    }
    const loaded = yaml.load(readFileSync(f, "utf-8"));
    const keep = Array.isArray(loaded) ? loaded : (loaded as PlanSnapshotDoc | null)?.keep;
    return { id: clean, doc: { ts: "", taskUri: "", op: "set", keep: (keep ?? null) as readonly KeepStage[] } };
}

/** 审计一行（`log/` 可清可丢；写失败不阻断业务，但要出声） */
function appendPlanEdit(
    home: string,
    entry: {
        taskUri: string;
        op: "set" | "restore";
        result: "ok" | "rejected" | "blocked";
        via: PlanWriteVia;
        snapshotId?: string;
        beforeKeep?: readonly KeepStage[];
        afterKeep?: readonly KeepStage[];
        issues?: KeepIssue[];
        reason?: string;
    },
): void {
    try {
        const p = planEditLogFile(home);
        mkdirSync(dirname(p), { recursive: true });
        appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf-8");
    } catch (e) {
        console.warn("[compact-plan] 审计写入失败（不影响写入本身）:", e);
    }
}

/**
 * 写 `history.keep[]` —— **闸 → 校验 → 快照 → 写 → 审计** 的唯一路径。
 *
 * 抛错条件：闸**通过**但 plan 非法（= 调用方写错）。CLI 要 exit≠0，工具要让模型看到错在哪；
 * 两侧都需要「异常」这个信号，故用抛。闸关**不抛**（见文件头注 ①）。
 */
export function planSet(args: PlanWriteArgs & { keepText: string }): PlanWriteResult {
    const { home, taskUri, via, measure, keepText } = args;
    const { source, keep: before } = effectiveKeep(home);
    const beforeList = source === "config" ? before : [];
    if (via === "agent" && !agentWriteAllowed(home)) {
        appendPlanEdit(home, { taskUri, op: "set", result: "blocked", via, beforeKeep: beforeList, reason: "agent-write-disabled" });
        return {
            ok: false,
            written: false,
            blocked: "agent-write-disabled",
            before: beforeList,
            scope: PLAN_SCOPE,
            note: PLAN_SCOPE_NOTE,
            text:
                `plan 写入未开启（history.allowAgentWrite=false）；可先 op:"check" 验证，再由用户开闸。\n` +
                `${PLAN_SCOPE_NOTE}——请把改动方案告诉用户，由用户在配置里把 history.allowAgentWrite 设为 true。`,
        };
    }
    let stages: KeepStage[];
    let issues: KeepIssue[];
    try {
        const report = planCheck({ home, taskUri, keepText, ...(measure ? { measure } : {}) });
        issues = report.issues;
        if (!report.ok) throw new Error(formatCheckFailure(report));
        stages = report.keep;
    } catch (e) {
        appendPlanEdit(home, { taskUri, op: "set", result: "rejected", via, beforeKeep: beforeList, reason: e instanceof Error ? e.message : String(e) });
        throw e;
    }
    const snapshotId = writePlanSnapshot(home, taskUri, "set", beforeList);
    saveKeepConfig(home, stages); // 不绕过校验的**唯一**写入口（此处已校验过一次，仍走它 —— 不许有第二条写路径）
    appendPlanEdit(home, { taskUri, op: "set", result: "ok", via, snapshotId, beforeKeep: beforeList, afterKeep: stages, issues });
    return {
        ok: true,
        written: true,
        before: beforeList,
        after: stages,
        snapshotId,
        issues,
        scope: PLAN_SCOPE,
        note: PLAN_SCOPE_NOTE,
        text: renderWriteResult("set", stages, snapshotId),
    };
}

/**
 * 回滚到某份快照（缺省最近一份）—— **走同一套校验 + 快照**：所以回滚本身也可回滚。
 * 目标快照的 keep 同样要过闸（agent 侧）与校验（快照可能是手改过的文件）。
 */
export function planRestore(args: PlanWriteArgs & { snapshot?: string }): PlanWriteResult {
    const { home, taskUri, via, measure, snapshot } = args;
    const { source, keep: before } = effectiveKeep(home);
    const beforeList = source === "config" ? before : [];
    if (via === "agent" && !agentWriteAllowed(home)) {
        appendPlanEdit(home, { taskUri, op: "restore", result: "blocked", via, beforeKeep: beforeList, reason: "agent-write-disabled" });
        return {
            ok: false,
            written: false,
            blocked: "agent-write-disabled",
            before: beforeList,
            scope: PLAN_SCOPE,
            note: PLAN_SCOPE_NOTE,
            text: `plan 写入未开启（history.allowAgentWrite=false）；回滚同样被闸挡住。\n${PLAN_SCOPE_NOTE}。`,
        };
    }
    const ids = listPlanSnapshots(home);
    const targetId = snapshot ?? ids.at(-1);
    if (!targetId) {
        throw new Error("没有可回滚的快照（plan-history/ 为空）—— 每次成功写入前才会留一份");
    }
    const snap = readPlanSnapshot(home, targetId);
    let stages: KeepStage[];
    try {
        const report = planCheck({ home, taskUri, keepText: yaml.dump(snap.doc.keep, { indent: 2, noRefs: true }), ...(measure ? { measure } : {}) });
        if (!report.ok) throw new Error(`快照 ${snap.id} 的 keep 校验不通过：\n${formatCheckFailure(report)}`);
        stages = report.keep;
    } catch (e) {
        appendPlanEdit(home, { taskUri, op: "restore", result: "rejected", via, beforeKeep: beforeList, reason: e instanceof Error ? e.message : String(e) });
        throw e;
    }
    const snapshotId = writePlanSnapshot(home, taskUri, "restore", beforeList);
    saveKeepConfig(home, stages);
    appendPlanEdit(home, { taskUri, op: "restore", result: "ok", via, snapshotId, beforeKeep: beforeList, afterKeep: stages });
    return {
        ok: true,
        written: true,
        before: beforeList,
        after: stages,
        snapshotId,
        scope: PLAN_SCOPE,
        note: PLAN_SCOPE_NOTE,
        text: `${renderWriteResult("restore", stages, snapshotId)}\n（已回滚到快照 ${snap.id}）`,
    };
}

// ─── 人读文本（工具输出 / CLI 提示共用；不许两处各写）──

/** 级列表 → 多行文本 */
export function renderKeep(keep: readonly KeepStage[]): string {
    if (keep.length === 0) return "  （无——当前是配置里的缺省级列表）";
    return keep
        .map((s, i) => {
            const flags = [
                s.must === true ? "必保（不占预算）" : "",
                s.limit !== undefined ? `最多 ${s.limit} 单元` : "",
                `clip=${clipLabel(s.clip)}`,
            ]
                .filter(Boolean)
                .join(" · ");
            return `  ${i + 1}. ${keepStageLabel(s)} · ${flags}`;
        })
        .join("\n");
}

/** `check` 的人读文本（工具输出用；CLI 侧返回结构化报告，不打印这份） */
export function renderCheckView(r: PlanCheckView): string {
    const lines = [
        `plan 校验：${r.ok ? "通过 ✓" : "未通过 ✗"}（来源：${r.source === "config" ? "配置" : "缺省回退"} · 预算 ${fmtBytes(r.budgetBytes)}）`,
    ];
    if (r.keep.length > 0) lines.push("通过校验的级列表（从上往下生效）：", renderKeep(r.keep));
    if (r.must) {
        lines.push(
            `must 层实占 ${fmtBytes(r.must.mustBytes)} / 硬上限 ${fmtBytes(r.must.hardCapBytes)}${r.must.over ? "（**超限**）" : ""}`,
        );
    }
    const errs = r.issues.filter((i) => i.level === "error");
    const warns = r.issues.filter((i) => i.level === "warn");
    if (errs.length > 0) lines.push("错误：", ...errs.map((i) => `  · ${i.message}`));
    if (warns.length > 0) lines.push("提醒：", ...warns.map((i) => `  · ${i.message}`));
    lines.push(`scope: ${r.scope} —— ${r.note}。`);
    return lines.join("\n");
}

/** `get` 的人读文本（scope 提示必带 —— M3b 要模型知道自己在动全局） */
export function renderPlanView(v: PlanView): string {
    return (
        `plan（来源：${v.source === "config" ? "配置" : "缺省回退"}）· 历史预算 ${fmtBytes(v.budgetBytes)}\n` +
        `${renderKeep(v.keep)}\n` +
        `agent 写闸：${v.writeAllowed ? "已开启（history.allowAgentWrite=true）" : "关闭（history.allowAgentWrite=false ⇒ set/restore 会被拒）"}\n` +
        `scope: ${v.scope} —— ${v.note}。`
    );
}

/** set / restore 成功的人读文本 */
export function renderWriteResult(op: "set" | "restore", keep: readonly KeepStage[], snapshotId: string): string {
    return (
        `plan ${op} 成功，当前级列表（从上往下生效）：\n` +
        `${renderKeep(keep)}\n` +
        `快照：${snapshotId}（回滚用 op:"restore" snapshot:"${snapshotId}"）\n` +
        `scope: ${PLAN_SCOPE} —— ${PLAN_SCOPE_NOTE}。`
    );
}
