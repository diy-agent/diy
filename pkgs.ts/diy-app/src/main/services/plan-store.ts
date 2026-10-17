// src/main/services/plan-store.ts
// 🎯 装配管道（plan）的**版本存储**（##378 M3b）：内容寻址 CAS + 版本链 index（全文存，不存 diff）。
//
// ── 为什么（一句话）──
// plan 是**全局配置**（`auto-compact.yaml` 的 `history.keep[]`），却曾以「每次压缩把全文内嵌进事件账」
// 的方式落盘 ⇒ 同内容反复内嵌（去重 0）、无版本链（回答不了「上一版是什么 / 谁改的 / 为什么改」）、
// 回滚只能靠时间戳快照这条独立第二链（20 份上限 + 静默删最旧）。本模块把 plan 提成独立真源：
//
//   $DIY_HOME/plan-store/plan-<sha12>.json          # 全局 CAS（跨会话去重）
//   $DIY_HOME/local/plan/<scopeKey>/index.jsonl     # 版本链（一行一版；current = 末行）
//
// ── 判据（钉死，见 ##378 body「判据」节）──
//   R1 同内容必同 id：id = `plan-` + sha256(**canonicalJson**(doc)) 前 12 位。
//      canonical 规则：对象键**递归字典序**、无空白、`undefined` 键**丢弃**、数组保序。
//      ⇒ 同内容两写 = 同一文件（天然去重）；内容任一字节变 ⇒ id 必变（读出即可自校验）。
//   R2 版本内容 = **纯 plan 数据** `{ v, source, keep[] }`，不含 ts/op/via/taskUri/parent/brief
//      （元信息进 index —— 否则同内容不同时间会 hash 成两版，去重失效）。
//      带 `source` 的理由：`config`（配置显式写了 keep）与 `default`（删键/未配置、跟随未来缺省）
//      **语义不同** —— 后者 restore 必须**删键**而非写死字面量。
//   R3 **全文存，不存 diff**：plan 单份几百字节，diff 换来的是链式依赖（重建第 N 版要重放整条链，
//      中间一份坏了整条断），而 plan 恰恰是「坏了就没上下文」的东西。要看变化 = 相邻两版全文实时对比
//      （`describePlanChange` / `renderPlanVersionDiff`，纯函数）。
//   R4 **不设份数上限**：一年几百 KB；若将来要上限，必须出声 + 迁移（否则事件账里的 planVersion 悬空）。
//   R5 index 是链**唯一真源**：`parent` = 写这一版时链尾；`current` = 末行。**禁另落指针文件**（两处各写必漂）。
//   R7 作用域可扩展但本任务只做全局：读走 `PlanScope`，目录键复用 `local-paths.ts::keyOf`（唯一算法）。
//
// ⚠️ 本模块**不做业务判断**（闸 / 校验 / 审计都在 `compact-plan-io`）—— 只做「算 id / 写 CAS / 记账 / 读回」。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { keyOf } from "../core/local-paths";
import type { KeepStage } from "../../shared/context/compact-keep";

// ─── 作用域（本任务只有 global；会话级是 ##380）──────────

/**
 * plan 作用域。当前**只有** `global`（本任务：plan 仍是全局生效语义）。
 * 形状留成判别联合：会话级（`{ type:"session", taskUri }`）将来只加一支，读侧不必改。
 */
export type PlanScope = { type: "global" };
export const GLOBAL_PLAN_SCOPE: PlanScope = { type: "global" };

/**
 * 作用域 → 会话键。**复用 `local-paths.ts::keyOf`**（唯一算法，禁复制第二份）。
 * 全局作用域用固定合成 uri（不是任何任务的 uri）⇒ 目录名自解释：`plan-scope_global-<sha12>`。
 */
export function planScopeKey(scope: PlanScope): string {
    switch (scope.type) {
        case "global":
            return keyOf("plan-scope:global");
    }
}

// ─── 路径 ────────────────────────────────────────

/** 全局 CAS 目录（跨会话去重） */
export function planStoreDir(home: string): string {
    return join(home, "plan-store");
}
/** 版本链目录（`local/plan/<scopeKey>/`）—— 与 `local/toolout/` 同构的平铺子目录 */
export function planChainDir(home: string, scope: PlanScope = GLOBAL_PLAN_SCOPE): string {
    return join(home, "local", "plan", planScopeKey(scope));
}
export function planChainFile(home: string, scope: PlanScope = GLOBAL_PLAN_SCOPE): string {
    return join(planChainDir(home, scope), "index.jsonl");
}
export function planVersionFile(home: string, version: string): string {
    return join(planStoreDir(home), `${version}.json`);
}

// ─── 版本文档（纯 plan 数据）────────────────────────

/** 版本内容：**只有 plan 数据**（元信息进 index，见 R2） */
export interface PlanVersionDoc {
    /** 文档版本（将来形状演进时读侧据它分支） */
    v: 1;
    /** 这套 plan 从哪来：`config` = 配置显式写了 keep；`default` = 未配置/删键（跟随未来缺省） */
    source: "config" | "default";
    /** 级列表（从上往下生效；先声明的先挑） */
    keep: KeepStage[];
}

/** 规整成版本文档（字段序固定 —— 也让人读的 JSON 稳定） */
export function planVersionDoc(input: { source: "config" | "default"; keep: readonly KeepStage[] }): PlanVersionDoc {
    return { v: 1, source: input.source, keep: input.keep.map((k) => ({ ...k })) };
}

/**
 * 规范化 JSON（**hash 的唯一口径**）：对象键递归字典序、无空白、`undefined` 键丢弃、数组保序。
 * 为什么不直接用 `JSON.stringify`：键序取决于**构造顺序**（配置解析路径不同就不同序），
 * 同内容会 hash 成两个 id —— 去重失效、链上出现假变化。
 */
export function canonicalJson(v: unknown): string {
    if (v === undefined) return "null"; // 数组里的 undefined（JSON.stringify 同口径）
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** 版本 id = `plan-<sha256(canonicalJson(doc)) 前 12 位>`（内容寻址；同内容同 id） */
export function planVersionId(doc: PlanVersionDoc): string {
    const sum = createHash("sha256").update(canonicalJson(doc), "utf-8").digest("hex").slice(0, 12);
    return `plan-${sum}`;
}

/** 版本 id 形状校验（**读盘前必过**：id 来自外部输入/事件账，防路径穿越） */
export function isPlanVersionId(v: unknown): v is string {
    return typeof v === "string" && /^plan-[0-9a-f]{12}$/.test(v);
}

// ─── CAS：写 / 读 ────────────────────────────────

export interface PlanVersionWrite {
    version: string;
    /** true = 这次真的落盘；false = 已存在（**同内容去重**，一个字都没写） */
    created: boolean;
}

/** 写一份版本（**已存在即不写**；返回 created:false ⇒ 去重可断言） */
export function writePlanVersion(home: string, doc: PlanVersionDoc): PlanVersionWrite {
    const version = planVersionId(doc);
    const file = planVersionFile(home, version);
    if (existsSync(file)) return { version, created: false };
    mkdirSync(planStoreDir(home), { recursive: true });
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
    return { version, created: true };
}

/** 读一份版本；不存在 / id 非法 / 内容与 id 不符（自校验失败）⇒ null */
export function readPlanVersion(home: string, version: string): PlanVersionDoc | null {
    if (!isPlanVersionId(version)) return null;
    const file = planVersionFile(home, version);
    if (!existsSync(file)) return null;
    try {
        const doc = JSON.parse(readFileSync(file, "utf-8")) as PlanVersionDoc;
        if (!doc || doc.v !== 1 || !Array.isArray(doc.keep)) return null;
        // 自校验：内容寻址的命门 —— 文件被手改 / 截断时 id 与内容不再对应
        if (planVersionId(doc) !== version) return null;
        return doc;
    } catch {
        return null;
    }
}

// ─── 版本链（index.jsonl）────────────────────────

/** 版本链一行：元信息（**不进版本内容**，见 R2） */
export interface PlanVersionEntry {
    /** `plan-<sha12>` */
    version: string;
    ts: string;
    op: "set" | "restore" | "reset";
    via: "agent" | "user";
    /** 谁触发的（全局 plan ⇒ 不是「哪个任务自己的 plan」，只是操作来源） */
    taskUri: string;
    /** 上一版 version（首版 null）⇒ **天然成链** */
    parent: string | null;
    /** 人读一句话摘要（列表/UI 直接显示，不必打开全文） */
    brief: string;
}

/** 读版本链（`**旧 → 新**`；坏行跳过 —— 链坏一行不该让整条不可用） */
export function listPlanVersions(home: string, scope: PlanScope = GLOBAL_PLAN_SCOPE): PlanVersionEntry[] {
    const file = planChainFile(home, scope);
    if (!existsSync(file)) return [];
    const out: PlanVersionEntry[] = [];
    for (const raw of readFileSync(file, "utf-8").split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        try {
            const e = JSON.parse(line) as PlanVersionEntry;
            if (!e || typeof e !== "object" || !isPlanVersionId(e.version)) continue;
            out.push(e);
        } catch {
            // 崩溃半行：跳过（与 compaction 的 parseCompactLog 同策略）
        }
    }
    return out;
}

/** 当前生效版本 = 链末行（**不另落指针文件**，见 R5） */
export function currentPlanVersion(home: string, scope: PlanScope = GLOBAL_PLAN_SCOPE): PlanVersionEntry | null {
    return listPlanVersions(home, scope).at(-1) ?? null;
}

export interface AppendPlanVersionArgs {
    home: string;
    doc: PlanVersionDoc;
    op: PlanVersionEntry["op"];
    via: PlanVersionEntry["via"];
    taskUri: string;
    /** 人读摘要；缺省由 `describePlanChange` 从上一版内容推 */
    brief?: string;
    scope?: PlanScope;
}

/**
 * 入链：写 CAS + 追加一行 index（`parent` = 链尾）。
 * **幂等**：内容与链尾版本相同 ⇒ 不追加（返回 `appended:false`）——「同内容再写一次」不是一次版本变化。
 * 台账语义：set/restore/reset 各入链一行；压缩事件**只引用**版本（全文已由 planCompact 现算好），
 * 只有在「链上没有这套内容」时才由 `local-agent.compact()` 补录一行（否则事件里的指针没有可列可查的落点）。
 */
export function appendPlanVersion(args: AppendPlanVersionArgs): {
    entry: PlanVersionEntry;
    created: boolean;
    appended: boolean;
} {
    const { home, doc, op, via, taskUri } = args;
    const scope = args.scope ?? GLOBAL_PLAN_SCOPE;
    const { version, created } = writePlanVersion(home, doc);
    const prev = currentPlanVersion(home, scope);
    // 内容与链尾相同 ⇒ 不是一次版本变化：不追加（否则链上出现重复 version 与**自指 parent**）
    if (prev && prev.version === version) {
        return { entry: prev, created, appended: false };
    }
    const prevDoc = prev ? readPlanVersion(home, prev.version) : null;
    const entry: PlanVersionEntry = {
        version,
        ts: new Date().toISOString(),
        op,
        via,
        taskUri,
        parent: prev?.version ?? null,
        brief: args.brief ?? describePlanChange(prevDoc?.keep ?? [], doc.keep, op),
    };
    mkdirSync(planChainDir(home, scope), { recursive: true });
    appendFileSync(planChainFile(home, scope), `${JSON.stringify(entry)}\n`, "utf-8");
    return { entry, created, appended: true };
}

// ─── 人读摘要 / 对比（纯函数；UI 与 CLI 共用，不许两处各写）──

const stageLabel = (s: KeepStage): string => {
    const d = (s as { data?: Record<string, unknown> }).data;
    const parts: string[] = [s.type];
    if (d) {
        for (const k of Object.keys(d).sort()) parts.push(`${k}=${String(d[k])}`);
    }
    if (s.must) parts.push("must");
    if (s.limit !== undefined) parts.push(`limit=${s.limit}`);
    if (s.clip) parts.push(`clip=${s.clip.type}`);
    return parts.join(" ");
};

/**
 * 一句话摘要（`brief`）：从上一版 keep 到这一版 keep 变了什么。
 * 只描述**结构差异**（级数 + 逐级标签），不铺全文 —— 列表里一行放得下才有用。
 */
export function describePlanChange(prev: readonly KeepStage[], next: readonly KeepStage[], op?: PlanVersionEntry["op"]): string {
    const head = op === "reset" ? "reset → 出厂缺省" : op === "restore" ? "restore" : "set";
    if (prev.length === 0 && next.length === 0) return `${head}：空级列表`;
    if (prev.length === 0) return `${head}：0 → ${next.length} 级（${next.map(stageLabel).join(" / ")}）`;
    const a = prev.map(stageLabel);
    const b = next.map(stageLabel);
    if (a.length === b.length && a.every((x, i) => x === b[i])) return `${head}：内容未变（${b.length} 级）`;
    const diffs: string[] = [];
    if (a.length !== b.length) diffs.push(`${a.length} 级 → ${b.length} 级`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        if (a[i] === undefined) diffs.push(`+${b[i]}`);
        else if (b[i] === undefined) diffs.push(`-${a[i]}`);
        else diffs.push(`${a[i]} → ${b[i]}`);
        if (diffs.length >= 3) break; // 摘要只留前几条：一行放得下才有用
    }
    return `${head}：${diffs.join("；")}`;
}

/**
 * 两版**全文对比**（diff 只作视图，见 R3）：按级对齐，逐条 `= / - / +`。
 * 不做行级 diff —— plan 是**有序级列表**，逐级对比才是人读得懂的粒度。
 */
export function renderPlanVersionDiff(a: { version: string; keep: readonly KeepStage[] }, b: { version: string; keep: readonly KeepStage[] }): string {
    const lines: string[] = [`--- ${a.version}`, `+++ ${b.version}`];
    const n = Math.max(a.keep.length, b.keep.length);
    for (let i = 0; i < n; i++) {
        const x = a.keep[i];
        const y = b.keep[i];
        if (x && y && stageLabel(x) === stageLabel(y)) lines.push(`  ${i + 1}. ${stageLabel(x)}`);
        else {
            if (x) lines.push(`- ${i + 1}. ${stageLabel(x)}`);
            if (y) lines.push(`+ ${i + 1}. ${stageLabel(y)}`);
        }
    }
    if (n === 0) lines.push("（两版都是空级列表）");
    return lines.join("\n");
}
