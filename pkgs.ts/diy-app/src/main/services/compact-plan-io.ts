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
//   ④ 审计 —— 每次 set / restore / reset 追加一行到 `$DIY_HOME/log/compact/plan-edits.jsonl`（`log/` 可清可丢）。
//
// 另：`reset`（##363）= **删 `history.keep[]` 回出厂缺省** —— 与 restore 的本质差别是**不依赖快照**
//   （快照全坏时它是唯一的逃生窗口）。它同样走闸 + 快照（旧 keep）+ 审计（`op:"reset"`）。
//
// ── 版本化（##378 M3b）──
// 每次成功的 set / restore / reset 都**入版本链**（`plan-store.ts`：内容寻址 CAS + `local/plan/<key>/index.jsonl`）。
// 版本 = 纯 plan 数据 `{ v, source, keep[] }`，id = `plan-<sha256(规范化 JSON) 前 12 位>` ⇒ 同内容同 id（天然去重）、
// 内容变 id 必变（自校验）。全文存**不存 diff**（plan 几百字节，diff 换来的是链式依赖）。
// 旧时间戳快照（`plan-history/<ISO>.yaml`）**保留且只读兼容**：restore 收到旧 id 时读到即转成版本入链。
// 压缩事件账（`local/<key>.compact.jsonl`）从此只记 `planVersion` 指针（见 local-agent 的 compact()）。
//
// ── 分层 ──
// 判据（validate / checkKeep）在 shared + compact-plan-service；文件 I/O 在 core/auto-compact-config；
// 版本存储（CAS + 链）在 plan-store；本模块只做**编排**（闸 → 校验 → 快照 → 写 → 入链 → 审计）与人读文本。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "../core/atomic-write";
import { dirname, join } from "node:path";
import * as yaml from "js-yaml";
import {
    deleteKeepConfig,
    loadAutoCompact,
    loadAutoCompactDetailed,
    parseKeepText,
    readAutoCompactText,
    saveKeepConfig,
} from "../core/auto-compact-config";
import { budgetBytesOf, fmtBytes } from "../../shared/context/compaction";
import type { AutoCompactIssue } from "../../shared/context/auto-compact";
import { DEFAULT_KEEP, clipLabel, keepStageLabel, reasoningClipLabel, type KeepIssue, type KeepStage } from "../../shared/context/compact-keep";
import { checkKeep, formatCheckFailure, type PlanCheckReport } from "./compact-plan-service";
import {
    appendPlanVersion,
    currentPlanVersion,
    isPlanVersionId,
    listPlanVersions,
    planVersionDoc,
    planVersionId,
    readPlanVersion,
    renderPlanVersionDiff,
    type PlanScope,
    type PlanVersionDoc,
    type PlanVersionEntry,
} from "./plan-store";

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
    /**
     * 读配置时的**出声条目**（##370）：空数组 = 干净读入；非空 = 有必填键缺失 / 类型错 / 值被归一，
     * 每条说明「哪一层缺什么 + 已回落到什么」。
     *
     * 为什么在这里：`raw` 永远是**原文**、`source` 可能已是回落态 —— 没有这一栏，用户看到
     * 「原文好好在那儿」却不知道**为什么**生效的不是它（旧行为：原因只写进应用日志）。
     */
    warnings: AutoCompactIssue[];
    scope: typeof PLAN_SCOPE;
    note: string;
    /** 当前生效 plan 的**内容寻址版本 id**（`plan-<sha12>`）—— 由生效内容现算，**不读链**
     *  （手改 `auto-compact.yaml` 也能显示真值；链里有没有这一行是另一件事，见 `versions`） */
    version: string;
    /** 链里已有的版本数（0 = 这套内容还没入过链） */
    versions: number;
    /** 链尾（`null` = 空链）；`entry.version` 与 `version` 不同 = 配置被手改过、尚未入链 */
    latest?: PlanVersionEntry;
}

/** 生效 plan → 版本文档（`source` 从配置形状推；`keep` 用生效的那份，不是缺省回显） */
export function planDocOfEffective(home: string): PlanVersionDoc {
    const { source, keep } = effectiveKeep(home);
    return planVersionDoc({ source, keep });
}

/** 当前生效版本 id（内容寻址）—— 压缩事件与 UI 都靠它指回 CAS */
export function currentPlanVersionId(home: string): string {
    return planVersionId(planDocOfEffective(home));
}

export function planGet(home: string): PlanView {
    const { config: cfg, issues: warnings } = loadAutoCompactDetailed(home);
    const source = planSourceOf(cfg);
    const latest = currentPlanVersion(home);
    return {
        source,
        keep: source === "config" ? cfg.history!.keep! : DEFAULT_KEEP,
        budgetBytes: budgetBytesOf(cfg.policy),
        raw: readAutoCompactText(home),
        writeAllowed: cfg.history?.allowAgentWrite === true,
        warnings,
        scope: PLAN_SCOPE,
        note: PLAN_SCOPE_NOTE,
        version: currentPlanVersionId(home),
        versions: listPlanVersions(home).length,
        ...(latest ? { latest } : {}),
    };
}

// ─── 版本链（读：CLI / 工具 / UI 同一份）─────────────

export interface PlanVersionsView {
    scope: PlanScope;
    /** 当前生效版本 id（由生效内容现算） */
    current: string;
    /** 链（**旧 → 新**） */
    versions: PlanVersionEntry[];
    /** 链尾版本（空链 = null） */
    latest: PlanVersionEntry | null;
    /** 配置内容尚未入链（手改过 / 版本化前配的）⇒ 下一次写或压缩会补录 */
    pending: boolean;
    note: string;
}

export function planVersions(home: string): PlanVersionsView {
    const versions = listPlanVersions(home);
    const current = currentPlanVersionId(home);
    const latest = versions.at(-1) ?? null;
    return {
        scope: { type: "global" },
        current,
        versions,
        latest,
        pending: latest?.version !== current,
        note: PLAN_SCOPE_NOTE,
    };
}

export interface PlanVersionView {
    entry: PlanVersionEntry;
    doc: PlanVersionDoc;
    /** 与上一版（`entry.parent`）的全文对比（无上一版 = 空串） */
    diff: string;
}

/** 单版详情（含与上一版对比；`diff` 由相邻两版全文实时算 —— diff 只作视图） */
export function planVersionView(home: string, version: string): PlanVersionView | null {
    const clean = version.trim();
    const entry = listPlanVersions(home).find((v) => v.version === clean);
    const doc = readPlanVersion(home, clean);
    if (!doc) return null;
    const prevDoc = entry?.parent ? readPlanVersion(home, entry.parent) : null;
    return {
        entry: entry ?? {
            version: clean,
            ts: "",
            op: "set",
            via: "user",
            taskUri: "",
            parent: null,
            brief: "（链里没有这一行：内容存在于 CAS，但没入链）",
        },
        doc,
        diff: prevDoc ? renderPlanVersionDiff({ version: entry!.parent!, keep: prevDoc.keep }, { version: clean, keep: doc.keep }) : "",
    };
}

/** 版本链的人读文本（工具输出 / CLI 同一份文案） */
export function renderPlanVersionsView(v: PlanVersionsView): string {
    const head =
        `plan 版本链（作用域 ${v.scope.type}）：当前 ${v.current}` +
        `${v.pending ? "（**链尾不同** —— 配置已手改，下一次写入 / 压缩会补录）" : ""}`;
    if (v.versions.length === 0) return `${head}\n  （链为空：还没有过一次写入）`;
    const lines = v.versions
        .slice(-10)
        .reverse()
        .map((e) => `  ${e.version}${e.version === v.current ? " ←当前" : ""} · ${e.ts} · ${e.op}/${e.via} · ${e.brief}`)
        .join("\n");
    const more = v.versions.length > 10 ? `\n  …共 ${v.versions.length} 版（只显示最近 10 版）` : "";
    return `${head}\n${lines}${more}`;
}

/** 单版详情的人读文本（级列表 + 与上一版对比） */
export function renderPlanVersionView(v: PlanVersionView): string {
    return (
        `版本 ${v.entry.version} · ${v.entry.op}/${v.entry.via} · ${v.entry.ts || "（未入链）"}\n` +
        `摘要：${v.entry.brief}\n` +
        `内容（${v.doc.source === "config" ? "配置显式" : "缺省/删键"}）：\n${renderKeep(v.doc.keep)}\n` +
        (v.diff ? `与上一版对比：\n${v.diff}` : "（无上一版：链首）")
    );
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
    /** 是否真的落盘（闸关 / 校验失败 / reset 幂等时 false） */
    written: boolean;
    /** 幂等空转（如 reset 时已是缺省）：成功但没动文件、没存快照 */
    noop?: boolean;
    /** 被闸挡下（不是调用方写错 —— 工具侧据此返回"你没权限"而不是抛错） */
    blocked?: "agent-write-disabled";
    before?: readonly KeepStage[];
    after?: readonly KeepStage[];
    /** 旧时间戳快照 id（`plan-history/<id>.yaml`；restore 仍兼容它） */
    snapshotId?: string;
    /** 这次写入后的**内容寻址版本 id**（`plan-<sha12>`；回滚用 `restore(version:"plan-…")`） */
    planVersion?: string;
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
    op: "set" | "restore" | "reset";
    keep: readonly KeepStage[];
}

function snapshotIdNow(): string {
    // ISO 里 `:` 在文件名上不安全（Windows）、且排序仍按时间 —— 换成 `-` 同时保住字典序 = 时间序
    return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 写一份快照（旧 keep），返回 snapshotId；顺带按份数上限清理最旧的 */
export function writePlanSnapshot(home: string, taskUri: string, op: "set" | "restore" | "reset", keep: readonly KeepStage[]): string {
    const dir = planHistoryDir(home);
    mkdirSync(dir, { recursive: true });
    let id = snapshotIdNow();
    // 同毫秒两次写（单测里常见）：追加序号，别互相覆盖（覆盖 = 悄悄少一份可回滚点）
    if (existsSync(join(dir, `${id}.yaml`))) id = `${id}-${Date.now() % 1000}`;
    const doc: PlanSnapshotDoc = { ts: new Date().toISOString(), taskUri, op, keep };
    writeFileAtomic(join(dir, `${id}.yaml`), yaml.dump(doc, { indent: 2, noRefs: true }));
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
        op: "set" | "restore" | "reset";
        result: "ok" | "rejected" | "blocked";
        via: PlanWriteVia;
        snapshotId?: string;
        /** 本次写入后的版本 id（`plan-<sha12>`；审计要能按版本回查） */
        planVersion?: string;
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
    // 入链：**写完之后按生效内容**取版本（不是按入参 stages）—— 配置归一化若改了形状，链记的必须是真值
    const { entry: versionEntry } = appendPlanVersion({
        home,
        doc: planDocOfEffective(home),
        op: "set",
        via,
        taskUri,
    });
    appendPlanEdit(home, {
        taskUri,
        op: "set",
        result: "ok",
        via,
        snapshotId,
        planVersion: versionEntry.version,
        beforeKeep: beforeList,
        afterKeep: stages,
        issues,
    });
    return {
        ok: true,
        written: true,
        before: beforeList,
        after: stages,
        snapshotId,
        planVersion: versionEntry.version,
        issues,
        scope: PLAN_SCOPE,
        note: PLAN_SCOPE_NOTE,
        text: renderWriteResult("set", stages, snapshotId, versionEntry.version),
    };
}

/**
 * 回滚到**某个版本**（缺省 = 版本链上一版）—— **切指针**：把该版本内容写回 `auto-compact.yaml`。
 *
 * 仍走**同一套** 闸 → 校验 → 快照 → 写 → 审计（所以回滚本身也可回滚：本次写入也入链）。
 *
 * 目标三种写法（##378）：
 *   · `version: "plan-<sha12>"` —— 版本 id（正路）；
 *   · `version: "<ISO 时间戳>"`（= 旧快照 id，`plan-history/<id>.yaml`）—— **旧名兼容**：读到即转成版本入链；
 *   · 都不给 —— 取**当前版本链的上一版**（`current.parent`）；链空 / 无上一版才回退「最近一份旧快照」。
 *
 * `source:"default"` 的版本（当时就是「删键回出厂缺省」）⇒ 还原时**删键**，而不是把缺省字面量写进配置
 * —— 否则就把缺省冻结在了还原那一刻（丢失「跟随将来缺省演进」的语义）。
 */
export interface PlanRestoreArgs extends PlanWriteArgs {
    /** 目标版本 id（`plan-<sha12>`）或**旧快照 id**；缺省 = 版本链上一版 */
    version?: string;
    /** 旧参数名（##362 的 `snapshot`）；语义同 `version`，保留兼容 */
    snapshot?: string;
}

export function planRestore(args: PlanRestoreArgs): PlanWriteResult {
    const { home, taskUri, via, measure } = args;
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
    // 目标 → 版本文档（三种写法归一，见函数头注）
    const target = args.version ?? args.snapshot;
    let doc: PlanVersionDoc | null = null;
    let targetLabel = "";
    if (target !== undefined && target.trim() !== "") {
        const id = target.trim();
        if (isPlanVersionId(id)) {
            doc = readPlanVersion(home, id);
            if (!doc) {
                const avail = listPlanVersions(home);
                throw new Error(
                    `版本不存在：${id}（链上 ${avail.length} 版${avail.length ? `，最近：${avail.slice(-3).map((v) => v.version).join(" / ")}` : ""}；见 op:"versions"）`,
                );
            }
            targetLabel = `版本 ${id}`;
        } else {
            // 旧快照 id：读到即转成版本入链（不删旧文件 —— ##378 边界：只做读兼容）
            const snap = readPlanSnapshot(home, id);
            doc = planVersionDoc({ source: "config", keep: (snap.doc.keep ?? []) as KeepStage[] });
            targetLabel = `旧快照 ${snap.id}`;
        }
    } else {
        const cur = currentPlanVersion(home);
        const prevVersion = cur?.parent;
        if (prevVersion) {
            doc = readPlanVersion(home, prevVersion);
            if (doc) targetLabel = `上一版 ${prevVersion}`;
        }
        if (!doc) {
            const ids = listPlanSnapshots(home);
            const last = ids.at(-1);
            if (!last) {
                throw new Error("没有可回滚的版本（版本链为空，`plan-history/` 也为空）—— 每次成功写入才会入链");
            }
            const snap = readPlanSnapshot(home, last);
            doc = planVersionDoc({ source: "config", keep: (snap.doc.keep ?? []) as KeepStage[] });
            targetLabel = `旧快照 ${snap.id}`;
        }
    }
    let stages: KeepStage[];
    try {
        const report = planCheck({ home, taskUri, keepText: yaml.dump(doc.keep, { indent: 2, noRefs: true }), ...(measure ? { measure } : {}) });
        if (!report.ok) throw new Error(`${targetLabel} 的 keep 校验不通过：\n${formatCheckFailure(report)}`);
        stages = report.keep;
    } catch (e) {
        appendPlanEdit(home, { taskUri, op: "restore", result: "rejected", via, beforeKeep: beforeList, reason: e instanceof Error ? e.message : String(e) });
        throw e;
    }
    const snapshotId = writePlanSnapshot(home, taskUri, "restore", beforeList);
    // 切指针：`default` 版本 = 删键（跟随将来缺省），`config` 版本 = 写入级列表
    if (doc.source === "default") deleteKeepConfig(home);
    else saveKeepConfig(home, stages);
    const { entry: versionEntry } = appendPlanVersion({
        home,
        doc: planDocOfEffective(home),
        op: "restore",
        via,
        taskUri,
        brief: `restore ← ${targetLabel}：${describeRestoreBrief(doc.keep)}`,
    });
    appendPlanEdit(home, {
        taskUri,
        op: "restore",
        result: "ok",
        via,
        snapshotId,
        planVersion: versionEntry.version,
        beforeKeep: beforeList,
        afterKeep: stages,
    });
    return {
        ok: true,
        written: true,
        before: beforeList,
        after: stages,
        snapshotId,
        planVersion: versionEntry.version,
        scope: PLAN_SCOPE,
        note: PLAN_SCOPE_NOTE,
        text: `${renderWriteResult("restore", stages, snapshotId, versionEntry.version)}\n（已回滚到${targetLabel}）`,
    };
}

/** restore 的一行摘要（源版本 → 目标内容；`describePlanChange` 从链尾推，这里是「还原自哪」） */
function describeRestoreBrief(keep: readonly KeepStage[]): string {
    return keep.map((s) => s.type).join(" / ") || "空级列表";
}

/**
 * **reset —— 逃生窗口**（##363 M3a 补）：把 `history.keep[]` **删键**回出厂缺省。
 *
 * 与 `restore` 的本质差别：restore 依赖「某份快照是好的」；reset **不依赖任何快照** ——
 * 第一份快照就是坏的、或 20 份快照全被污染时，它是**唯一的落点**（这就是它存在的理由）。
 *
 * 语义（钉死，见 ##363 body）：
 *   · 目标 = 出厂缺省（唯一真源 `DEFAULT_KEEP` / `defaultBudgetPlan`）—— **删键**而非写死字面量：
 *     写死会把配置冻结在当时那版缺省；删键则 `plan get` 报 `source:"default"`、自动跟随未来缺省。
 *   · **只重置 plan**（`history.keep[]`），保留 `mode` / `triggers` / `policy` / `allowAgentWrite`。
 *   · reset 本身**也先快照旧 keep** ⇒ reset 也可被 `restore` 回滚（与 ##362「回滚本身也可回滚」同口径）。
 *   · 幂等：已是缺省（配置里没有 keep 键）⇒ 成功返回「已是缺省，无需重置」，不写文件、不多存快照。
 *   · 闸：与 set/restore 同 —— `via:"agent"` 且闸关 ⇒ 返回拒绝文本（**不抛错**，口径同 ##362）。
 */
export function planReset(args: PlanWriteArgs): PlanWriteResult {
    const { home, taskUri, via } = args;
    const { source, keep: before } = effectiveKeep(home);
    const beforeList = source === "config" ? before : [];
    if (via === "agent" && !agentWriteAllowed(home)) {
        appendPlanEdit(home, { taskUri, op: "reset", result: "blocked", via, beforeKeep: beforeList, reason: "agent-write-disabled" });
        return {
            ok: false,
            written: false,
            blocked: "agent-write-disabled",
            before: beforeList,
            scope: PLAN_SCOPE,
            note: PLAN_SCOPE_NOTE,
            text:
                `plan 写入未开启（history.allowAgentWrite=false）；重置同样被闸挡住。\n` +
                `${PLAN_SCOPE_NOTE}——请把改动方案告诉用户，由用户在配置里把 history.allowAgentWrite 设为 true。`,
        };
    }
    if (source === "default") {
        // 幂等：没有 keep 键 ⇒ 已经落在出厂缺省上。不写文件、不多存快照（存了也只是噪音）。
        appendPlanEdit(home, { taskUri, op: "reset", result: "ok", via, reason: "already-default" });
        return {
            ok: true,
            written: false,
            noop: true,
            before: [],
            after: DEFAULT_KEEP,
            scope: PLAN_SCOPE,
            note: PLAN_SCOPE_NOTE,
            text:
                `plan reset：history.keep[] **已是缺省**（配置里没有 keep 键），无需重置。\n` +
                `当前生效级列表（出厂缺省，从上往下生效）：\n${renderKeep(DEFAULT_KEEP)}\n` +
                `scope: ${PLAN_SCOPE} —— ${PLAN_SCOPE_NOTE}。`,
        };
    }
    const snapshotId = writePlanSnapshot(home, taskUri, "reset", beforeList);
    deleteKeepConfig(home);
    // 入链：reset 也是一版（`source:"default"`）—— 但**逃生窗口本身不依赖链**（先删键，再入链）
    const { entry: versionEntry } = appendPlanVersion({
        home,
        doc: planDocOfEffective(home),
        op: "reset",
        via,
        taskUri,
    });
    appendPlanEdit(home, {
        taskUri,
        op: "reset",
        result: "ok",
        via,
        snapshotId,
        planVersion: versionEntry.version,
        beforeKeep: beforeList,
        afterKeep: DEFAULT_KEEP,
    });
    return {
        ok: true,
        written: true,
        before: beforeList,
        after: DEFAULT_KEEP,
        snapshotId,
        planVersion: versionEntry.version,
        scope: PLAN_SCOPE,
        note: PLAN_SCOPE_NOTE,
        text: renderWriteResult("reset", DEFAULT_KEEP, snapshotId, versionEntry.version),
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
                // 第二条裁剪轴（##374 T2）：只在该级**声明了**它时才显示 —— 没声明即回落缺省，
                // 每级都打一行「回落缺省」只会把回显冲淡
                ...(s.reasoningClip ? [`推理裁法=${reasoningClipLabel(s.reasoningClip)}`] : []),
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
        renderWarnings(v.warnings) +
        `${renderKeep(v.keep)}\n` +
        `版本：${v.version}（${v.versions > 0 ? `链上 ${v.versions} 版` : "尚未入链"}${v.latest && v.latest.version !== v.version ? "；配置已手改，尚未入链" : ""}）\n` +
        `agent 写闸：${v.writeAllowed ? "已开启（history.allowAgentWrite=true）" : "关闭（history.allowAgentWrite=false ⇒ set/restore 会被拒）"}\n` +
        `scope: ${v.scope} —— ${v.note}。`
    );
}

/**
 * 出声条目 → 人读文本（**空则空串**，调用方直接拼）。CLI / 工具输出 / UI 同一份文案，不许两处各写。
 * 没有这一段，用户只看到「来源：缺省回退」而不知道为什么（##370 的病根）。
 */
export function renderWarnings(warnings: readonly AutoCompactIssue[]): string {
    if (warnings.length === 0) return "";
    return (
        `⚠ 读配置有 ${warnings.length} 条出声（已逐键回落缺省，配置里写对的部分仍在用）：\n` +
        warnings.map((w) => `  · ${w.message}\n`).join("")
    );
}

/** set / restore / reset 成功的人读文本 */
export function renderWriteResult(
    op: "set" | "restore" | "reset",
    keep: readonly KeepStage[],
    snapshotId: string,
    planVersion?: string,
): string {
    const head =
        op === "reset"
            ? `plan reset 成功 —— history.keep[] 已删除，回落**出厂缺省管道**（未配置状态；将来缺省演进会自动跟随）`
            : `plan ${op} 成功`;
    return (
        `${head}，当前级列表（从上往下生效）：\n` +
        `${renderKeep(keep)}\n` +
        (planVersion ? `版本：${planVersion}（回滚用 op:"restore" version:"${planVersion}"；列表见 op:"versions"）\n` : "") +
        `快照：${snapshotId}（旧式快照 id 仍可 restore，读到即转成版本入链）\n` +
        `scope: ${PLAN_SCOPE} —— ${PLAN_SCOPE_NOTE}。`
    );
}
