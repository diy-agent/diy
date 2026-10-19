// scripts/measure-reasoning-budget.mts
// 🎯 ##374 T3：**真实投递字节**的 before / after 量测（口径 = 渲染后**投递**字节，与真发同源）
//
// 用法：
//   npx tsx scripts/measure-reasoning-budget.mts [--task projects/4/tasks/266] [--home ~/.diy] [--budget 20480]
//
// 口径（为什么这样才算数）：
//   · 输入 = 该会话的 **ops.jsonl**（会话唯一权威）→ `replay` → 块树；
//   · 两侧都过**真发同一条链**：`projectAll` → `selectHistoryByBudget` → `blocksToMessages`
//     （`keptBytes` 与真发同一个渲染函数；不是 `JSON.stringify(projectAll)` 的全量投影 —— 那是个更大的数）。
//   · before = 本任务**前**的口径：老 `DEFAULT_KEEP`（`steps{n:6} must clip:full` + `ladder`，
//     没有 `reasoningClip`）+ 不注入 `defaultReasoningClip`。
//   · after  = 本任务口径：`DEFAULT_KEEP`（多两处 `reasoningClip`）+ `defaultReasoningClip = DEFAULT_REASONING_CLIP`。
//   · must 层（`budget:"exempt"`，**不占预算**）单独量：它撑多大，预算是管不到的。
//
// 只读：只读 `~/.diy`（ops.jsonl / auto-compact.yaml），一个字节都不写回去。

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAutoCompact } from "../src/main/core/auto-compact-config";
import { blocksToMessages, costOfWith, projectAll, replay, selectHistoryByBudget, type LocalModelMessage, type Op } from "../src/main/services/local-blocks";
import { keepStagesToPlan, runPlan } from "../src/main/services/compaction-plan";
import { DEFAULT_KEEP, DEFAULT_REASONING_CLIP, type KeepStage } from "../src/shared/context/compact-keep";
import { budgetBytesOf, clipSpecOf, fmtBytes, makeDeliveryTransform, toolResultOf, type ReasoningClipSpec } from "../src/shared/context/compaction";

const argOf = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
};
const HOME = (argOf("home") ?? join(homedir(), ".diy")).replace(/^~/, homedir());
const TASK = argOf("task") ?? "projects/4/tasks/266";
const LOCAL = join(HOME, "local");
/** 会话文件名 = `keyOf(uri)` + 后缀；`keyOf` 带 sha256 尾巴，故用「可读前缀 + 后缀」做 glob，
 *  不复制 key 算法（复制 = 两处漂移，见 local-paths 头注）。 */
const stem = `${TASK.replace(/[^\w.-]+/g, "_").slice(0, 64)}-`;
function findFile(suffix: string): string {
    const hits = readdirSync(LOCAL).filter((f) => f.startsWith(stem) && f.endsWith(suffix));
    if (hits.length !== 1) throw new Error(`找不到唯一的 ${suffix}（${LOCAL}/${stem}*）：${hits.join(", ") || "无"}`);
    return join(LOCAL, hits[0]!);
}
const OPS = findFile(".ops.jsonl");

/** 老口径的 keep（本任务前）：与 `DEFAULT_KEEP` 逐字段相同，**只少** reasoningClip */
const KEEP_BEFORE: KeepStage[] = [
    { type: "steps", must: true, clip: { type: "full" }, data: { n: 6 } },
    { type: "ladder" },
];

const SIDES: { label: string; keep: readonly KeepStage[]; defaultReasoningClip?: ReasoningClipSpec }[] = [
    { label: "before（推理不裁）", keep: KEEP_BEFORE },
    { label: "after （推理保头 600）", keep: DEFAULT_KEEP, defaultReasoningClip: DEFAULT_REASONING_CLIP },
    // ⚠️ **假设对照**：本任务**不**改 must 级（它按设计保持 full）。这一行只为量出「要是 must 也裁」
    //   还有多少余量 —— 供 owner 决定要不要另开一条轴（must 是 exempt，撑多大预算是管不到的）。
    {
        label: "假设：must 也裁（**未落配置**）",
        keep: [{ type: "steps", must: true, clip: { type: "full" }, reasoningClip: DEFAULT_REASONING_CLIP, data: { n: 6 } }, DEFAULT_KEEP[1]!],
        defaultReasoningClip: DEFAULT_REASONING_CLIP,
    },
];

const ops: Op[] = readFileSync(OPS, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Op);
const store = replay(ops);
const all = projectAll(store);
const policy = loadAutoCompact(HOME).policy;
const defaultClip = clipSpecOf(toolResultOf(policy));

/** 投递后的推理统计：part 数 / 字节 / 被裁条数（marker 辨认） */
function reasoningStats(msgs: readonly LocalModelMessage[]) {
    let parts = 0;
    let bytes = 0;
    let clipped = 0;
    for (const m of msgs) {
        if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
        for (const p of m.content) {
            if (p.type !== "reasoning") continue;
            parts++;
            bytes += Buffer.byteLength(p.text, "utf-8");
            if (p.text.includes("推理省略")) clipped++;
        }
    }
    return { parts, bytes, clipped };
}

console.log(`会话：${TASK}（ops ${(readFileSync(OPS).length / 1024 / 1024).toFixed(1)} MiB）`);
console.log(
    `块树：${all.length} 条消息 · 工具全局 clip ${JSON.stringify(defaultClip)} · 会话 issue ${store.issues.length}` +
        ` · 配置预算 ${fmtBytes(budgetBytesOf(policy))}`,
);

const budgets = (argOf("budget") ?? String(budgetBytesOf(policy)))
    .split(",")
    .map((x) => Number(x.trim()));

interface Row {
    lines: string[];
    keptBytes: number;
    reasoningBytes: number;
    reasoningParts: number;
    clipped: number;
}

for (const b of budgets) {
    console.log(`\n══ 预算 ${fmtBytes(b)} ══`);
    const rows: Row[] = [];
    for (const side of SIDES) {
        const plan = keepStagesToPlan(side.keep, b, defaultClip);
        const opts = {
            ...makeDeliveryTransform(policy, (id: string) => `toolout/${id}.txt`),
            ...(side.defaultReasoningClip ? { defaultReasoningClip: side.defaultReasoningClip } : {}),
            plan,
        };
        const cost = costOfWith(opts);
        const sel = selectHistoryByBudget(all, b, opts);
        // 真发形状（含索引位与工具裁剪）—— 与 keptBytes 同一个渲染函数
        const delivered = blocksToMessages(store, { ...opts, budgetBytes: b }) as unknown as LocalModelMessage[];
        const r = reasoningStats(delivered);
        const mustKeep = side.keep.filter((s) => s.must === true);
        const must = mustKeep.length
            ? runPlan(all, keepStagesToPlan(mustKeep, Number.MAX_SAFE_INTEGER, defaultClip), { costOf: cost })
            : { keptBytes: 0, kept: [] as number[] };
        const mustSet = new Set(must.kept);
        // 角色直方图：分开「must 层」与「计预算层」（判断推理到底有没有机会被挑到，就看这行）
        const histOf = (pick: (i: number) => boolean) => {
            const h = new Map<string, number>();
            for (const i of sel.kept) if (pick(i)) h.set(all[i]!.role, (h.get(all[i]!.role) ?? 0) + 1);
            return [...h].map(([role, n]) => `${role} ${n}`).join(" · ") || "—";
        };
        let recomputed = 0;
        for (const i of sel.kept) recomputed += cost(all[i]!, sel.clips?.[i] ?? null, sel.reasoningClips?.[i] ?? null);
        const line = (label: string) =>
            `  ${label}｜投递 ${fmtBytes(sel.keptBytes)}（must ${fmtBytes(must.keptBytes)} + 计预算 ${fmtBytes(sel.keptBytes - must.keptBytes)}）· ` +
            `推理 ${r.parts} 条/${fmtBytes(r.bytes)}（裁 ${r.clipped} 条）\n` +
            `         保留 ${sel.kept.length}/${all.length} 条〔must: ${histOf((i) => mustSet.has(i))}｜计预算: ${histOf((i) => !mustSet.has(i))}〕` +
            `${sel.keptBytes === recomputed ? "" : "  ⚠️ 口径不一致"}`;
        console.log(`\n【${side.label}】`);
        console.log(line("   "));
        rows.push({ lines: [], keptBytes: sel.keptBytes, reasoningBytes: r.bytes, reasoningParts: r.parts, clipped: r.clipped });
    }
    const [bef, aft] = rows as [Row, Row];
    console.log(
        `\n  ⇒ 差值：投递 ${fmtBytes(aft.keptBytes - bef.keptBytes)}（${bef.keptBytes ? `${((aft.keptBytes / bef.keptBytes - 1) * 100).toFixed(1)}%` : "n/a"}）· ` +
            `推理 ${fmtBytes(aft.reasoningBytes - bef.reasoningBytes)}（新裁 ${aft.clipped - bef.clipped} 条）`,
    );
}
